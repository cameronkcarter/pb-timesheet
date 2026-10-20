// Approvals (on Admin): hours and expenses on the projects you manage — or,
// for admins, on projects with no project manager yet. "Pending" lists
// what's waiting (Edit, Decline, Approve); "Approved" lists what's approved
// but not invoiced yet (Edit, Unapprove). Grouped by project, then one row
// per person; clicking a person lists each entry. Declined entries go back to
// the person's Timesheet (with the reason) and return once they edit them.
// Invoiced hours aren't shown — void the invoice to change them.
import { TimeEntries, Expenses } from "./db.js";
import { esc, fmtHrs, showToast, projectColor, sortProjects, formatCurrency } from "./util.js";
import { expenseLabel, createExpenseEditor } from "./expenses.js";
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
  const viewToggle = document.getElementById("approvalView");
  let showAll = false; // "All" projects instead of just the ones you manage
  let view = "pending"; // "pending" (to approve) or "approved" (not invoiced yet)
  let openKey = null; // "<projectId>|<personId>"
  // Expenses are edited in the same popup used to record them.
  const expenseEditor = createExpenseEditor({
    getData: () => ({ people: getData().people, projects: getData().projects }),
    sessionPersonId,
    projectChoices: () => getData().projects,
    canPickPayer: () => true,
  });
  let editing = null; // { id, mode: "edit" | "decline" }

  // Projects whose hours you approve.
  function myProjectIds() {
    const { projects, people } = getData();
    const me = people.find((p) => p.id === sessionPersonId);
    return new Set(projects
      .filter((p) => !isInternal(p) && (showAll || p.pmPersonId === sessionPersonId || (me && me.isAdmin && !p.pmPersonId)))
      .map((p) => p.id));
  }

  // Hours and expenses waiting for approval, in date order. Expenses are
  // tagged isExpense and filed under the person who paid (or who added it).
  function pendingEntries() {
    const ids = myProjectIds();
    const approved = view === "approved";
    const waiting = (e) => !!e.approved === approved && !e.invoiced && !e.declined && ids.has(e.projectId);
    const hours = getData().timeEntries.filter(waiting);
    const exps = (getData().expenses || []).filter((e) => e.kind !== "sub" && waiting(e))
      .map((e) => ({ ...e, isExpense: true, hours: 0, personId: e.personId || e.createdByPersonId }));
    return [...hours, ...exps].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  const expenseSum = (items) => items.filter((e) => e.isExpense).reduce((t, e) => t + Number(e.amount || 0), 0);

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
    const { tasks, projects } = getData();
    if (e.isExpense && !(editing && editing.id === e.id)) {
      return `<tr class="appr-entry">
        <td class="appr-date">${apprDate(e.date)}</td>
        <td class="appr-task appr-muted">Expense</td>
        <td class="num appr-muted">—</td>
        <td class="appr-entry-note"><strong>${formatCurrency(e.amount)}</strong> · ${esc(expenseLabel(e, projects.find((p) => p.id === e.projectId)))}</td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="link-btn" data-action="edit-expense" data-id="${e.id}">Edit</button>
          ${rowActions(e)}
        </td></tr>`;
    }
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
        ${rowActions(e)}
      </td></tr>`;
  }

  // Decline + Approve while waiting; Unapprove once approved.
  function rowActions(e) {
    return view === "approved"
      ? `<button type="button" class="link-btn appr-decline" data-action="unapprove-entry" data-id="${e.id}">Unapprove</button>`
      : `<button type="button" class="link-btn appr-decline" data-action="decline-entry" data-id="${e.id}">Decline</button>
         <button type="button" class="link-btn appr-approve" data-action="approve-entry" data-id="${e.id}">Approve</button>`;
  }

  function render() {
    // Don't redraw under someone typing in an entry being edited.
    if (editing && body.contains(document.activeElement) && document.activeElement.matches("input")) return;
    const gs = groups();
    card.style.display = "block";
    approveAllBtn.style.display = gs.length && view === "pending" ? "" : "none";
    if (gs.length === 0) {
      total.textContent = "";
      body.innerHTML = `<div class="empty">${view === "approved" ? "No approved hours waiting to be invoiced." : "Nothing to approve."}</div>`;
      return;
    }
    const allItems = gs.flatMap((g) => g.entries);
    const owed = expenseSum(allItems);
    total.textContent = `${fmtHrs(gs.reduce((s, g) => s + g.hours, 0))} hrs${owed ? ` · ${formatCurrency(owed)} expenses` : ""}`;

    body.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table">
      <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
      <thead><tr><th>Date</th><th>Person</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
      ${gs.map((g) => `<tbody>
        <tr class="appr-group">
          <td colspan="4"><span class="pay-dot" style="--c:${g.project ? projectColor(g.project.id) : "#c9c2cf"};"></span><strong>${g.project ? esc(g.project.name) : "—"}</strong> <span class="appr-muted">${fmtHrs(g.hours)} hrs</span></td>
          <td class="num" colspan="2">${g.people.length > 1 && view === "pending"
            ? `<button type="button" class="link-btn" data-action="approve-project" data-id="${g.projectId}">Approve all</button>` : ""}</td>
        </tr>
        ${g.people.map((r) => {
          const open = openKey === r.key;
          const over = r.entries.some((e) => isOver(e.personId, e.taskId));
          return `<tr class="appr-row ${open ? "open" : ""}" data-key="${esc(r.key)}">
            <td class="appr-date">${dateRange(r.entries)}</td>
            <td class="appr-task">${esc(r.name)}</td>
            <td class="num appr-subtotal ${over ? "appr-over" : ""}" ${over ? 'title="More than their assigned hours on a task"' : ""}>${fmtHrs(r.hours)}</td>
            <td class="appr-note appr-muted">${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"}${expenseSum(r.entries) ? ` · ${formatCurrency(expenseSum(r.entries))} expenses` : ""}</td>
            <td class="num">${view === "pending" ? `<button type="button" class="small due-btn due-complete" data-action="approve-person" data-key="${esc(r.key)}">${r.entries.length > 1 ? `Approve all (${r.entries.length})` : "Approve"}</button>` : ""}</td>
            <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
          </tr>
          ${open ? r.entries.map(entryRowHtml).join("") : ""}`;
        }).join("")}
      </tbody>`).join("")}
    </table></div>`;
  }

  // Approves a mix of hours and expenses.
  async function approveItems(items, message) {
    try {
      const hourIds = items.filter((e) => !e.isExpense).map((e) => e.id);
      const expenseIds = items.filter((e) => e.isExpense).map((e) => e.id);
      if (hourIds.length) await TimeEntries.approve(hourIds);
      if (expenseIds.length) await Expenses.approve(expenseIds);
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
    if (action === "edit-expense") {
      const rec = (getData().expenses || []).find((x) => x.id === btn.dataset.id);
      if (rec) expenseEditor.open(rec);
      return;
    }
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
        const item = pendingEntries().find((x) => x.id === btn.dataset.id);
        await (item && item.isExpense ? Expenses : TimeEntries).update(btn.dataset.id, { declined: true, declineReason: reason || null });
        editing = null;
        render();
        showToast("Declined — sent back to their Timesheet.");
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "unapprove-entry") {
      const item = pendingEntries().find((x) => x.id === btn.dataset.id);
      if (!item) return;
      try {
        await (item.isExpense ? Expenses : TimeEntries).update(item.id, { approved: false, approvedDate: null });
        showToast("Moved back to Pending.");
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "approve-entry") {
      const item = pendingEntries().find((x) => x.id === btn.dataset.id);
      if (item) return approveItems([item], "Approved.");
    }
    const gs = groups();
    if (action === "approve-person") {
      const r = gs.flatMap((g) => g.people).find((x) => x.key === btn.dataset.key);
      if (r) return approveItems(r.entries, `${r.name}'s hours approved.`);
    }
    if (action === "approve-project") {
      const g = gs.find((x) => x.projectId === btn.dataset.id);
      if (g) return approveItems(g.entries, "Approved.");
    }
  });

  body.addEventListener("keydown", (e) => {
    if (!e.target.matches(".appr-entry input")) return;
    if (e.key === "Escape") { editing = null; render(); }
    if (e.key === "Enter") e.target.closest("tr").querySelector("button.small")?.click();
  });

  viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    view = btn.dataset.value;
    viewToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    openKey = null;
    editing = null;
    render();
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
    const items = pendingEntries();
    if (items.length === 0) return;
    if (!confirm(`Approve all ${items.length} pending ${items.length === 1 ? "entry" : "entries"}?`)) return;
    approveItems(items, "All entries approved.");
  });

  return { render };
}
