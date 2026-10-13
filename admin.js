import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices } from "./db.js";
import { formatCurrency, formatDate, showToast, fmtHrs } from "./util.js";
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
let expandedTaskId = null;
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
personModal.addEventListener("click", (e) => {
  if (e.target === personModal) closePersonModal();
});

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
      expandedTaskId = null;
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
projectModal.addEventListener("click", (e) => {
  if (e.target === projectModal) closeProjectModal();
});

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

// ---------- Tasks + Assignments (merged) ----------
// Assignments are hours per person per task, usually added a bit at a time as
// work goes on — so unassigned budget is normal, not a warning. The real limit
// is the task's budget: red only when assigned or spent goes past it. People
// logging past their own assigned hours are flagged (amber) so you can add more.
const tasksTbody = document.querySelector("#tasksTable tbody");
const tasksEmpty = document.getElementById("tasksEmpty");

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

// Assigned hours/dollars for a task. Dollars are hours at each person's
// budget rate (the project's bill rate, or their pay rate on staff-rate projects).
function taskAssignmentTotals(task) {
  const project = projects.find((p) => p.id === task.projectId);
  return assignments.filter((a) => a.taskId === task.id).reduce((t, a) => {
    const hours = assignedHours(a, ctx());
    t.hours += hours;
    t.dollars += hours * assignmentRate(project, personById(a.personId));
    if (loggedHours(task.id, a.personId) - hours > 0.005) t.overPeople += 1;
    return t;
  }, { hours: 0, dollars: 0, overPeople: 0 });
}

// "40 hrs" on projects with one bill rate; dollars on staff-rate projects,
// where an hour costs a different amount depending on who works it.
function availableLabel(project, dollars) {
  return project && project.billRate ? `${fmtHrs(dollars / project.billRate)} hrs` : formatCurrency(dollars);
}

function renderTasks() {
  const project = projects.find((p) => p.id === selectedProjectId);
  const internal = isInternal(project);
  const projectTasks = tasks.filter((t) => t.projectId === selectedProjectId);
  document.querySelector("#tasksTable thead").innerHTML = internal
    ? `<tr><th>Task</th><th></th><th>Logged</th><th style="width:160px;">Progress</th><th>Assigned</th></tr>`
    : `<tr><th>Task</th><th>Budget</th><th>Spent</th><th style="width:160px;">Progress</th><th>Assigned</th></tr>`;
  if (projectTasks.length === 0) {
    tasksTbody.innerHTML = "";
    tasksEmpty.style.display = "block";
    return;
  }
  tasksEmpty.style.display = "none";

  tasksTbody.innerHTML = projectTasks.map((t) => {
    const totals = taskAssignmentTotals(t);
    const overFlag = totals.overPeople
      ? ` <span class="pill orange" title="Logged more than their assigned hours">${totals.overPeople} over assigned</span>` : "";
    let cells;
    if (internal) {
      const logged = loggedHours(t.id);
      const pct = totals.hours > 0 ? Math.min(100, (logged / totals.hours) * 100) : 0;
      cells = `<td></td><td>${fmtHrs(logged)} hrs</td>
        <td><div class="progress-bar"><div class="fill ${logged > totals.hours ? "over-soft" : ""}" style="width:${pct}%"></div></div></td>
        <td>${fmtHrs(totals.hours)} hrs${overFlag}</td>`;
    } else {
      const budget = Number(t.budget || 0);
      const spent = spentOnTask(t.id);
      const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
      const available = budget - totals.dollars;
      const assignedCell = available < -0.005
        ? `<span class="pill red">Over-assigned by ${availableLabel(project, -available)}</span>`
        : `${fmtHrs(totals.hours)} hrs <span class="empty" style="padding:0;">&middot; ${availableLabel(project, available)} available</span>`;
      cells = `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
        <td><div class="progress-bar"><div class="fill ${spent > budget ? "over" : ""}" style="width:${pct}%"></div></div></td>
        <td>${assignedCell}${overFlag}</td>`;
    }
    const expanded = t.id === expandedTaskId;
    const mainRow = `<tr class="task-row ${expanded ? "expanded" : ""}" data-task-row="${t.id}"><td>${esc(t.name)}</td>${cells}</tr>`;
    if (!expanded) return mainRow;
    return mainRow + `<tr><td colspan="5" class="accordion-cell">${renderAccordion(t, project)}</td></tr>`;
  }).join("");
}

function renderAccordion(task, project) {
  const internal = isInternal(project);
  const taskAssignments = assignments.filter((a) => a.taskId === task.id)
    .sort((a, b) => (personById(a.personId)?.name || "").localeCompare(personById(b.personId)?.name || ""));
  const assignedPersonIds = taskAssignments.map((a) => a.personId);
  const availablePeople = people.filter((p) => !assignedPersonIds.includes(p.id));

  const rows = taskAssignments.map((a) => {
    const person = personById(a.personId);
    const rate = assignmentRate(project, person);
    const hours = assignedHours(a, ctx());
    const logged = loggedHours(task.id, a.personId);
    return `<tr class="assignmentRow" data-assignment-id="${a.id}" data-rate="${rate}" data-logged="${logged}">
      <td>${person ? esc(person.name) : "—"} <span class="empty" style="padding:0;">(${person ? formatCurrency(person.rate) : "$0"}/hr)</span></td>
      <td>
        <div class="assign-hours">
          <input type="number" class="editHours" min="0" step="0.5" value="${Math.round(hours * 100) / 100}" /> hrs
          <button class="small secondary" data-action="bump" data-amount="5">+5</button>
          <button class="small secondary" data-action="bump" data-amount="10">+10</button>
        </div>
        ${internal ? "" : `<div class="empty assignDollars" style="padding:2px 0 0;">${formatCurrency(hours * rate)}</div>`}
      </td>
      <td>${fmtHrs(logged)} hrs${internal ? "" : `<div class="empty" style="padding:2px 0 0;">${formatCurrency(spentByPerson(task.id, a.personId))}</div>`}</td>
      <td class="leftCell">${leftHtml(hours, logged)}</td>
      <td><button class="danger small" data-action="remove-assignment" data-id="${a.id}">Remove</button></td>
    </tr>`;
  }).join("");

  const addRow = availablePeople.length === 0
    ? `<div class="empty">Everyone on the team is already assigned to this task.</div>`
    : `<div class="inline-form" style="margin-top:4px;">
        <div>
          <label>Assign someone</label>
          <select class="newAssignPerson">
            ${availablePeople.map((p) => `<option value="${p.id}">${esc(p.name)} (${formatCurrency(p.rate)}/hr)</option>`).join("")}
          </select>
        </div>
        <div style="flex:0 0 120px;">
          <label>Hours</label>
          <input type="number" class="newAssignHours" min="0" step="0.5" placeholder="20" />
        </div>
        <div style="flex:0;">
          <label>&nbsp;</label>
          <button class="small" data-action="add-assignment" data-task-id="${task.id}" data-project-id="${task.projectId}">Add</button>
        </div>
      </div>`;

  return `
    <div class="assign-summary" data-task-id="${task.id}">${assignSummaryHtml(task, project)}</div>
    ${taskAssignments.length > 0 ? `<table style="margin-top:10px;">
      <thead><tr><th>Person</th><th>Assigned</th><th>Logged</th><th>Left</th><th style="width:90px;"></th></tr></thead>
      <tbody class="assignmentRows">${rows}</tbody>
    </table>
    <div class="row-actions" style="margin-top:10px; align-items:center;">
      <button class="small" data-action="save-assignments" data-task-id="${task.id}">Save Changes</button>
      <span class="empty unsavedNote" style="padding:0; display:none;">Unsaved changes</span>
    </div>` : `<div class="empty">No one assigned to this task yet.</div>`}
    <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border);">
      ${addRow}
    </div>
  `;
}

function spentByPerson(taskId, personId) {
  return timeEntries
    .filter((e) => e.taskId === taskId && e.personId === personId)
    .reduce((sum, e) => sum + Number(e.hours || 0) * billRate(e), 0);
}

function leftHtml(assigned, logged) {
  const left = assigned - logged;
  return left < -0.005
    ? `<span class="hours-over">${fmtHrs(-left)} hrs over</span>`
    : `${fmtHrs(left)} hrs`;
}

// Totals line above the people table. overrideHours (from unsaved inputs)
// lets it update live while editing.
function assignSummaryHtml(task, project, override = null) {
  const totals = override || taskAssignmentTotals(task);
  const logged = loggedHours(task.id);
  const part = (label, value) => `<span><span class="summary-label">${label}</span> ${value}</span>`;
  if (isInternal(project)) {
    return part("Assigned", `<strong>${fmtHrs(totals.hours)} hrs</strong>`) + part("Logged", `${fmtHrs(logged)} hrs`);
  }
  const budget = Number(task.budget || 0);
  const spent = spentOnTask(task.id);
  const available = budget - totals.dollars;
  const budgetHours = project && project.billRate ? ` <span class="empty" style="padding:0;">(${fmtHrs(budget / project.billRate)} hrs at ${formatCurrency(project.billRate)}/hr)</span>` : "";
  return part("Budget", `${formatCurrency(budget)}${budgetHours}`)
    + part("Assigned", `<strong>${fmtHrs(totals.hours)} hrs</strong> <span class="empty" style="padding:0;">(${formatCurrency(totals.dollars)})</span>`)
    + part("Logged", `${fmtHrs(logged)} hrs <span class="empty" style="padding:0;">(${formatCurrency(spent)})</span>`)
    + part("Available to assign", available < -0.005
      ? `<span class="pill red">Over by ${availableLabel(project, -available)}</span>`
      : `<strong>${availableLabel(project, available)}</strong>`);
}

function liveRecomputeAssignments(accordionCell) {
  const summaryEl = accordionCell.querySelector(".assign-summary");
  if (!summaryEl) return;
  const task = tasks.find((t) => t.id === summaryEl.dataset.taskId);
  const project = projects.find((p) => p.id === task.projectId);
  const totals = { hours: 0, dollars: 0 };
  accordionCell.querySelectorAll(".assignmentRow").forEach((row) => {
    const hours = Number(row.querySelector(".editHours").value) || 0;
    const rate = Number(row.dataset.rate || 0);
    totals.hours += hours;
    totals.dollars += hours * rate;
    row.querySelector(".leftCell").innerHTML = leftHtml(hours, Number(row.dataset.logged || 0));
    const dollarsEl = row.querySelector(".assignDollars");
    if (dollarsEl) dollarsEl.textContent = formatCurrency(hours * rate);
  });
  summaryEl.innerHTML = assignSummaryHtml(task, project, totals);
  const note = accordionCell.querySelector(".unsavedNote");
  if (note) note.style.display = "inline";
}

tasksTbody.addEventListener("input", (e) => {
  if (!e.target.classList.contains("editHours")) return;
  const cell = e.target.closest(".accordion-cell");
  if (cell) liveRecomputeAssignments(cell);
});

tasksTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");

  if (!btn) {
    const row = e.target.closest("tr.task-row");
    if (row) {
      const taskId = row.dataset.taskRow;
      expandedTaskId = expandedTaskId === taskId ? null : taskId;
      renderTasks();
    }
    return;
  }

  const { action, id } = btn.dataset;

  if (action === "bump") {
    const input = btn.closest(".assign-hours").querySelector(".editHours");
    input.value = Math.round(((Number(input.value) || 0) + Number(btn.dataset.amount)) * 100) / 100;
    liveRecomputeAssignments(btn.closest(".accordion-cell"));
    return;
  }
  if (action === "remove-assignment") {
    if (!confirm("Remove this person from the task?")) return;
    try { await Assignments.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "save-assignments") {
    const cell = btn.closest(".accordion-cell");
    try {
      for (const row of cell.querySelectorAll(".assignmentRow")) {
        const assignmentId = row.dataset.assignmentId;
        const hours = Number(row.querySelector(".editHours").value) || 0;
        const original = assignments.find((a) => a.id === assignmentId);
        if (original && (original.hours == null || Math.abs(Number(original.hours) - hours) > 0.001)) {
          await Assignments.update(assignmentId, { hours });
        }
      }
      showToast("Assignments saved.");
    } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "add-assignment") {
    const container = btn.closest(".accordion-cell");
    const personId = container.querySelector(".newAssignPerson").value;
    const hoursInput = container.querySelector(".newAssignHours");
    const hours = hoursInput.value === "" ? 0 : Number(hoursInput.value);
    if (!personId) return showToast("Select a person.");
    if (isNaN(hours) || hours < 0) return showToast("Enter a valid number of hours.");
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
