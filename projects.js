import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses } from "./db.js";
import {
  formatCurrency, formatDate, showToast,
  todayISO, toISODate, addDays, daysBetween, projectColor, fmtHrs, closeOnBackdropClick, budgetBarHtml, sortProjects, subtaskActionsHtml, esc, confirmDialog,
  projectShortName, hoursBarHtml, hoursScale,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createItemEditor, isSubtask, setItemCompleted, deleteItem } from "./subtasks.js";
import {
  billedAmount, assignedHours, assignmentRate, isInternal, taskBudgetUse,
} from "./rates.js";
import { createProjectEditor } from "./project-editor.js";
import { createExpenseEditor, expenseStatus, expenseQtyText, countsToward } from "./expenses.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let expenses = [];
let navChecked = false;
let othersOpen = false; // the "Other projects" list is open
// ?project=<id> (e.g. from a Message Board post) opens that project;
// otherwise the first (newest) is selected until you pick one.
let selectedProjectId = new URLSearchParams(location.search).get("project");
let projectPicked = !!selectedProjectId;
let expandedTaskId = null;
let showCompleted = false; // completed subtasks and past events are hidden unless shown

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const projectDetail = document.getElementById("projectDetail");

const projectHead = document.getElementById("projectHead");
const projectHeadName = document.getElementById("projectHeadName");
const projectHeadMeta = document.getElementById("projectHeadMeta");
const projectStats = document.getElementById("projectStats");
const otherProjectsEl = document.getElementById("otherProjects");
const budgetHeading = document.getElementById("budgetHeading");
const budgetEditTip = document.getElementById("budgetEditTip");
const budgetTbody = document.querySelector("#budgetTable tbody");
const budgetEmpty = document.getElementById("budgetEmpty");
const barLegend = document.getElementById("barLegend");
const editProjectBtn = document.getElementById("editProjectBtn");
const editTimelineBtn = document.getElementById("editTimelineBtn");

const ganttChart = document.getElementById("ganttChart");
const ganttEmpty = document.getElementById("ganttEmpty");
const schedList = document.getElementById("schedList");

const timelineModal = document.getElementById("timelineModal");
const timelineModalTitle = document.getElementById("timelineModalTitle");
const timelineModalRows = document.getElementById("timelineModalRows");

wireLogout("logoutLink");

function currentPerson() {
  return people.find((p) => p.id === sessionPersonId);
}

function isAdmin() {
  const me = currentPerson();
  return !!(me && me.isAdmin);
}

function canManage(dueDateRecord) {
  const me = currentPerson();
  if (!me) return false;
  return me.isAdmin || dueDateRecord.createdByPersonId === sessionPersonId;
}

// Assignees can complete their own subtasks; creators and admins can too, and edit.
function canComplete(d) {
  return canManage(d) || (d.personIds || []).includes(sessionPersonId);
}

// Subtasks and events on this project by date, so overdue ones come first.
// Completed subtasks and past events only with "Show completed", at the end.
function scheduleItems() {
  const today = todayISO();
  const done = (d) => (isSubtask(d) ? !!d.completed : d.dueDate < today);
  return dueDates
    .filter((d) => d.projectId === selectedProjectId && d.dueDate && (showCompleted || !done(d)))
    .sort((a, b) => (done(a) - done(b)) || (a.dueDate < b.dueDate ? -1 : 1));
}

// Under the timeline: one row per subtask or event (Due | Name | Task |
// People | Edit ✓ ×), each once however many people share it.
function renderSchedule() {
  if (!selectedProjectId) return;
  const items = scheduleItems();
  const today = todayISO();
  // "Nov 6", with the year when it isn't this year ("Jun 10 '27").
  const short = (iso) => {
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return iso.slice(0, 4) === today.slice(0, 4) ? label : `${label} ’${iso.slice(2, 4)}`;
  };
  toggleCompletedBtn.textContent = showCompleted ? "Hide completed" : "Show completed";
  if (!items.length) {
    schedList.innerHTML = `<div class="empty">${showCompleted ? "No subtasks or events yet." : "Nothing coming up."}</div>`;
    return;
  }
  schedList.innerHTML = `<div class="sched-row sched-head"><div>Due</div><div>Subtask</div><div>Task</div><div>People</div><div></div></div>
    ${items.map((d) => {
      const sub = isSubtask(d);
      const done = sub ? d.completed : d.dueDate < today;
      const task = tasks.find((t) => t.id === d.taskId);
      const who = (d.personIds || []).map((pid) => people.find((p) => p.id === pid)?.name).filter(Boolean).join(", ");
      return `<div class="sched-row sched-item ${sub ? "" : "sched-event"} ${done ? "done" : ""}" data-item-id="${d.id}" data-task-id="${d.taskId || ""}">
        <div class="sched-due ${!done && d.dueDate < today ? "overdue" : ""}">${short(d.dueDate)}</div>
        <div class="sched-name"><span>${esc(d.title)}</span></div>
        <div class="sched-task">${task ? esc(task.name) : sub ? "Whole project" : ""}</div>
        <div class="sched-who">${esc(who)}</div>
        <div class="tp-sub-actions">${subtaskActionsHtml(d, { canComplete: sub && canComplete(d), canManage: canManage(d) })}</div>
      </div>`;
    }).join("")}`;
}

// Point at rows in the list (a task's "2 due" chip, a dot on the chart).
function flashScheduleRows(selector) {
  const rows = [...schedList.querySelectorAll(selector)];
  if (!rows.length) return false;
  rows[0].scrollIntoView({ behavior: "smooth", block: "center" });
  rows.forEach((r) => { r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash"); });
  return true;
}

if (sessionPersonId) {
  People.listen((data) => {
    people = data;
    if (!navChecked) {
      navChecked = true;
      applyAdminNavVisibility(currentPerson());
      renderNavUserName(currentPerson());
    }
    renderAll();
  });
  Projects.listen((data) => { projects = data; renderAll(); });
  Tasks.listen((data) => { tasks = data; renderAll(); });
  Assignments.listen((data) => { assignments = data; renderAll(); });
  TimeEntries.listen((data) => { timeEntries = data; renderBudget(); });
  DueDates.listen((data) => { dueDates = data; renderBudget(); renderGantt(); renderSchedule(); });
  Invoices.listen((data) => { invoices = data; });
  Expenses.listen((data) => { expenses = data; renderBudget(); });
}

// Projects you're on: assigned to a task, or its project manager, plus
// internal ones (open to everyone). Everything else is under "Other projects".
function myProjects() {
  const assignedProjectIds = new Set(
    assignments.filter((a) => a.personId === sessionPersonId).map((a) => a.projectId)
  );
  return sortProjects(projects.filter((p) =>
    assignedProjectIds.has(p.id) || p.pmPersonId === sessionPersonId || isInternal(p)));
}

function renderAll() {
  renderProjectCards();
  renderBudget();
  renderGantt();
  renderSchedule();
}

// ---------- Project picker ----------
// One card: the open project (name, client, PM, a few numbers, Edit project),
// then your projects as chips, then "Other projects (N)", which opens a list
// of every other project's name. Picking one from that list shows it as a
// chip too while it's open.
function renderProjectCards() {
  document.getElementById("openAddProject").style.display = isAdmin() ? "" : "none";
  if (projects.length === 0) {
    projectCardsEl.innerHTML = "";
    otherProjectsEl.hidden = true;
    projectHead.hidden = true;
    projectCardsEmpty.style.display = "block";
    projectDetail.style.display = "none";
    return;
  }
  projectHead.hidden = false;
  projectCardsEmpty.style.display = "none";
  projectDetail.style.display = "block";

  const mine = myProjects();
  const mineIds = new Set(mine.map((p) => p.id));
  const others = projects.filter((p) => !mineIds.has(p.id)).sort((x, y) => x.name.localeCompare(y.name));
  if (!projectPicked || !projects.some((p) => p.id === selectedProjectId)) {
    selectedProjectId = (mine[0] || sortProjects(projects)[0]).id;
  }
  const selected = projects.find((p) => p.id === selectedProjectId);
  const chip = (p) => `<button type="button" class="project-chip ${p.id === selectedProjectId ? "on" : ""}" data-project-card="${p.id}"
    style="--c:${projectColor(p.id)};" title="${esc(p.name)}"><i aria-hidden="true"></i>${esc(projectShortName(p))}</button>`;
  projectCardsEl.innerHTML = [...mine, ...(mineIds.has(selectedProjectId) ? [] : [selected])].map(chip).join("")
    + (others.length ? `<button type="button" class="project-chip project-chip-more" data-action="other-projects" aria-expanded="${othersOpen}">
        Other projects (${others.length}) <span class="chev ${othersOpen ? "up" : ""}" aria-hidden="true">&#9662;</span></button>` : "");
  otherProjectsEl.hidden = !othersOpen || !others.length;
  otherProjectsEl.innerHTML = others.map((p) => `<button type="button" class="other-project ${p.id === selectedProjectId ? "on" : ""}"
    data-project-card="${p.id}" style="--c:${projectColor(p.id)};"><i aria-hidden="true"></i>${esc(p.name)}</button>`).join("");
}

function pickProject(id) {
  othersOpen = false;
  if (id === selectedProjectId) { renderProjectCards(); return; }
  selectedProjectId = id;
  projectPicked = true;
  finishEditing();
  expandedTaskId = null;
  addingTaskId = null;
  renderAll();
}

[projectCardsEl, otherProjectsEl].forEach((el) => el.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="other-projects"]')) {
    othersOpen = !othersOpen;
    renderProjectCards();
    return;
  }
  const btn = e.target.closest("[data-project-card]");
  if (btn) pickProject(btn.dataset.projectCard);
}));

// The open project's numbers: budget used, hours logged and hours waiting
// for approval (billable); hours and open tasks (internal).
function renderProjectStats(project) {
  const internal = isInternal(project);
  const entries = timeEntries.filter((e) => e.projectId === project.id);
  const hours = loggedHours(entries);
  const stat = (value, label) => `<div><b>${value}</b>${label}</div>`;
  if (internal) {
    const open = tasks.filter((t) => t.projectId === project.id && !t.closed).length;
    const peopleCount = new Set(entries.map((e) => e.personId)).size;
    projectStats.innerHTML = `<div class="project-stat-row">${stat(`${fmtHrs(hours)} hrs`, "logged")}${stat(open, open === 1 ? "open task" : "open tasks")}${stat(peopleCount, peopleCount === 1 ? "person" : "people")}</div>`;
    return;
  }
  const budget = tasks.filter((t) => t.projectId === project.id).reduce((s, t) => s + Number(t.budget || 0), 0);
  const spent = billedAmount(entries, ctx());
  const pct = budget > 0 ? Math.round((spent / budget) * 100) : null;
  const waitingHrs = loggedHours(entries.filter((e) => !e.approved && !e.declined && !e.invoiced));
  projectStats.innerHTML = `<div class="project-stat-row">
      ${pct != null ? stat(`<span class="${pct > 100 ? "hours-over" : ""}">${pct}%</span>`, "budget used") : ""}
      ${stat(`${fmtHrs(hours)} hrs`, "logged")}
      ${stat(`${fmtHrs(waitingHrs)} hrs`, "waiting approval")}
    </div>
    ${pct != null ? `<div class="project-stat-bar"><i style="width:${Math.min(100, pct)}%;"></i></div>` : ""}`;
}

// ---------- Budget ----------
// Budgets are spent at each person's bill rate (see rates.js). Bars show
// invoiced (dark), logged but not invoiced, and assigned but not logged yet.
const ctx = () => ({ projects, people });

function invoicedOnTask(taskId) {
  return billedAmount(timeEntries.filter((e) => e.taskId === taskId && e.invoiced), ctx());
}

// Closed tasks (internal projects, e.g. a finished proposal) sort last.
function selectedProjectTasks() {
  return tasks.filter((t) => t.projectId === selectedProjectId)
    .sort((a, b) => (!!a.closed - !!b.closed) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function loggedHours(entries) {
  return entries.reduce((s, e) => s + Number(e.hours || 0), 0);
}

// Last row: budget nobody has yet, or how far over it is.
function unassignedRowHtml(use) {
  if (use.budget <= 0) return "";
  const over = use.unassigned < -0.005;
  return `<div class="tp-row tp-unassigned">
      <div class="tp-name">Unassigned</div>
      <div class="${over ? "hours-over-strong" : "tp-open-amt"}">${over ? `Assigned hours are ${formatCurrency(-use.unassigned)} over budget` : `${formatCurrency(use.unassigned)} of the budget`}</div>
      <div></div><div></div>
    </div>`;
}

function renderBudget() {
  if (!selectedProjectId) return;
  // Don't wipe an hours box someone is in the middle of editing.
  if (budgetTbody.contains(document.activeElement) && document.activeElement.matches(".assignHours")) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;

  const project = projects.find((p) => p.id === selectedProjectId);
  if (!project) return;
  const internal = isInternal(project);
  const admin = isAdmin();
  const projectTasks = selectedProjectTasks();
  const thead = document.querySelector("#budgetTable thead");
  const cols = 5;

  const pm = people.find((x) => x.id === project.pmPersonId);
  // The selected project: name, then client / internal and its PM, with
  // Edit project (admins) beside them.
  projectHead.style.setProperty("--c", projectColor(project.id));
  renderProjectStats(project);
  projectHeadName.textContent = project.name;
  projectHeadMeta.textContent = [
    project.client || (internal ? "Internal" : ""),
    project.client && internal ? "Internal" : "",
    pm ? `PM: ${pm.name}` : "",
  ].filter(Boolean).join(" · ");
  budgetHeading.textContent = internal ? "Tasks" : "Tasks & Budget";
  budgetEditTip.hidden = internal || !canEditHours(project.id);
  editProjectBtn.style.display = admin ? "" : "none";
  barLegend.style.display = internal ? "none" : "";

  thead.innerHTML = internal
    ? `<tr><th class="internal-task-col">Task</th><th colspan="4">Hours logged</th></tr>`
    : `<tr><th>Task</th><th class="c-money">Budget</th><th class="c-money">Spent</th><th class="c-bar">Progress</th><th class="c-money">Remaining</th></tr>`;

  // No tasks yet: say so, but still show the expense rows below.
  budgetEmpty.style.display = projectTasks.length ? "none" : "block";

  const totals = { budget: 0, spent: 0, committed: 0, invoiced: 0, unassigned: 0 };
  const rows = projectTasks.map((t, i) => {
    const expanded = t.id === expandedTaskId;
    let cells;
    if (internal) {
      const taskEntries = timeEntries.filter((e) => e.taskId === t.id);
      cells = `<td colspan="4">${fmtHrs(loggedHours(taskEntries))} hrs</td>`;
    } else {
      const use = taskBudgetUse(t, { projects, people, assignments, timeEntries });
      const invoiced = invoicedOnTask(t.id);
      const remaining = use.budget - use.spent;
      totals.budget += use.budget;
      totals.spent += use.spent;
      totals.committed += use.committed;
      totals.invoiced += invoiced;
      totals.unassigned += use.unassigned;
      cells = `<td>${formatCurrency(use.budget)}</td><td>${formatCurrency(use.spent)}</td>
        <td class="progressCell">${budgetBarHtml(use.spent, use.committed, use.budget, false, invoiced)}</td>
        <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>`;
    }
    const open = dueDates.filter((d) => d.taskId === t.id && isSubtask(d) && !d.completed);
    const overdue = open.some((d) => d.dueDate < todayISO());
    const dueChip = open.length ? `<button type="button" class="due-chip ${overdue ? "overdue" : ""}" data-jump-task="${t.id}" title="Show this task's subtasks">${open.length} due</button>` : "";
    const closedPill = t.closed ? '<span class="pill">Closed</span>' : "";
    const mainRow = `<tr class="task-row ${i % 2 === 1 ? "stripe" : ""} ${expanded ? "expanded" : ""} ${t.closed ? "task-closed" : ""}" data-task-row="${t.id}"><td><div class="task-cell" title="${esc(t.name)}"><span class="task-chevron" aria-hidden="true">&#9656;</span><span class="task-name">${esc(t.name)}</span>${closedPill}${dueChip}</div></td>${cells}</tr>`;
    if (!expanded) return mainRow;
    return mainRow + `<tr class="task-detail" data-task-id="${t.id}"><td colspan="${cols}" class="accordion-cell">${internal ? internalTaskHtml(t) : taskHoursHtml(t)}</td></tr>`;
  }).join("");

  budgetTbody.innerHTML = rows + (internal ? "" : expenseRowsHtml(project, totals, cols));

  // Someone was just added: put the cursor in their hours box.
  if (focusPersonId) {
    const input = budgetTbody.querySelector(`.tp-row[data-person-id="${focusPersonId}"] .assignHours`);
    if (input) {
      focusPersonId = null;
      input.focus();
      input.select();
    }
  }
}

// ---------- Expenses in the Budget table ----------
// Under the tasks: Tasks subtotal, Project expenses, one row per
// subconsultant, Expenses subtotal and the grand Total. Expense rows open to
// list what was recorded, with "+ Expense" / "+ Sub invoice".
function moneyCells({ budget, spent, committed = spent, invoiced = 0 }, extra = "") {
  const remaining = budget - spent;
  return `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
    <td>${budgetBarHtml(spent, committed, budget, false, invoiced)}</td>
    <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>${extra}`;
}

function expenseRowsHtml(project, taskTotals, cols) {
  const list = expenses.filter((e) => e.projectId === project.id && countsToward(e));
  const sum = (arr) => arr.reduce((t, e) => t + Number(e.amount || 0), 0);

  const groups = [
    { key: "exp:project", name: "Project expenses", budget: Number(project.expenseBudget || 0), items: list.filter((e) => e.kind !== "sub") },
    ...(project.subconsultants || []).map((sub) => ({
      key: `exp:sub:${sub.id}`, name: sub.name, sub, budget: Number(sub.budget || 0),
      items: list.filter((e) => e.kind === "sub" && e.subId === sub.id),
    })),
  ];
  const exp = { budget: 0, spent: 0, invoiced: 0 };
  // Expense and sub rows: one warm tint, so they read as their own section.
  const groupRows = groups.map((g, i) => {
    const spent = sum(g.items);
    const invoiced = sum(g.items.filter((e) => e.invoiced));
    exp.budget += g.budget;
    exp.spent += spent;
    exp.invoiced += invoiced;
    const expanded = expandedTaskId === g.key;
    const row = `<tr class="task-row expense-row ${expanded ? "expanded" : ""}" data-task-row="${g.key}">
      <td><div class="task-cell" title="${esc(g.name)}"><span class="task-chevron" aria-hidden="true">&#9656;</span><span class="task-name">${g.sub ? `<span class="row-kind">Sub</span>` : ""}${esc(g.name)}</span></div></td>
      ${moneyCells({ budget: g.budget, spent, invoiced })}</tr>`;
    return expanded ? row + `<tr><td colspan="${cols}" class="accordion-cell">${expenseListHtml(g)}</td></tr>` : row;
  }).join("");

  return `<tr class="budget-subtotal-row"><td>Tasks subtotal</td>${moneyCells(taskTotals)}</tr>
    ${groupRows}
    <tr class="budget-subtotal-row"><td>Expenses subtotal</td>${moneyCells(exp)}</tr>
    <tr class="budget-total-row"><td>Total</td>${moneyCells({
      budget: taskTotals.budget + exp.budget,
      spent: taskTotals.spent + exp.spent,
      committed: taskTotals.committed + exp.spent,
      invoiced: taskTotals.invoiced + exp.invoiced,
    })}</tr>`;
}

function isPmOf(projectId) {
  const project = projects.find((p) => p.id === projectId);
  return !!project && project.pmPersonId === sessionPersonId;
}

function canEditExpense(e) {
  return isAdmin() || isPmOf(e.projectId) ||
    (e.personId === sessionPersonId && !e.approved && !e.invoiced);
}

function expenseListHtml(g) {
  const project = projects.find((p) => p.id === selectedProjectId);
  const items = [...g.items, ...expenses.filter((e) => e.declined && e.projectId === project.id &&
    (g.sub ? e.subId === g.sub.id : e.kind !== "sub"))]
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const canRecordSub = isAdmin() || isPmOf(project.id);
  const addBtn = g.sub
    ? (canRecordSub ? `<button class="link-btn" data-action="add-expense" data-kind="sub" data-sub-id="${g.sub.id}">+ Sub invoice</button>` : "")
    : `<button class="link-btn" data-action="add-expense" data-kind="project">+ Expense</button>`;
  if (!items.length) return `<div class="empty" style="padding:2px 0 6px;">Nothing recorded yet.</div>${addBtn}`;
  const shortDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // Laid out like subtasks: a header, then the rows in a tinted band. Project
  // expenses: Description | Type | Date | Paid by | Amount (quantity × rate
  // under it) | Status; the description gets the spare room.
  const kind = g.sub ? "tp-exp-sub" : "";
  return `<div class="tp-exp ${kind}">
    <div class="tp-exp-row tp-head"><div>Description</div>${g.sub ? "" : "<div>Type</div>"}<div>Date</div>${g.sub ? "" : "<div>Paid by</div>"}<div>Amount</div><div>Status</div><div></div></div>
    <div class="tp-subs">${items.map((e) => {
      const [status, cls] = expenseStatus(e);
      const payer = people.find((p) => p.id === e.personId);
      const canReimburse = isAdmin() && e.personId && e.approved && !e.reimbursed;
      const qty = g.sub ? "" : expenseQtyText(e);
      return `<div class="tp-exp-row tp-sub ${e.invoiced ? "done" : ""}">
        <div class="tp-sub-name"><span>${esc(e.description || "—")}</span>${e.declined && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : ""}</div>
        ${g.sub ? "" : `<div class="tp-exp-type">${esc(e.category || "—")}</div>`}
        <div class="tp-due">${shortDate(e.date)}</div>
        ${g.sub ? "" : `<div>${payer ? esc(payer.name) : "Company"}</div>`}
        <div class="tp-num"><strong>${formatCurrency(e.amount)}</strong>${qty ? `<div class="tp-exp-qty">${qty}</div>` : ""}</div>
        <div><span class="pay-status ${cls}">${status}</span></div>
        <div class="tp-sub-actions">
          ${canReimburse ? `<button class="link-btn" data-action="reimburse-expense" data-id="${e.id}">Mark reimbursed</button>` : ""}
          ${canEditExpense(e) && !e.invoiced ? `<button class="link-btn" data-action="edit-expense" data-id="${e.id}">Edit</button>` : ""}
        </div>
      </div>`;
    }).join("")}</div>
  </div>${addBtn}`;
}

const expenseEditor = createExpenseEditor({
  getData: () => ({ people, projects }),
  sessionPersonId,
  projectChoices: () => projects.filter((p) => p.id === selectedProjectId),
  canPickPayer: () => isAdmin() || isPmOf(selectedProjectId),
});

async function handleExpenseAction(btn) {
  const { action, id } = btn.dataset;
  if (action === "add-expense") {
    expenseEditor.open(null, { kind: btn.dataset.kind, projectId: selectedProjectId, subId: btn.dataset.subId });
  }
  if (action === "edit-expense") {
    const e = expenses.find((x) => x.id === id);
    if (e) expenseEditor.open(e);
  }
  if (action === "reimburse-expense") {
    const e = expenses.find((x) => x.id === id);
    const who = e && people.find((p) => p.id === e.personId)?.name;
    if (!e || !(await confirmDialog("", { title: `Mark ${formatCurrency(e.amount)} as reimbursed to ${who || "them"}?`, confirmText: "Mark reimbursed" }))) return;
    try {
      await Expenses.update(id, { reimbursed: true, reimbursedDate: new Date().toISOString() });
      showToast("Marked reimbursed.");
    } catch (err) { showToast("Error: " + err.message); }
  }
}

// Internal tasks (e.g. a proposal): who has logged hours on it, and a way to
// close it. Anyone can close one so it drops off the Timesheet's task list;
// its hours stay.
function internalTaskHtml(task) {
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const closeBar = `<div class="task-close-bar"><span class="appr-muted">${task.closed ? "Closed — hidden from the Timesheet." : "Done with this one?"}</span>
      <button class="link-btn" data-action="${task.closed ? "reopen-task" : "close-task"}" data-task-id="${task.id}">${task.closed ? "Reopen task" : "Close task"}</button></div>`;
  const rows = [...new Set(taskEntries.map((e) => e.personId))]
    .map((pid) => ({
      name: people.find((p) => p.id === pid)?.name || "—",
      logged: loggedHours(taskEntries.filter((e) => e.personId === pid)),
    })).sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) return `${closeBar}<div class="empty">No hours on this task yet.</div>`;
  return `${closeBar}<div class="tp-list tp-internal">
    <div class="tp-row tp-head"><div>Person</div><div>Logged</div></div>
    ${rows.map((r) => `<div class="tp-row tp-person"><div class="tp-name">${esc(r.name)}</div><div class="tp-num">${fmtHrs(r.logged)} hrs</div></div>`).join("")}
  </div>`;
}

// ---------- Assigned hours (admins and the project's PM) ----------
// Each person's hours box saves itself a moment after typing; "+ Person"
// adds people. The bars and Unassigned update as you type.
let addingTaskId = null;    // task whose "Add person" chips are showing
let focusPersonId = null;   // just added: focus their hours box once it appears
let justAdded = [];         // people added since "+ Person" was opened
let renderDeferred = false; // skip re-rendering while someone is editing hours
const saveTimers = {};      // assignmentId -> pending auto-save
const SAVE_DELAY_MS = 800;

// Admins and the project's PM set who's on a task and their hours.
function canEditHours(projectId) {
  return isAdmin() || isPmOf(projectId);
}

// One row per person on the task (or with hours on it): name, hours bar,
// assigned hours. Editors click the hours to change them (saves itself), and
// can add and remove people; then the budget nobody has yet.
function taskHoursHtml(task) {
  const canEdit = canEditHours(task.projectId);
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const rows = [...new Set([...taskAssignments.map((a) => a.personId), ...taskEntries.map((e) => e.personId)])]
    .map((pid) => {
      const a = taskAssignments.find((x) => x.personId === pid);
      return {
        personId: pid,
        name: people.find((p) => p.id === pid)?.name || "—",
        a,
        assigned: a ? assignedHours(a) : 0,
        logged: loggedHours(taskEntries.filter((e) => e.personId === pid)),
      };
    }).sort((x, y) => x.name.localeCompare(y.name));
  const scale = hoursScale(rows);
  const assignedCell = (r) => {
    if (!r.a) return `<span class="tp-dim">—</span>`;
    if (!canEdit) return `${fmtHrs(r.assigned)} <span class="tp-unit">hrs</span>`;
    return `<input type="number" class="assignHours" data-id="${r.a.id}" min="0" step="0.5" value="${Math.round(r.assigned * 100) / 100}" aria-label="Assigned hours for ${esc(r.name)}" title="Click to change" /><span class="tp-unit">hrs</span><span class="saved-tick"></span>`;
  };
  return `<div class="tp-list tp-hours">
    ${rows.length ? `<div class="tp-row tp-head"><div>Person</div><div>Hours</div><div class="tp-assigned">Assigned</div><div></div></div>` : ""}
    ${rows.map((r) => `<div class="tp-row tp-person" data-person-id="${r.personId}" ${r.a ? `data-assignment-id="${r.a.id}"` : ""} data-assigned="${r.assigned}" data-logged="${r.logged}">
      <div class="tp-name">${esc(r.name)}</div>
      <div class="tp-hours-cell">${hoursBarHtml(r.assigned, r.logged, scale)}</div>
      <div class="tp-assigned">${assignedCell(r)}</div>
      <div class="tp-x">${canEdit && r.a ? `<button class="icon-btn" data-action="remove-assignment" data-id="${r.a.id}" title="Remove from task" aria-label="Remove ${esc(r.name)}">&times;</button>` : ""}</div>
    </div>`).join("") || `<div class="empty" style="padding:4px 0;">No one is assigned to this task yet.</div>`}
    ${unassignedRowHtml(taskBudgetUse(task, { projects, people, assignments, timeEntries }))}
    ${canEdit ? addPersonHtml(task) : ""}
  </div>`;
}

function addPersonHtml(task) {
  const assignedIds = assignments.filter((a) => a.taskId === task.id).map((a) => a.personId);
  const available = people.filter((p) => !p.inactive && !assignedIds.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (available.length === 0) {
    // Everyone's on it: just Done, if they were being added.
    return addingTaskId === task.id ? `<div class="person-picker"><span class="appr-muted">Everyone's on this task.</span>
      <button type="button" class="link-btn" data-action="cancel-add">Done</button></div>` : "";
  }
  if (addingTaskId !== task.id) {
    return `<button class="link-btn" data-action="open-add" data-task-id="${task.id}">+ Person</button>`;
  }
  // Tap people to add them (0 hrs each); Done puts the cursor in the first
  // one's hours box.
  const project = projects.find((pr) => pr.id === task.projectId);
  const initials = (name) => String(name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return `<div class="person-picker">
    <div class="person-chips">${available.map((p) => `<button type="button" class="person-chip" data-action="add-assignment"
        data-person-id="${p.id}" data-task-id="${task.id}" data-project-id="${task.projectId}"
        title="Bills ${formatCurrency(assignmentRate(project, p))}/hr">
        <span class="person-chip-avatar">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>
      </button>`).join("")}</div>
    <button type="button" class="link-btn" data-action="cancel-add">Done</button>
  </div>`;
}

// Redraw a task's bars and Unassigned from the hours boxes as they're being
// edited (before the save lands).
function liveUpdateTask(detailRow) {
  if (!detailRow) return;
  const task = tasks.find((t) => t.id === detailRow.dataset.taskId);
  const override = {};
  const rows = [...detailRow.querySelectorAll(".tp-row.tp-person")].map((row) => {
    const input = row.querySelector(".assignHours");
    let assigned = Number(row.dataset.assigned || 0);
    if (input) {
      const value = Number(input.value);
      assigned = isNaN(value) || value < 0 ? 0 : value;
      override[row.dataset.assignmentId] = assigned;
    }
    return { row, assigned, logged: Number(row.dataset.logged || 0) };
  });
  const scale = hoursScale(rows);
  rows.forEach((r) => { r.row.querySelector(".tp-hours-cell").innerHTML = hoursBarHtml(r.assigned, r.logged, scale); });
  const use = taskBudgetUse(task, { projects, people, assignments, timeEntries }, override);
  const open = detailRow.querySelector(".tp-unassigned");
  if (open) open.outerHTML = unassignedRowHtml(use);
  const mainRow = budgetTbody.querySelector(`tr.task-row[data-task-row="${task.id}"]`);
  if (!mainRow) return;
  const progressCell = mainRow.querySelector(".progressCell");
  if (progressCell) progressCell.innerHTML = budgetBarHtml(use.spent, use.committed, use.budget, false, invoicedOnTask(task.id));
}

function scheduleSave(input) {
  clearTimeout(saveTimers[input.dataset.id]);
  saveTimers[input.dataset.id] = setTimeout(() => saveHours(input), SAVE_DELAY_MS);
}

async function saveHours(input) {
  clearTimeout(saveTimers[input.dataset.id]);
  delete saveTimers[input.dataset.id];
  const assignment = assignments.find((a) => a.id === input.dataset.id);
  if (!assignment) return;
  const hours = Number(input.value);
  if (input.value === "" || isNaN(hours) || hours < 0) return; // fixed on blur
  if (assignment.hours != null && Math.abs(Number(assignment.hours) - hours) < 0.001) return;
  try {
    await Assignments.update(assignment.id, { hours });
    const tick = input.parentElement.querySelector(".saved-tick");
    if (tick) {
      tick.textContent = "Saved";
      tick.classList.add("show");
      setTimeout(() => tick.classList.remove("show"), 1200);
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// Finish any hours edit in progress (saving it) before the table redraws.
function finishEditing() {
  const el = document.activeElement;
  if (budgetTbody.contains(el) && el.matches(".assignHours")) {
    if (saveTimers[el.dataset.id]) saveHours(el);
    el.blur();
  }
}

budgetTbody.addEventListener("input", (e) => {
  if (!e.target.classList.contains("assignHours")) return;
  liveUpdateTask(e.target.closest("tr.task-detail"));
  scheduleSave(e.target);
});

budgetTbody.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.classList.contains("assignHours")) e.target.blur();
});

budgetTbody.addEventListener("focusout", (e) => {
  if (e.target.classList.contains("assignHours")) {
    // Leaving the box saves right away; an invalid entry snaps back.
    const assignment = assignments.find((a) => a.id === e.target.dataset.id);
    const value = Number(e.target.value);
    if (assignment && (e.target.value === "" || isNaN(value) || value < 0)) {
      e.target.value = Math.round(assignedHours(assignment) * 100) / 100;
      liveUpdateTask(e.target.closest("tr.task-detail"));
    }
    if (saveTimers[e.target.dataset.id]) saveHours(e.target);
  }
  // Catch up on any re-render skipped while editing.
  setTimeout(() => { if (renderDeferred) renderBudget(); }, 0);
});

async function handleAssignAction(btn) {
  const { action, id } = btn.dataset;
  finishEditing();
  if (action === "open-add") {
    addingTaskId = btn.dataset.taskId;
    justAdded = [];
    renderBudget();
  }
  if (action === "cancel-add") {
    // Done: start on the first new person's hours.
    addingTaskId = null;
    focusPersonId = justAdded[0] || null;
    justAdded = [];
    renderBudget();
  }
  if (action === "remove-assignment") {
    const a = assignments.find((x) => x.id === id);
    const name = a ? people.find((p) => p.id === a.personId)?.name : null;
    if (!(await confirmDialog("", { title: `Remove ${name || "this person"} from this task?`, confirmText: "Remove", danger: true }))) return;
    try { await Assignments.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "add-assignment") {
    const { personId, taskId, projectId } = btn.dataset;
    if (assignments.some((x) => x.taskId === taskId && x.personId === personId)) return;
    // The chips stay open so several people can be added in a row.
    justAdded.push(personId);
    try {
      await Assignments.add({ projectId, taskId, personId, hours: 0 });
    } catch (err) {
      justAdded = justAdded.filter((x) => x !== personId);
      showToast("Error: " + err.message);
    }
  }
}

budgetTbody.addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-jump-task]");
  if (chip) {
    flashScheduleRows(`.sched-item[data-task-id="${chip.dataset.jumpTask}"]`);
    return;
  }
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    if (["open-add", "cancel-add", "remove-assignment", "add-assignment"].includes(btn.dataset.action)) {
      await handleAssignAction(btn);
    } else if (["add-expense", "edit-expense", "reimburse-expense"].includes(btn.dataset.action)) {
      await handleExpenseAction(btn);
    } else if (["close-task", "reopen-task"].includes(btn.dataset.action)) {
      const closed = btn.dataset.action === "close-task";
      try {
        await Tasks.update(btn.dataset.taskId, { closed });
        showToast(closed ? "Task closed. Its hours are kept." : "Task reopened.");
      } catch (err) {
        showToast("Error: " + err.message);
      }
    } else {
      await handleItemAction(btn);
    }
    return;
  }
  const row = e.target.closest("tr.task-row");
  if (!row) return;
  finishEditing();
  const taskId = row.dataset.taskRow;
  expandedTaskId = expandedTaskId === taskId ? null : taskId;
  addingTaskId = null;
  renderBudget();
});

// ---------- Admin tools: add/edit project ----------
const projectEditor = createProjectEditor({
  getData: () => ({ people, projects, tasks, assignments, dueDates, timeEntries, invoices, expenses }),
  onSaved: (projectId) => {
    if (projectId) {
      selectedProjectId = projectId;
      projectPicked = true;
    } else {
      projectPicked = false;
    }
    renderAll();
  },
});

document.getElementById("openAddProject").addEventListener("click", () => projectEditor.open(null));
editProjectBtn.addEventListener("click", () => projectEditor.open(projects.find((p) => p.id === selectedProjectId)));
editTimelineBtn.addEventListener("click", () => openTimelineModal(selectedProjectId));

// ---------- Timeline for the selected project ----------
// The whole project fitted to the card's width, no scrolling.
const GANTT_LABEL_W = { wide: 212, narrow: 116 }; // label column + gap, as in style.css

function monthStart(iso, add = 0) {
  const d = new Date(iso + "T00:00:00");
  return toISODate(new Date(d.getFullYear(), d.getMonth() + add, 1));
}

function renderGantt() {
  const project = projects.find((p) => p.id === selectedProjectId);
  editTimelineBtn.style.display = project && isAdmin() ? "" : "none";
  if (!project) {
    ganttChart.innerHTML = "";
    return;
  }

  // Same order as Tasks & Budget.
  const projectTasks = selectedProjectTasks();
  const scheduledTasks = projectTasks.filter((t) => t.startDate && t.endDate);
  const projectDueDates = dueDates.filter((d) => d.dueDate && d.projectId === project.id);

  if (scheduledTasks.length === 0 && projectDueDates.length === 0) {
    ganttChart.innerHTML = "";
    ganttEmpty.style.display = "block";
    ganttEmpty.innerHTML = isAdmin()
      ? `No task dates set for this project yet. <a href="#" data-edit-timeline="${project.id}">Set task dates</a>`
      : "No task dates set for this project yet.";
    return;
  }
  ganttEmpty.style.display = "none";

  const today = todayISO();
  const dates = [...scheduledTasks.flatMap((t) => [t.startDate, t.endDate]), ...projectDueDates.map((d) => d.dueDate), today].sort();
  const rangeStart = toISODate(addDays(dates[0] + "T00:00:00", -4));
  const rangeEnd = toISODate(addDays(dates[dates.length - 1] + "T00:00:00", 10));
  const width = ganttChart.clientWidth || 800;
  const trackW = width - (width < 520 ? GANTT_LABEL_W.narrow : GANTT_LABEL_W.wide);
  const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd));
  const pct = (iso) => (daysBetween(rangeStart, iso) / totalDays) * 100;

  // A line every month; labels every month, or every 2/3/6/12 when they'd
  // crowd. The first label and each January carry the year.
  const monthPx = (trackW * 30.4) / totalDays;
  const every = [1, 2, 3, 6, 12].find((n) => n * monthPx >= 56) || 12;
  const ticks = [];
  for (let m = monthStart(rangeStart, rangeStart.endsWith("-01") ? 0 : 1); m < rangeEnd; m = monthStart(m, 1)) {
    const d = new Date(m + "T00:00:00");
    let label = "";
    if (d.getMonth() % every === 0) {
      label = d.toLocaleDateString("en-US", { month: "short" });
      if (d.getMonth() === 0 || !ticks.some((t) => t.label)) label += " \u2019" + String(d.getFullYear()).slice(2);
    }
    ticks.push({ x: pct(m), label });
  }

  const dotHtml = (d) => {
    const sub = isSubtask(d);
    const hollow = sub ? d.completed : d.dueDate < today;
    return `<button type="button" class="gantt-dot ${sub ? "gantt-dot-assignment" : "gantt-dot-event"} ${hollow ? "gantt-dot-hollow" : ""}"
      style="left:${pct(d.dueDate)}%;" data-dot-id="${d.id}" title="${esc(d.title)} · ${formatDate(d.dueDate)}" aria-label="${esc(d.title)}"></button>`;
  };
  const barHtml = (t) => {
    if (!t.startDate || !t.endDate) return "";
    const left = pct(t.startDate);
    return `<div class="gantt-bar" style="left:${left}%; width:max(4px, ${pct(t.endDate) - left}%);"
      title="${esc(t.name)} · ${formatDate(t.startDate)} – ${formatDate(t.endDate)}"></div>`;
  };

  const row = (label, track, cls = "") => `<div class="gantt-row ${cls}"><div class="gantt-label-col">${label}</div><div class="gantt-track">${track}</div></div>`;
  const projectLabel = isAdmin()
    ? `<span class="gantt-project-clickable" data-edit-timeline="${project.id}" title="Edit task dates">Whole project</span>`
    : "Whole project";
  const projectDots = projectDueDates.filter((d) => !d.taskId).map(dotHtml).join("");

  ganttChart.innerHTML = `<div class="gantt-inner">
    <div class="gantt-grid">
      ${ticks.map((t) => `<div class="gantt-month-line" style="left:${t.x}%;"></div>`).join("")}
      <div class="gantt-today-line" style="left:${pct(today)}%;"><span>Today</span></div>
    </div>
    ${row("", ticks.map((t) => (t.label ? `<div class="gantt-tick" style="left:${t.x}%;">${t.label}</div>` : "")).join(""), "gantt-header-row")}
    ${projectDots ? row(projectLabel, projectDots, "gantt-project-row") : ""}
    ${projectTasks.map((t) => row(`<span title="${esc(t.name)}">${esc(t.name)}</span>`, barHtml(t) + projectDueDates.filter((d) => d.taskId === t.id).map(dotHtml).join(""))).join("")}
  </div>`;
}

window.addEventListener("resize", renderGantt);

ganttEmpty.addEventListener("click", (e) => {
  const link = e.target.closest("[data-edit-timeline]");
  if (!link) return;
  e.preventDefault();
  openTimelineModal(link.dataset.editTimeline);
});

// A dot points at its row in the list below (showing completed ones if
// it's one of those).
ganttChart.addEventListener("click", (e) => {
  const projectLabel = e.target.closest("[data-edit-timeline]");
  if (projectLabel) {
    openTimelineModal(projectLabel.dataset.editTimeline);
    return;
  }
  const dot = e.target.closest(".gantt-dot");
  if (!dot) return;
  const selector = `.sched-item[data-item-id="${dot.dataset.dotId}"]`;
  if (!flashScheduleRows(selector) && !showCompleted) {
    showCompleted = true;
    renderSchedule();
    flashScheduleRows(selector);
  }
});

// Hovering a row in the list lights up its dot.
schedList.addEventListener("mouseover", (e) => {
  const item = e.target.closest(".sched-item");
  ganttChart.querySelectorAll(".gantt-dot.hot").forEach((el) => el.classList.remove("hot"));
  if (item) ganttChart.querySelector(`.gantt-dot[data-dot-id="${item.dataset.itemId}"]`)?.classList.add("hot");
});
schedList.addEventListener("mouseleave", () => {
  ganttChart.querySelectorAll(".gantt-dot.hot").forEach((el) => el.classList.remove("hot"));
});

schedList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) await handleItemAction(btn);
});

async function handleItemAction(btn) {
  const { action, id } = btn.dataset;
  if (action === "quick-assign") {
    itemEditor.open(null, { mode: "subtask", projectId: selectedProjectId, personId: btn.dataset.personId || null, taskId: btn.dataset.taskId || null });
    return;
  }
  if (action === "complete-duedate") return setItemCompleted(id, true);
  if (action === "reopen-duedate") return setItemCompleted(id, false);
  await handleDueDateAction(action, id);
}

async function handleDueDateAction(action, id) {
  const d = dueDates.find((dd) => dd.id === id);
  if (!d || !canManage(d)) return;
  if (action === "edit-duedate") itemEditor.open(d);
  if (action === "delete-duedate") await deleteItem(d);
}

// ---------- Subtask / event editor (shared with the Dashboard) ----------
const itemEditor = createItemEditor({
  getData: () => ({ people, tasks, projects, assignments }),
  sessionPersonId,
  // Your projects, plus the open one if it is one of the others.
  projectChoices: () => {
    const mine = myProjects();
    const open = projects.find((p) => p.id === selectedProjectId);
    return open && !mine.includes(open) ? [...mine, open] : mine;
  },
  canManage,
});

document.getElementById("openAddEvent").addEventListener("click", () =>
  itemEditor.open(null, { mode: "event", projectId: selectedProjectId }));
document.getElementById("openAddSubtask").addEventListener("click", () =>
  itemEditor.open(null, { mode: "subtask", projectId: selectedProjectId }));

const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  renderSchedule();
});

// ---------- Timeline (task dates) edit modal ----------
// One row per task, in the same order as Tasks & Budget.
function openTimelineModal(projectId) {
  const project = projects.find((p) => p.id === projectId);
  const projectTasks = tasks.filter((t) => t.projectId === projectId)
    .sort((a, b) => (!!a.closed - !!b.closed) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  timelineModalTitle.textContent = project ? `Edit Timeline — ${project.name}` : "Edit Timeline";
  timelineModalRows.innerHTML = projectTasks.length ? `
    <div class="tl-table">
      <div class="tl-head"><span>Task</span><span>Start</span><span>End</span><span class="tl-len">Length</span></div>
      ${projectTasks.map((t) => `
        <div class="tl-row" data-task-id="${t.id}">
          <span class="tl-name" title="${esc(t.name)}">${esc(t.name)}</span>
          <input type="date" class="timelineStart" aria-label="Start" value="${t.startDate || ""}" />
          <input type="date" class="timelineEnd" aria-label="End" value="${t.endDate || ""}" />
          <span class="tl-len"></span>
        </div>`).join("")}
    </div>` : `<div class="empty">This project has no tasks yet.</div>`;
  timelineModalRows.querySelectorAll(".tl-row").forEach(updateTimelineRow);
  updateTimelineSave();

  timelineModal.style.display = "flex";
}

// Length in days or weeks; an end before its start turns the row red.
function updateTimelineRow(row) {
  const start = row.querySelector(".timelineStart").value;
  const end = row.querySelector(".timelineEnd").value;
  const days = start && end ? daysBetween(start, end) + 1 : null;
  row.classList.toggle("tl-bad", days !== null && days < 1);
  row.querySelector(".tl-len").textContent = days === null ? "" : days < 1 ? "End is before start"
    : days < 14 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.round(days / 7)} wk`;
}

function updateTimelineSave() {
  document.getElementById("modalSaveTimeline").disabled = !!timelineModalRows.querySelector(".tl-bad");
}

timelineModalRows.addEventListener("input", (e) => {
  const row = e.target.closest(".tl-row");
  if (!row) return;
  updateTimelineRow(row);
  updateTimelineSave();
});

function closeTimelineModal() {
  timelineModal.style.display = "none";
}

document.getElementById("modalCancelTimeline").addEventListener("click", closeTimelineModal);
closeOnBackdropClick(timelineModal, closeTimelineModal);

document.getElementById("modalSaveTimeline").addEventListener("click", async () => {
  const rows = [...timelineModalRows.querySelectorAll("[data-task-id]")];
  if (timelineModalRows.querySelector(".tl-bad")) return;
  try {
    for (const row of rows) {
      const taskId = row.dataset.taskId;
      const startDate = row.querySelector(".timelineStart").value || null;
      const endDate = row.querySelector(".timelineEnd").value || null;
      const task = tasks.find((t) => t.id === taskId);
      if (task && (task.startDate !== startDate || task.endDate !== endDate)) {
        await Tasks.update(taskId, { startDate, endDate });
      }
    }
    showToast("Timeline updated.");
    closeTimelineModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
