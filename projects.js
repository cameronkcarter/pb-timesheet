import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses } from "./db.js";
import {
  formatCurrency, formatDate, dueLabel, showToast,
  todayISO, toISODate, addDays, daysBetween, projectColor, fmtHrs, closeOnBackdropClick, budgetBarHtml, sortProjects, subtaskActionsHtml, esc, confirmDialog,
  projectShortName,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createItemEditor, isSubtask, setItemCompleted, deleteItem } from "./subtasks.js";
import {
  billRateOf, billedAmount, assignedHours, assignmentRate, isInternal, taskBudgetUse,
} from "./rates.js";
import { createProjectEditor } from "./project-editor.js";
import { createExpenseEditor, expenseLabel, expenseStatus, expenseQtyText, countsToward } from "./expenses.js";

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
let editMode = false;  // admins: edit assigned hours instead of seeing subtasks
let selectedProjectId = null;
let projectPicked = false; // until you pick one, the first (newest) project is selected
let expandedTaskId = null;
let openDotId = null;
let showCompleted = false; // completed subtasks are hidden unless shown

const PX_PER_DAY = 4;
const LABEL_COL_WIDTH = 200;

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const projectDetail = document.getElementById("projectDetail");

const projectHead = document.getElementById("projectHead");
const projectHeadName = document.getElementById("projectHeadName");
const projectHeadMeta = document.getElementById("projectHeadMeta");
const projectStats = document.getElementById("projectStats");
const otherProjectsEl = document.getElementById("otherProjects");
const budgetHeading = document.getElementById("budgetHeading");
const budgetTbody = document.querySelector("#budgetTable tbody");
const budgetEmpty = document.getElementById("budgetEmpty");
const barLegend = document.getElementById("barLegend");
const editAssignmentsBtn = document.getElementById("editAssignmentsBtn");
const editProjectBtn = document.getElementById("editProjectBtn");
const editTimelineBtn = document.getElementById("editTimelineBtn");

const ganttChart = document.getElementById("ganttChart");
const ganttEmpty = document.getElementById("ganttEmpty");
const ganttScroll = document.getElementById("ganttScroll");
let userHasScrolledGantt = false;
let isProgrammaticGanttScroll = false;
ganttScroll.addEventListener("scroll", () => {
  if (isProgrammaticGanttScroll) return;
  userHasScrolledGantt = true;
});
const generalItemsEl = document.getElementById("generalItems");

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

// Subtasks (dated to-dos with people) on this project, optionally for one
// task / one person, respecting "Show completed".
function projectItems({ taskId, personId } = {}) {
  return dueDates
    .filter((d) => d.projectId === selectedProjectId && isSubtask(d) && (showCompleted || !d.completed))
    .filter((d) => taskId === undefined || (d.taskId || null) === taskId)
    .filter((d) => !personId || (d.personIds || []).includes(personId))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
}

function itemsListHtml(items, withWho = false) {
  if (!items.length) return "";
  // Same look as the Dashboard: a band of rows under the person, each with
  // its name and due date, then Edit / ✓ / × at the right.
  const today = todayISO();
  const short = (iso) => new Date(String(iso).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `<div class="tp-subs">${items.map((d) => {
    const who = withWho ? (d.personIds || []).map((pid) => people.find((p) => p.id === pid)?.name).filter(Boolean).join(", ") : "";
    const overdue = !d.completed && d.dueDate < today;
    const due = d.completed ? `Done${d.completedDate ? " " + short(d.completedDate) : ""}` : short(d.dueDate);
    return `<div class="tp-row tp-sub ${d.completed ? "done" : ""}">
      <div class="tp-sub-name"><span>${esc(d.title)} <span class="due-inline ${overdue ? "overdue" : ""}">· ${due}</span>${who ? ` <span class="tp-sub-who">${esc(who)}</span>` : ""}</span></div>
      <div class="tp-sub-actions">${subtaskActionsHtml(d, { canComplete: canComplete(d), canManage: canManage(d) })}</div>
    </div>`;
  }).join("")}</div>`;
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
  TimeEntries.listen((data) => { timeEntries = data; renderBudget(); renderGantt(); });
  DueDates.listen((data) => { dueDates = data; renderBudget(); renderGantt(); });
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
  userHasScrolledGantt = false;
  closeDotPopover();
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

function spentOnTask(taskId) {
  return timeEntries
    .filter((e) => e.taskId === taskId)
    .reduce((sum, e) => sum + Number(e.hours || 0) * billRateOf(e, ctx()), 0);
}

function invoicedOnTask(taskId) {
  return billedAmount(timeEntries.filter((e) => e.taskId === taskId && e.invoiced), ctx());
}

// Closed tasks (internal projects, e.g. a finished proposal) sort last.
function selectedProjectTasks() {
  return tasks.filter((t) => t.projectId === selectedProjectId)
    .sort((a, b) => (!!a.closed - !!b.closed) || a.name.localeCompare(b.name));
}

function loggedHours(entries) {
  return entries.reduce((s, e) => s + Number(e.hours || 0), 0);
}

function loggedBy(taskId, personId) {
  return loggedHours(timeEntries.filter((e) => e.taskId === taskId && e.personId === personId));
}

// Each person's share of a task's budget, in dollars at their bill rate:
// what they've logged (spent) and their assigned hours not logged yet
// (outstanding). Bars are drawn against the budget, or against everything
// logged and assigned when that's more. hoursOverride ({ assignmentId: hours })
// follows unsaved edits. Internal tasks have no budget, so no bars.
function taskShares(task, hoursOverride = {}) {
  const project = projects.find((p) => p.id === task.projectId);
  if (isInternal(project)) return null;
  const entries = timeEntries.filter((e) => e.taskId === task.id);
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const byPerson = {};
  [...new Set([...taskAssignments.map((a) => a.personId), ...entries.map((e) => e.personId)])].forEach((pid) => {
    const person = people.find((p) => p.id === pid);
    const mine = entries.filter((e) => e.personId === pid);
    const a = taskAssignments.find((x) => x.personId === pid);
    const hours = a ? (a.id in hoursOverride ? hoursOverride[a.id] : assignedHours(a)) : 0;
    const logged = loggedHours(mine);
    const toGo = Math.max(0, hours - logged);
    byPerson[pid] = { logged, toGo, spent: billedAmount(mine, { projects, people }), outstanding: toGo * assignmentRate(project, person) };
  });
  const use = taskBudgetUse(task, { projects, people, assignments, timeEntries }, hoursOverride);
  return { ...use, byPerson, scale: Math.max(use.budget, use.committed) };
}

// One person's bar: solid for logged, lighter for assigned but not logged.
// Their share of the budget as a percent goes in the last column.
function shareCellHtml(shares, personId) {
  const p = shares && shares.byPerson[personId];
  if (!p || shares.scale <= 0) return "";
  const pct = (n) => `${(n / shares.scale) * 100}%`;
  return `<div class="tp-bar" title="${fmtHrs(p.logged)} hrs logged${p.toGo ? ` · ${fmtHrs(p.toGo)} hrs assigned, not logged yet` : ""}">
      <div class="tp-bar-logged" style="width:${pct(p.spent)};"></div><div class="tp-bar-togo" style="width:${pct(p.outstanding)};"></div>
    </div>`;
}

function sharePct(shares, personId) {
  const p = shares && shares.byPerson[personId];
  return p && shares.budget > 0 ? `${Math.round(((p.spent + p.outstanding) / shares.budget) * 100)}%` : "";
}

// Last row: budget nobody has yet, or how far over it is.
function unassignedRowHtml(shares) {
  if (!shares || shares.budget <= 0) return "";
  const over = shares.unassigned < -0.005;
  const cell = over
    ? `<span class="hours-over-strong">Over by ${formatCurrency(-shares.unassigned)}</span>`
    : `<div class="tp-bar"><div class="tp-bar-open" style="width:${(shares.unassigned / shares.scale) * 100}%;"></div></div>`;
  return `<div class="tp-row tp-unassigned">
      <div class="tp-name">Unassigned${over ? "" : ` <span class="tp-open-amt">${formatCurrency(shares.unassigned)}</span>`}</div><div></div><div></div><div></div>
      <div class="tp-share ${over ? "over" : ""}">${cell}</div>
      <div class="tp-tail"><span class="tp-pct">${over ? "" : `${Math.round((shares.unassigned / shares.budget) * 100)}%`}</span></div>
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
  if (internal) editMode = false;
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
  editProjectBtn.style.display = admin ? "" : "none";
  editAssignmentsBtn.style.display = admin && !internal ? "" : "none";
  editAssignmentsBtn.textContent = editMode ? "Done editing" : "Edit staff & hours";
  editAssignmentsBtn.classList.toggle("active-toggle", editMode);
  toggleCompletedBtn.style.display = editMode ? "none" : "";
  barLegend.style.display = internal ? "none" : "";

  thead.innerHTML = internal
    ? `<tr><th class="internal-task-col">Task</th><th colspan="4">Hours logged</th></tr>`
    : `<tr><th>Task</th><th class="c-money">Budget</th><th class="c-money">Spent</th><th class="c-bar">Progress</th><th class="c-money">Remaining</th></tr>`;

  const general = editMode ? [] : projectItems({ taskId: null });
  generalItemsEl.innerHTML = general.length
    ? `<div class="summary-label" style="margin:16px 0 4px;">Project-wide subtasks</div>${itemsListHtml(general, true)}`
    : "";

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
    const dueChip = open.length ? `<span class="due-chip ${overdue ? "overdue" : ""}" title="Open subtasks on this task">${open.length} due</span>` : "";
    const closedPill = t.closed ? '<span class="pill">Closed</span>' : "";
    const mainRow = `<tr class="task-row ${i % 2 === 1 ? "stripe" : ""} ${expanded ? "expanded" : ""} ${t.closed ? "task-closed" : ""}" data-task-row="${t.id}"><td><div class="task-cell" title="${esc(t.name)}"><span class="task-chevron" aria-hidden="true">&#9656;</span><span class="task-name">${esc(t.name)}</span>${closedPill}${dueChip}</div></td>${cells}</tr>`;
    if (!expanded) return mainRow;
    return mainRow + `<tr class="task-detail" data-task-id="${t.id}"><td colspan="${cols}" class="accordion-cell">${editMode ? assignEditorHtml(t) : taskPeopleHtml(t)}</td></tr>`;
  }).join("");

  budgetTbody.innerHTML = rows + (internal ? "" : expenseRowsHtml(project, totals, cols));
  alignShareBars();

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

// The people under an open task have their share-of-budget bars in the
// same place as the tasks' Progress bars above them: measure that column
// and size the last two grid columns to match.
const TP_GAP = 18;
function alignShareBars() {
  const ref = budgetTbody.querySelector("tr.task-row .progressCell .progress-bar");
  if (!ref) return;
  const bar = ref.getBoundingClientRect();
  budgetTbody.querySelectorAll(".tp-list").forEach((list) => {
    const box = list.getBoundingClientRect();
    const tail = box.right - bar.right - TP_GAP;
    if (bar.width <= 0 || tail < 30) return;
    list.style.setProperty("--share-w", `${bar.width}px`);
    list.style.setProperty("--tail-w", `${tail}px`);
  });
}
window.addEventListener("resize", alignShareBars);

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
  const groupRows = groups.map((g) => {
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
  // Laid out like subtasks: a header, then the rows in a tinted band.
  const kind = g.sub ? "tp-exp-sub" : "";
  return `<div class="tp-exp ${kind}">
    <div class="tp-exp-row tp-head"><div>Description</div><div>Date</div>${g.sub ? "" : "<div>Paid by</div><div>Quantity</div>"}<div>Amount</div><div>Status</div><div></div></div>
    <div class="tp-subs">${items.map((e) => {
      const [status, cls] = expenseStatus(e);
      const payer = people.find((p) => p.id === e.personId);
      const canReimburse = isAdmin() && e.personId && e.approved && !e.reimbursed;
      return `<div class="tp-exp-row tp-sub ${e.invoiced ? "done" : ""}">
        <div class="tp-sub-name"><span>${esc(g.sub ? e.description || "—" : expenseLabel(e, project))}</span>${e.declined && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : ""}</div>
        <div class="tp-due">${shortDate(e.date)}</div>
        ${g.sub ? "" : `<div>${payer ? esc(payer.name) : "Company"}</div><div class="tp-dim">${expenseQtyText(e) || "—"}</div>`}
        <div class="tp-num"><strong>${formatCurrency(e.amount)}</strong></div>
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

// Who's on a task: each person's hours bar and their subtasks for it.
function taskPeopleHtml(task) {
  // Internal tasks have no assigned hours, just hours logged.
  const internal = isInternal(projects.find((p) => p.id === task.projectId));
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const taskItems = projectItems({ taskId: task.id });
  // Anyone can close an internal task (e.g. a proposal that's been submitted)
  // so it drops off the Timesheet's task list; its hours stay.
  const closeBar = internal
    ? `<div class="task-close-bar"><span class="appr-muted">${task.closed ? "Closed — hidden from the Timesheet." : "Done with this one?"}</span>
        <button class="link-btn" data-action="${task.closed ? "reopen-task" : "close-task"}" data-task-id="${task.id}">${task.closed ? "Reopen task" : "Close task"}</button></div>`
    : "";
  const personIds = [...new Set([
    ...taskAssignments.map((a) => a.personId),
    ...taskEntries.map((e) => e.personId),
    ...taskItems.flatMap((d) => d.personIds || []),
  ])];
  if (personIds.length === 0) {
    return `${closeBar}<div class="empty">${internal ? "No hours or subtasks on this task yet." : "No one is assigned to this task yet."}</div>
      <button class="link-btn task-add-subtask" data-action="quick-assign" data-task-id="${task.id}">+ Subtask</button>`;
  }

  const rows = personIds.map((pid) => {
    const person = people.find((p) => p.id === pid);
    const assignment = taskAssignments.find((a) => a.personId === pid);
    return {
      personId: pid,
      name: person ? person.name : "—",
      assigned: assignment ? assignedHours(assignment) : 0,
      logged: loggedHours(taskEntries.filter((e) => e.personId === pid)),
      isAssigned: !!assignment,
      items: taskItems.filter((d) => (d.personIds || []).includes(pid)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Like the Dashboard: one row per person with plain numbers (Assigned,
  // Logged, Remaining — remaining stops at 0) and a bar for their share of
  // the task's budget, their subtasks in a band underneath; then a row for
  // the budget nobody has yet. Same columns as "Edit staff & hours" so switching modes
  // doesn't move anything. Internal tasks only have hours logged.
  const shares = taskShares(task);
  return `${closeBar}<div class="tp-list ${internal ? "tp-internal" : ""}" style="--c:${projectColor(task.projectId)};">
    ${tpHeadHtml(internal)}
    ${rows.map((r) => `<div class="tp-row tp-person">
      <div class="tp-name">${esc(r.name)}</div>
      <div class="tp-num ${r.isAssigned ? "" : "tp-dim"}">${internal ? "" : r.isAssigned ? fmtHrs(r.assigned) : "—"}</div>
      <div class="tp-num">${fmtHrs(r.logged)}</div>
      <div class="tp-num ${r.isAssigned ? "" : "tp-dim"}">${internal ? "" : r.isAssigned ? fmtHrs(Math.max(0, r.assigned - r.logged)) : "—"}</div>
      <div class="tp-share">${shareCellHtml(shares, r.personId)}</div>
      <div class="tp-tail"><span class="tp-pct">${sharePct(shares, r.personId)}</span></div>
    </div>${itemsListHtml(r.items)}`).join("")}
    ${unassignedRowHtml(shares)}
  </div>
  <button class="link-btn task-add-subtask" data-action="quick-assign" data-task-id="${task.id}">+ Subtask</button>`;
}

function tpHeadHtml(internal) {
  return `<div class="tp-row tp-head"><div>Person</div><div>${internal ? "" : "Assigned"}</div><div>Logged</div><div>${internal ? "" : "Remaining"}</div><div>${internal ? "" : "Share of budget"}</div><div></div></div>`;
}

// ---------- Edit assignments (admins) ----------
// Each person on the task gets an hours box (saves itself a moment after
// typing), their logged and remaining hours and a remove button; "+ Add person"
// adds someone. Unassigned updates as you type.
let addingTaskId = null;    // task whose "Add person" chips are showing
let focusPersonId = null;   // just added: focus their hours box once it appears
let renderDeferred = false; // skip re-rendering while someone is editing hours
const saveTimers = {};      // assignmentId -> pending auto-save
const SAVE_DELAY_MS = 800;

function assignRowHtml(a, shares) {
  const person = people.find((p) => p.id === a.personId);
  const project = projects.find((p) => p.id === a.projectId);
  const hours = assignedHours(a);
  const logged = loggedBy(a.taskId, a.personId);
  return `<div class="tp-row tp-person" data-assignment-id="${a.id}" data-person-id="${a.personId}" data-logged="${logged}">
    <div class="tp-name">${person ? esc(person.name) : "—"}<div class="tp-rate">${person ? `Bill ${formatCurrency(assignmentRate(project, person))}/hr` : ""}</div></div>
    <div class="tp-input"><input type="number" class="assignHours" data-id="${a.id}" min="0" step="0.5" value="${Math.round(hours * 100) / 100}" aria-label="Assigned hours" /><span class="saved-tick"></span></div>
    <div class="tp-num">${fmtHrs(logged)}</div>
    <div class="tp-num tp-remaining">${fmtHrs(Math.max(0, hours - logged))}</div>
    <div class="tp-share">${shareCellHtml(shares, a.personId)}</div>
    <div class="tp-tail"><span class="tp-pct">${sharePct(shares, a.personId)}</span><button class="icon-btn" data-action="remove-assignment" data-id="${a.id}" title="Remove from task" aria-label="Remove">&times;</button></div>
  </div>`;
}

function addPersonHtml(task) {
  const assignedIds = assignments.filter((a) => a.taskId === task.id).map((a) => a.personId);
  const available = people.filter((p) => !p.inactive && !assignedIds.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (available.length === 0) return "";
  if (addingTaskId !== task.id) {
    return `<button class="link-btn" data-action="open-add" data-task-id="${task.id}">+ Person</button>`;
  }
  // Tap someone to add them (0 hrs); their hours box is then ready to type in.
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

function assignEditorHtml(task) {
  const shares = taskShares(task);
  const rows = assignments.filter((a) => a.taskId === task.id)
    .sort((a, b) => (people.find((p) => p.id === a.personId)?.name || "").localeCompare(people.find((p) => p.id === b.personId)?.name || ""))
    .map((a) => assignRowHtml(a, shares)).join("");
  return `<div class="tp-list" style="--c:${projectColor(task.projectId)};">
    ${rows ? tpHeadHtml(false) + rows : '<div class="empty" style="padding:4px 0;">No one assigned yet.</div>'}
    ${unassignedRowHtml(shares)}
    ${addPersonHtml(task)}
  </div>`;
}

// Redraw a task's Remaining hours and budget bars from the hours boxes as
// they're being edited (before the save lands).
function liveUpdateTask(detailRow) {
  if (!detailRow) return;
  const task = tasks.find((t) => t.id === detailRow.dataset.taskId);
  const override = {};
  detailRow.querySelectorAll(".tp-row[data-assignment-id]").forEach((row) => {
    const value = Number(row.querySelector(".assignHours").value);
    const hours = isNaN(value) || value < 0 ? 0 : value;
    override[row.dataset.assignmentId] = hours;
    row.querySelector(".tp-remaining").textContent = fmtHrs(Math.max(0, hours - Number(row.dataset.logged || 0)));
  });
  const mainRow = budgetTbody.querySelector(`tr.task-row[data-task-row="${task.id}"]`);
  if (!mainRow) return;
  const use = taskBudgetUse(task, { projects, people, assignments, timeEntries }, override);
  const shares = taskShares(task, override);
  detailRow.querySelectorAll(".tp-row[data-person-id]").forEach((row) => {
    row.querySelector(".tp-share").innerHTML = shareCellHtml(shares, row.dataset.personId);
    row.querySelector(".tp-pct").textContent = sharePct(shares, row.dataset.personId);
  });
  const open = detailRow.querySelector(".tp-unassigned");
  if (open) open.outerHTML = unassignedRowHtml(shares);
  alignShareBars();
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
    renderBudget();
  }
  if (action === "cancel-add") {
    addingTaskId = null;
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
    addingTaskId = null;
    focusPersonId = personId;
    try {
      await Assignments.add({ projectId, taskId, personId, hours: 0 });
    } catch (err) {
      focusPersonId = null;
      showToast("Error: " + err.message);
    }
  }
}

budgetTbody.addEventListener("click", async (e) => {
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

// ---------- Admin tools: add/edit project, edit staff & hours ----------
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
editAssignmentsBtn.addEventListener("click", () => {
  finishEditing();
  editMode = !editMode;
  addingTaskId = null;
  renderBudget();
});
editTimelineBtn.addEventListener("click", () => openTimelineModal(selectedProjectId));

// ---------- Timeline (Gantt) for the selected project ----------
function closeDotPopover() {
  openDotId = null;
  document.querySelectorAll(".gantt-dot-popover").forEach((el) => el.remove());
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".gantt-dot") && !e.target.closest(".gantt-dot-popover")) {
    closeDotPopover();
  }
});

function renderGantt() {
  const project = projects.find((p) => p.id === selectedProjectId);
  editTimelineBtn.style.display = project && isAdmin() ? "" : "none";
  if (!project) {
    ganttChart.innerHTML = "";
    return;
  }

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
  const allStarts = scheduledTasks.map((t) => t.startDate);
  const allEnds = scheduledTasks.map((t) => t.endDate);
  const allDueDates = projectDueDates.map((d) => d.dueDate);
  const rangeStartRaw = [...allStarts, ...allDueDates, today].sort()[0];
  const rangeEndRaw = [...allEnds, ...allDueDates, today].sort().slice(-1)[0];
  const rangeStart = toISODate(addDays(rangeStartRaw + "T00:00:00", -4));
  const rangeEnd = toISODate(addDays(rangeEndRaw + "T00:00:00", 14));
  const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd));
  const timelineWidth = totalDays * PX_PER_DAY;

  function xFor(dateStr) {
    return daysBetween(rangeStart, dateStr) * PX_PER_DAY;
  }

  const ticks = [];
  let cursor = new Date(rangeStart + "T00:00:00");
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const endDateObj = new Date(rangeEnd + "T00:00:00");
  while (cursor <= endDateObj) {
    const iso = toISODate(cursor);
    ticks.push({ x: xFor(iso), label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  const todayX = xFor(today);
  const todayInRange = todayX >= 0 && todayX <= timelineWidth;

  function dotHtml(d) {
    const dx = xFor(d.dueDate);
    const assignment = isSubtask(d);
    const kind = assignment ? "gantt-dot-assignment" : "gantt-dot-event";
    const hollow = assignment ? d.completed : d.dueDate < today;
    return `<div class="gantt-dot ${kind} ${hollow ? "gantt-dot-hollow" : ""}" style="left:${dx}px;" data-dot-id="${d.id}" title="${esc(d.title)} — ${formatDate(d.dueDate)}"></div>`;
  }

  const rulerHtml = `<div class="gantt-ruler" style="width:${timelineWidth}px;">
    ${ticks.map((t) => `<div class="gantt-tick" style="left:${t.x}px;">${t.label}</div>`).join("")}
  </div>`;

  const projectRemaining = projectTasks.reduce((s, t) => s + (Number(t.budget || 0) - spentOnTask(t.id)), 0);
  const projectDotsHtml = projectDueDates.filter((d) => !d.taskId).map(dotHtml).join("");
  const canEditTimeline = isAdmin();

  const taskRowsHtml = projectTasks.map((t) => {
    const hasDates = t.startDate && t.endDate;
    const barHtml = hasDates
      ? `<div class="gantt-bar" style="left:${xFor(t.startDate)}px; width:${Math.max(4, xFor(t.endDate) - xFor(t.startDate))}px;"></div>`
      : "";
    const dotsHtml = projectDueDates.filter((d) => d.taskId === t.id).map(dotHtml).join("");
    const remaining = Number(t.budget || 0) - spentOnTask(t.id);
    return `<div class="gantt-row">
      <div class="gantt-label-col gantt-task-label">${esc(t.name)}</div>
      <div class="gantt-track" style="width:${timelineWidth}px;">${barHtml}${dotsHtml}</div>
      <div class="gantt-remaining-col">${isInternal(project) ? "" : formatCurrency(remaining)}</div>
    </div>`;
  }).join("");

  const projectRowHtml = `<div class="gantt-row gantt-project-row">
      <div class="gantt-label-col ${canEditTimeline ? "gantt-project-clickable" : ""}" ${canEditTimeline ? `data-edit-timeline="${project.id}" title="Click to edit task dates"` : ""}>${esc(project.name)}</div>
      <div class="gantt-track" style="width:${timelineWidth}px;">${projectDotsHtml}</div>
      <div class="gantt-remaining-col gantt-project-remaining">${isInternal(project) ? "Internal" : formatCurrency(projectRemaining)}</div>
    </div>
    ${taskRowsHtml}`;

  const monthLinesHtml = ticks.map((t) =>
    `<div class="gantt-month-line" style="left:${LABEL_COL_WIDTH + t.x}px;"></div>`
  ).join("");
  const todayLineHtml = todayInRange
    ? `<div class="gantt-today-line" style="left:${LABEL_COL_WIDTH + todayX}px;"></div>`
    : "";

  ganttChart.innerHTML = `<div class="gantt-inner">
    <div class="gantt-row gantt-header-row">
      <div class="gantt-label-col">Task</div>
      ${rulerHtml}
      <div class="gantt-remaining-col">Remaining</div>
    </div>
    ${projectRowHtml}
    ${monthLinesHtml}
    ${todayLineHtml}
  </div>`;

  if (!userHasScrolledGantt && todayInRange) {
    isProgrammaticGanttScroll = true;
    ganttScroll.scrollLeft = Math.max(0, todayX - 60);
    requestAnimationFrame(() => { isProgrammaticGanttScroll = false; });
  }
}

ganttEmpty.addEventListener("click", (e) => {
  const link = e.target.closest("[data-edit-timeline]");
  if (!link) return;
  e.preventDefault();
  openTimelineModal(link.dataset.editTimeline);
});

ganttChart.addEventListener("click", (e) => {
  const projectLabel = e.target.closest("[data-edit-timeline]");
  if (projectLabel) {
    openTimelineModal(projectLabel.dataset.editTimeline);
    return;
  }

  const dot = e.target.closest(".gantt-dot");
  if (!dot) return;
  e.stopPropagation();
  const id = dot.dataset.dotId;
  if (openDotId === id) {
    closeDotPopover();
    return;
  }
  closeDotPopover();
  openDotId = id;
  const d = dueDates.find((dd) => dd.id === id);
  if (!d) return;
  const names = (d.personIds || []).map((pid) => people.find((p) => p.id === pid)?.name).filter(Boolean);
  const task = tasks.find((t) => t.id === d.taskId);
  const manageable = canManage(d);
  const popover = document.createElement("div");
  popover.className = "gantt-dot-popover";
  popover.innerHTML = `
    <div class="gantt-dot-popover-title">${esc(d.title)}</div>
    ${task ? `<div>${esc(task.name)}</div>` : ""}
    <div>${formatDate(d.dueDate)} <span class="empty" style="padding:0;">(${dueLabel(d.dueDate)})</span></div>
    ${names.length > 0 ? `<div>Assigned: ${names.map(esc).join(", ")}</div>` : ""}
    ${manageable ? `<div class="gantt-dot-popover-actions">
      <button class="small secondary" data-action="edit-duedate" data-id="${d.id}">Edit</button>
    </div>` : ""}
  `;
  const rect = dot.getBoundingClientRect();
  popover.style.left = `${rect.left + window.scrollX}px`;
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  document.body.appendChild(popover);
});

document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest(".gantt-dot-popover button");
  if (!btn) return;
  e.stopPropagation();
  const { action, id } = btn.dataset;
  closeDotPopover();
  await handleDueDateAction(action, id);
});

generalItemsEl.addEventListener("click", async (e) => {
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

const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  toggleCompletedBtn.textContent = showCompleted ? "Hide completed subtasks" : "Show completed subtasks";
  renderBudget();
});

// ---------- Timeline (task dates) edit modal ----------
function openTimelineModal(projectId) {
  const project = projects.find((p) => p.id === projectId);
  const projectTasks = tasks.filter((t) => t.projectId === projectId).sort((a, b) => a.name.localeCompare(b.name));

  timelineModalTitle.textContent = project ? `Edit Timeline — ${project.name}` : "Edit Timeline";
  timelineModalRows.innerHTML = projectTasks.map((t) => `
    <div class="timeline-task-row" data-task-id="${t.id}">
      <div class="timeline-task-name">${esc(t.name)}</div>
      <div class="timeline-task-dates">
        <div>
          <label>Start</label>
          <input type="date" class="timelineStart" value="${t.startDate || ""}" />
        </div>
        <div>
          <label>End</label>
          <input type="date" class="timelineEnd" value="${t.endDate || ""}" />
        </div>
      </div>
    </div>
  `).join("") || `<div class="empty">This project has no tasks yet.</div>`;

  timelineModal.style.display = "flex";
}

function closeTimelineModal() {
  timelineModal.style.display = "none";
}

document.getElementById("modalCancelTimeline").addEventListener("click", closeTimelineModal);
closeOnBackdropClick(timelineModal, closeTimelineModal);

document.getElementById("modalSaveTimeline").addEventListener("click", async () => {
  const rows = [...timelineModalRows.querySelectorAll("[data-task-id]")];
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
