// Approvals (the Approvals tab, for project managers and admins): hours and
// expenses on the projects you manage — or, for admins, on projects with no
// project manager yet ("All Projects" shows every project). Three panels:
//   pending  — what's waiting (Decline, No charge, Approve)
//   approved — approved but not invoiced yet (Unapprove)
//   internal — hours on internal projects (e.g. Proposals & Pursuits), which
//              don't need approval, by task so each proposal's hours add up
// Each is grouped by project, then one row per person (per task when
// internal); opening a row lists its entries, grouped by task (by person when
// internal). Declined entries go back to the person's Timesheet (with the
// reason) and return once they edit them. Invoiced hours aren't shown — void
// the invoice to change them.
//
// "No charge" marks an entry as paid but not charged to the client (see
// isBillable in rates.js). Clicking an entry's hours or note changes it in
// place; "Change task" moves it to another task on the same project.
import { TimeEntries, Expenses } from "./db.js";
import { esc, fmtHrs, showToast, projectColor, sortProjects, formatCurrency, dateRange, entryDate } from "./util.js";
import { expenseLabel, createExpenseEditor } from "./expenses.js";
import { assignedHours, isInternal, isBillable, billRateOf } from "./rates.js";
import { notifyEntries, unnotify } from "./notifications.js";

const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

// Admins and anyone who manages a project see Approvals.
export function canApprove(me, projects) {
  return !!me && (me.isAdmin || projects.some((p) => p.pmPersonId === me.id));
}

const PANELS = {
  pending: { empty: "Nothing waiting for approval." },
  approved: { empty: "No approved hours waiting to be invoiced." },
  internal: { empty: "No internal hours yet." },
};

export function createApprovals({ getData, sessionPersonId }) {
  const panels = Object.fromEntries(Object.keys(PANELS).map((v) => [v, document.querySelector(`.appr-panel[data-view="${v}"]`)]));
  const scope = document.getElementById("approvalScope");
  let showAll = false; // "All Projects" instead of just the ones you manage
  // The panel being drawn or clicked in. Set before each render or click, so
  // the helpers below work on that panel.
  let view = "pending";
  const panelOpen = { pending: true, approved: true, internal: false };
  const openKeys = { pending: null, approved: null, internal: null }; // "<projectId>|<personId or taskId>"
  // Expenses are edited in the same popup used to record them.
  const expenseEditor = createExpenseEditor({
    getData: () => ({ people: getData().people, projects: getData().projects }),
    sessionPersonId,
    projectChoices: () => getData().projects,
    canPickPayer: () => true,
  });
  let editing = null; // { id, field: "task" | "hours" | "note" } or { id, mode: "decline" }

  const me = () => getData().people.find((p) => p.id === sessionPersonId);
  const isAdmin = () => !!me()?.isAdmin;
  const byTask = () => view === "internal";

  // Projects whose hours a panel lists.
  function myProjectIds(v = view) {
    const { projects } = getData();
    const all = showAll && isAdmin();
    return new Set(projects
      .filter((p) => (v === "internal") === isInternal(p))
      .filter((p) => all || p.pmPersonId === sessionPersonId || (isAdmin() && !p.pmPersonId))
      .map((p) => p.id));
  }

  // Hours and expenses for a panel, in date order. Expenses are tagged
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
  const panelItems = () => itemsFor(view);

  // What the client is billed: hours at the person's bill rate on the project
  // ("No charge" hours at $0), expenses at their amount. Internal hours aren't.
  const rateOf = (e) => billRateOf(e, getData());
  const billedOf = (e) => (e.isExpense ? Number(e.amount || 0) : Number(e.hours || 0) * rateOf(e));
  const billedSum = (items) => items.reduce((t, e) => t + billedOf(e), 0);
  const money = () => !byTask(); // Rate and Billed columns
  const cols = () => (money() ? 8 : 6);

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
  // Rows are people, or tasks in the Internal panel.
  function groups() {
    const { projects, people, tasks } = getData();
    const rowOf = (e) => (byTask() ? e.taskId : e.personId);
    const byProject = new Map();
    panelItems().forEach((e) => {
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
      }).sort((x, y) => (x.closed - y.closed) || x.name.localeCompare(y.name, undefined, { numeric: true }));
      const entries = rows.flatMap((r) => r.entries);
      return { project: projects.find((p) => p.id === projectId), projectId, hours: sumHours(entries), entries, rows };
    }).sort((x, y) => order.indexOf(x.projectId) - order.indexOf(y.projectId));
  }

  // An open row's entries, in sub-groups: by task (expenses last), or by
  // person in the Internal panel. [{ label, hours, entries }]
  function subGroups(entries) {
    const { tasks, people } = getData();
    const keyOf = (e) => (e.isExpense ? "~expenses" : byTask() ? e.personId : e.taskId);
    const map = new Map();
    entries.forEach((e) => {
      if (!map.has(keyOf(e))) map.set(keyOf(e), []);
      map.get(keyOf(e)).push(e);
    });
    return [...map].map(([key, list]) => ({
      key,
      label: key === "~expenses" ? "Expenses"
        : byTask() ? people.find((p) => p.id === key)?.name || "—" : tasks.find((t) => t.id === key)?.name || "—",
      hours: sumHours(list),
      entries: list,
    })).sort((a, b) => (a.key === "~expenses") - (b.key === "~expenses") || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  const rateCell = (rate) => (money() ? `<td class="num appr-rate-col">${rate == null ? "" : `${formatCurrency(rate)}/hr`}</td>` : "");
  const billedCell = (amount, extra = "") => (money() ? `<td class="num appr-billed">${formatCurrency(amount)}${extra}</td>` : "");

  function entryRowHtml(e, i) {
    const { tasks, projects } = getData();
    const stripe = i % 2 ? "stripe" : "";
    const lead = `<td class="appr-date">${entryDate(e.date)}</td>`;
    if (e.isExpense) {
      return `<tr class="appr-entry ${stripe}">${lead}<td></td>
        <td class="num appr-muted">—</td>${rateCell(null)}${billedCell(Number(e.amount || 0))}
        <td class="appr-entry-note">${esc(expenseLabel(e, projects.find((p) => p.id === e.projectId)))}</td>
        <td class="num appr-actions" colspan="2">${actionsHtml(e)}</td></tr>`;
    }
    const mode = editing && editing.id === e.id ? editing.mode : null;
    const field = editing && editing.id === e.id ? editing.field : null;
    if (mode === "decline") {
      return `<tr class="appr-entry editing ${stripe}">${lead}<td></td>
        <td class="num">${fmtHrs(Number(e.hours))}</td>${rateCell(rateOf(e))}${billedCell(billedOf(e))}
        <td><input type="text" class="appr-reason" placeholder="Reason (optional)" /></td>
        <td class="num appr-actions" colspan="2">
          <button type="button" class="small secondary" data-action="cancel-entry">Cancel</button>
          <button type="button" class="small danger" data-action="confirm-decline" data-id="${e.id}">Decline</button>
        </td></tr>`;
    }
    // Hours and note: click one to change it in place. It saves when you
    // press Enter or click away. "Change task" picks another task.
    const over = byTask() ? "" : overNote(e.personId, e.taskId);
    let moveCell = "<td></td>";
    if (!byTask()) {
      const choices = tasks.filter((t) => t.projectId === e.projectId && (!t.closed || t.id === e.taskId))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      moveCell = field === "task"
        ? `<td><select class="appr-inline" aria-label="Task">${choices.map((t) =>
            `<option value="${t.id}" ${t.id === e.taskId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></td>`
        : `<td>${choices.length > 1 ? '<button type="button" class="link-btn appr-move" data-edit-btn="task">Change task</button>' : ""}</td>`;
    }
    const hoursCell = field === "hours"
      ? `<td class="num"><input type="number" class="appr-inline appr-inline-hours" min="0" step="0.25" value="${Number(e.hours)}" aria-label="Hours" /></td>`
      : `<td class="num appr-editable ${over ? "appr-over" : ""}" data-edit="hours" title="${over ? esc(over) : "Change hours"}">${fmtHrs(Number(e.hours))}</td>`;
    const noteCell = field === "note"
      ? `<td><textarea class="appr-inline appr-inline-note" rows="1" placeholder="Note" aria-label="Note">${esc(e.note || "")}</textarea></td>`
      : `<td class="appr-entry-note appr-editable ${e.note ? "" : "appr-muted"}" data-edit="note" title="Change note">${e.note ? esc(e.note) : "No note"}</td>`;
    const billed = billedCell(billedOf(e), isBillable(e) ? "" : '<div class="appr-sub">No charge</div>');
    return `<tr class="appr-entry ${stripe} ${field ? "editing" : ""}" data-id="${e.id}">${lead}${moveCell}${hoursCell}${rateCell(isBillable(e) ? rateOf(e) : null)}${billed}${noteCell}
      <td class="num appr-actions" colspan="2">${actionsHtml(e)}</td></tr>`;
  }

  // An entry's actions. Waiting: Decline | No charge | Approve as one group
  // (No charge approves it but doesn't bill the client; they're still paid).
  // Approved: a "No charge" tag when it applies, and Unapprove. Expenses
  // have no No charge and keep Edit, which opens their own editor. Internal
  // hours have none.
  function actionsHtml(e) {
    const id = `data-id="${e.id}"`;
    const edit = e.isExpense ? `<button type="button" class="small secondary" data-action="edit-expense" ${id}>Edit</button>` : "";
    if (view === "internal") return `<div class="appr-btns">${edit}</div>`;
    if (view === "approved") {
      const tag = !e.isExpense && !isBillable(e) ? '<span class="nc-tag">No charge</span>' : "";
      return `<div class="appr-btns">${edit}${tag}<button type="button" class="appr-unapprove" data-action="unapprove-entry" ${id}>Unapprove</button></div>`;
    }
    const noCharge = e.isExpense ? ""
      : `<button type="button" class="split-nocharge ${isBillable(e) ? "" : "on"}" data-action="nocharge-entry" ${id} title="Approve, but don't bill the client (still paid)">No charge</button>`;
    return `<div class="appr-btns">${edit}<span class="appr-split"><button type="button" class="split-decline" data-action="decline-entry" ${id}>Decline</button>${noCharge}<button type="button" class="split-approve" data-action="approve-entry" ${id}>Approve</button></span></div>`;
  }

  // An open row: its entries under a line per task (or person).
  function openRowHtml(r) {
    return subGroups(r.entries).map((s) => `
      <tr class="appr-sub-head"><td colspan="${cols()}">${esc(s.label)}${s.key === "~expenses" ? "" : ` <span class="appr-muted">· ${fmtHrs(s.hours)} hrs</span>`}</td></tr>
      ${s.entries.map(entryRowHtml).join("")}`).join("");
  }

  function tableHtml() {
    const gs = groups();
    if (gs.length === 0) return `<div class="empty">${PANELS[view].empty}</div>`;
    const openKey = openKeys[view];
    return `<div class="pay-scroll"><table class="appr-table ${money() ? "" : "appr-no-money"}">
      <colgroup><col class="c-date" /><col class="c-who" /><col class="c-hours" />${money() ? '<col class="c-rate" /><col class="c-billed" />' : ""}<col /><col class="c-actions ${view}" /><col class="c-chev" /></colgroup>
      <thead><tr><th>Date</th><th>${byTask() ? "Task" : "Person"}</th><th class="num">Hours</th>${money() ? '<th class="num">Rate</th><th class="num">Billed</th>' : ""}<th>Notes</th><th></th><th></th></tr></thead>
      ${gs.map((g) => `<tbody>
        <tr class="appr-group">
          <td colspan="${cols() - 2}"><span class="pay-dot" style="--c:${g.project ? projectColor(g.project.id) : "#c9c2cf"};"></span>${g.project ? esc(g.project.name) : "—"}</td>
          <td class="num" colspan="2">${view === "pending"
            ? `<button type="button" class="small btn-approve-project" data-action="approve-project" data-id="${g.projectId}">Approve All (${g.entries.length})</button>` : ""}</td>
        </tr>
        ${g.rows.map((r, ri) => {
          const open = openKey === r.key;
          const over = !byTask() && r.entries.some((e) => !e.isExpense && isOver(e.personId, e.taskId));
          const unbilled = sumHours(r.entries.filter((e) => !e.isExpense && !isBillable(e)));
          const people = byTask() ? new Set(r.entries.map((e) => e.personId)).size : 0;
          const rates = [...new Set(r.entries.filter((e) => !e.isExpense && isBillable(e)).map(rateOf))];
          const detail = [
            `${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"}`,
            people > 1 ? `${people} people` : "",
            r.entries.some((e) => e.isExpense) ? `${formatCurrency(r.entries.filter((e) => e.isExpense).reduce((t, e) => t + Number(e.amount || 0), 0))} expenses` : "",
            unbilled ? `${fmtHrs(unbilled)} hrs no charge` : "",
          ].filter(Boolean).join(" · ");
          return `<tr class="appr-row ${ri % 2 ? "stripe" : ""} ${open ? "open" : ""} ${r.closed ? "appr-closed" : ""}" data-key="${esc(r.key)}">
            <td class="appr-date">${dateRange(r.entries)}</td>
            <td class="appr-who">${esc(r.name)}${r.closed ? ' <span class="pill">Closed</span>' : ""}</td>
            <td class="num ${over ? "appr-over" : ""}" ${over ? 'title="More than their assigned hours on a task (or none were assigned)"' : ""}>${fmtHrs(r.hours)}</td>
            ${money() ? `<td class="num appr-rate-col">${rates.length === 1 ? `${formatCurrency(rates[0])}/hr` : rates.length > 1 ? "Varies" : ""}</td>` : ""}
            ${billedCell(billedSum(r.entries))}
            <td class="appr-muted">${detail}</td>
            <td class="num">${view === "pending" ? `<button type="button" class="small btn-approve-project" data-action="approve-person" data-key="${esc(r.key)}">${r.entries.length > 1 ? `Approve (${r.entries.length})` : "Approve"}</button>` : ""}</td>
            <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
          </tr>
          ${open ? openRowHtml(r) : ""}`;
        }).join("")}
        <tr class="appr-total">
          <td colspan="2">Total</td>
          <td class="num">${fmtHrs(g.hours)}</td>
          ${money() ? `<td></td>${billedCell(billedSum(g.entries))}` : ""}
          <td colspan="3"></td>
        </tr>
      </tbody>`).join("")}
    </table></div>`;
  }

  // A panel's heading line: what's in it, e.g. "6 hrs · $870.00 · 2 people".
  function metaText() {
    const items = panelItems();
    if (!items.length) return "";
    const people = new Set(items.map((e) => e.personId)).size;
    return [
      `${fmtHrs(sumHours(items))} hrs`,
      money() ? formatCurrency(billedSum(items)) : "",
      `${people} ${people === 1 ? "person" : "people"}`,
    ].filter(Boolean).join(" · ");
  }

  function render() {
    // Don't redraw under someone typing in an entry being edited.
    if (editing && document.activeElement?.closest(".appr-panel") && document.activeElement.matches("input, select, textarea")) return;
    scope.hidden = !isAdmin();
    // Internal hours only for admins and managers of an internal project.
    panels.internal.hidden = !isAdmin() && !getData().projects.some((p) => isInternal(p) && p.pmPersonId === sessionPersonId);
    Object.entries(panels).forEach(([v, el]) => {
      if (el.hidden) return;
      view = v;
      el.classList.toggle("open", panelOpen[v]);
      el.querySelector(".appr-panel-toggle").setAttribute("aria-expanded", String(panelOpen[v]));
      el.querySelector(".appr-panel-meta").textContent = metaText();
      el.querySelector(".appr-panel-body").innerHTML = panelOpen[v] ? tableHtml() : "";
    });
  }

  // Approves a mix of hours and expenses.
  async function approveItems(items, message) {
    try {
      const hourIds = items.filter((e) => !e.isExpense).map((e) => e.id);
      const expenseIds = items.filter((e) => e.isExpense).map((e) => e.id);
      if (hourIds.length) await TimeEntries.approve(hourIds);
      if (expenseIds.length) await Expenses.approve(expenseIds);
      showToast(message);
      notifyEntries(items, { by: sessionPersonId, data: getData(), verb: "approved" });
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }

  // Click hours or a note (or Change task) to edit just that.
  function startEdit(panel, id, field) {
    editing = { id, field };
    render();
    const el = panel.querySelector(".appr-inline");
    if (!el) return;
    el.focus();
    if (el.tagName === "SELECT") {
      try { el.showPicker(); } catch (_) { /* not supported: it's focused */ }
    } else if (el.tagName === "TEXTAREA") {
      fitNote(el);
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      el.select();
    }
  }

  function fitNote(el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  // Saves the field being edited if it changed, with Undo.
  async function commitInline(el) {
    if (!editing || !editing.field) return;
    const { id, field } = editing;
    editing = null;
    const entry = getData().timeEntries.find((x) => x.id === id);
    let key = field;
    let value = el.value;
    let message;
    if (!entry) return render();
    if (field === "hours") {
      value = Number(value);
      if (value === Number(entry.hours)) return render();
      if (!(value > 0) || value > 24) {
        render();
        return showToast("Enter hours between 0 and 24.");
      }
      message = `Hours ${fmtHrs(Number(entry.hours))} → ${fmtHrs(value)}.`;
    } else if (field === "note") {
      value = value.trim();
      if (value === (entry.note || "")) return render();
      message = "Note saved.";
    } else {
      key = "taskId";
      if (value === entry.taskId) return render();
      // One entry per person, task and day (the Timesheet relies on it).
      if (getData().timeEntries.some((x) =>
        x.id !== entry.id && x.personId === entry.personId && x.taskId === value && x.date === entry.date)) {
        render();
        return showToast("They already have hours on that task that day. Edit that entry instead.");
      }
      message = `Moved to ${getData().tasks.find((t) => t.id === value)?.name || "that task"}.`;
    }
    const before = { [key]: key === "note" ? entry.note || "" : entry[key] };
    render();
    try {
      await TimeEntries.update(id, { [key]: value });
      const sent = notifyEntries([entry], {
        by: sessionPersonId, data: getData(), verb: "edited",
        what: field === "hours" ? "your hours" : field === "note" ? "your note" : `your ${fmtHrs(Number(entry.hours || 0))} hrs`,
        after: field === "hours" ? `: ${fmtHrs(Number(entry.hours))} → ${fmtHrs(value)}`
          : field === "note" ? "" : `: moved to ${getData().tasks.find((t) => t.id === value)?.name || "another task"}`,
      });
      showToast(message, {
        action: "Undo",
        onAction: () => {
          sent.then(unnotify);
          TimeEntries.update(id, before).catch((err) => showToast("Error: " + err.message));
        },
      });
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }

  async function onClick(e, panel) {
    view = panel.dataset.view;
    if (e.target.closest(".appr-panel-toggle")) {
      panelOpen[view] = !panelOpen[view];
      editing = null;
      render();
      return;
    }
    const btn = e.target.closest("button[data-action]");
    const cell = e.target.closest("td[data-edit], [data-edit-btn]");
    if (cell) {
      startEdit(panel, cell.closest("tr").dataset.id, cell.dataset.edit || cell.dataset.editBtn);
      return;
    }
    if (!btn) {
      const row = e.target.closest("tr.appr-row");
      if (row) {
        openKeys[view] = openKeys[view] === row.dataset.key ? null : row.dataset.key;
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
    if (action === "decline-entry") {
      editing = { id: btn.dataset.id, mode: "decline" };
      render();
      panel.querySelector(".appr-entry.editing input")?.focus();
      return;
    }
    if (action === "cancel-entry") {
      editing = null;
      render();
      return;
    }
    // Approve one entry, billed or not.
    if (action === "nocharge-entry" || (action === "approve-entry" && getData().timeEntries.some((x) => x.id === btn.dataset.id && !isBillable(x)))) {
      const billable = action === "approve-entry";
      try {
        await TimeEntries.update(btn.dataset.id, { approved: true, approvedDate: new Date().toISOString(), billable });
        showToast(billable ? "Approved." : "Approved, no charge to the client.");
        notifyEntries([getData().timeEntries.find((x) => x.id === btn.dataset.id)], { by: sessionPersonId, data: getData(), verb: "approved" });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "confirm-decline") {
      const reason = btn.closest("tr").querySelector(".appr-reason").value.trim();
      try {
        const item = panelItems().find((x) => x.id === btn.dataset.id);
        await (item && item.isExpense ? Expenses : TimeEntries).update(btn.dataset.id, { declined: true, declineReason: reason || null });
        editing = null;
        render();
        showToast("Declined — sent back to their Timesheet.");
        notifyEntries([item], { by: sessionPersonId, data: getData(), verb: "declined", after: reason ? `: “${reason}”` : "" });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "unapprove-entry") {
      const item = panelItems().find((x) => x.id === btn.dataset.id);
      if (!item) return;
      try {
        // Hours go back to billed, to be decided again.
        await (item.isExpense ? Expenses : TimeEntries).update(item.id,
          item.isExpense ? { approved: false, approvedDate: null } : { approved: false, approvedDate: null, billable: true });
        showToast("Moved back to Waiting for Approval.");
        notifyEntries([item], { by: sessionPersonId, data: getData(), verb: "moved", after: " back to pending" });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      return;
    }
    if (action === "approve-entry") {
      const item = panelItems().find((x) => x.id === btn.dataset.id);
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
  }

  Object.values(panels).forEach((panel) => {
    panel.addEventListener("click", (e) => onClick(e, panel));
    panel.addEventListener("keydown", (e) => {
      if (e.target.matches(".appr-inline")) {
        if (e.key === "Escape") { editing = null; render(); }
        // Enter saves (the note wraps onto more lines by itself).
        if (e.key === "Enter") {
          e.preventDefault();
          commitInline(e.target);
        }
        return;
      }
      if (!e.target.matches(".appr-entry input")) return;
      if (e.key === "Escape") { editing = null; render(); }
      if (e.key === "Enter") e.target.closest("tr").querySelector('[data-action="confirm-decline"]')?.click();
    });
    // Picking a task, or leaving hours / note, saves.
    panel.addEventListener("change", (e) => { if (e.target.matches("select.appr-inline")) commitInline(e.target); });
    panel.addEventListener("input", (e) => { if (e.target.matches("textarea.appr-inline")) fitNote(e.target); });
    panel.addEventListener("focusout", (e) => { if (e.target.matches(".appr-inline")) commitInline(e.target); });
  });

  scope.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    showAll = btn.dataset.value === "all";
    scope.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    Object.keys(openKeys).forEach((v) => { openKeys[v] = null; });
    render();
  });

  return { render };
}
