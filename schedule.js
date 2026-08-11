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
let expandedAssignmentPersonId = null;
let openDotId = null;

const PX_PER_DAY = 4;

const ganttChart = document.getElementById("ganttChart");
const ganttEmpty = document.getElementById("ganttEmpty");
const eventsTbody = document.querySelector("#eventsTable tbody");
const eventsEmpty = document.getElementById("eventsEmpty");
const assignmentsTbody = document.querySelector("#assignmentsTable tbody");

const dueDateModal = document.getElementById("dueDateModal");
const dueDateModalTitle = document.getElementById("dueDateModalTitle");
const ddProject = document.getElementById("ddProject");
const ddTaskRow = document.getElementById("ddTaskRow");
const ddTaskLabel = document.getElementById("ddTaskLabel");
const ddTask = document.getElementById("ddTask");
const ddTitle = document.getElementById("ddTitle");
const ddDate = document.getElementById("ddDate");
const ddHoursField = document.getElementById("ddHoursField");
const ddHours = document.getElementById("ddHours");
const ddPeopleField = document.getElementById("ddPeopleField");
const ddPeoplePills = document.getElementById("ddPeoplePills");

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
  renderEvents();
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
  const dueDatesWithDates = dueDates.filter((d) => d.dueDate && d.taskId);

  const allStarts = scheduledTasks.map((t) => t.startDate);
  const allEnds = scheduledTasks.map((t) => t.endDate);
  const today = todayISO();
  const rangeStartRaw = [...allStarts, today].sort()[0];
  const rangeEndRaw = [...allEnds, today].sort().slice(-1)[0];
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

  const rulerHtml = `<div class="gantt-ruler" style="width:${timelineWidth}px;">
    ${ticks.map((t) => `<div class="gantt-tick" style="left:${t.x}px;">${t.label}</div>`).join("")}
    ${todayInRange ? `<div class="gantt-today-tick" style="left:${todayX}px;"></div>` : ""}
  </div>`;

  const projectRowsHtml = projects.map((project) => {
    const projectTasks = tasks.filter((t) => t.projectId === project.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    const projectRemaining = projectTasks.reduce(
      (s, t) => s + (Number(t.budget || 0) - spentOnTask(t.id)), 0
    );

    const taskRowsHtml = projectTasks.map((t) => {
      const hasDates = t.startDate && t.endDate;
      const barHtml = hasDates
        ? `<div class="gantt-bar" style="left:${xFor(t.startDate)}px; width:${Math.max(4, xFor(t.endDate) - xFor(t.startDate))}px;"></div>`
        : "";
      const taskDueDates = dueDatesWithDates.filter((d) => d.taskId === t.id);
      const dotsHtml = taskDueDates.map((d) => {
        const dx = xFor(d.dueDate);
        return `<div class="gantt-dot" style="left:${dx}px;" data-dot-id="${d.id}" title="${esc(d.title)} — ${formatDate(d.dueDate)}"></div>`;
      }).join("");

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
        <div class="gantt-label-col">${project.name}</div>
        <div class="gantt-track" style="width:${timelineWidth}px;"></div>
        <div class="gantt-remaining-col gantt-project-remaining">${formatCurrency(projectRemaining)}</div>
      </div>
      ${taskRowsHtml}`;
  }).join("");

  ganttChart.innerHTML = `<div class="gantt-inner">
    <div class="gantt-row gantt-header-row">
      <div class="gantt-label-col">Project / Task</div>
      ${rulerHtml}
      <div class="gantt-remaining-col">Remaining</div>
    </div>
    ${projectRowsHtml}
  </div>`;
}

ganttChart.addEventListener("click", (e) => {
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
  const popover = document.createElement("div");
  popover.className = "gantt-dot-popover";
  popover.innerHTML = `
    <div class="gantt-dot-popover-title">${esc(d.title)}</div>
    <div>${formatDate(d.dueDate)} <span class="empty" style="padding:0;">(${dueLabel(d.dueDate)})</span></div>
    ${d.estimatedHours ? `<div>${d.estimatedHours} hrs estimated</div>` : ""}
    ${names.length > 0 ? `<div>Assigned: ${names.join(", ")}</div>` : ""}
  `;
  const rect = dot.getBoundingClientRect();
  popover.style.left = `${rect.left + window.scrollX}px`;
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  document.body.appendChild(popover);
});

// ---------- Events (due dates with no linked task) ----------
function renderEvents() {
  const events = dueDates.filter((d) => !d.taskId).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (events.length === 0) {
    eventsTbody.innerHTML = "";
    eventsEmpty.style.display = "block";
    return;
  }
  eventsEmpty.style.display = "none";

  eventsTbody.innerHTML = events.map((d) => {
    const project = projects.find((p) => p.id === d.projectId);
    const manageable = canManage(d);
    return `<tr>
      <td>${d.title}</td>
      <td>${project ? project.name : "—"}</td>
      <td>${formatDate(d.dueDate)} <span class="empty">(${dueLabel(d.dueDate)})</span></td>
      <td class="row-actions">
        ${manageable ? `
          <button class="small secondary" data-action="edit-duedate" data-id="${d.id}">Edit</button>
          <button class="danger small" data-action="remove-duedate" data-id="${d.id}">Remove</button>
        ` : ""}
      </td>
    </tr>`;
  }).join("");
}

eventsTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  await handleDueDateAction(btn.dataset.action, btn.dataset.id);
});

// ---------- Assignments (due dates linked to a task), grouped by person ----------
function assignmentItems() {
  return dueDates.filter((d) => d.taskId);
}

function assignmentGroups() {
  const items = assignmentItems();
  const byPerson = {};
  items.forEach((d) => {
    const ids = d.personIds && d.personIds.length > 0 ? d.personIds : [""];
    ids.forEach((pid) => {
      if (!byPerson[pid]) byPerson[pid] = [];
      byPerson[pid].push(d);
    });
  });
  const groups = people.map((p) => ({
    personId: p.id, name: p.name, items: (byPerson[p.id] || []).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
  }));
  if (byPerson[""]) {
    groups.push({ personId: "", name: "Unassigned", items: byPerson[""].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)) });
  }
  return groups;
}

function renderAssignments() {
  const groups = assignmentGroups();

  assignmentsTbody.innerHTML = groups.map((g) => {
    const expanded = g.personId === expandedAssignmentPersonId;
    const mainRow = `<tr class="task-row ${expanded ? "expanded" : ""}" data-assign-person-row="${g.personId}">
      <td colspan="4">${g.name} <span class="empty" style="padding:0;">(${g.items.length} ${g.items.length === 1 ? "item" : "items"})</span></td>
      <td class="row-actions">
        <button class="small secondary" data-action="quick-assign" data-id="${g.personId}">+ Assign</button>
      </td>
    </tr>`;

    if (!expanded) return mainRow;

    if (g.items.length === 0) {
      return mainRow + `<tr><td colspan="5" class="accordion-cell"><div class="empty">No items assigned yet.</div></td></tr>`;
    }

    const subRowsWithActions = g.items.map((d) => {
      const project = projects.find((p) => p.id === d.projectId);
      const task = tasks.find((t) => t.id === d.taskId);
      const creator = people.find((p) => p.id === d.createdByPersonId);
      const manageable = canManage(d);
      return `<tr class="assignment-sub-row">
        <td></td>
        <td>
          <span class="creator-tag" style="background:${colorForPerson(d.createdByPersonId)};" title="Added by ${creator ? esc(creator.name) : "someone no longer on the team"}">${initialsFor(creator)}</span>
          ${d.title}
        </td>
        <td>${project ? project.name : "—"}${task ? ` / ${task.name}` : ""}</td>
        <td>${formatDate(d.dueDate)} <span class="empty">(${dueLabel(d.dueDate)})</span></td>
        <td>${d.estimatedHours ? `${d.estimatedHours} hrs` : "—"}</td>
        <td class="row-actions">
          ${manageable ? `
            <button class="small secondary" data-action="edit-duedate" data-id="${d.id}">Edit</button>
            <button class="danger small" data-action="remove-duedate" data-id="${d.id}">Remove</button>
          ` : ""}
        </td>
      </tr>`;
    }).join("");

    return mainRow + subRowsWithActions;
  }).join("");
}

assignmentsTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) {
    const row = e.target.closest("tr.task-row");
    if (row) {
      const id = row.dataset.assignPersonRow;
      expandedAssignmentPersonId = expandedAssignmentPersonId === id ? null : id;
      renderAssignments();
    }
    return;
  }
  const { action, id } = btn.dataset;
  if (action === "quick-assign") {
    openDueDateModal(null, "assignment", id || null);
    return;
  }
  await handleDueDateAction(action, id);
});

async function handleDueDateAction(action, id) {
  const d = dueDates.find((dd) => dd.id === id);
  if (!d || !canManage(d)) return;
  if (action === "edit-duedate") openDueDateModal(d, d.taskId ? "assignment" : "event");
  if (action === "remove-duedate") {
    if (!confirm("Remove this item?")) return;
    try { await DueDates.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
}

// ---------- Modal ----------
function populateTaskOptions(projectId, selectedTaskId) {
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  ddTask.innerHTML = (modalMode === "event" ? `<option value="">No specific task</option>` : "") +
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
  dueDateModalTitle.textContent = dueDateRecord
    ? (mode === "event" ? "Edit Event" : "Edit Assignment")
    : (mode === "event" ? "Add Event" : "Add Assignment");

  ddTaskLabel.textContent = mode === "event" ? "Task (optional)" : "Task";
  ddHoursField.style.display = mode === "assignment" ? "block" : "none";
  ddPeopleField.style.display = "block";

  ddProject.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  const projectId = dueDateRecord ? dueDateRecord.projectId : (projects[0] && projects[0].id);
  ddProject.value = projectId || "";
  populateTaskOptions(projectId, dueDateRecord ? dueDateRecord.taskId : "");

  ddTitle.value = dueDateRecord ? dueDateRecord.title : "";
  ddDate.value = dueDateRecord ? dueDateRecord.dueDate : "";
  ddHours.value = dueDateRecord && dueDateRecord.estimatedHours ? dueDateRecord.estimatedHours : "";

  const defaultPeople = dueDateRecord
    ? dueDateRecord.personIds
    : (presetPersonId ? [presetPersonId] : (mode === "event" ? [] : [sessionPersonId]));
  renderPeoplePills(defaultPeople);

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

document.getElementById("modalSaveDueDate").addEventListener("click", async () => {
  const projectId = ddProject.value;
  const taskId = ddTask.value || null;
  const title = ddTitle.value.trim();
  const dueDate = ddDate.value;
  const estimatedHours = ddHours.value ? Number(ddHours.value) : null;
  const personIds = [...ddPeoplePills.querySelectorAll(".ddPerson:checked")].map((cb) => cb.value);

  if (!projectId) return showToast("Select a project.");
  if (!title || !dueDate) return showToast("Enter a name and date.");
  if (modalMode === "assignment" && !taskId) return showToast("Select a task for this assignment.");
  if (modalMode === "assignment" && personIds.length === 0) return showToast("Assign this to at least one person.");

  try {
    if (editingDueDateId) {
      await DueDates.update(editingDueDateId, { projectId, taskId, title, dueDate, estimatedHours, personIds });
      showToast("Updated.");
    } else {
      await DueDates.add({
        projectId, taskId, title, dueDate, estimatedHours, personIds,
        createdByPersonId: sessionPersonId,
      });
      showToast("Added.");
    }
    closeDueDateModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
