import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, dueLabel, showToast,
  todayISO, toISODate, addDays, daysBetween,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility } from "./session.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let navChecked = false;
let editingDueDateId = null;
let modalMode = "event"; // "event" | "assignment"
let openDotId = null;
let editingTimelineProjectId = null;

const PX_PER_DAY = 4;
const LABEL_COL_WIDTH = 200;

const ganttChart = document.getElementById("ganttChart");
const ganttEmpty = document.getElementById("ganttEmpty");
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
  return String(str ?? "").replace(/"/g, "&quot;");
}

function currentPerson() {
  return people.find((p) => p.id === sessionPersonId);
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
    }
    renderAll();
  });
  Projects.listen((data) => { projects = data; renderAll(); });
  Tasks.listen((data) => { tasks = data; renderAll(); });
  Assignments.listen((data) => { assignments = data; });
  TimeEntries.listen((data) => { timeEntries = data; renderGantt(); });
  DueDates.listen((data) => { dueDates = data; renderAll(); });
}

function renderAll() {
  renderGantt();
  renderAssignments();
}

// ---------- Gantt ----------
function spentOnTask(taskId) {
  return timeEntries
    .filter((e) => e.taskId === taskId)
    .reduce((sum, e) => {
      const person = people.find((p) => p.id === e.personId);
      return sum + Number(e.hours || 0) * (person ? person.rate : 0);
    }, 0);
}

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
  if (projects.length === 0) {
    ganttChart.innerHTML = "";
    ganttEmpty.style.display = "block";
    return;
  }
  ganttEmpty.style.display = "none";

  const scheduledTasks = tasks.filter((t) => t.startDate && t.endDate);
  const dueDatesWithDates = dueDates.filter((d) => d.dueDate && !d.completed);

  const allStarts = scheduledTasks.map((t) => t.startDate);
  const allEnds = scheduledTasks.map((t) => t.endDate);
  const allDueDates = dueDatesWithDates.map((d) => d.dueDate);
  const today = todayISO();
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
    const kind = isAssignment(d) ? "gantt-dot-assignment" : "gantt-dot-event";
    return `<div class="gantt-dot ${kind}" style="left:${dx}px;" data-dot-id="${d.id}" title="${esc(d.title)} — ${formatDate(d.dueDate)}"></div>`;
  }

  const rulerHtml = `<div class="gantt-ruler" style="width:${timelineWidth}px;">
    ${ticks.map((t) => `<div class="gantt-tick" style="left:${t.x}px;">${t.label}</div>`).join("")}
  </div>`;

  const projectRowsHtml = projects.map((project) => {
    const projectTasks = tasks.filter((t) => t.projectId === project.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    const projectRemaining = projectTasks.reduce(
      (s, t) => s + (Number(t.budget || 0) - spentOnTask(t.id)), 0
    );

    const projectDueDates = dueDatesWithDates.filter((d) => d.projectId === project.id && !d.taskId);
    const projectDotsHtml = projectDueDates.map(dotHtml).join("");
    const canEditTimeline = currentPerson() && currentPerson().isAdmin;

    const taskRowsHtml = projectTasks.map((t) => {
      const hasDates = t.startDate && t.endDate;
      const barHtml = hasDates
        ? `<div class="gantt-bar" style="left:${xFor(t.startDate)}px; width:${Math.max(4, xFor(t.endDate) - xFor(t.startDate))}px;"></div>`
        : "";
      const taskDueDates = dueDatesWithDates.filter((d) => d.taskId === t.id);
      const dotsHtml = taskDueDates.map(dotHtml).join("");
      const remaining = Number(t.budget || 0) - spentOnTask(t.id);

      return `<div class="gantt-row">
        <div class="gantt-label-col gantt-task-label">${t.name}</div>
        <div class="gantt-track" style="width:${timelineWidth}px;">
          ${barHtml}
          ${dotsHtml}
        </div>
        <div class="gantt-remaining-col">${formatCurrency(remaining)}</div>
      </div>`;
    }).join("");

    return `<div class="gantt-row gantt-project-row">
        <div class="gantt-label-col ${canEditTimeline ? "gantt-project-clickable" : ""}" ${canEditTimeline ? `data-edit-timeline="${project.id}" title="Click to edit this project's timeline"` : ""}>${project.name}</div>
        <div class="gantt-track" style="width:${timelineWidth}px;">${projectDotsHtml}</div>
        <div class="gantt-remaining-col gantt-project-remaining">${formatCurrency(projectRemaining)}</div>
      </div>
      ${taskRowsHtml}`;
  }).join("");

  const monthLinesHtml = ticks.map((t) =>
    `<div class="gantt-month-line" style="left:${LABEL_COL_WIDTH + t.x}px;"></div>`
  ).join("");
  const todayLineHtml = todayInRange
    ? `<div class="gantt-today-line" style="left:${LABEL_COL_WIDTH + todayX}px;"></div>`
    : "";

  ganttChart.innerHTML = `<div class="gantt-inner">
    <div class="gantt-row gantt-header-row">
      <div class="gantt-label-col">Project / Task</div>
      ${rulerHtml}
      <div class="gantt-remaining-col">Remaining</div>
    </div>
    ${projectRowsHtml}
    ${monthLinesHtml}
    ${todayLineHtml}
  </div>`;
}

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
  const project = projects.find((p) => p.id === d.projectId);
  const manageable = canManage(d);
  const popover = document.createElement("div");
  popover.className = "gantt-dot-popover";
  popover.innerHTML = `
    <div class="gantt-dot-popover-title">${esc(d.title)}</div>
    ${project ? `<div>${esc(project.name)}</div>` : ""}
    <div>${formatDate(d.dueDate)} <span class="empty" style="padding:0;">(${dueLabel(d.dueDate)})</span></div>
    ${names.length > 0 ? `<div>Assigned: ${names.join(", ")}</div>` : ""}
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

// ---------- Assignments (due dates with at least one assigned person) ----------
function assignmentItems() {
  return dueDates.filter((d) => isAssignment(d) && !d.completed);
}

function assignmentGroups() {
  const items = assignmentItems();
  const byPerson = {};
  items.forEach((d) => {
    (d.personIds || []).forEach((pid) => {
      if (!byPerson[pid]) byPerson[pid] = [];
      byPerson[pid].push(d);
    });
  });
  return people.map((p) => ({
    personId: p.id, name: p.name, items: (byPerson[p.id] || []).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
  }));
}

function renderAssignments() {
  const groups = assignmentGroups();

  assignmentsList.innerHTML = groups.map((g) => {
    const itemsHtml = g.items.length === 0
      ? `<div class="empty">No items assigned yet.</div>`
      : g.items.map((d) => {
          const project = projects.find((p) => p.id === d.projectId);
          const task = tasks.find((t) => t.id === d.taskId);
          const creator = people.find((p) => p.id === d.createdByPersonId);
          const manageable = canManage(d);
          return `<div class="assignment-item">
            <div class="assignment-item-main">
              <span class="creator-tag" style="background:${colorForPerson(d.createdByPersonId)};" title="Added by ${creator ? esc(creator.name) : "someone no longer on the team"}">${initialsFor(creator)}</span>
              <div>
                <div class="assignment-item-title">${d.title}</div>
                <div class="empty" style="padding:0;">${project ? project.name : "—"}${task ? ` / ${task.name}` : ""} &middot; ${formatDate(d.dueDate)} (${dueLabel(d.dueDate)})</div>
              </div>
            </div>
            ${manageable ? `<div class="row-actions">
              <button class="small secondary" data-action="edit-duedate" data-id="${d.id}">Edit</button>
              <button class="small complete-btn" data-action="complete-duedate" data-id="${d.id}">Complete</button>
            </div>` : ""}
          </div>`;
        }).join("");

    return `<div class="assignment-group">
      <div class="assignment-group-header">
        ${g.name} <span class="empty" style="padding:0;">(${g.items.length} ${g.items.length === 1 ? "item" : "items"})</span>
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

// ---------- Due date / assignment modal ----------
function populateTaskOptions(projectId, selectedTaskId) {
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  ddTask.innerHTML = `<option value="">No specific task</option>` +
    projectTasks.map((t) => `<option value="${t.id}" ${t.id === selectedTaskId ? "selected" : ""}>${t.name}</option>`).join("");
}

function renderPeoplePills(selectedIds) {
  const checked = selectedIds || [];
  ddPeoplePills.innerHTML = people.map((p) => `<label>
    <input type="checkbox" class="ddPerson" value="${p.id}" ${checked.includes(p.id) ? "checked" : ""} />
    ${p.name}
  </label>`).join("");
}

function openDueDateModal(dueDateRecord, mode, presetPersonId) {
  modalMode = mode;
  editingDueDateId = dueDateRecord ? dueDateRecord.id : null;
  const isEditing = !!dueDateRecord;
  dueDateModalTitle.textContent = isEditing
    ? (mode === "event" ? "Edit Event" : "Edit Assignment")
    : (mode === "event" ? "Add Event" : "Add Assignment");

  // Fresh "Add Event" is a minimal form: no task, no people. Everything
  // else (Add Assignment, or editing anything) shows the full form so
  // items can be reclassified or linked to a task later.
  const showTaskAndPeople = isEditing || mode === "assignment";
  ddTaskRow.style.display = showTaskAndPeople ? "block" : "none";
  ddPeopleField.style.display = showTaskAndPeople ? "block" : "none";

  ddProject.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  const projectId = dueDateRecord ? dueDateRecord.projectId : (projects[0] && projects[0].id);
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
document.getElementById("modalCancelDueDate").addEventListener("click", closeDueDateModal);
dueDateModal.addEventListener("click", (e) => {
  if (e.target === dueDateModal) closeDueDateModal();
});
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
    <div class="inline-form" data-task-id="${t.id}" style="margin-bottom:10px;">
      <div>
        <label>${t.name}</label>
      </div>
      <div>
        <label>Start</label>
        <input type="date" class="timelineStart" value="${t.startDate || ""}" />
      </div>
      <div>
        <label>End</label>
        <input type="date" class="timelineEnd" value="${t.endDate || ""}" />
      </div>
    </div>
  `).join("") || `<div class="empty">This project has no tasks yet.</div>`;

  timelineModal.style.display = "flex";
}

function closeTimelineModal() {
  timelineModal.style.display = "none";
}

document.getElementById("modalCancelTimeline").addEventListener("click", closeTimelineModal);
timelineModal.addEventListener("click", (e) => {
  if (e.target === timelineModal) closeTimelineModal();
});

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
