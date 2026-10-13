import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices } from "./db.js";
import { formatCurrency, formatDate, showToast, fmtHrs, closeOnBackdropClick, hoursBarHtml, projectColor } from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import { sheetSyncEnabled, buildBudgets, postToSheet } from "./sheets.js";
import { DEFAULT_BILL_RATE, billRateOf, assignmentRate, assignedHours, isInternal } from "./rates.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let adminCheckDone = false;
let assignmentsLoaded = false;

let modalEditingPersonId = null;
let selectedProjectId = null;
let modalEditingProjectId = null;
let pendingTaskDeletions = new Set();

wireLogout("logoutLink", "navBrandLink");

if (sessionPersonId) {
  People.listen((d) => {
    people = d;
    if (!adminCheckDone) {
      adminCheckDone = true;
      const me = people.find((p) => p.id === sessionPersonId);
      if (!enforceAdmin(me)) return;
      renderNavUserName(me);
    }
    renderPeople();
    renderTasks();
    renderPendingApproval();
    migrateLegacyAssignments();
  });
  Projects.listen((d) => { projects = d; renderProjectCards(); renderPendingApproval(); migrateLegacyAssignments(); });
  Tasks.listen((d) => { tasks = d; renderTasks(); renderPendingApproval(); });
  Assignments.listen((d) => { assignments = d; assignmentsLoaded = true; migrateLegacyAssignments(); renderTasks(); renderPendingApproval(); });
  TimeEntries.listen((d) => { timeEntries = d; renderTasks(); renderPendingApproval(); });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; });
}

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- People (table + modal) ----------
const peopleTbody = document.querySelector("#peopleTable tbody");
const peopleEmpty = document.getElementById("peopleEmpty");

const personModal = document.getElementById("personModal");
const personModalTitle = document.getElementById("personModalTitle");
const modalPersonName = document.getElementById("modalPersonName");
const modalPersonRate = document.getElementById("modalPersonRate");
const modalPersonAdmin = document.getElementById("modalPersonAdmin");
const modalPersonPassword = document.getElementById("modalPersonPassword");

function renderPeople() {
  if (people.length === 0) {
    peopleTbody.innerHTML = "";
    peopleEmpty.style.display = "block";
    return;
  }
  peopleEmpty.style.display = "none";
  peopleTbody.innerHTML = people.map((p) => `
    <tr>
      <td>${p.name}${p.isAdmin ? ' <span class="pill orange">Admin</span>' : ""}</td>
      <td>${formatCurrency(p.rate)}/hr</td>
      <td class="row-actions">
        <button class="small secondary" data-action="edit-person" data-id="${p.id}">Edit</button>
        <button class="danger small" data-action="remove-person" data-id="${p.id}">Remove</button>
      </td>
    </tr>`).join("");
}

peopleTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === "edit-person") {
    const p = people.find((pr) => pr.id === id);
    openPersonModal(p);
  }
  if (action === "remove-person") {
    if (!confirm("Remove this person?")) return;
    try { await People.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
});

function openPersonModal(person) {
  modalEditingPersonId = person ? person.id : null;
  personModalTitle.textContent = person ? "Edit Person" : "Add Person";
  modalPersonName.value = person ? person.name : "";
  modalPersonRate.value = person ? person.rate : "";
  modalPersonAdmin.checked = person ? !!person.isAdmin : false;
  modalPersonPassword.value = person ? (person.password || "") : "";
  personModal.style.display = "flex";
  modalPersonName.focus();
}

function closePersonModal() {
  personModal.style.display = "none";
}

document.getElementById("openAddPerson").addEventListener("click", () => openPersonModal(null));
document.getElementById("modalCancelPerson").addEventListener("click", closePersonModal);
closeOnBackdropClick(personModal, closePersonModal);

document.getElementById("modalSavePerson").addEventListener("click", async () => {
  const name = modalPersonName.value.trim();
  const rate = Number(modalPersonRate.value);
  const isAdmin = modalPersonAdmin.checked;
  const password = modalPersonPassword.value.trim() || null;
  if (!name || !rate) return showToast("Enter a name and rate.");
  try {
    if (modalEditingPersonId) {
      await People.update(modalEditingPersonId, { name, rate, isAdmin, password });
      showToast("Person updated.");
    } else {
      await People.add({ name, rate, isAdmin, password });
      showToast("Person added.");
    }
    closePersonModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Projects (cards + modal) ----------
const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const tasksSection = document.getElementById("tasksSection");
const selectedProjectHeading = document.getElementById("selectedProjectHeading");

const projectModal = document.getElementById("projectModal");
const projectModalTitle = document.getElementById("projectModalTitle");
const modalProjectName = document.getElementById("modalProjectName");
const modalProjectClient = document.getElementById("modalProjectClient");
const modalBillToName = document.getElementById("modalBillToName");
const modalBillToCompany = document.getElementById("modalBillToCompany");
const modalBillToAddress1 = document.getElementById("modalBillToAddress1");
const modalBillToAddress2 = document.getElementById("modalBillToAddress2");
const modalProjectNumber = document.getElementById("modalProjectNumber");
const modalProjectBillRate = document.getElementById("modalProjectBillRate");
const modalProjectInternal = document.getElementById("modalProjectInternal");
const modalBillingFields = document.getElementById("modalBillingFields");

// Internal projects have no client billing or budgets — hide those fields.
function syncInternalFields() {
  const internal = modalProjectInternal.checked;
  modalBillingFields.style.display = internal ? "none" : "block";
  modalTaskRows.classList.toggle("internal", internal);
}
const modalTaskRows = document.getElementById("modalTaskRows");

function renderProjectCards() {
  if (projects.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    tasksSection.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";

  if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
    selectedProjectId = projects[0].id;
  }

  projectCardsEl.innerHTML = projects.map((p) => `
    <div class="project-card ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}">
      <div class="name">${p.name}</div>
      <div class="client">${p.client || "&nbsp;"}</div>
      <div class="client">${p.internal ? "Internal &middot; not billed or paid" : p.billRate ? `Bills ${formatCurrency(p.billRate)}/hr` : "Bills at staff pay rates"}</div>
      <div class="card-actions">
        <button class="small secondary" data-action="edit-project" data-id="${p.id}">Edit</button>
        <button class="danger small" data-action="remove-project" data-id="${p.id}">Remove</button>
      </div>
    </div>
  `).join("");

  const selected = projects.find((p) => p.id === selectedProjectId);
  tasksSection.style.display = "block";
  selectedProjectHeading.textContent = selected ? selected.name : "";
  renderTasks();
}

projectCardsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");

  if (!btn) {
    const card = e.target.closest(".project-card");
    if (card) {
      selectedProjectId = card.dataset.projectCard;
      addingTaskId = null;
      if (taskBlocks.contains(document.activeElement)) document.activeElement.blur();
      renderProjectCards();
    }
    return;
  }

  const { action, id } = btn.dataset;
  if (action === "edit-project") {
    const p = projects.find((pr) => pr.id === id);
    openProjectModal(p);
  }
  if (action === "remove-project") await removeProject(id);
});

// Removes a project and everything that belongs to it (tasks, assignments,
// schedule items, logged hours). Refuses if anything was ever invoiced, since
// that history is part of the invoice paper trail.
async function removeProject(projectId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const projectAssignments = assignments.filter((a) => a.projectId === projectId);
  const projectDueDates = dueDates.filter((d) => d.projectId === projectId);
  const projectEntries = timeEntries.filter((e) => e.projectId === projectId);

  if (projectEntries.some((e) => e.invoiced) || invoices.some((i) => i.projectId === projectId)) {
    alert(`"${project.name}" has invoiced hours, so it can't be removed — that would break the invoice history.`);
    return;
  }

  const counts = [
    [projectTasks.length, "task"], [projectAssignments.length, "assignment"],
    [projectDueDates.length, "schedule item"], [projectEntries.length, "logged time entry"],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);
  const detail = counts.length ? `\n\nThis also permanently deletes its ${counts.join(", ")}.` : "";
  if (!confirm(`Permanently remove "${project.name}"?${detail}\n\nThis can't be undone.`)) return;

  try {
    for (const e of projectEntries) await TimeEntries.remove(e.id);
    for (const d of projectDueDates) await DueDates.remove(d.id);
    for (const a of projectAssignments) await Assignments.remove(a.id);
    for (const t of projectTasks) await Tasks.remove(t.id);
    await Projects.remove(projectId);
    showToast(`"${project.name}" removed.`);
    syncBudgetsToSheet();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// Keep the Google Sheet's Task Budgets tab current. Best-effort: if it fails,
// the next invoice sync rewrites budgets anyway.
function syncBudgetsToSheet() {
  if (!sheetSyncEnabled()) return;
  postToSheet({ budgets: buildBudgets({ tasks, projects }) })
    .catch((err) => console.warn("Sheet budget sync failed:", err));
}

function modalTaskRowHtml(taskId, name, budget, startDate, endDate) {
  return `<div class="modal-task-row" data-task-id="${taskId || ""}">
    <div class="modal-task-row-main">
      <input type="text" class="modalTaskName" placeholder="Task name" value="${esc(name || "")}" />
      <input type="number" class="modalTaskBudget" placeholder="Budget ($)" min="0" step="0.01" value="${budget || ""}" />
      <button type="button" class="danger small removeTaskRow">&times;</button>
    </div>
    <div class="modal-task-row-dates">
      <span>Schedule (optional):</span>
      <input type="date" class="modalTaskStart" value="${startDate || ""}" />
      <span>to</span>
      <input type="date" class="modalTaskEnd" value="${endDate || ""}" />
    </div>
  </div>`;
}

function openProjectModal(project) {
  modalEditingProjectId = project ? project.id : null;
  pendingTaskDeletions = new Set();
  projectModalTitle.textContent = project ? "Edit Project" : "Add Project";
  modalProjectName.value = project ? project.name : "";
  modalProjectClient.value = project ? project.client || "" : "";
  modalBillToName.value = project ? project.billToName || "" : "";
  modalBillToCompany.value = project ? project.billToCompany || "" : "";
  modalBillToAddress1.value = project ? project.billToAddress1 || "" : "";
  modalBillToAddress2.value = project ? project.billToAddress2 || "" : "";
  modalProjectNumber.value = project ? project.projectNumber || "" : "";
  // New projects start at the firm's standard rate; existing ones show their
  // own (blank = bill each person at their pay rate).
  modalProjectBillRate.value = project ? (project.billRate || "") : DEFAULT_BILL_RATE;
  modalProjectInternal.checked = !!(project && project.internal);

  const projectTasks = project ? tasks.filter((t) => t.projectId === project.id) : [];
  modalTaskRows.innerHTML = projectTasks.length > 0
    ? projectTasks.map((t) => modalTaskRowHtml(t.id, t.name, t.budget, t.startDate, t.endDate)).join("")
    : modalTaskRowHtml();
  syncInternalFields();

  projectModal.style.display = "flex";
  modalProjectName.focus();
}

function closeProjectModal() {
  projectModal.style.display = "none";
}

document.getElementById("openAddProject").addEventListener("click", () => openProjectModal(null));
modalProjectInternal.addEventListener("change", syncInternalFields);
document.getElementById("modalAddTaskRow").addEventListener("click", () => {
  modalTaskRows.insertAdjacentHTML("beforeend", modalTaskRowHtml());
});
modalTaskRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".removeTaskRow");
  if (!btn) return;
  const row = btn.closest(".modal-task-row");
  if (row.dataset.taskId) pendingTaskDeletions.add(row.dataset.taskId);
  row.remove();
});
document.getElementById("modalCancelProject").addEventListener("click", closeProjectModal);
closeOnBackdropClick(projectModal, closeProjectModal);

document.getElementById("modalSaveProject").addEventListener("click", async () => {
  const name = modalProjectName.value.trim();
  const client = modalProjectClient.value.trim();
  const billToName = modalBillToName.value.trim();
  const billToCompany = modalBillToCompany.value.trim();
  const billToAddress1 = modalBillToAddress1.value.trim();
  const billToAddress2 = modalBillToAddress2.value.trim();
  const projectNumber = modalProjectNumber.value.trim();
  const internal = modalProjectInternal.checked;
  const billRate = internal || modalProjectBillRate.value === "" ? null : Number(modalProjectBillRate.value);
  if (billRate != null && !(billRate > 0)) return showToast("Billing rate must be more than $0, or blank.");
  if (!name) return showToast("Enter a project name.");
  try {
    let projectId = modalEditingProjectId;
    const projectData = { name, client, billToName, billToCompany, billToAddress1, billToAddress2, projectNumber, billRate, internal };
    if (projectId) {
      await Projects.update(projectId, projectData);
    } else {
      const ref = await Projects.add(projectData);
      projectId = ref.id;
    }

    const rows = [...modalTaskRows.querySelectorAll(".modal-task-row")];
    for (const row of rows) {
      const taskId = row.dataset.taskId;
      const taskName = row.querySelector(".modalTaskName").value.trim();
      const taskBudget = internal ? 0 : Number(row.querySelector(".modalTaskBudget").value) || 0;
      const startDate = row.querySelector(".modalTaskStart").value || null;
      const endDate = row.querySelector(".modalTaskEnd").value || null;
      if (!taskName) continue;
      if (taskId) {
        await Tasks.update(taskId, { name: taskName, budget: taskBudget, startDate, endDate });
      } else {
        await Tasks.add({ projectId, name: taskName, budget: taskBudget, startDate, endDate });
      }
    }

    for (const taskId of pendingTaskDeletions) {
      await Tasks.remove(taskId);
      const related = assignments.filter((a) => a.taskId === taskId);
      for (const a of related) await Assignments.remove(a.id);
    }

    selectedProjectId = projectId;
    renderProjectCards();
    closeProjectModal();
    showToast(modalEditingProjectId ? "Project updated." : "Project added.");
    syncBudgetsToSheet();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Tasks + Assignments ----------
// Same compact table as the Projects page (Task / Budget / Spent / Progress /
// Remaining, plus Unassigned for handing out hours). Click a task to open its
// people: each has an hours box, the same assigned-vs-logged bar staff see,
// and a remove button. Changing hours (typing or the arrows) updates the bar
// and Unassigned immediately and saves itself a moment later. Assignments are
// usually added a bit at a time, so unassigned budget is normal; red only
// means a task's assignments went past its budget.
const taskBlocks = document.getElementById("taskBlocks");
const tasksEmpty = document.getElementById("tasksEmpty");
const openTaskIds = new Set(); // tasks whose people are showing
let addingTaskId = null;       // task whose "Add person" form is open
let renderDeferred = false;    // skip re-rendering while someone is editing hours
const saveTimers = {};         // assignmentId -> pending auto-save
const SAVE_DELAY_MS = 800;

const ctx = () => ({ projects, people });

// Budgets are spent at the project's bill rate (see rates.js).
function billRate(e) {
  return billRateOf(e, ctx());
}

function spentOnTask(taskId) {
  return timeEntries
    .filter((e) => e.taskId === taskId)
    .reduce((sum, e) => sum + Number(e.hours || 0) * billRate(e), 0);
}

function loggedHours(taskId, personId = null) {
  return timeEntries
    .filter((e) => e.taskId === taskId && (!personId || e.personId === personId))
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);
}

function personById(id) {
  return people.find((p) => p.id === id);
}

// Budget not yet handed out. Hours on projects with one bill rate; dollars on
// staff-rate projects, where an hour costs a different amount depending on
// who works it. hoursOverride ({ assignmentId: hours }) follows unsaved edits.
function unassignedHtml(task, project, hoursOverride = {}) {
  const hoursOf = (a) => (a.id in hoursOverride ? hoursOverride[a.id] : assignedHours(a, ctx()));
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  if (isInternal(project)) {
    return `${fmtHrs(taskAssignments.reduce((s, a) => s + hoursOf(a), 0))} hrs`;
  }
  const budget = Number(task.budget || 0);
  const assignedDollars = taskAssignments.reduce((s, a) =>
    s + hoursOf(a) * assignmentRate(project, personById(a.personId)), 0);
  const open = budget - assignedDollars;
  const label = (dollars) => (project.billRate ? `${fmtHrs(dollars / Number(project.billRate))} hrs` : formatCurrency(dollars));
  return open < -0.005
    ? `<span class="hours-over-strong">Over by ${label(-open)}</span>`
    : label(open);
}

function personRowHtml(a, color) {
  const person = personById(a.personId);
  const hours = assignedHours(a, ctx());
  const logged = loggedHours(a.taskId, a.personId);
  return `<div class="assign-row" data-assignment-id="${a.id}" data-logged="${logged}">
    <div class="assign-name">${person ? esc(person.name) : "—"}<div class="empty" style="padding:0; font-size:12px;">${person ? formatCurrency(person.rate) : "$0"}/hr</div></div>
    <div class="assign-input"><input type="number" class="assignHours" data-id="${a.id}" min="0" step="0.5" value="${Math.round(hours * 100) / 100}" /> hrs <span class="saved-tick"></span></div>
    <div class="assign-bar">${hoursBarHtml(logged, hours, color)}</div>
    <button class="icon-btn" data-action="remove-assignment" data-id="${a.id}" title="Remove from task" aria-label="Remove">&times;</button>
  </div>`;
}

function addPersonHtml(task) {
  const assignedIds = assignments.filter((a) => a.taskId === task.id).map((a) => a.personId);
  const available = people.filter((p) => !assignedIds.includes(p.id));
  if (available.length === 0) return "";
  if (addingTaskId !== task.id) {
    return `<button class="link-btn" data-action="open-add" data-task-id="${task.id}">+ Add person</button>`;
  }
  return `<div class="assign-row assign-add">
    <div class="assign-name"><select class="newAssignPerson">
      ${available.map((p) => `<option value="${p.id}">${esc(p.name)} (${formatCurrency(p.rate)}/hr)</option>`).join("")}
    </select></div>
    <div class="assign-input"><input type="number" class="newAssignHours" min="0" step="0.5" placeholder="20" /> hrs</div>
    <div class="row-actions">
      <button class="small" data-action="add-assignment" data-task-id="${task.id}" data-project-id="${task.projectId}">Add</button>
      <button class="small secondary" data-action="cancel-add">Cancel</button>
    </div>
  </div>`;
}

function taskDetailHtml(task, project) {
  const color = projectColor(project.id);
  const rows = assignments.filter((a) => a.taskId === task.id)
    .sort((a, b) => (personById(a.personId)?.name || "").localeCompare(personById(b.personId)?.name || ""))
    .map((a) => personRowHtml(a, color)).join("");
  return `<div class="assign-list">
    ${rows || '<div class="empty" style="padding:4px 0;">No one assigned yet.</div>'}
    ${addPersonHtml(task)}
  </div>`;
}

function renderTasks() {
  // Don't wipe an hours box someone is in the middle of editing.
  if (taskBlocks.contains(document.activeElement) && document.activeElement.matches(".assignHours")) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;

  const project = projects.find((p) => p.id === selectedProjectId);
  const projectTasks = tasks.filter((t) => t.projectId === selectedProjectId)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!project || projectTasks.length === 0) {
    taskBlocks.innerHTML = "";
    tasksEmpty.style.display = "block";
    return;
  }
  tasksEmpty.style.display = "none";
  const internal = isInternal(project);

  const head = internal
    ? `<tr><th>Task</th><th>Assigned</th><th>Logged</th><th style="width:160px;">Progress</th></tr>`
    : `<tr><th>Task</th><th>Budget</th><th>Spent</th><th style="width:160px;">Progress</th><th>Remaining</th><th>Unassigned</th></tr>`;
  const cols = internal ? 4 : 6;

  const body = projectTasks.map((t, i) => {
    const open = openTaskIds.has(t.id);
    let cells;
    if (internal) {
      const assigned = assignments.filter((a) => a.taskId === t.id).reduce((s, a) => s + assignedHours(a, ctx()), 0);
      const logged = loggedHours(t.id);
      const pct = assigned > 0 ? Math.min(100, (logged / assigned) * 100) : 0;
      cells = `<td class="unassignedCell">${fmtHrs(assigned)} hrs</td><td>${fmtHrs(logged)} hrs</td>
        <td><div class="progress-bar"><div class="fill ${logged > assigned ? "over-soft" : ""}" style="width:${pct}%"></div></div></td>`;
    } else {
      const budget = Number(t.budget || 0);
      const spent = spentOnTask(t.id);
      const remaining = budget - spent;
      const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
      cells = `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
        <td><div class="progress-bar"><div class="fill ${spent > budget ? "over" : ""}" style="width:${pct}%"></div></div></td>
        <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>
        <td class="unassignedCell">${unassignedHtml(t, project)}</td>`;
    }
    const stripe = i % 2 === 1 ? "stripe" : "";
    const mainRow = `<tr class="task-row ${stripe} ${open ? "expanded" : ""}" data-task-id="${t.id}">
      <td><span class="task-chevron" aria-hidden="true">&#9656;</span> ${esc(t.name)}</td>${cells}</tr>`;
    if (!open) return mainRow;
    return mainRow + `<tr class="task-detail" data-task-id="${t.id}"><td colspan="${cols}" class="accordion-cell">${taskDetailHtml(t, project)}</td></tr>`;
  }).join("");

  taskBlocks.innerHTML = `<table class="task-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;

  if (addingTaskId) {
    const hoursInput = taskBlocks.querySelector(".newAssignHours");
    if (hoursInput) hoursInput.focus();
  }
}

// Redraw a task's people bars and Unassigned cell from the hours boxes as
// they're being edited (before the save lands).
function liveUpdateTask(detailRow) {
  const task = tasks.find((t) => t.id === detailRow.dataset.taskId);
  const project = projects.find((p) => p.id === task.projectId);
  const color = projectColor(project.id);
  const override = {};
  detailRow.querySelectorAll(".assign-row[data-assignment-id]").forEach((row) => {
    const value = Number(row.querySelector(".assignHours").value);
    const hours = isNaN(value) || value < 0 ? 0 : value;
    override[row.dataset.assignmentId] = hours;
    row.querySelector(".assign-bar").innerHTML = hoursBarHtml(Number(row.dataset.logged || 0), hours, color);
  });
  const mainRow = taskBlocks.querySelector(`tr.task-row[data-task-id="${task.id}"] .unassignedCell`);
  if (mainRow) mainRow.innerHTML = unassignedHtml(task, project, override);
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

taskBlocks.addEventListener("input", (e) => {
  if (!e.target.classList.contains("assignHours")) return;
  liveUpdateTask(e.target.closest("tr.task-detail"));
  scheduleSave(e.target);
});

taskBlocks.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.classList.contains("assignHours")) e.target.blur();
  if (e.target.classList.contains("newAssignHours")) taskBlocks.querySelector('[data-action="add-assignment"]')?.click();
});

taskBlocks.addEventListener("focusout", (e) => {
  if (e.target.classList.contains("assignHours")) {
    // Leaving the box saves right away; an invalid entry snaps back.
    const assignment = assignments.find((a) => a.id === e.target.dataset.id);
    const value = Number(e.target.value);
    if (assignment && (e.target.value === "" || isNaN(value) || value < 0)) {
      e.target.value = Math.round(assignedHours(assignment, ctx()) * 100) / 100;
      liveUpdateTask(e.target.closest("tr.task-detail"));
    }
    if (saveTimers[e.target.dataset.id]) saveHours(e.target);
  }
  // Catch up on any re-render skipped while editing.
  setTimeout(() => { if (renderDeferred) renderTasks(); }, 0);
});

// Finish any hours edit in progress (saving it) before the list redraws.
function finishEditing() {
  const el = document.activeElement;
  if (taskBlocks.contains(el) && el.matches(".assignHours")) {
    if (saveTimers[el.dataset.id]) saveHours(el);
    el.blur();
  }
}

taskBlocks.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) {
    const row = e.target.closest("tr.task-row");
    if (!row) return;
    finishEditing();
    const taskId = row.dataset.taskId;
    if (openTaskIds.has(taskId)) openTaskIds.delete(taskId); else openTaskIds.add(taskId);
    if (addingTaskId === taskId) addingTaskId = null;
    renderTasks();
    return;
  }
  const { action, id } = btn.dataset;
  if (["open-add", "cancel-add"].includes(action)) finishEditing();

  if (action === "open-add") {
    addingTaskId = btn.dataset.taskId;
    renderTasks();
  }
  if (action === "cancel-add") {
    addingTaskId = null;
    renderTasks();
  }
  if (action === "remove-assignment") {
    const a = assignments.find((x) => x.id === id);
    const name = a ? personById(a.personId)?.name : null;
    if (!confirm(`Remove ${name || "this person"} from this task?`)) return;
    try { await Assignments.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "add-assignment") {
    const row = btn.closest(".assign-add");
    const personId = row.querySelector(".newAssignPerson").value;
    const hoursValue = row.querySelector(".newAssignHours").value;
    const hours = hoursValue === "" ? 0 : Number(hoursValue);
    if (!personId) return showToast("Select a person.");
    if (isNaN(hours) || hours < 0) return showToast("Enter a valid number of hours.");
    addingTaskId = null;
    // Leave the hours box first (Enter adds from inside it), so the list re-renders.
    if (taskBlocks.contains(document.activeElement)) document.activeElement.blur();
    try {
      await Assignments.add({ projectId: btn.dataset.projectId, taskId: btn.dataset.taskId, personId, hours });
      showToast("Assigned.");
    } catch (err) { showToast("Error: " + err.message); }
  }
});

// Assignments used to be stored as dollar amounts. Convert any old ones to
// hours once (at the rate they were entered against) so they stop shifting
// when someone's pay rate changes.
let assignmentsMigrated = false;
async function migrateLegacyAssignments() {
  if (assignmentsMigrated || !assignmentsLoaded || !people.length || !projects.length) return;
  const legacy = assignments.filter((a) => a.hours == null);
  assignmentsMigrated = true;
  for (const a of legacy) {
    const hours = Math.round(assignedHours(a, ctx()) * 100) / 100;
    try { await Assignments.update(a.id, { hours }); } catch (err) { console.warn("Assignment migration failed:", err); }
  }
}

// ---------- Pending Approval ----------
const pendingApprovalCard = document.getElementById("pendingApprovalCard");
const pendingApprovalTbody = document.querySelector("#pendingApprovalTable tbody");
const approveAllBtn = document.getElementById("approveAllBtn");

let expandedApprovalPersonId = null;

function pendingEntries() {
  return timeEntries
    .filter((e) => !e.approved && !e.invoiced)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// True when this person has logged more on the entry's task than assigned.
function isOverAssigned(e) {
  const assignment = assignments.find((a) => a.taskId === e.taskId && a.personId === e.personId);
  const assigned = assignment ? assignedHours(assignment, ctx()) : 0;
  return loggedHours(e.taskId, e.personId) - assigned > 0.005;
}

function pendingByPerson() {
  const byPerson = {};
  pendingEntries().forEach((e) => {
    if (!byPerson[e.personId]) byPerson[e.personId] = [];
    byPerson[e.personId].push(e);
  });
  return Object.entries(byPerson).map(([personId, entries]) => {
    const person = people.find((p) => p.id === personId);
    const totalHours = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
    return { personId, name: person ? person.name : "—", entries, totalHours };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderPendingApproval() {
  const groups = pendingByPerson();
  if (groups.length === 0) {
    pendingApprovalCard.style.display = "none";
    return;
  }
  pendingApprovalCard.style.display = "block";

  pendingApprovalTbody.innerHTML = groups.map((g) => {
    const expanded = g.personId === expandedApprovalPersonId;
    const mainRow = `<tr class="task-row ${expanded ? "expanded" : ""}" data-person-row="${g.personId}">
      <td colspan="4">${g.name} <span class="empty" style="padding:0;">(${g.entries.length} ${g.entries.length === 1 ? "entry" : "entries"})</span>${g.entries.some(isOverAssigned) ? " <span class=\"pill orange\">Over assigned hours</span>" : ""}</td>
      <td>${g.totalHours.toFixed(2)}</td>
      <td class="row-actions">
        <button class="small" data-action="approve-person" data-id="${g.personId}">Approve All</button>
      </td>
    </tr>`;

    if (!expanded) return mainRow;

    const subRows = g.entries.map((e) => {
      const project = projects.find((p) => p.id === e.projectId);
      const task = tasks.find((t) => t.id === e.taskId);
      const noteHtml = e.note ? `<div class="empty" style="padding:2px 0 0;">${esc(e.note)}</div>` : "";
      return `<tr class="pending-sub-row">
        <td>${formatDate(e.date)}</td>
        <td></td>
        <td>${project ? project.name : "—"}</td>
        <td>${task ? task.name : "—"}${isOverAssigned(e) ? " <span class=\"pill orange\" title=\"This person has logged more on this task than they are assigned\">Over assigned</span>" : ""}${noteHtml}</td>
        <td>${e.hours}</td>
        <td class="row-actions">
          <button class="small" data-action="approve-entry" data-id="${e.id}">Approve</button>
        </td>
      </tr>`;
    }).join("");

    return mainRow + subRows;
  }).join("");
}

pendingApprovalTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) {
    const row = e.target.closest("tr.task-row");
    if (row) {
      const id = row.dataset.personRow;
      expandedApprovalPersonId = expandedApprovalPersonId === id ? null : id;
      renderPendingApproval();
    }
    return;
  }
  const { action, id } = btn.dataset;
  if (action === "approve-entry") {
    try {
      await TimeEntries.approve([id]);
      showToast("Entry approved.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }
  if (action === "approve-person") {
    const group = pendingByPerson().find((g) => g.personId === id);
    if (!group) return;
    try {
      await TimeEntries.approve(group.entries.map((e) => e.id));
      showToast(`${group.name}'s hours approved.`);
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }
});

approveAllBtn.addEventListener("click", async () => {
  const ids = pendingEntries().map((e) => e.id);
  if (ids.length === 0) return;
  if (!confirm(`Approve all ${ids.length} pending ${ids.length === 1 ? "entry" : "entries"}?`)) return;
  try {
    await TimeEntries.approve(ids);
    showToast("All entries approved.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
