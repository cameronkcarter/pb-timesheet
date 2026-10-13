import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, dueLabel, showToast,
  todayISO, toISODate, addDays, daysBetween, projectColor, hoursBarHtml, fmtHrs, closeOnBackdropClick,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { billRateOf, assignedHours, isInternal } from "./rates.js";

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
let editingDueDateId = null;
let modalMode = "event"; // "event" | "assignment"
let openDotId = null;
let editingTimelineProjectId = null;
let showCompleted = false;

const PX_PER_DAY = 4;
const LABEL_COL_WIDTH = 200;
const SELECTED_PROJECT_KEY = "pb_projects_selected";

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const projectDetail = document.getElementById("projectDetail");

const budgetSummary = document.getElementById("budgetSummary");
const budgetOverallFill = document.getElementById("budgetOverallFill");
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
const assignmentsList = document.getElementById("assignmentsList");

const dueDateModal = document.getElementById("dueDateModal");
const dueDateModalTitle = document.getElementById("dueDateModalTitle");
const ddProject = document.getElementById("ddProject");
const ddTaskRow = document.getElementById("ddTaskRow");
const ddTask = document.getElementById("ddTask");
const ddTitle = document.getElementById("ddTitle");
const ddDate = document.getElementById("ddDate");
const ddPeopleField = document.getElementById("ddPeopleField");
const ddPeoplePills = document.getElementById("ddPeoplePills");
const modalDeleteDueDate = document.getElementById("modalDeleteDueDate");

const timelineModal = document.getElementById("timelineModal");
const timelineModalTitle = document.getElementById("timelineModalTitle");
const timelineModalRows = document.getElementById("timelineModalRows");

wireLogout("logoutLink", "navBrandLink");

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

function isAssignment(d) {
  return !!(d.personIds && d.personIds.length > 0);
}

function colorForPerson(personId) {
  if (!personId) return "#9aa0a6";
  let hash = 0;
  for (let i = 0; i < personId.length; i++) hash = personId.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 50%, 42%)`;
}

function initialsFor(person) {
  if (!person) return "?";
  return person.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
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
  DueDates.listen((data) => { dueDates = data; renderGantt(); renderAssignments(); });
}

// Admins see every project; everyone else sees the projects they're
// assigned to a task on.
function visibleProjects() {
  if (isAdmin()) return projects;
  const assignedProjectIds = new Set(
    assignments.filter((a) => a.personId === sessionPersonId).map((a) => a.projectId)
  );
  return projects.filter((p) => assignedProjectIds.has(p.id));
}

function renderAll() {
  renderProjectCards();
  renderBudget();
  renderGantt();
  renderAssignments();
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
// Budgets are spent at the project's bill rate (see rates.js).
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

function assignedOnTask(taskId) {
  return assignments
    .filter((a) => a.taskId === taskId)
    .reduce((s, a) => s + assignedHours(a, { projects, people }), 0);
}

// Billed projects show dollars (budget / spent / remaining). Internal projects
// have no budget, so they show hours (assigned / logged) instead.
function renderBudget() {
  if (!selectedProjectId) return;
  const project = projects.find((p) => p.id === selectedProjectId);
  const internal = isInternal(project);
  const projectTasks = selectedProjectTasks();
  const thead = document.querySelector("#budgetTable thead");

  if (internal) {
    const assigned = projectTasks.reduce((s, t) => s + assignedOnTask(t.id), 0);
    const logged = loggedHours(timeEntries.filter((e) => e.projectId === selectedProjectId));
    budgetSummary.innerHTML = `
      <span class="pill blue">Internal &middot; not billed</span>
      <span><span class="summary-label">Assigned</span> ${fmtHrs(assigned)} hrs</span>
      <span><span class="summary-label">Logged</span> ${fmtHrs(logged)} hrs</span>`;
    budgetOverallFill.style.width = `${assigned > 0 ? Math.min(100, (logged / assigned) * 100) : 0}%`;
    budgetOverallFill.classList.remove("over");
    thead.innerHTML = `<tr><th>Task</th><th>Assigned</th><th>Logged</th><th style="width:160px;">Progress</th><th></th></tr>`;
  } else {
    const totalBudget = projectTasks.reduce((s, t) => s + Number(t.budget || 0), 0);
    const totalSpent = projectTasks.reduce((s, t) => s + spentOnTask(t.id), 0);
    const totalRemaining = totalBudget - totalSpent;
    budgetSummary.innerHTML = `
      <span><span class="summary-label">Budget</span> ${formatCurrency(totalBudget)}</span>
      <span><span class="summary-label">Spent</span> ${formatCurrency(totalSpent)}</span>
      <span><span class="summary-label">Remaining</span> <span ${totalRemaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(totalRemaining)}</span></span>`;
    budgetOverallFill.style.width = `${totalBudget > 0 ? Math.min(100, (totalSpent / totalBudget) * 100) : 0}%`;
    budgetOverallFill.classList.toggle("over", totalSpent > totalBudget);
    thead.innerHTML = `<tr><th>Task</th><th>Budget</th><th>Spent</th><th style="width:160px;">Progress</th><th>Remaining</th></tr>`;
  }

  if (projectTasks.length === 0) {
    budgetTbody.innerHTML = "";
    budgetEmpty.style.display = "block";
    budgetHint.style.display = "none";
    return;
  }
  budgetEmpty.style.display = "none";
  budgetHint.style.display = "block";

  budgetTbody.innerHTML = projectTasks.map((t) => {
    const expanded = t.id === expandedTaskId;
    let cells;
    if (internal) {
      const assigned = assignedOnTask(t.id);
      const logged = loggedHours(timeEntries.filter((e) => e.taskId === t.id));
      const pct = assigned > 0 ? Math.min(100, (logged / assigned) * 100) : 0;
      cells = `<td>${fmtHrs(assigned)} hrs</td><td>${fmtHrs(logged)} hrs</td>
        <td><div class="progress-bar"><div class="fill ${logged > assigned ? "over-soft" : ""}" style="width:${pct}%"></div></div></td><td></td>`;
    } else {
      const budget = Number(t.budget || 0);
      const spent = spentOnTask(t.id);
      const remaining = budget - spent;
      const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
      cells = `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
        <td><div class="progress-bar"><div class="fill ${spent > budget ? "over" : ""}" style="width:${pct}%"></div></div></td>
        <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>`;
    }
    const mainRow = `<tr class="task-row ${expanded ? "expanded" : ""}" data-task-row="${t.id}"><td>${esc(t.name)}</td>${cells}</tr>`;
    if (!expanded) return mainRow;
    return mainRow + `<tr><td colspan="5" class="accordion-cell">${taskPeopleHtml(t)}</td></tr>`;
  }).join("");
}

// Who's on a task: each person's assigned hours vs. hours logged.
function taskPeopleHtml(task) {
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const personIds = [...new Set([...taskAssignments.map((a) => a.personId), ...taskEntries.map((e) => e.personId)])];
  if (personIds.length === 0) return `<div class="empty">No one is assigned to this task yet.</div>`;

  const rows = personIds.map((pid) => {
    const person = people.find((p) => p.id === pid);
    const assignment = taskAssignments.find((a) => a.personId === pid);
    return {
      name: person ? person.name : "—",
      assigned: assignment ? assignedHours(assignment, { projects, people }) : 0,
      logged: loggedHours(taskEntries.filter((e) => e.personId === pid)),
      isAssigned: !!assignment,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const color = projectColor(task.projectId);
  return `<div class="hours-rows" style="margin-top:0;">${rows.map((r) => `<div class="hours-row">
      <div class="hours-row-name">${esc(r.name)}${r.isAssigned ? "" : ' <span class="empty" style="padding:0; font-weight:400;">(not assigned)</span>'}</div>
      ${hoursBarHtml(r.logged, r.assigned, color)}
    </div>`).join("")}</div>`;
}

budgetTbody.addEventListener("click", (e) => {
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
    const assignment = isAssignment(d);
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

// ---------- Assignments for the selected project ----------
// (due dates with at least one assigned person)
function assignmentGroups() {
  const items = dueDates.filter((d) =>
    d.projectId === selectedProjectId && isAssignment(d) && (showCompleted || !d.completed));
  const byPerson = {};
  items.forEach((d) => {
    (d.personIds || []).forEach((pid) => {
      (byPerson[pid] = byPerson[pid] || []).push(d);
    });
  });
  // Everyone on the project's tasks gets a group (so "+ Assign" is handy),
  // plus anyone else who has items here.
  const projectPersonIds = new Set([
    ...assignments.filter((a) => a.projectId === selectedProjectId).map((a) => a.personId),
    ...Object.keys(byPerson),
  ]);
  return people
    .filter((p) => projectPersonIds.has(p.id))
    .map((p) => ({
      personId: p.id, name: p.name,
      items: (byPerson[p.id] || []).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
    }));
}

function renderAssignments() {
  if (!selectedProjectId) return;
  const groups = assignmentGroups();
  if (groups.length === 0) {
    assignmentsList.innerHTML = `<div class="empty">No one is assigned to this project yet.</div>`;
    return;
  }

  assignmentsList.innerHTML = groups.map((g) => {
    const itemsHtml = g.items.length === 0
      ? `<div class="empty">No items assigned.</div>`
      : g.items.map((d) => {
          const task = tasks.find((t) => t.id === d.taskId);
          const creator = people.find((p) => p.id === d.createdByPersonId);
          const manageable = canManage(d);
          return `<div class="assignment-item ${d.completed ? "assignment-item-completed" : ""}">
            <div class="assignment-item-main">
              <span class="creator-tag" style="background:${colorForPerson(d.createdByPersonId)};" title="Added by ${creator ? esc(creator.name) : "someone no longer on the team"}">${initialsFor(creator)}</span>
              <div>
                <div class="assignment-item-title">${esc(d.title)}</div>
                <div class="empty" style="padding:0;">${task ? `${esc(task.name)} &middot; ` : ""}${formatDate(d.dueDate)} (${dueLabel(d.dueDate)})</div>
              </div>
            </div>
            ${d.completed
              ? `<span class="pill green">Completed</span>`
              : manageable ? `<div class="row-actions">
                  <button class="small secondary" data-action="edit-duedate" data-id="${d.id}">Edit</button>
                  <button class="small complete-btn" data-action="complete-duedate" data-id="${d.id}">Complete</button>
                </div>` : ""}
          </div>`;
        }).join("");

    return `<div class="assignment-group">
      <div class="assignment-group-header">
        ${esc(g.name)} <span class="empty" style="padding:0;">(${g.items.length} ${g.items.length === 1 ? "item" : "items"})</span>
        <button class="small secondary" data-action="quick-assign" data-id="${g.personId}">+ Assign</button>
      </div>
      ${itemsHtml}
    </div>`;
  }).join("");
}

assignmentsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "quick-assign") {
    openDueDateModal(null, "assignment", id || null);
    return;
  }
  if (action === "complete-duedate") {
    try { await DueDates.update(id, { completed: true, completedDate: new Date().toISOString() }); } catch (err) { showToast("Error: " + err.message); }
    return;
  }
  await handleDueDateAction(action, id);
});

async function handleDueDateAction(action, id) {
  const d = dueDates.find((dd) => dd.id === id);
  if (!d || !canManage(d)) return;
  if (action === "edit-duedate") openDueDateModal(d, isAssignment(d) ? "assignment" : "event");
}

// ---------- Event / assignment modal ----------
function populateTaskOptions(projectId, selectedTaskId) {
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  ddTask.innerHTML = `<option value="">No specific task</option>` +
    projectTasks.map((t) => `<option value="${t.id}" ${t.id === selectedTaskId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
}

function renderPeoplePills(selectedIds) {
  const checked = selectedIds || [];
  ddPeoplePills.innerHTML = people.map((p) => `<label>
    <input type="checkbox" class="ddPerson" value="${p.id}" ${checked.includes(p.id) ? "checked" : ""} />
    ${esc(p.name)}
  </label>`).join("");
}

function openDueDateModal(dueDateRecord, mode, presetPersonId) {
  modalMode = mode;
  editingDueDateId = dueDateRecord ? dueDateRecord.id : null;
  const isEditing = !!dueDateRecord;
  dueDateModalTitle.textContent = isEditing
    ? (mode === "event" ? "Edit Event" : "Edit Assignment")
    : (mode === "event" ? "Add Event" : "Add Assignment");

  // Task is always available (for placing an event on a task's timeline
  // row). Events never show the people picker, add or edit — events are
  // universal, never assigned to anyone.
  ddTaskRow.style.display = "block";
  ddPeopleField.style.display = mode === "assignment" ? "block" : "none";

  ddProject.innerHTML = visibleProjects().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const projectId = dueDateRecord ? dueDateRecord.projectId : selectedProjectId;
  ddProject.value = projectId || "";
  populateTaskOptions(projectId, dueDateRecord ? dueDateRecord.taskId : "");

  ddTitle.value = dueDateRecord ? dueDateRecord.title : "";
  ddDate.value = dueDateRecord ? dueDateRecord.dueDate : "";

  const defaultPeople = dueDateRecord
    ? dueDateRecord.personIds
    : (presetPersonId ? [presetPersonId] : (mode === "event" ? [] : [sessionPersonId]));
  renderPeoplePills(defaultPeople);

  modalDeleteDueDate.style.display = (isEditing && canManage(dueDateRecord)) ? "inline-block" : "none";

  dueDateModal.style.display = "flex";
  ddTitle.focus();
}

function closeDueDateModal() {
  dueDateModal.style.display = "none";
}

document.getElementById("openAddEvent").addEventListener("click", () => openDueDateModal(null, "event"));
document.getElementById("openAddAssignment").addEventListener("click", () => openDueDateModal(null, "assignment"));

const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  toggleCompletedBtn.textContent = showCompleted ? "Hide Completed" : "Show Completed";
  renderAssignments();
});
document.getElementById("modalCancelDueDate").addEventListener("click", closeDueDateModal);
closeOnBackdropClick(dueDateModal, closeDueDateModal);
ddProject.addEventListener("change", () => populateTaskOptions(ddProject.value, ""));

modalDeleteDueDate.addEventListener("click", async () => {
  if (!editingDueDateId) return;
  if (!confirm("Delete this item?")) return;
  try {
    await DueDates.remove(editingDueDateId);
    closeDueDateModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

document.getElementById("modalSaveDueDate").addEventListener("click", async () => {
  const projectId = ddProject.value;
  const taskId = ddTaskRow.style.display !== "none" ? (ddTask.value || null) : null;
  const title = ddTitle.value.trim();
  const dueDate = ddDate.value;
  const personIds = ddPeopleField.style.display !== "none"
    ? [...ddPeoplePills.querySelectorAll(".ddPerson:checked")].map((cb) => cb.value)
    : [];

  if (!projectId) return showToast("Select a project.");
  if (!title || !dueDate) return showToast("Enter a name and date.");
  if (modalMode === "assignment" && !editingDueDateId && !taskId) return showToast("Select a task for this assignment.");
  if (modalMode === "assignment" && !editingDueDateId && personIds.length === 0) return showToast("Assign this to at least one person.");

  try {
    if (editingDueDateId) {
      await DueDates.update(editingDueDateId, { projectId, taskId, title, dueDate, personIds });
      showToast("Updated.");
    } else {
      await DueDates.add({
        projectId, taskId, title, dueDate, personIds,
        createdByPersonId: sessionPersonId,
      });
      showToast("Added.");
    }
    closeDueDateModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Timeline (task dates) edit modal ----------
function openTimelineModal(projectId) {
  editingTimelineProjectId = projectId;
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
