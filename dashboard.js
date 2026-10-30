import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses } from "./db.js";
import {
  formatCurrency, esc, fmtHrs,
  todayISO, toISODate, getWeekStart, addDays, projectColor, projectShortName, sortProjects, subtaskActionsHtml,
  hoursBarHtml, hoursScale,
} from "./util.js";
import { paidAmount, billedAmount, assignedHours, isInternal } from "./rates.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createItemEditor, setItemCompleted, deleteItem } from "./subtasks.js";
import { createExpenseEditor, expenseLabel, expenseStatus } from "./expenses.js";
import { createApprovals, canApprove } from "./approvals.js";
import { createMessageBoard } from "./board.js";

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let expenses = [];
let navChecked = false;
let payOpen = false;            // the pay stubs panel under the stat boxes
let showClientPaid = false;     // client-paid rows are hidden unless asked for
let showCompleted = false; // completed subtasks are hidden unless shown

const projectSummaryCards = document.getElementById("projectSummaryCards");
const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
const payToggle = document.getElementById("payToggle");
const payPanel = document.getElementById("payPanel");

wireLogout("logoutLink");

if (selectedPersonId) {
  People.listen((d) => {
    people = d;
    if (!navChecked) {
      navChecked = true;
      const me = people.find((p) => p.id === selectedPersonId);
      applyAdminNavVisibility(me);
      renderNavUserName(me);
    }
    render();
  });
  Projects.listen((d) => { projects = d; render(); });
  Tasks.listen((d) => { tasks = d; render(); });
  Assignments.listen((d) => { assignments = d; render(); });
  TimeEntries.listen((d) => { timeEntries = d; render(); });
  DueDates.listen((d) => { dueDates = d; render(); });
  Invoices.listen((d) => { invoices = d; render(); });
  Expenses.listen((d) => { expenses = d; render(); });
}

// ---------- Approvals ----------
// For project managers and admins: one line saying what's waiting, opening
// to the approvals list (see approvals.js). Starts closed so the Dashboard
// stays short; remembers if you leave it open.
const approvalsCard = document.getElementById("approvals");
const approvalToggle = document.getElementById("approvalToggle");
const approvalPanel = document.getElementById("approvalPanel");
const approvalSummary = document.getElementById("approvalSummary");
let approvalsOpen = location.hash === "#approvals";
try { if (localStorage.getItem("pb_approvals_open") === "1") approvalsOpen = true; } catch (_) { /* no storage */ }

const approvals = createApprovals({
  getData: () => ({ people, projects, tasks, assignments, timeEntries, expenses }),
  sessionPersonId: selectedPersonId,
  onChange: (s) => {
    approvalSummary.innerHTML = s.count
      ? `<span class="appr-dot"></span>${[
        s.hours ? `${fmtHrs(s.hours)} hrs` : "",
        s.expenses ? `${formatCurrency(s.expenses)} expenses` : "",
      ].filter(Boolean).join(" · ")} waiting from ${s.people} ${s.people === 1 ? "person" : "people"}`
      : "Nothing waiting";
  },
});

function renderApprovals() {
  const me = people.find((p) => p.id === selectedPersonId);
  approvalsCard.hidden = !canApprove(me, projects);
  if (approvalsCard.hidden) return;
  approvalToggle.setAttribute("aria-expanded", String(approvalsOpen));
  approvalsCard.classList.toggle("open", approvalsOpen);
  approvalPanel.hidden = !approvalsOpen;
  approvals.render();
}

approvalToggle.addEventListener("click", () => {
  approvalsOpen = !approvalsOpen;
  try { localStorage.setItem("pb_approvals_open", approvalsOpen ? "1" : "0"); } catch (_) { /* no storage */ }
  renderApprovals();
});

// ---------- Message Board ----------
// Posts to everyone or one person, under the hours and pay boxes (see board.js).
const board = selectedPersonId ? createMessageBoard({
  el: document.getElementById("messageBoard"),
  getData: () => ({ people, projects }),
  sessionPersonId: selectedPersonId,
}) : null;

function render() {
  board?.render();
  renderApprovals();
  const personId = selectedPersonId;
  const person = people.find((p) => p.id === personId);
  if (!person) return;

  const myEntries = timeEntries.filter((e) => e.personId === personId);
  const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

  // Hours logged per week (Sunday start) for the last 8 weeks; this week last.
  const WEEKS = 8;
  const weekStart = getWeekStart(todayISO());
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const start = addDays(weekStart, (i - (WEEKS - 1)) * 7);
    const days = Array.from({ length: 7 }, (_, j) => toISODate(addDays(start, j)));
    return { start: toISODate(start), hours: sumHours(myEntries.filter((e) => days.includes(e.date))) };
  });
  const maxWeek = Math.max(1, ...weeks.map((w) => w.hours));
  document.getElementById("statWeekHours").textContent = fmtHrs(weeks[WEEKS - 1].hours);
  document.getElementById("weekChart").innerHTML = weeks.map((w, i) => {
    const current = i === WEEKS - 1;
    const label = current ? "This wk" : new Date(w.start + "T00:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
    return `<div class="week-col ${current ? "current" : ""}" title="Week of ${shortDate(w.start)}: ${fmtHrs(w.hours)} hrs">
      <span class="week-val">${w.hours ? fmtHrs(w.hours) : ""}</span>
      <div class="week-bar" style="height:${Math.max(w.hours ? 4 : 2, (w.hours / maxWeek) * 100)}%;"></div>
      <span class="week-label">${label}</span>
    </div>`;
  }).join("");

  // Hours remaining across all your assigned tasks (billable projects).
  let assignedTotal = 0;
  let loggedTotal = 0;
  let remainingTotal = 0;
  assignments
    .filter((a) => a.personId === personId && !isInternal(projects.find((p) => p.id === a.projectId)))
    .forEach((a) => {
      const assigned = assignedHours(a);
      const logged = sumHours(myEntries.filter((e) => e.taskId === a.taskId && !e.declined));
      assignedTotal += assigned;
      loggedTotal += logged;
      remainingTotal += Math.max(0, assigned - logged);
    });
  document.getElementById("statRemaining").textContent = fmtHrs(remainingTotal);

  // Your pay that the client hasn't paid yet: not invoiced + invoiced.
  const payOf = (entries) => paidAmount(entries, { projects, people });
  const notInvoiced = payOf(myEntries.filter((e) => !e.invoiced && !e.declined));
  const invoicedUnpaid = payOf(myEntries.filter((e) => e.invoiced && !e.paid));
  document.getElementById("statOwed").textContent = formatCurrency(notInvoiced + invoicedUnpaid);
  document.getElementById("statNotInvoiced").textContent = formatCurrency(notInvoiced);
  document.getElementById("statInvoiced").textContent = formatCurrency(invoicedUnpaid);
  const owedBack = myExpenses().filter((e) => !e.declined && !e.reimbursed).reduce((t, e) => t + Number(e.amount || 0), 0);
  document.getElementById("statExpenses").textContent = formatCurrency(owedBack);
  document.getElementById("statOwed").textContent = formatCurrency(notInvoiced + invoicedUnpaid + owedBack);
  renderPay(myEntries);

  renderDeclined(myEntries);

  // Your subtasks; completed ones too when shown.
  const myItems = dueDates.filter((d) => (d.personIds || []).includes(personId)
    && (showCompleted || !d.completed));
  const myOpenExpenses = myExpenses().filter((e) => !e.invoiced);
  // Only what's relevant to you: billable projects you're assigned to, have
  // logged on, have subtasks or open expenses on; internal projects (e.g.
  // RFPs) only when you have subtasks there.
  const myProjectIds = [...new Set([
    ...assignments.filter((a) => a.personId === personId).map((a) => a.projectId),
    ...myEntries.map((e) => e.projectId),
    ...myItems.map((d) => d.projectId),
    ...myOpenExpenses.map((e) => e.projectId),
  ])].filter((id) => {
    const p = projects.find((x) => x.id === id);
    return p && (!isInternal(p) || myItems.some((d) => d.projectId === id));
  });
  // Same order as everywhere else: newest projects first.
  const order = sortProjects(projects).map((p) => p.id);
  myProjectIds.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  if (myProjectIds.length === 0) {
    projectSummaryCards.innerHTML = '<div class="card empty">No projects yet. Ask your PM to assign you to a task.</div>';
    return;
  }

  // Each card: your hours on the whole project as one bar (logged / left of
  // what you're assigned) with the project's budget used beside it, then a
  // row per task with your hours bar (one scale per card, like the Projects
  // tab) and the task's budget used; its subtasks underneath. Staff see
  // budgets as percentages only, never dollars.
  const byDue = (a, b) => (!!a.completed - !!b.completed) || (a.dueDate < b.dueDate ? -1 : 1);
  // Subtasks sit under their task: name with its due date after it, then
  // Edit / ✓ complete / × delete at the far right.
  const today = todayISO();
  const subtaskRow = (d) => {
    const overdue = !d.completed && d.dueDate < today;
    const due = d.completed ? `Done${d.completedDate ? " " + shortDate(String(d.completedDate)) : ""}` : shortDate(d.dueDate);
    return `<div class="pc-task pc-sub ${d.completed ? "done" : ""}">
      <div class="pc-sub-name"><span>${esc(d.title)} <span class="due-inline ${overdue ? "overdue" : ""}">· ${due}</span></span></div>
      <div class="pc-sub-actions">${subtaskActionsHtml(d, { canManage: canManage(d) })}</div>
    </div>`;
  };
  const itemsHtml = (items) => (items.length ? `<div class="pc-subs">${items.sort(byDue).map(subtaskRow).join("")}</div>` : "");
  const pctOf = (spent, budget) => (budget > 0 ? Math.round((spent / budget) * 100) : null);
  const budgetHtml = (pct) => (pct != null ? `<span class="pc-pct">${pct}%</span>` : "");

  projectSummaryCards.innerHTML = myProjectIds.map((projectId) => {
    const project = projects.find((p) => p.id === projectId);
    const internal = isInternal(project);
    const color = projectColor(project.id);
    const pm = people.find((x) => x.id === project.pmPersonId);
    const projectEntries = myEntries.filter((e) => e.projectId === projectId && !e.declined);
    const projectItems = myItems.filter((d) => d.projectId === projectId);
    const myAssignments = assignments.filter((a) => a.personId === personId && a.projectId === projectId);
    // Tasks you're assigned to, have logged on, or have a subtask on;
    // internal projects only list tasks with your subtasks.
    const taskIds = [...new Set([
      ...(internal ? [] : myAssignments.map((a) => a.taskId)),
      ...(internal ? [] : projectEntries.map((e) => e.taskId)),
      ...projectItems.filter((d) => d.taskId).map((d) => d.taskId),
    ])];
    const projectTasks = taskIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const loggedOn = (taskId) => sumHours(projectEntries.filter((e) => e.taskId === taskId));
    const assignedOn = (taskId) => {
      const a = myAssignments.find((x) => x.taskId === taskId);
      return a ? assignedHours(a, { projects, people }) : null;
    };
    const assignedTotal = myAssignments.reduce((s, a) => s + assignedHours(a, { projects, people }), 0);
    const loggedTotal = sumHours(projectEntries);
    const projectBudget = tasks.filter((t) => t.projectId === projectId).reduce((s, t) => s + Number(t.budget || 0), 0);
    const budgetPct = pctOf(billedAmount(timeEntries.filter((e) => e.projectId === projectId && !e.declined), { projects, people }), projectBudget);

    const summary = internal ? "" : `<div class="pc-summary">
      <div class="pc-summary-hours">${hoursBarHtml(assignedTotal, loggedTotal, Math.max(1, assignedTotal, loggedTotal))}</div>
      <div class="pc-summary-budget">${budgetPct != null ? `<b>${budgetPct}%</b> budget used` : ""}</div>
    </div>`;

    const rows = projectTasks.map((task) => ({ task, logged: loggedOn(task.id), assigned: assignedOn(task.id) || 0 }));
    const scale = hoursScale(rows);
    const taskRows = rows.map(({ task, logged, assigned }) => {
      const pct = internal ? null : pctOf(billedAmount(timeEntries.filter((e) => e.taskId === task.id && !e.declined), { projects, people }), Number(task.budget || 0));
      return `<div class="pc-task">
        <div class="pc-task-name" title="${esc(task.name)}">${esc(task.name)}</div>
        <div class="pc-hours">${internal ? `<span class="hb-label"><b>${fmtHrs(logged)} logged</b></span>` : hoursBarHtml(assigned, logged, scale)}</div>
        <div class="pc-budget">${budgetHtml(pct)}</div>
      </div>${itemsHtml(projectItems.filter((d) => d.taskId === task.id))}`;
    }).join("");
    const generalItems = projectItems.filter((d) => !d.taskId);

    return `<div class="card project-card-v2" style="--c:${color};">
      <div class="pc-head">
        <h2><span class="cal-swatch"></span>${esc(project.name)}</h2>
        <div class="pc-meta">${esc([project.client || (internal ? "Internal" : ""), pm ? `PM ${pm.name}` : ""].filter(Boolean).join(" · "))}</div>
      </div>
      ${summary}
      ${taskRows ? `<div class="pc-tasks">
        <div class="pc-task pc-task-head"><div>Task</div><div>Your hours</div><div class="pc-budget">${internal ? "" : "Budget used"}</div></div>
        ${taskRows}
      </div>` : ""}
      ${generalItems.length ? `<div class="pc-tasks pc-general"><div class="pc-task"><div class="pc-task-name">Other subtasks</div></div>${itemsHtml(generalItems)}</div>` : ""}
      ${cardFooterHtml(project)}
    </div>`;
  }).join("");
}

// ---------- Pay stubs ----------
// A compact list under the Pay box: one row per invoice your hours were on
// (newest first), with rows on top for each project's hours not invoiced yet —
// what will go on that project's next invoice. "Client paid" means the client
// paid Place Builders, not that your paycheck went out.
const shortDate = (iso) => new Date(iso.slice(0, 10) + "T00:00:00")
  .toLocaleDateString("en-US", { month: "short", day: "numeric" });

function renderPay(myEntries) {
  payToggle.setAttribute("aria-expanded", String(payOpen));
  document.getElementById("payBox").classList.toggle("open", payOpen);
  payPanel.hidden = !payOpen;
  if (!payOpen) return;

  const ctx = { projects, people };
  const projectOf = (id) => projects.find((p) => p.id === id);
  const billable = myEntries.filter((e) => !isInternal(projectOf(e.projectId)));
  const hoursOf = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

  // Your expenses go on the same invoices as your hours.
  const mine = myExpenses().filter((e) => !e.declined);

  // Not invoiced yet: one row per project.
  const open = billable.filter((e) => !e.invoiced && !e.declined);
  const openExp = mine.filter((e) => !e.invoiced);
  const upcoming = [...new Set([...open, ...openExp].map((e) => e.projectId))].map((pid) => ({
    date: "", number: "", projectId: pid,
    entries: open.filter((e) => e.projectId === pid),
    exps: openExp.filter((e) => e.projectId === pid),
    status: ["Not invoiced", "pending"],
  }));

  // Invoiced: one row per invoice.
  const byInvoice = new Map();
  const keyOf = (e) => e.invoiceId || `${e.projectId}|${(e.invoicedDate || "").slice(0, 10)}`;
  billable.filter((e) => e.invoiced).forEach((e) => {
    if (!byInvoice.has(keyOf(e))) byInvoice.set(keyOf(e), { entries: [], exps: [] });
    byInvoice.get(keyOf(e)).entries.push(e);
  });
  mine.filter((e) => e.invoiced).forEach((e) => {
    if (!byInvoice.has(keyOf(e))) byInvoice.set(keyOf(e), { entries: [], exps: [] });
    byInvoice.get(keyOf(e)).exps.push(e);
  });
  const invoiced = [...byInvoice].map(([k, { entries, exps }]) => {
    const first = entries[0] || exps[0];
    const inv = invoices.find((i) => i.id === k);
    const paid = (inv && inv.paid) || (entries.length > 0 && entries.every((e) => e.paid));
    const paidDate = (inv && inv.paidDate) || entries.find((e) => e.paidDate)?.paidDate;
    return {
      date: (inv && inv.date) || first.invoicedDate || "",
      number: (inv && inv.invoiceNumber) || "",
      projectId: first.projectId,
      projectName: inv && inv.projectName,
      entries,
      exps,
      paid,
      status: paid ? [paidDate ? `Client paid ${shortDate(paidDate)}` : "Client paid", "paid"] : ["Outstanding", "invoiced"],
    };
  }).sort((x, y) => (x.date < y.date ? 1 : -1));

  const paidCount = invoiced.filter((r) => r.paid).length;
  const rows = [...upcoming, ...invoiced.filter((r) => showClientPaid || !r.paid)];
  const head = `<div class="pay-card-head">
    <h2>Your invoices</h2>
    ${paidCount ? `<button type="button" class="link-btn" data-action="toggle-paid">${showClientPaid ? "Hide client-paid" : `Show client-paid (${paidCount})`}</button>` : ""}
    <button type="button" class="icon-btn" data-action="close-pay" aria-label="Close">&times;</button>
  </div>`;
  if (!rows.length) {
    payPanel.innerHTML = head + `<div class="pay-empty">${paidCount ? "All paid." : "No billable hours yet."}</div>`;
    return;
  }
  const expSum = (list) => list.reduce((t, e) => t + Number(e.amount || 0), 0);

  payPanel.innerHTML = head + `<div class="pay-scroll"><table class="pay-table">
    <thead><tr>
      <th class="col-num">Date</th><th class="col-num">Invoice #</th><th>Project</th>
      <th class="num">Hours</th><th class="num">Expenses</th><th class="num">Pay</th><th>Status</th>
    </tr></thead>
    <tbody>${rows.map((r) => {
      const project = projectOf(r.projectId);
      return `<tr>
        <td class="col-num ${r.date ? "" : "blank"}">${r.date ? shortDate(r.date) : "—"}</td>
        <td class="col-num ${r.number ? "" : "blank"}">${r.number ? esc(r.number) : "—"}</td>
        <td class="proj"><span class="pay-dot" style="--c:${project ? projectColor(project.id) : "#c9c2cf"};"></span>${esc(project ? project.name : r.projectName || "Project")}</td>
        <td class="num">${r.entries.length ? fmtHrs(hoursOf(r.entries)) : "—"}</td>
        <td class="num ${r.exps.length ? "" : "blank"}">${r.exps.length ? formatCurrency(expSum(r.exps)) : "—"}</td>
        <td class="num"><strong>${formatCurrency(paidAmount(r.entries, ctx) + expSum(r.exps))}</strong></td>
        <td><span class="pay-status ${r.status[1]}">${esc(r.status[0])}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function myExpenses() {
  return expenses.filter((e) => e.personId === selectedPersonId && e.kind !== "sub");
}

// Bottom of each card: "+ Subtask" and "+ Expense", then a summary of your
// expenses that opens the list. Invoiced ones count as completed, so they
// only show with "Show completed subtasks".
const openExpenseLists = new Set(); // project ids with the expense list open
function cardFooterHtml(project) {
  const internal = isInternal(project);
  const all = internal ? [] : myExpenses().filter((e) => e.projectId === project.id);
  const sum = (list) => list.reduce((t, e) => t + Number(e.amount || 0), 0);
  const open = all.filter((e) => !e.invoiced && !e.declined);
  const shown = all.filter((e) => showCompleted || !e.invoiced)
    .sort((a, b) => (!!a.invoiced - !!b.invoiced) || (a.date < b.date ? 1 : -1));
  const listOpen = openExpenseLists.has(project.id) && shown.length > 0;
  const summary = shown.length
    ? `<button type="button" class="link-btn pc-exp-toggle" data-action="toggle-expenses" data-project-id="${project.id}" aria-expanded="${listOpen}">${shown.length} expense${shown.length === 1 ? "" : "s"} · ${formatCurrency(sum(open))} not invoiced <span class="chev ${listOpen ? "up" : ""}" aria-hidden="true">&#9662;</span></button>`
    : "";
  const shortDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `<div class="pc-foot">
      <button type="button" class="link-btn" data-action="add-subtask" data-project-id="${project.id}">+ Subtask</button>
      ${internal ? "" : `<button type="button" class="link-btn" data-action="add-expense" data-project-id="${project.id}">+ Expense</button>`}
      ${summary}
    </div>
    ${listOpen ? `<div class="pc-subs pc-expenses">${shown.map((e) => {
      const [status, cls] = expenseStatus(e);
      return `<div class="pc-exp-row ${e.invoiced ? "done" : ""}">
        <div class="pc-sub-name" title="${esc(expenseLabel(e, project))}"><span>${esc(expenseLabel(e, project))}${e.declined && e.declineReason ? ` <span class="declined-note inline">${esc(e.declineReason)}</span>` : ""}</span></div>
        <span class="pc-exp-when">${shortDay(e.date)} &middot; ${formatCurrency(e.amount)}</span>
        <span class="pay-status ${cls}">${status}</span>
        <span class="pc-exp-edit">${!e.approved ? `<button type="button" class="link-btn" data-action="edit-expense" data-id="${e.id}">Edit</button>` : ""}</span>
      </div>`;
    }).join("")}</div>` : ""}`;
}

// Declined hours and expenses waiting on you to fix, with the PM's reason.
// Only shows when there's something; editing an entry resubmits it.
const declinedStrip = document.getElementById("declinedStrip");
function renderDeclined(myEntries) {
  const projName = (id) => { const p = projects.find((x) => x.id === id); return p ? projectShortName(p) : "—"; };
  const taskName = (id) => { const t = tasks.find((x) => x.id === id); return t ? t.name : ""; };
  const rows = [
    ...myEntries.filter((e) => e.declined && !e.approved && !e.invoiced).map((e) => ({
      date: e.date,
      what: `${fmtHrs(Number(e.hours))} hrs declined`,
      where: [projName(e.projectId), taskName(e.taskId)].filter(Boolean).join(" › "),
      reason: e.declineReason,
      action: `<a class="declined-fix" href="timesheet.html?day=${encodeURIComponent(e.date)}">Fix on timesheet</a>`,
    })),
    ...myExpenses().filter((e) => e.declined && !e.approved && !e.invoiced).map((e) => ({
      date: e.date,
      what: `${formatCurrency(e.amount)} expense declined`,
      where: projName(e.projectId),
      reason: e.declineReason,
      action: `<button type="button" class="declined-fix" data-action="edit-expense" data-id="${e.id}">Edit expense</button>`,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  declinedStrip.hidden = !rows.length;
  declinedStrip.innerHTML = rows.map((r) => `<div class="declined-row">
      <span class="declined-icon" aria-hidden="true">!</span>
      <div class="declined-body">
        <div><strong>${r.what}</strong> · ${esc(r.where)} · ${shortDate(r.date)}</div>
        ${r.reason ? `<div class="declined-reason">“${esc(r.reason)}”</div>` : ""}
      </div>
      ${r.action}
    </div>`).join("");
}

declinedStrip.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="edit-expense"]');
  const exp = btn && expenses.find((x) => x.id === btn.dataset.id);
  if (exp) expenseEditor.open(exp);
});

payToggle.addEventListener("click", () => {
  payOpen = !payOpen;
  render();
});

payPanel.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "toggle-paid") showClientPaid = !showClientPaid;
  if (btn.dataset.action === "close-pay") payOpen = false;
  render();
});

// The person who created a subtask, or an admin, can edit or delete it.
function canManage(d) {
  const me = people.find((p) => p.id === selectedPersonId);
  return !!me && (me.isAdmin || d.createdByPersonId === selectedPersonId);
}

const itemEditor = createItemEditor({
  getData: () => ({ people, tasks, projects, assignments }),
  sessionPersonId: selectedPersonId,
  // Projects you're on, plus internal ones (open to all); newest first.
  projectChoices: () => sortProjects(projects.filter((p) => isInternal(p) || (
    assignments.some((a) => a.projectId === p.id && a.personId === selectedPersonId)
    || dueDates.some((d) => d.projectId === p.id && (d.personIds || []).includes(selectedPersonId))))),
  canManage,
});

const expenseEditor = createExpenseEditor({
  getData: () => ({ people, projects }),
  sessionPersonId: selectedPersonId,
  // Billable projects you're on.
  projectChoices: () => sortProjects(projects.filter((p) => !isInternal(p) && (
    assignments.some((a) => a.projectId === p.id && a.personId === selectedPersonId)
    || p.pmPersonId === selectedPersonId))),
  canPickPayer: () => false,
});

projectSummaryCards.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "add-expense") {
    expenseEditor.open(null, { kind: "project", projectId: btn.dataset.projectId });
    return;
  }
  if (btn.dataset.action === "edit-expense") {
    const exp = expenses.find((x) => x.id === btn.dataset.id);
    if (exp) expenseEditor.open(exp);
    return;
  }
  if (btn.dataset.action === "toggle-expenses") {
    const pid = btn.dataset.projectId;
    if (openExpenseLists.has(pid)) openExpenseLists.delete(pid);
    else openExpenseLists.add(pid);
    render();
    return;
  }
  const { action, id } = btn.dataset;
  const d = dueDates.find((x) => x.id === id);
  if (action === "complete-duedate") setItemCompleted(id, true);
  if (action === "reopen-duedate") setItemCompleted(id, false);
  if (action === "edit-duedate" && d && canManage(d)) itemEditor.open(d);
  if (action === "delete-duedate" && d && canManage(d)) deleteItem(d);
  if (action === "add-subtask") {
    itemEditor.open(null, { mode: "subtask", projectId: btn.dataset.projectId, personId: selectedPersonId });
  }
});

toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  toggleCompletedBtn.textContent = showCompleted ? "Hide completed subtasks" : "Show completed subtasks";
  render();
});


