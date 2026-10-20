// Hours to approve (on Admin): hours waiting on the projects you
// manage — or, for admins, on projects with no project manager yet. Grouped
// by project, then one row per person; clicking a person lists each entry
// (date, task, hours, note) with Edit, Decline and Approve. Declined entries
// go back to the person's Timesheet (with the reason) and return here once
// they edit them.
import { TimeEntries } from "./db.js";
import { esc, fmtHrs, showToast, projectColor, sortProjects } from "./util.js";
import { assignedHours, isInternal } from "./rates.js";

const apprDate = (iso) => new Date(iso + "T00:00:00")
  .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// "Oct 14", "Oct 14 – 16" or "Sep 30 – Oct 2" for a set of entries.
function dateRange(entries) {
  const dates = entries.map((e) => e.date).sort();
  const fmt = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);
  const a = dates[0];
  const b = dates[dates.length - 1];
  if (a === b) return fmt(a, { month: "short", day: "numeric" });
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { day: "numeric" })}`
    : `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { month: "short", day: "numeric" })}`;
}

const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

export function createApprovals({ getData, sessionPersonId }) {
  const card = document.getElementById("pendingApprovalCard");
  const body = document.getElementById("pendingBody");
  const total = document.getElementById("pendingTotal");
  const approveAllBtn = document.getElementById("approveAllBtn");

  const scope = document.getElementById("approvalScope");
  let showAll = false; // "All" projects instead of just the ones you manage
  let openKey = null; // "<projectId>|<personId>"
  let editing = null; // { id, mode: "edit" | "decline" }

  // Projects whose hours you approve.
  function myProjectIds() {
    const { projects, people } = getData();
    const me = people.find((p) => p.id === sessionPersonId);
    return new Set(projects
      .filter((p) => !isInternal(p) && (showAll || p.pmPersonId === sessionPersonId || (me && me.isAdmin && !p.pmPersonId)))
      .map((p) => p.id));
  }

  function pendingEntries() {
    const ids = myProjectIds();
    return getData().timeEntries
      .filter((e) => !e.approved && !e.invoiced && !e.declined && ids.has(e.projectId))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // True when this person has logged more on the task than assigned.
  function isOver(personId, taskId) {
    const { assignments, timeEntries } = getData();
    const assignment = assignments.find((a) => a.taskId === taskId && a.personId === personId);
    const assigned = assignment ? assignedHours(assignment) : 0;
    const logged = sumHours(timeEntries.filter((e) => e.taskId === taskId && e.personId === personId));
    return logged - assigned > 0.005;
  }

  // [{ project, hours, entries, people: [{ key, person, name, hours, entries }] }]
  function groups() {
    const { projects, people } = getData();
    const byProject = new Map();
    pendingEntries().forEach((e) => {
      if (!byProject.has(e.projectId)) byProject.set(e.projectId, new Map());
      const byPerson = byProject.get(e.projectId);
      if (!byPerson.has(e.personId)) byPerson.set(e.personId, []);
      byPerson.get(e.personId).push(e);
    });
    const order = sortProjects(projects).map((p) => p.id);
    return [...byProject].map(([projectId, byPerson]) => {
      const rows = [...byPerson].map(([personId, entries]) => ({
        key: `${projectId}|${personId}`,
        personId,
        name: people.find((p) => p.id === personId)?.name || "—",
        hours: sumHours(entries),
        entries,
      })).sort((x, y) => x.name.localeCompare(y.name));
      const entries = rows.flatMap((r) => r.entries);
      return { project: projects.find((p) => p.id === projectId), projectId, hours: sumHours(entries), entries, people: rows };
    }).sort((x, y) => order.indexOf(x.projectId) - order.indexOf(y.projectId));
  }

  function entryRowHtml(e) {
    const { tasks } = getData();
    const mode = editing && editing.id === e.id ? editing.mode : null;
    const task = tasks.find((t) => t.id === e.taskId);
    const lead = `<td class="appr-date">${apprDate(e.date)}</td>
      <td class="appr-task appr-muted">${task ? esc(task.name) : "—"}</td>`;
    if (mode === "edit") {
      return `<tr class="appr-entry editing">${lead}
        <td class="num"><input type="number" class="appr-hours" min="0" step="0.25" value="${Number(e.hours)}" /></td>
        <td><input type="text" class="appr-note-input" value="${esc(e.note || "")}" /></td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
          <button type="button" class="small" data-action="save-entry" data-id="${e.id}">Save</button>
        </td></tr>`;
    }
    if (mode === "decline") {
      return `<tr class="appr-entry editing">${lead}
        <td class="num">${fmtHrs(Number(e.hours))}</td>
        <td><input type="text" class="appr-reason" placeholder="Reason (optional)" /></td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
          <button type="button" class="small danger" data-action="confirm-decline" data-id="${e.id}">Decline</button>
        </td></tr>`;
    }
    return `<tr class="appr-entry">${lead}
      <td class="num ${isOver(e.personId, e.taskId) ? "appr-over" : ""}">${fmtHrs(Number(e.hours))}</td>
      <td class="appr-entry-note ${e.note ? "" : "appr-muted"}">${e.note ? esc(e.note) : "No note"}</td>
      <td class="num appr-actions" colspan="2">
        <button type="button" class="link-btn" data-action="edit-entry" data-id="${e.id}">Edit</button>
        <button type="button" class="link-btn appr-decline" data-action="decline-entry" data-id="${e.id}">Decline</button>
        <button type="button" class="link-btn appr-approve" data-action="approve-entry" data-id="${e.id}">Approve</button>
      </td></tr>`;
  }

  function render() {
    // Don't redraw under someone typing in an entry being edited.
    if (editing && body.contains(document.activeElement) && document.activeElement.matches("input")) return;
    const gs = groups();
    card.style.display = "block";
    approveAllBtn.style.display = gs.length ? "" : "none";
    if (gs.length === 0) {
      total.textContent = "";
      body.innerHTML = '<div class="empty">Nothing to approve.</div>';
      return;
    }
    total.textContent = `${fmtHrs(gs.reduce((s, g) => s + g.hours, 0))} hrs`;

    body.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table">
      <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
      <thead><tr><th>Date</th><th>Person</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
      ${gs.map((g) => `<tbody>
        <tr class="appr-group">
          <td colspan="4"><span class="pay-dot" style="--c:${g.project ? projectColor(g.project.id) : "#c9c2cf"};"></span><strong>${g.project ? esc(g.project.name) : "—"}</strong> <span class="appr-muted">${fmtHrs(g.hours)} hrs</span></td>
          <td class="num" colspan="2">${g.people.length > 1
            ? `<button type="button" class="link-btn" data-action="approve-project" data-id="${g.projectId}">Approve all</button>` : ""}</td>
        </tr>
        ${g.people.map((r) => {
          const open = openKey === r.key;
          const over = r.entries.some((e) => isOver(e.personId, e.taskId));
          return `<tr class="appr-row ${open ? "open" : ""}" data-key="${esc(r.key)}">
            <td class="appr-date">${dateRange(r.entries)}</td>
            <td class="appr-task">${esc(r.name)}</td>
            <td class="num appr-subtotal ${over ? "appr-over" : ""}" ${over ? 'title="More than their assigned hours on a task"' : ""}>${fmtHrs(r.hours)}</td>
            <td class="appr-note appr-muted">${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"}</td>
            <td class="num"><button type="button" class="small due-btn due-complete" data-action="approve-person" data-key="${esc(r.key)}">${r.entries.length > 1 ? `Approve all (${r.entries.length})` : "Approve"}</button></td>
            <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
          </tr>
          ${open ? r.entries.map(entryRowHtml).join("") : ""}`;
        }).join("")}
      </tbody>`).join("")}
    </table></div>`;
  }

  async function approveIds(ids, message) {
    try {
      await TimeEntries.approve(ids);
      showToast(message);
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }

  body.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) {
      const row = e.target.closest("tr.appr-row");
      if (row) {
        openKey = openKey === row.dataset.key ? null : row.dataset.key;
        editing = null;
        render();
      }
      return;
    }
    const { action } = btn.dataset;
    if (action === "edit-entry" || action === "decline-entry") {
      editing = { id: btn.dataset.id, mode: action === "edit-entry" ? "edit" : "decline" };
      render();
      const input = body.querySelector(".appr-entry.editing input");
      if (input) input.focus();
      return;
    }
    if (action === "cancel-entry") {
      editing = null;
      render();
      return;
    }
    if (action === "save-entry") {
      const row = btn.closest("tr");
      const hours = Number(row.querySelector(".appr-hours").value);
      const note = row.querySelector(".appr-note-input").value.trim();
      if (!(hours > 0) || hours > 24) return showToast("Enter hours between 0 and 24.");
      try {
        await TimeEntries.update(btn.dataset.id, { hours, note });
        editing = null;
        render();
        showToast("Entry updated.");
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "confirm-decline") {
      const reason = btn.closest("tr").querySelector(".appr-reason").value.trim();
      try {
        await TimeEntries.update(btn.dataset.id, { declined: true, declineReason: reason || null });
        editing = null;
        render();
        showToast("Declined — sent back to their Timesheet.");
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "approve-entry") return approveIds([btn.dataset.id], "Approved.");
    const gs = groups();
    if (action === "approve-person") {
      const r = gs.flatMap((g) => g.people).find((x) => x.key === btn.dataset.key);
      if (r) return approveIds(r.entries.map((x) => x.id), `${r.name}'s hours approved.`);
    }
    if (action === "approve-project") {
      const g = gs.find((x) => x.projectId === btn.dataset.id);
      if (g) return approveIds(g.entries.map((x) => x.id), "Approved.");
    }
  });

  body.addEventListener("keydown", (e) => {
    if (!e.target.matches(".appr-entry input")) return;
    if (e.key === "Escape") { editing = null; render(); }
    if (e.key === "Enter") e.target.closest("tr").querySelector("button.small")?.click();
  });

  scope.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    showAll = btn.dataset.value === "all";
    scope.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    openKey = null;
    render();
  });

  approveAllBtn.addEventListener("click", async () => {
    const ids = pendingEntries().map((e) => e.id);
    if (ids.length === 0) return;
    if (!confirm(`Approve all ${ids.length} pending ${ids.length === 1 ? "entry" : "entries"}?`)) return;
    approveIds(ids, "All entries approved.");
  });

  return { render };
}
