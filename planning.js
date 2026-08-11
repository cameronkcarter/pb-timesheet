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

const PX_PER_DAY = 6;

const ganttChart = document.getElementById("ganttChart");
const ganttEmpty = document.getElementById("ganttEmpty");
const projectionRows = document.getElementById("projectionRows");
const projectionEmpty = document.getElementById("projectionEmpty");
const dueDatesTbody = document.querySelector("#dueDatesTable tbody");
const dueDatesEmpty = document.getElementById("dueDatesEmpty");

const dueDateModal = document.getElementById("dueDateModal");
const dueDateModalTitle = document.getElementById("dueDateModalTitle");
const ddProject = document.getElementById("ddProject");
const ddTask = document.getElementById("ddTask");
const ddTitle = document.getElementById("ddTitle");
const ddDate = document.getElementById("ddDate");
const ddHours = document.getElementById("ddHours");
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
  Assignments.listen((data) => { assignments = data; renderProjection(); });
  TimeEntries.listen((data) => { timeEntries = data; renderProjection(); });
  DueDates.listen((data) => { dueDates = data; renderAll(); });
}

function renderAll() {
  renderGantt();
  renderProjection();
  renderDueDates();
}

// ---------- Gantt ----------
function renderGantt() {
  const scheduledTasks = tasks.filter((t) => t.startDate && t.endDate);
  if (scheduledTasks.length === 0) {
    ganttChart.innerHTML = "";
    ganttEmpty.style.display = "block";
    return;
  }
  ganttEmpty.style.display = "none";

  const allStarts = scheduledTasks.map((t) => t.startDate);
  const allEnds = scheduledTasks.map((t) => t.endDate);
  const dueDatesWithDates = dueDates.filter((d) => d.dueDate);
  const rangeStartRaw = [...allStarts, ...dueDatesWithDates.map((d) => d.dueDate)].sort()[0];
  const rangeEndRaw = [...allEnds, ...dueDatesWithDates.map((d) => d.dueDate)].sort().slice(-1)[0];
  const rangeStart = toISODate(addDays(rangeStartRaw + "T00:00:00", -4));
  const rangeEnd = toISODate(addDays(rangeEndRaw + "T00:00:00", 4));
  const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd));
  const timelineWidth = totalDays * PX_PER_DAY;

  function xFor(dateStr) {
    return daysBetween(rangeStart, dateStr) * PX_PER_DAY;
  }

  // Month ruler ticks
  const ticks = [];
  let cursor = new Date(rangeStart + "T00:00:00");
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const endDate = new Date(rangeEnd + "T00:00:00");
  while (cursor <= endDate) {
    const iso = toISODate(cursor);
    ticks.push({ x: xFor(iso), label: cursor.toLocaleDateString("en-US", { month: "short", year: "numeric" }) });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  const todayX = xFor(todayISO());
  const todayInRange = todayX >= 0 && todayX <= timelineWidth;

  const rulerHtml = `<div class="gantt-ruler" style="width:${timelineWidth}px;">
    ${ticks.map((t) => `<div class="gantt-tick" style="left:${t.x}px;">${t.label}</div>`).join("")}
    ${todayInRange ? `<div class="gantt-today-tick" style="left:${todayX}px;">Today</div>` : ""}
  </div>`;

  const projectRowsHtml = projects.map((project) => {
    const projectTasks = scheduledTasks.filter((t) => t.projectId === project.id)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (projectTasks.length === 0) return "";

    const taskRowsHtml = projectTasks.map((t) => {
      const barX = xFor(t.startDate);
      const barW = Math.max(4, xFor(t.endDate) - barX);
      const taskDueDates = dueDatesWithDates.filter((d) => d.taskId === t.id);
      const dotsHtml = taskDueDates.map((d) => {
        const dx = xFor(d.dueDate);
        return `<div class="gantt-dot" style="left:${dx}px;" title="${esc(d.title)} — ${formatDate(d.dueDate)}"></div>`;
      }).join("");
      return `<div class="gantt-row">
        <div class="gantt-label-col gantt-task-label">${t.name}</div>
        <div class="gantt-track" style="width:${timelineWidth}px;">
          <div class="gantt-bar" style="left:${barX}px; width:${barW}px;"></div>
          ${dotsHtml}
        </div>
      </div>`;
    }).join("");

    const generalDueDates = dueDatesWithDates.filter((d) => d.projectId === project.id && !d.taskId);
    const generalRowHtml = generalDueDates.length > 0 ? `<div class="gantt-row">
        <div class="gantt-label-col gantt-task-label">General</div>
        <div class="gantt-track" style="width:${timelineWidth}px;">
          ${generalDueDates.map((d) => `<div class="gantt-dot" style="left:${xFor(d.dueDate)}px;" title="${esc(d.title)} — ${formatDate(d.dueDate)}"></div>`).join("")}
        </div>
      </div>` : "";

    return `<div class="gantt-row gantt-project-row">
        <div class="gantt-label-col">${project.name}</div>
        <div class="gantt-track" style="width:${timelineWidth}px;"></div>
      </div>
      ${taskRowsHtml}${generalRowHtml}`;
  }).join("");

  ganttChart.innerHTML = `<div class="gantt-inner">
    <div class="gantt-row gantt-header-row">
      <div class="gantt-label-col">Project / Task</div>
      ${rulerHtml}
    </div>
    ${projectRowsHtml}
  </div>`;
}

// ---------- Hours projection ----------
function renderProjection() {
  const myAssignments = assignments.filter((a) => a.personId === sessionPersonId);
  if (myAssignments.length === 0) {
    projectionRows.innerHTML = "";
    projectionEmpty.style.display = "block";
    return;
  }
  projectionEmpty.style.display = "none";

  const me = currentPerson();
  const rate = me ? me.rate : 0;
  const today = todayISO();

  projectionRows.innerHTML = myAssignments.map((a) => {
    const task = tasks.find((t) => t.id === a.taskId);
    const project = projects.find((p) => p.id === a.projectId);
    if (!task) return "";

    const totalHours = rate > 0 ? (a.capValue || 0) / rate : 0;
    const loggedHours = timeEntries
      .filter((e) => e.personId === sessionPersonId && e.taskId === task.id)
      .reduce((s, e) => s + Number(e.hours || 0), 0);
    const remainingHours = totalHours - loggedHours;

    const plannedItems = dueDates.filter((d) =>
      d.taskId === task.id && (d.personIds || []).includes(sessionPersonId) &&
      d.estimatedHours && d.dueDate >= today
    );
    const plannedHours = plannedItems.reduce((s, d) => s + Number(d.estimatedHours || 0), 0);
    const projected = remainingHours - plannedHours;

    return `<div class="projection-row">
      <div>
        <div class="projection-task">${task.name}</div>
        <div class="empty" style="padding:0;">${project ? project.name : "—"}</div>
      </div>
      <div class="projection-stats">
        <div><span class="summary-label">Remaining</span><div class="summary-value">${remainingHours.toFixed(1)} hrs</div></div>
        <div><span class="summary-label">Planned (${plannedItems.length})</span><div class="summary-value">${plannedHours.toFixed(1)} hrs</div></div>
        <div><span class="summary-label">Projected Left</span><div class="summary-value" style="${projected < 0 ? "color:var(--red);" : ""}">${projected.toFixed(1)} hrs</div></div>
      </div>
      ${plannedItems.length > 0 ? `<div class="projection-items">
        ${plannedItems.map((d) => `<div>${d.title} — ${formatDate(d.dueDate)} — ${d.estimatedHours} hrs</div>`).join("")}
      </div>` : ""}
    </div>`;
  }).join("");
}

// ---------- Due Dates list ----------
function renderDueDates() {
  const sorted = [...dueDates].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (sorted.length === 0) {
    dueDatesTbody.innerHTML = "";
    dueDatesEmpty.style.display = "block";
    return;
  }
  dueDatesEmpty.style.display = "none";

  dueDatesTbody.innerHTML = sorted.map((d) => {
    const project = projects.find((p) => p.id === d.projectId);
    const task = tasks.find((t) => t.id === d.taskId);
    const names = (d.personIds || []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean);
    const manageable = canManage(d);
    return `<tr>
      <td>${d.title}</td>
      <td>${project ? project.name : "—"}${task ? ` / ${task.name}` : ""}</td>
      <td>${names.length > 0 ? names.join(", ") : "Unassigned"}</td>
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
}

dueDatesTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const d = dueDates.find((dd) => dd.id === id);
  if (!d || !canManage(d)) return;

  if (action === "edit-duedate") openDueDateModal(d);
  if (action === "remove-duedate") {
    if (!confirm("Remove this due date?")) return;
    try { await DueDates.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
});

// ---------- Due Date modal ----------
function populateTaskOptions(projectId, selectedTaskId) {
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  ddTask.innerHTML = `<option value="">No specific task</option>` +
    projectTasks.map((t) => `<option value="${t.id}" ${t.id === selectedTaskId ? "selected" : ""}>${t.name}</option>`).join("");
}

function renderPeoplePills(selectedIds) {
  const checked = selectedIds || [sessionPersonId];
  ddPeoplePills.innerHTML = people.map((p) => `<label>
    <input type="checkbox" class="ddPerson" value="${p.id}" ${checked.includes(p.id) ? "checked" : ""} />
    ${p.name}
  </label>`).join("");
}

function openDueDateModal(dueDateRecord) {
  editingDueDateId = dueDateRecord ? dueDateRecord.id : null;
  dueDateModalTitle.textContent = dueDateRecord ? "Edit Due Date" : "Add Due Date";

  ddProject.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  const projectId = dueDateRecord ? dueDateRecord.projectId : (projects[0] && projects[0].id);
  ddProject.value = projectId || "";
  populateTaskOptions(projectId, dueDateRecord ? dueDateRecord.taskId : "");

  ddTitle.value = dueDateRecord ? dueDateRecord.title : "";
  ddDate.value = dueDateRecord ? dueDateRecord.dueDate : "";
  ddHours.value = dueDateRecord && dueDateRecord.estimatedHours ? dueDateRecord.estimatedHours : "";
  renderPeoplePills(dueDateRecord ? dueDateRecord.personIds : null);

  dueDateModal.style.display = "flex";
  ddTitle.focus();
}

function closeDueDateModal() {
  dueDateModal.style.display = "none";
}

document.getElementById("openAddDueDate").addEventListener("click", () => openDueDateModal(null));
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
  if (!title || !dueDate) return showToast("Enter an event name and due date.");

  try {
    if (editingDueDateId) {
      await DueDates.update(editingDueDateId, { projectId, taskId, title, dueDate, estimatedHours, personIds });
      showToast("Due date updated.");
    } else {
      await DueDates.add({
        projectId, taskId, title, dueDate, estimatedHours, personIds,
        createdByPersonId: sessionPersonId,
      });
      showToast("Due date added.");
    }
    closeDueDateModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
