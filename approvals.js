// Approvals (on the Dashboard, for project managers and admins): hours and
// expenses on the projects you manage — or, for admins, on projects with no
// project manager yet ("All" shows every project). "Pending" lists what's
// waiting (Edit, Decline, Approve); "Approved" lists what's approved but not
// invoiced yet (Edit, Unapprove). Grouped by project, then one row per
// person; clicking a person lists each entry. Declined entries go back to
// the person's Timesheet (with the reason) and return once they edit them.
// Invoiced hours aren't shown — void the invoice to change them.
//
// "Don't bill" marks an entry as paid but not charged to the client (see
// isBillable in rates.js). Edit can also move an entry to another task on
// the same project.
//
// "Internal" lists hours on internal projects (e.g. Proposals & Pursuits),
// which don't need approval, grouped by task instead of person — so each
// proposal's hours add up — with Edit to fix or move entries.
import { TimeEntries, Expenses } from "./db.js";
import { esc, fmtHrs, showToast, projectColor, sortProjects, formatCurrency, dateRange, entryDate } from "./util.js";
import { expenseLabel, createExpenseEditor } from "./expenses.js";
import { assignedHours, isInternal, isBillable } from "./rates.js";

const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

// Admins and anyone who manages a project see Approvals.
export function canApprove(me, projects) {
  return !!me && (me.isAdmin || projects.some((p) => p.pmPersonId === me.id));
}

export function createApprovals({ getData, sessionPersonId, onChange = () => {} }) {
  const body = document.getElementById("pendingBody");
  const scope = document.getElementById("approvalScope");
  const viewToggle = document.getElementById("approvalView");
  let showAll = false; // "All" projects instead of just the ones you manage
  let view = "pending"; // "pending", "approved" (not invoiced yet) or "internal"
  let openKey = null; // "<projectId>|<personId or taskId>"
  // Expenses are edited in the same popup used to record them.
  const expenseEditor = createExpenseEditor({
    getData: () => ({ people: getData().people, projects: getData().projects }),
    sessionPersonId,
    projectChoices: () => getData().projects,
    canPickPayer: () => true,
  });
  let editing = null; // { id, mode: "edit" | "decline" }

  const me = () => getData().people.find((p) => p.id === sessionPersonId);
  const isAdmin = () => !!me()?.isAdmin;
  const byTask = () => view === "internal";

  // Projects whose hours this view lists.
  function myProjectIds(v = view) {
    const { projects } = getData();
    const all = showAll && isAdmin();
    return new Set(projects
      .filter((p) => (v === "internal") === isInternal(p))
      .filter((p) => all || p.pmPersonId === sessionPersonId || (isAdmin() && !p.pmPersonId))
      .map((p) => p.id));
  }

  // Hours and expenses for a view, in date order. Expenses are tagged
  // isExpense and filed under the person who paid (or who added it).
  function itemsFor(v) {
    const ids = myProjectIds(v);
    const { timeEntries, expenses = [] } = getData();
    if (v === "internal") return timeEntries.filter((e) => ids.has(e.projectId)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const approved = v === "approved";
    const waiting = (e) => !!e.approved === approved && !e.invoiced && !e.declined && ids.has(e.projectId);
    const hours = timeEntries.filter(waiting);
    const exps = expenses.filter((e) => e.kind !== "sub" && waiting(e))
      .map((e) => ({ ...e, isExpense: true, hours: 0, personId: e.personId || e.createdByPersonId }));
    return [...hours, ...exps].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const pendingEntries = () => itemsFor(view);

  // What's waiting on you, for the collapsed Approvals header.
  function summary() {
    const items = itemsFor("pending");
    return {
      hours: sumHours(items),
      expenses: expenseSum(items),
      people: new Set(items.map((e) => e.personId)).size,
      count: items.length,
    };
  }

  const expenseSum = (items) => items.filter((e) => e.isExpense).reduce((t, e) => t + Number(e.amount || 0), 0);

  // When this person has logged more on the task than assigned (including
  // tasks they weren't assigned to at all), why, for the hover note; else "".
  // Declined hours don't count.
  function overNote(personId, taskId) {
    const { assignments, timeEntries } = getData();
    const assignment = assignments.find((a) => a.taskId === taskId && a.personId === personId);
    const assigned = assignment ? assignedHours(assignment) : 0;
    const logged = sumHours(timeEntries.filter((e) => e.taskId === taskId && e.personId === personId && !e.declined));
    if (logged - assigned <= 0.005) return "";
    return assignment
      ? `Over assigned hours: ${fmtHrs(logged)} hrs logged on this task, ${fmtHrs(assigned)} assigned`
      : `Not assigned to this task: ${fmtHrs(logged)} hrs logged on it`;
  }
  const isOver = (personId, taskId) => !!overNote(personId, taskId);

  // [{ project, hours, entries, rows: [{ key, name, hours, entries }] }]
  // Rows are people, or tasks in the Internal view.
  function groups() {
    const { projects, people, tasks } = getData();
    const rowOf = (e) => (byTask() ? e.taskId : e.personId);
    const byProject = new Map();
    pendingEntries().forEach((e) => {
      if (!byProject.has(e.projectId)) byProject.set(e.projectId, new Map());
      const rows = byProject.get(e.projectId);
      if (!rows.has(rowOf(e))) rows.set(rowOf(e), []);
      rows.get(rowOf(e)).push(e);
    });
    const order = sortProjects(projects).map((p) => p.id);
    return [...byProject].map(([projectId, byRow]) => {
      const rows = [...byRow].map(([id, entries]) => {
        const task = byTask() && tasks.find((t) => t.id === id);
        return {
          key: `${projectId}|${id}`,
          id,
          name: byTask() ? (task ? task.name : "—") : people.find((p) => p.id === id)?.name || "—",
          closed: !!(task && task.closed),
          hours: sumHours(entries),
          entries,
        };
      }).sort((x, y) => (x.closed - y.closed) || x.name.localeCompare(y.name));
      const entries = rows.flatMap((r) => r.entries);
      return { project: projects.find((p) => p.id === projectId), projectId, hours: sumHours(entries), entries, rows };
    }).sort((x, y) => order.indexOf(x.projectId) - order.indexOf(y.projectId));
  }

  function entryRowHtml(e) {
    const { tasks, projects, people } = getData();
    if (e.isExpense && !(editing && editing.id === e.id)) {
      return `<tr class="appr-entry">
        <td class="appr-date">${entryDate(e.date)}</td>
        <td class="appr-task appr-muted">Expense</td>
        <td class="num appr-muted">—</td>
        <td class="appr-entry-note"><strong>${formatCurrency(e.amount)}</strong> · ${esc(expenseLabel(e, projects.find((p) => p.id === e.projectId)))}</td>
        <td class="num appr-actions" colspan="2">${actionsHtml(e, "edit-expense")}</td></tr>`;
    }
    const mode = editing && editing.id === e.id ? editing.mode : null;
    const task = tasks.find((t) => t.id === e.taskId);
    // Second column: the task, or (grouped by task) the person.
    const who = byTask() ? people.find((p) => p.id === e.personId)?.name || "—" : task ? task.name : "—";
    const lead = `<td class="appr-date">${entryDate(e.date)}</td>`;
    if (mode === "edit") {
      // The task can be changed to any task on the same project.
      const choices = tasks.filter((t) => t.projectId === e.projectId && (!t.closed || t.id === e.taskId))
        .sort((a, b) => a.name.localeCompare(b.name));
      return `<tr class="appr-entry editing">${lead}
        <td><select class="appr-task-select" aria-label="Task">${choices.map((t) =>
          `<option value="${t.id}" ${t.id === e.taskId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></td>
        <td class="num"><input type="number" class="appr-hours" min="0" step="0.25" value="${Number(e.hours)}" /></td>
        <td><input type="text" class="appr-note-input" value="${esc(e.note || "")}" /></td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
          <button type="button" class="small" data-action="save-entry" data-id="${e.id}">Save</button>
        </td></tr>`;
    }
    if (mode === "decline") {
      return `<tr class="appr-entry editing">${lead}
        <td class="appr-task appr-muted">${esc(who)}</td>
        <td class="num">${fmtHrs(Number(e.hours))}</td>
        <td><input type="text" class="appr-reason" placeholder="Reason (optional)" /></td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
          <button type="button" class="small danger" data-action="confirm-decline" data-id="${e.id}">Decline</button>
        </td></tr>`;
    }
    const over = byTask() ? "" : overNote(e.personId, e.taskId);
    return `<tr class="appr-entry">${lead}
      <td class="appr-task appr-muted">${esc(who)}</td>
      <td class="num ${over ? "appr-over" : ""}" ${over ? `title="${esc(over)}"` : ""}>${fmtHrs(Number(e.hours))}</td>
      <td class="appr-entry-note ${e.note ? "" : "appr-muted"}">${e.note ? esc(e.note) : "No note"}</td>
      <td class="num appr-actions" colspan="2">${actionsHtml(e, "edit-entry")}</td></tr>`;
  }

  // An entry's actions: Edit (a plain link); "Don't bill", a dashed amber
  // chip that turns solid ("Not billed ×") once set, since it's the unusual
  // case; then Decline | Approve as one split button while waiting, or
  // Unapprove once approved. Internal hours just get Edit.
  function actionsHtml(e, editAction) {
    const id = `data-id="${e.id}"`;
    const edit = `<button type="button" class="link-btn appr-edit" data-action="${editAction}" ${id}>Edit</button>`;
    if (view === "internal") return `<div class="appr-btns">${edit}</div>`;
    const bill = e.isExpense ? ""
      : isBillable(e)
        ? `<button type="button" class="bill-chip" data-action="toggle-bill" ${id} title="Still paid, but not charged to the client">Don't bill</button>`
        : `<button type="button" class="bill-chip on" data-action="toggle-bill" ${id} title="Click to bill the client again">Not billed <span aria-hidden="true">&times;</span></button>`;
    const decide = view === "approved"
      ? `<button type="button" class="appr-unapprove" data-action="unapprove-entry" ${id}>Unapprove</button>`
      : `<span class="appr-split"><button type="button" class="split-decline" data-action="decline-entry" ${id}>Decline</button><button type="button" class="split-approve" data-action="approve-entry" ${id}>Approve</button></span>`;
    return `<div class="appr-btns">${edit}${bill}${decide}</div>`;
  }

  function render() {
    // Don't redraw under someone typing in an entry being edited.
    if (editing && body.contains(document.activeElement) && document.activeElement.matches("input, select")) return;
    scope.style.display = isAdmin() ? "" : "none";
    // "Internal" only for admins and managers of an internal project.
    const internalBtn = viewToggle.querySelector('[data-value="internal"]');
    internalBtn.hidden = !isAdmin() && !getData().projects.some((p) => isInternal(p) && p.pmPersonId === sessionPersonId);
    if (internalBtn.hidden && view === "internal") {
      view = "pending";
      viewToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === view));
    }
    onChange(summary());
    const gs = groups();
    if (gs.length === 0) {
      body.innerHTML = `<div class="empty">${{
        pending: "Nothing to approve.",
        approved: "No approved hours waiting to be invoiced.",
        internal: "No internal hours yet.",
      }[view]}</div>`;
      return;
    }

    body.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table">
      <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
      <thead><tr><th>Date</th><th>${byTask() ? "Task" : "Person"}</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
      ${gs.map((g) => `<tbody>
        <tr class="appr-group">
          <td colspan="4"><span class="pay-dot" style="--c:${g.project ? projectColor(g.project.id) : "#c9c2cf"};"></span><strong>${g.project ? esc(g.project.name) : "—"}</strong> <span class="appr-muted">${fmtHrs(g.hours)} hrs</span></td>
          <td class="num" colspan="2">${view === "pending"
            ? `<button type="button" class="small btn-approve-project" data-action="approve-project" data-id="${g.projectId}">Approve all (${g.entries.length})</button>` : ""}</td>
        </tr>
        ${g.rows.map((r) => {
          const open = openKey === r.key;
          const over = !byTask() && r.entries.some((e) => !e.isExpense && isOver(e.personId, e.taskId));
          const unbilled = sumHours(r.entries.filter((e) => !e.isExpense && !isBillable(e)));
          const people = byTask() ? new Set(r.entries.map((e) => e.personId)).size : 0;
          const detail = [
            `${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"}`,
            people > 1 ? `${people} people` : "",
            expenseSum(r.entries) ? `${formatCurrency(expenseSum(r.entries))} expenses` : "",
            unbilled ? `${fmtHrs(unbilled)} hrs not billed` : "",
          ].filter(Boolean).join(" · ");
          return `<tr class="appr-row ${open ? "open" : ""} ${r.closed ? "appr-closed" : ""}" data-key="${esc(r.key)}">
            <td class="appr-date">${dateRange(r.entries)}</td>
            <td class="appr-task">${esc(r.name)}${r.closed ? ' <span class="pill">Closed</span>' : ""}</td>
            <td class="num appr-subtotal ${over ? "appr-over" : ""}" ${over ? 'title="More than their assigned hours on a task (or none were assigned)"' : ""}>${fmtHrs(r.hours)}</td>
            <td class="appr-note appr-muted">${detail}</td>
            <td class="num">${view === "pending" ? `<button type="button" class="small due-btn due-complete" data-action="approve-person" data-key="${esc(r.key)}">${r.entries.length > 1 ? `Approve (${r.entries.length})` : "Approve"}</button>` : ""}</td>
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

  async function saveEntry(btn) {
    const row = btn.closest("tr");
    const entry = getData().timeEntries.find((x) => x.id === btn.dataset.id);
    if (!entry) return;
    const hours = Number(row.querySelector(".appr-hours").value);
    const note = row.querySelector(".appr-note-input").value.trim();
    const taskId = row.querySelector(".appr-task-select")?.value || entry.taskId;
    if (!(hours > 0) || hours > 24) return showToast("Enter hours between 0 and 24.");
    // One entry per person, task and day (the Timesheet relies on it).
    if (taskId !== entry.taskId && getData().timeEntries.some((x) =>
      x.id !== entry.id && x.personId === entry.personId && x.taskId === taskId && x.date === entry.date)) {
      return showToast("They already have hours on that task that day. Edit that entry instead.");
    }
    try {
      await TimeEntries.update(entry.id, { hours, note, taskId });
      editing = null;
      render();
      showToast(taskId !== entry.taskId ? "Moved." : "Entry updated.");
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
    if (action === "save-entry") return saveEntry(btn);
    if (action === "toggle-bill") {
      const entry = getData().timeEntries.find((x) => x.id === btn.dataset.id);
      if (!entry) return;
      try {
        await TimeEntries.update(entry.id, { billable: !isBillable(entry) });
        showToast(isBillable(entry) ? "Won't be billed. Still paid." : "Will be billed.");
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
      const r = gs.flatMap((g) => g.rows).find((x) => x.key === btn.dataset.key);
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

  return { render, summary };
}
