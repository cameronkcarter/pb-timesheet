import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, dueLabel, showToast,
  todayISO, toISODate, addDays, daysBetween, projectColor, hoursBarHtml, fmtHrs, closeOnBackdropClick, budgetBarHtml, dueItemHtml, sortProjects, esc,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createItemEditor, isSubtask, setItemCompleted, deleteItem } from "./subtasks.js";
import { billRateOf, assignedHours, isInternal, taskBudgetUse } from "./rates.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let navChecked = false;
let selectedProjectId = loadSelectedProject();
let expandedTaskId = null;
let openDotId = null;
let showCompleted = true; // completed subtasks show by default; can be hidden

const PX_PER_DAY = 4;
const LABEL_COL_WIDTH = 200;
const SELECTED_PROJECT_KEY = "pb_projects_selected";

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const projectDetail = document.getElementById("projectDetail");

const budgetSummary = document.getElementById("budgetSummary");
const budgetOverallBar = document.getElementById("budgetOverallBar");
const budgetTbody = document.querySelector("#budgetTable tbody");
const budgetEmpty = document.getElementById("budgetEmpty");
const budgetHint = document.getElementById("budgetHint");

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

wireLogout("logoutLink", "navBrandLink");

function loadSelectedProject() {
  try { return localStorage.getItem(SELECTED_PROJECT_KEY); } catch { return null; }
}

function saveSelectedProject(id) {
  try { localStorage.setItem(SELECTED_PROJECT_KEY, id); } catch { /* not critical */ }
}

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
  return `<div class="due-list">${items.map((d) => dueItemHtml(d, {
    canComplete: canComplete(d),
    canEdit: canManage(d),
    canDelete: canManage(d),
    who: withWho ? (d.personIds || []).map((pid) => people.find((p) => p.id === pid)?.name).filter(Boolean).join(", ") : "",
  })).join("")}</div>`;
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
}

// Admins see every project; everyone else sees the projects they're
// assigned to a task on.
function visibleProjects() {
  if (isAdmin()) return sortProjects(projects);
  const assignedProjectIds = new Set(
    assignments.filter((a) => a.personId === sessionPersonId).map((a) => a.projectId)
  );
  return sortProjects(projects.filter((p) => assignedProjectIds.has(p.id) || isInternal(p)));
}

function renderAll() {
  renderProjectCards();
  renderBudget();
  renderGantt();
}

// ---------- Project picker ----------
function renderProjectCards() {
  const visible = visibleProjects();
  if (visible.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    projectDetail.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";
  projectDetail.style.display = "block";

  if (!selectedProjectId || !visible.some((p) => p.id === selectedProjectId)) {
    selectedProjectId = visible[0].id;
  }

  projectCardsEl.innerHTML = visible.map((p) => `
    <div class="project-card project-card-colored ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}" style="--c:${projectColor(p.id)};">
      <div class="name">${esc(p.name)}</div>
      <div class="client">${p.client ? esc(p.client) : "&nbsp;"}</div>
    </div>
  `).join("");
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card || card.dataset.projectCard === selectedProjectId) return;
  selectedProjectId = card.dataset.projectCard;
  saveSelectedProject(selectedProjectId);
  expandedTaskId = null;
  userHasScrolledGantt = false;
  closeDotPopover();
  renderAll();
});

// ---------- Budget (read-only) ----------
// Budgets are spent at each person's bill rate (see rates.js).
function spentOnTask(taskId) {
  return timeEntries
    .filter((e) => e.taskId === taskId)
    .reduce((sum, e) => sum + Number(e.hours || 0) * billRateOf(e, { projects, people }), 0);
}

function selectedProjectTasks() {
  return tasks.filter((t) => t.projectId === selectedProjectId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loggedHours(entries) {
  return entries.reduce((s, e) => s + Number(e.hours || 0), 0);
}

// Billed projects show dollars (budget / spent / remaining). Internal projects
// have no budget, so they show hours logged instead.
function renderBudget() {
  if (!selectedProjectId) return;
  const project = projects.find((p) => p.id === selectedProjectId);
  const internal = isInternal(project);
  const projectTasks = selectedProjectTasks();
  const thead = document.querySelector("#budgetTable thead");

  if (internal) {
    const projectEntries = timeEntries.filter((e) => e.projectId === selectedProjectId);
    budgetSummary.innerHTML = `
      <span class="pill blue">Internal</span>
      <span><span class="summary-label">Logged</span> ${fmtHrs(loggedHours(projectEntries))} hrs</span>`;
    budgetOverallBar.innerHTML = "";
    thead.innerHTML = `<tr><th class="internal-task-col">Task</th><th colspan="4">Hours logged</th></tr>`;
  } else {
    const totalBudget = projectTasks.reduce((s, t) => s + Number(t.budget || 0), 0);
    const totalSpent = projectTasks.reduce((s, t) => s + spentOnTask(t.id), 0);
    const totalRemaining = totalBudget - totalSpent;
    budgetSummary.innerHTML = `
      <span><span class="summary-label">Budget</span> ${formatCurrency(totalBudget)}</span>
      <span><span class="summary-label">Spent</span> ${formatCurrency(totalSpent)}</span>
      <span><span class="summary-label">Remaining</span> <span ${totalRemaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(totalRemaining)}</span></span>`;
    const totalCommitted = projectTasks.reduce((s, t) => s + taskBudgetUse(t, { projects, people, assignments, timeEntries }).committed, 0);
    budgetOverallBar.innerHTML = budgetBarHtml(totalSpent, totalCommitted, totalBudget, true);
    thead.innerHTML = `<tr><th>Task</th><th>Budget</th><th>Spent</th><th style="width:160px;">Progress</th><th>Remaining</th></tr>`;
  }

  const general = projectItems({ taskId: null });
  generalItemsEl.innerHTML = general.length
    ? `<div class="summary-label" style="margin:16px 0 4px;">Project-wide subtasks</div>${itemsListHtml(general, true)}`
    : "";

  if (projectTasks.length === 0) {
    budgetTbody.innerHTML = "";
    budgetEmpty.style.display = "block";
    budgetHint.style.display = "none";
    return;
  }
  budgetEmpty.style.display = "none";
  budgetHint.style.display = "block";
  budgetHint.textContent = "Click a task to see who's on it.";

  budgetTbody.innerHTML = projectTasks.map((t, i) => {
    const expanded = t.id === expandedTaskId;
    let cells;
    if (internal) {
      const taskEntries = timeEntries.filter((e) => e.taskId === t.id);
      cells = `<td colspan="4">${fmtHrs(loggedHours(taskEntries))} hrs</td>`;
    } else {
      const budget = Number(t.budget || 0);
      const spent = spentOnTask(t.id);
      const remaining = budget - spent;
      const use = taskBudgetUse(t, { projects, people, assignments, timeEntries });
      cells = `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
        <td>${budgetBarHtml(use.spent, use.committed, budget)}</td>
        <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>`;
    }
    const open = dueDates.filter((d) => d.taskId === t.id && isSubtask(d) && !d.completed);
    const overdue = open.some((d) => d.dueDate < todayISO());
    const dueChip = open.length ? `<span class="due-chip ${overdue ? "overdue" : ""}" title="Open subtasks on this task">${open.length} due</span>` : "";
    const mainRow = `<tr class="task-row ${i % 2 === 1 ? "stripe" : ""} ${expanded ? "expanded" : ""}" data-task-row="${t.id}"><td><span class="task-chevron" aria-hidden="true">&#9656;</span> ${esc(t.name)}${dueChip}</td>${cells}</tr>`;
    if (!expanded) return mainRow;
    return mainRow + `<tr><td colspan="5" class="accordion-cell">${taskPeopleHtml(t)}</td></tr>`;
  }).join("");
}

// Who's on a task: each person's hours bar and their subtasks for it.
function taskPeopleHtml(task) {
  // Internal tasks have no assigned hours, just hours logged.
  const internal = isInternal(projects.find((p) => p.id === task.projectId));
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const taskItems = projectItems({ taskId: task.id });
  const personIds = [...new Set([
    ...(internal ? people.filter((x) => !x.inactive).map((x) => x.id) : []),
    ...taskAssignments.map((a) => a.personId),
    ...taskEntries.map((e) => e.personId),
    ...taskItems.flatMap((d) => d.personIds || []),
  ])];
  if (personIds.length === 0) {
    return `<div class="empty">No one is assigned to this task yet.</div>
      <button class="link-btn" data-action="quick-assign" data-task-id="${task.id}">+ Assign subtask</button>`;
  }

  const rows = personIds.map((pid) => {
    const person = people.find((p) => p.id === pid);
    const assignment = taskAssignments.find((a) => a.personId === pid);
    return {
      personId: pid,
      name: person ? person.name : "—",
      assigned: assignment ? assignedHours(assignment, { projects, people }) : 0,
      logged: loggedHours(taskEntries.filter((e) => e.personId === pid)),
      isAssigned: !!assignment,
      items: taskItems.filter((d) => (d.personIds || []).includes(pid)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const color = projectColor(task.projectId);
  return `<div class="hours-rows" style="margin-top:0;">${rows.map((r) => `<div class="hours-row hours-row-with-items">
      <div class="hours-row-name">
        ${esc(r.name)}
        <button class="link-btn assign-link" data-action="quick-assign" data-person-id="${r.personId}" data-task-id="${task.id}">+ Assign subtask</button>
      </div>
      <div>
        ${internal
          ? `<div class="hours-logged-only">${r.logged ? `${fmtHrs(r.logged)} hrs` : "—"}</div>`
          : r.isAssigned || r.logged ? hoursBarHtml(r.logged, r.assigned, color) : '<div class="empty" style="padding:0; font-size:12px;">No hours assigned</div>'}
        ${itemsListHtml(r.items)}
      </div>
    </div>`).join("")}</div>`;
}

budgetTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    await handleItemAction(btn);
    return;
  }
  const row = e.target.closest("tr.task-row");
  if (!row) return;
  const taskId = row.dataset.taskRow;
  expandedTaskId = expandedTaskId === taskId ? null : taskId;
  renderBudget();
});

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
  getData: () => ({ people, tasks, projects }),
  sessionPersonId,
  projectChoices: visibleProjects,
  canManage,
});

document.getElementById("openAddEvent").addEventListener("click", () =>
  itemEditor.open(null, { mode: "event", projectId: selectedProjectId }));
document.getElementById("openAddAssignment").addEventListener("click", () =>
  itemEditor.open(null, { mode: "subtask", projectId: selectedProjectId }));

const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  toggleCompletedBtn.textContent = showCompleted ? "Hide completed" : "Show completed";
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
