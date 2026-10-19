import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Staff, normEmail } from "./db.js";
import {
  formatCurrency, showToast, fmtHrs, closeOnBackdropClick, hoursBarHtml, projectColor, budgetBarHtml, sortProjects, esc,
} from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName, isTestMode } from "./session.js";
import { sheetSyncEnabled, buildBudgets, postToSheet } from "./sheets.js";
import {
  DEFAULT_BILL_RATE, billRateOf, assignmentRate, assignedHours, isInternal, personPayRate, personBillRate,
  taskBudgetUse,
} from "./rates.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let adminCheckDone = false;
let staff = [];
let staffLoaded = false;

let modalEditingPersonId = null;
let selectedProjectId = null;
let modalEditingProjectId = null;
let pendingTaskDeletions = new Set();

wireLogout("logoutLink");

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
    syncStaff();
  });
  Staff.listen((d) => { staff = d; staffLoaded = true; syncStaff(); });
  Projects.listen((d) => { projects = d; renderProjectCards(); renderPendingApproval(); });
  Tasks.listen((d) => { tasks = d; renderTasks(); renderPendingApproval(); });
  Assignments.listen((d) => { assignments = d; renderTasks(); renderPendingApproval(); });
  TimeEntries.listen((d) => { timeEntries = d; renderTasks(); renderPendingApproval(); });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; });
}

// ---------- People (table + modal) ----------
const peopleTbody = document.querySelector("#peopleTable tbody");
const peopleEmpty = document.getElementById("peopleEmpty");

const personModal = document.getElementById("personModal");
const personModalTitle = document.getElementById("personModalTitle");
const modalPersonName = document.getElementById("modalPersonName");
const modalPersonRate = document.getElementById("modalPersonRate");
const modalPersonBillRate = document.getElementById("modalPersonBillRate");
const modalPersonAdmin = document.getElementById("modalPersonAdmin");
const modalPersonEmail = document.getElementById("modalPersonEmail");

function renderPeople() {
  if (people.length === 0) {
    peopleTbody.innerHTML = "";
    peopleEmpty.style.display = "block";
    return;
  }
  peopleEmpty.style.display = "none";
  // Active people by pay rate (highest first), then deactivated people.
  const byPay = [...people].sort((a, b) =>
    (!!a.inactive - !!b.inactive) || personPayRate(b) - personPayRate(a) || a.name.localeCompare(b.name));
  peopleTbody.innerHTML = byPay.map((p, i) => `
    <tr class="${i % 2 === 1 ? "stripe-row" : ""} ${p.inactive ? "inactive-row" : ""}">
      <td>${esc(p.name)}${p.isAdmin ? ' <span class="pill orange">Admin</span>' : ""}${p.inactive ? ' <span class="pill">Inactive</span>' : ""}
        <div class="person-email ${p.email ? "" : "missing"}">${p.email ? esc(p.email) : "No email"}</div></td>
      <td>${formatCurrency(personPayRate(p))}/hr</td>
      <td>${formatCurrency(personBillRate(p))}/hr${p.billRate == null ? ' <span class="empty" style="padding:0;">(not set — using pay rate)</span>' : ""}</td>
      <td><div class="row-actions" style="justify-content:flex-end;">
        <button class="small secondary" data-action="edit-person" data-id="${p.id}">Edit</button>
        ${p.inactive
          ? `<button class="small secondary" data-action="reactivate-person" data-id="${p.id}">Reactivate</button>`
          : `<button class="danger small" data-action="remove-person" data-id="${p.id}">Remove</button>`}
      </div></td>
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
  if (action === "remove-person") await removePerson(id);
  if (action === "reactivate-person") {
    try { await People.update(id, { inactive: false }); showToast("Reactivated."); } catch (err) { showToast("Error: " + err.message); }
  }
});

// Keep the Google sign-in list (Staff) matching People: one entry per active
// person with an email, carrying their admin flag. Runs whenever either
// changes, so adding an email, toggling admin or deactivating someone
// updates who can sign in.
let syncing = false;
async function syncStaff() {
  if (!staffLoaded || syncing || isTestMode()) return;
  const me = people.find((p) => p.id === sessionPersonId);
  if (!me || !me.isAdmin) return;
  const want = new Map(people
    .filter((p) => !p.inactive && normEmail(p.email))
    .map((p) => [normEmail(p.email), { personId: p.id, isAdmin: !!p.isAdmin }]));
  const ops = [];
  want.forEach((data, email) => {
    const cur = staff.find((s) => s.id === email);
    if (!cur || cur.personId !== data.personId || !!cur.isAdmin !== data.isAdmin) ops.push(Staff.set(email, data));
  });
  staff.filter((s) => !want.has(s.id)).forEach((s) => ops.push(Staff.remove(s.id)));
  people.filter((p) => p.password).forEach((p) => ops.push(People.update(p.id, { password: null })));
  if (!ops.length) return;
  syncing = true;
  try { await Promise.all(ops); } catch (err) { showToast("Error updating sign-in list: " + err.message); }
  syncing = false;
}

// People with logged hours or task assignments can't be deleted without
// breaking history (timesheets, invoices), so they're deactivated instead:
// hidden from login and from pickers, but kept on past records.
async function removePerson(id) {
  const person = personById(id);
  if (!person) return;
  if (id === sessionPersonId) return showToast("You can't remove yourself.");
  const hasHistory = timeEntries.some((e) => e.personId === id) || assignments.some((a) => a.personId === id);
  try {
    if (hasHistory) {
      if (!confirm(`${person.name} has logged hours or task assignments, so they can't be deleted without losing history.\n\nDeactivate them instead? They won't be able to log in or be assigned work, but their past hours stay on record. You can reactivate them later.`)) return;
      await People.update(id, { inactive: true });
      showToast(`${person.name} deactivated.`);
    } else {
      if (!confirm(`Permanently remove ${person.name}?`)) return;
      await People.remove(id);
      showToast(`${person.name} removed.`);
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

function openPersonModal(person) {
  modalEditingPersonId = person ? person.id : null;
  personModalTitle.textContent = person ? "Edit person" : "New person";
  modalPersonName.value = person ? person.name : "";
  modalPersonRate.value = person ? person.rate : "";
  // New people start at the firm's standard bill rate.
  modalPersonBillRate.value = person ? (person.billRate ?? "") : DEFAULT_BILL_RATE;
  modalPersonAdmin.checked = person ? !!person.isAdmin : false;
  modalPersonEmail.value = person ? (person.email || "") : "";
  personModal.style.display = "flex";
  modalPersonName.focus();
}

function closePersonModal() {
  personModal.style.display = "none";
}

document.getElementById("openAddPerson").addEventListener("click", () => openPersonModal(null));
document.getElementById("modalCancelPerson").addEventListener("click", closePersonModal);
document.getElementById("modalClosePerson").addEventListener("click", closePersonModal);
closeOnBackdropClick(personModal, closePersonModal);

document.getElementById("modalSavePerson").addEventListener("click", async () => {
  const name = modalPersonName.value.trim();
  const rate = Number(modalPersonRate.value);
  const billRate = modalPersonBillRate.value === "" ? null : Number(modalPersonBillRate.value);
  const isAdmin = modalPersonAdmin.checked;
  const email = normEmail(modalPersonEmail.value) || null;
  if (!name || !rate) return showToast("Enter a name and pay rate.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showToast("Enter a valid email.");
  if (email && people.some((p) => p.id !== modalEditingPersonId && normEmail(p.email) === email)) {
    return showToast("Someone else already has that email.");
  }
  if (billRate != null && !(billRate >= 0)) return showToast("Enter a valid bill rate.");
  try {
    if (modalEditingPersonId) {
      await People.update(modalEditingPersonId, { name, email, rate, billRate, isAdmin, password: null });
      showToast("Person updated.");
    } else {
      await People.add({ name, email, rate, billRate, isAdmin });
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
const modalProjectType = document.getElementById("modalProjectType");
const modalTypeHint = document.getElementById("modalTypeHint");
const modalBillingFields = document.getElementById("modalBillingFields");
const modalTaskRows = document.getElementById("modalTaskRows");
const modalTaskHead = document.getElementById("modalTaskHead");
const modalTaskTotal = document.getElementById("modalTaskTotal");

// How a project bills: each person's bill rate (default), each person's pay
// rate (older no-overhead contracts like Cache County), or not at all.
const PROJECT_TYPES = {
  rates: "Hours are billed, and the budget spent, at each person's bill rate (set under People & Rates).",
  pay: "Hours are billed at each person's pay rate, with no overhead — for older contracts like Cache County.",
  internal: "Not billed to a client and staff aren't paid. Just tracks hours, e.g. Proposals & Pursuits.",
};
let modalType = "rates";

function projectTypeOf(project) {
  if (!project) return "rates";
  if (project.internal) return "internal";
  return project.billAtPayRate ? "pay" : "rates";
}

function setModalType(type) {
  modalType = type;
  modalProjectType.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.value === type;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  modalTypeHint.textContent = PROJECT_TYPES[type];
  const internal = type === "internal";
  modalBillingFields.style.display = internal ? "none" : "block";
  modalTaskRows.classList.toggle("internal", internal);
  modalTaskHead.classList.toggle("internal", internal);
  updateTaskTotal();
}

function updateTaskTotal() {
  const rows = [...modalTaskRows.querySelectorAll(".modal-task-row")];
  if (modalType === "internal") {
    modalTaskTotal.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"}` : "";
    return;
  }
  const total = rows.reduce((s, r) => s + (Number(r.querySelector(".modalTaskBudget").value) || 0), 0);
  modalTaskTotal.textContent = `${formatCurrency(total)} total budget`;
}

function renderProjectCards() {
  if (projects.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    tasksSection.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";

  const ordered = sortProjects(projects);
  if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
    selectedProjectId = ordered[0].id;
  }

  projectCardsEl.innerHTML = ordered.map((p) => `
    <div class="project-card project-card-colored ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}" style="--c:${projectColor(p.id)};">
      <div class="name">${esc(p.name)}</div>
      <div class="client">${p.client ? esc(p.client) : "&nbsp;"}</div>
      <div class="client">${p.internal ? "Internal &middot; not billed or paid" : p.billAtPayRate ? "Bills at staff pay rates" : "Bills at staff bill rates"}</div>
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
// subtasks and events, logged hours). Refuses if anything was ever invoiced, since
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
    [projectDueDates.length, "subtask/event"], [projectEntries.length, "logged time entry"],
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
  return `<div class="modal-task-row task-edit-grid" data-task-id="${taskId || ""}">
    <input type="text" class="modalTaskName" placeholder="Task name" value="${esc(name || "")}" />
    <div class="money-input col-budget"><span>$</span><input type="number" class="modalTaskBudget" placeholder="0" min="0" step="0.01" value="${budget || ""}" /></div>
    <input type="date" class="modalTaskStart" value="${startDate || ""}" title="Start (optional)" />
    <input type="date" class="modalTaskEnd" value="${endDate || ""}" title="End (optional)" />
    <button type="button" class="icon-btn removeTaskRow" title="Remove task" aria-label="Remove task">&times;</button>
  </div>`;
}

function openProjectModal(project) {
  modalEditingProjectId = project ? project.id : null;
  pendingTaskDeletions = new Set();
  projectModalTitle.textContent = project ? "Edit project" : "New project";
  modalProjectName.value = project ? project.name : "";
  modalProjectClient.value = project ? project.client || "" : "";
  modalBillToName.value = project ? project.billToName || "" : "";
  modalBillToCompany.value = project ? project.billToCompany || "" : "";
  modalBillToAddress1.value = project ? project.billToAddress1 || "" : "";
  modalBillToAddress2.value = project ? project.billToAddress2 || "" : "";
  modalProjectNumber.value = project ? project.projectNumber || "" : "";

  const projectTasks = project
    ? tasks.filter((t) => t.projectId === project.id).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  modalTaskRows.innerHTML = projectTasks.length > 0
    ? projectTasks.map((t) => modalTaskRowHtml(t.id, t.name, t.budget, t.startDate, t.endDate)).join("")
    : modalTaskRowHtml();
  setModalType(projectTypeOf(project));

  projectModal.style.display = "flex";
  modalProjectName.focus();
}

function closeProjectModal() {
  projectModal.style.display = "none";
}

document.getElementById("openAddProject").addEventListener("click", () => openProjectModal(null));
modalProjectType.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (btn) setModalType(btn.dataset.value);
});
document.getElementById("modalAddTaskRow").addEventListener("click", () => {
  modalTaskRows.insertAdjacentHTML("beforeend", modalTaskRowHtml());
  modalTaskRows.lastElementChild.querySelector(".modalTaskName").focus();
  updateTaskTotal();
});
modalTaskRows.addEventListener("input", (e) => {
  if (e.target.classList.contains("modalTaskBudget")) updateTaskTotal();
});
modalTaskRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".removeTaskRow");
  if (!btn) return;
  const row = btn.closest(".modal-task-row");
  const taskId = row.dataset.taskId;
  if (taskId) {
    // Hours logged on a task are part of the timesheet/invoice history.
    if (timeEntries.some((e) => e.taskId === taskId)) {
      alert("This task already has hours logged, so it can't be removed — that would break the timesheet and invoice history.");
      return;
    }
    const linked = assignments.filter((a) => a.taskId === taskId).length + dueDates.filter((d) => d.taskId === taskId).length;
    if (linked && !confirm(`Remove this task? Its ${linked} assignment${linked === 1 ? "" : "s"} and subtask${linked === 1 ? "" : "s"} will be removed too when you save.`)) return;
    pendingTaskDeletions.add(taskId);
  }
  row.remove();
  updateTaskTotal();
});
document.getElementById("modalCancelProject").addEventListener("click", closeProjectModal);
document.getElementById("modalCloseProject").addEventListener("click", closeProjectModal);
closeOnBackdropClick(projectModal, closeProjectModal);

document.getElementById("modalSaveProject").addEventListener("click", async () => {
  const name = modalProjectName.value.trim();
  const internal = modalType === "internal";
  if (!name) {
    modalProjectName.focus();
    return showToast("Give the project a name.");
  }
  const projectData = {
    name,
    client: modalProjectClient.value.trim(),
    billToName: modalBillToName.value.trim(),
    billToCompany: modalBillToCompany.value.trim(),
    billToAddress1: modalBillToAddress1.value.trim(),
    billToAddress2: modalBillToAddress2.value.trim(),
    projectNumber: modalProjectNumber.value.trim(),
    internal,
    billAtPayRate: modalType === "pay",
  };
  try {
    let projectId = modalEditingProjectId;
    if (projectId) {
      await Projects.update(projectId, projectData);
    } else {
      const ref = await Projects.add(projectData);
      projectId = ref.id;
    }

    for (const row of modalTaskRows.querySelectorAll(".modal-task-row")) {
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
      for (const a of assignments.filter((x) => x.taskId === taskId)) await Assignments.remove(a.id);
      for (const d of dueDates.filter((x) => x.taskId === taskId)) await DueDates.remove(d.id);
      await Tasks.remove(taskId);
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

// Budgets are spent at each person's bill rate (see rates.js).
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

// Budget not yet spent or handed out, in dollars (see taskBudgetUse).
// hoursOverride ({ assignmentId: hours }) follows unsaved edits.
function unassignedHtml(task, project, hoursOverride = {}) {
  const hoursOf = (a) => (a.id in hoursOverride ? hoursOverride[a.id] : assignedHours(a, ctx()));
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  if (isInternal(project)) {
    return `${fmtHrs(taskAssignments.reduce((s, a) => s + hoursOf(a), 0))} hrs`;
  }
  const open = taskBudgetUse(task, { projects, people, assignments, timeEntries }, hoursOverride).unassigned;
  return open < -0.005
    ? `<span class="hours-over-strong">Over by ${formatCurrency(-open)}</span>`
    : formatCurrency(open);
}

function ratesLabel(person, project) {
  if (!person) return "";
  return `Pay ${formatCurrency(personPayRate(person))} &middot; Bill ${formatCurrency(assignmentRate(project, person))}/hr`;
}

function personRowHtml(a, color) {
  const person = personById(a.personId);
  const project = projects.find((p) => p.id === a.projectId);
  const hours = assignedHours(a, ctx());
  const logged = loggedHours(a.taskId, a.personId);
  return `<div class="assign-row" data-assignment-id="${a.id}" data-logged="${logged}">
    <div class="assign-name">${person ? esc(person.name) : "—"}<div class="empty" style="padding:0; font-size:12px; font-weight:400;">${ratesLabel(person, project)}</div></div>
    <div class="assign-input"><input type="number" class="assignHours" data-id="${a.id}" min="0" step="0.5" value="${Math.round(hours * 100) / 100}" /> hrs <span class="saved-tick"></span></div>
    <div class="assign-bar">${hoursBarHtml(logged, hours, color)}</div>
    <button class="icon-btn" data-action="remove-assignment" data-id="${a.id}" title="Remove from task" aria-label="Remove">&times;</button>
  </div>`;
}

function addPersonHtml(task) {
  const assignedIds = assignments.filter((a) => a.taskId === task.id).map((a) => a.personId);
  const available = people.filter((p) => !p.inactive && !assignedIds.includes(p.id));
  if (available.length === 0) return "";
  if (addingTaskId !== task.id) {
    return `<button class="link-btn" data-action="open-add" data-task-id="${task.id}">+ Add person</button>`;
  }
  return `<div class="assign-row assign-add">
    <div class="assign-name"><select class="newAssignPerson">
      ${available.map((p) => `<option value="${p.id}">${esc(p.name)} (pay ${formatCurrency(personPayRate(p))}, bill ${formatCurrency(assignmentRate(projects.find((pr) => pr.id === task.projectId), p))})</option>`).join("")}
    </select></div>
    <div class="assign-input"><input type="number" class="newAssignHours" min="0" step="0.5" placeholder="20" /> hrs</div>
    <div class="row-actions">
      <button class="small" data-action="add-assignment" data-task-id="${task.id}" data-project-id="${task.projectId}">Add</button>
      <button class="small secondary" data-action="cancel-add">Cancel</button>
    </div>
  </div>`;
}

// Internal projects are open to everyone and have no assigned hours, so
// each person just shows the hours they've logged.
function loggedByPersonHtml(task) {
  const taskEntries = timeEntries.filter((e) => e.taskId === task.id);
  const ids = new Set([
    ...people.filter((p) => !p.inactive).map((p) => p.id),
    ...taskEntries.map((e) => e.personId),
  ]);
  const rows = [...ids]
    .map((pid) => ({ name: personById(pid)?.name || "—", hours: loggedHours(task.id, pid) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return rows.map((r) => `<tr class="person-subrow">
    <td>${esc(r.name)}</td><td>${r.hours ? `${fmtHrs(r.hours)} hrs` : "—"}</td>
  </tr>`).join("");
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
    ? `<tr><th class="internal-task-col">Task</th><th>Hours logged</th></tr>`
    : `<tr><th>Task</th><th>Budget</th><th>Spent</th><th style="width:160px;">Progress</th><th>Remaining</th><th>Unassigned</th></tr>`;
  const cols = internal ? 2 : 6;

  const body = projectTasks.map((t, i) => {
    const open = openTaskIds.has(t.id);
    let cells;
    if (internal) {
      cells = `<td>${fmtHrs(loggedHours(t.id))} hrs</td>`;
    } else {
      const budget = Number(t.budget || 0);
      const spent = spentOnTask(t.id);
      const remaining = budget - spent;
      const use = taskBudgetUse(t, { projects, people, assignments, timeEntries });
      cells = `<td>${formatCurrency(budget)}</td><td>${formatCurrency(spent)}</td>
        <td class="progressCell">${budgetBarHtml(use.spent, use.committed, budget)}</td>
        <td ${remaining < 0 ? 'style="color:var(--red);"' : ""}>${formatCurrency(remaining)}</td>
        <td class="unassignedCell">${unassignedHtml(t, project)}</td>`;
    }
    const stripe = i % 2 === 1 ? "stripe" : "";
    const mainRow = `<tr class="task-row ${stripe} ${open ? "expanded" : ""}" data-task-id="${t.id}">
      <td><span class="task-chevron" aria-hidden="true">&#9656;</span> ${esc(t.name)}</td>${cells}</tr>`;
    if (!open) return mainRow;
    if (internal) return mainRow + loggedByPersonHtml(t);
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
  const mainRow = taskBlocks.querySelector(`tr.task-row[data-task-id="${task.id}"]`);
  if (!mainRow) return;
  mainRow.querySelector(".unassignedCell").innerHTML = unassignedHtml(task, project, override);
  const progressCell = mainRow.querySelector(".progressCell");
  if (progressCell) {
    const use = taskBudgetUse(task, { projects, people, assignments, timeEntries }, override);
    progressCell.innerHTML = budgetBarHtml(use.spent, use.committed, use.budget);
  }
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

// ---------- Pending approval ----------
// Grouped by person, then one row per task with their notes up front.
// Clicking a task row lists each entry (date, hours, note) with Edit,
// Decline and Approve. Declined entries go back to the person's Timesheet
// (with the reason) and return here once they edit them.
const pendingApprovalCard = document.getElementById("pendingApprovalCard");
const pendingBody = document.getElementById("pendingBody");
const pendingTotal = document.getElementById("pendingTotal");
const approveAllBtn = document.getElementById("approveAllBtn");

let openApprovalKey = null; // "<personId>|<taskId>"
let apprEditing = null;      // { id, mode: "edit" | "decline" }

function pendingEntries() {
  return timeEntries
    .filter((e) => !e.approved && !e.invoiced && !e.declined)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// True when this person has logged more on the task than assigned.
function isOverAssigned(personId, taskId, projectId) {
  if (isInternal(projects.find((p) => p.id === projectId))) return false;
  const assignment = assignments.find((a) => a.taskId === taskId && a.personId === personId);
  const assigned = assignment ? assignedHours(assignment, ctx()) : 0;
  return loggedHours(taskId, personId) - assigned > 0.005;
}

// [{ personId, name, hours, entries, tasks: [{ key, project, task, hours, entries }] }]
function pendingGroups() {
  const byPerson = new Map();
  pendingEntries().forEach((e) => {
    if (!byPerson.has(e.personId)) byPerson.set(e.personId, new Map());
    const tasksMap = byPerson.get(e.personId);
    const key = `${e.personId}|${e.taskId}`;
    if (!tasksMap.has(key)) tasksMap.set(key, []);
    tasksMap.get(key).push(e);
  });
  const order = sortProjects(projects).map((p) => p.id);
  return [...byPerson].map(([personId, tasksMap]) => {
    const taskRows = [...tasksMap].map(([key, entries]) => ({
      key,
      entries,
      project: projects.find((p) => p.id === entries[0].projectId),
      task: tasks.find((t) => t.id === entries[0].taskId),
      hours: entries.reduce((s, e) => s + Number(e.hours || 0), 0),
    })).sort((x, y) => order.indexOf(x.project?.id) - order.indexOf(y.project?.id)
      || (x.task?.name || "").localeCompare(y.task?.name || ""));
    const entries = taskRows.flatMap((t) => t.entries);
    return {
      personId,
      name: personById(personId)?.name || "—",
      hours: entries.reduce((s, e) => s + Number(e.hours || 0), 0),
      entries,
      tasks: taskRows,
    };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

// "Oct 14", "Oct 14 – 16" or "Sep 30 – Oct 2" for a task's entries.
function dateRange(entries) {
  const dates = entries.map((e) => e.date).sort();
  const fmt = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);
  const a = dates[0], b = dates[dates.length - 1];
  if (a === b) return fmt(a, { month: "short", day: "numeric" });
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { day: "numeric" })}`
    : `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { month: "short", day: "numeric" })}`;
}

const apprDate = (iso) => new Date(iso + "T00:00:00")
  .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function renderPendingApproval() {
  if (apprEditing && pendingBody.contains(document.activeElement) && document.activeElement.matches("input")) return;
  const groups = pendingGroups();
  if (groups.length === 0) {
    pendingApprovalCard.style.display = "none";
    return;
  }
  pendingApprovalCard.style.display = "block";
  pendingTotal.textContent = `${fmtHrs(groups.reduce((s, g) => s + g.hours, 0))} hrs`;

  pendingBody.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table">
    <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
    <thead><tr><th>Date</th><th>Task</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
    ${groups.map((g) => `<tbody>
      <tr class="appr-person">
        <td colspan="4"><strong>${esc(g.name)}</strong> <span class="appr-muted">${fmtHrs(g.hours)} hrs</span></td>
        <td class="num" colspan="2">${g.tasks.length > 1
          ? `<button type="button" class="link-btn" data-action="approve-person" data-id="${g.personId}">Approve all</button>` : ""}</td>
      </tr>
      ${g.tasks.map((t) => {
        const open = openApprovalKey === t.key;
        const notes = t.entries.filter((e) => e.note);
        const over = isOverAssigned(g.personId, t.task?.id, t.project?.id);
        return `<tr class="appr-row ${open ? "open" : ""}" data-key="${esc(t.key)}">
          <td class="appr-date">${dateRange(t.entries)}</td>
          <td class="appr-task" title="${esc((t.project?.name || "") + " · " + (t.task?.name || ""))}"><span class="pay-dot" style="--c:${t.project ? projectColor(t.project.id) : "#c9c2cf"};"></span>${t.project ? esc(t.project.name) : "—"} <span class="appr-muted">· ${t.task ? esc(t.task.name) : "—"}</span></td>
          <td class="num ${over ? "appr-over" : ""}" ${over ? 'title="More than their assigned hours on this task"' : ""}>${fmtHrs(t.hours)}</td>
          <td class="appr-note">${notes.length
            ? `${esc(notes[notes.length - 1].note)}${notes.length > 1 ? ` <span class="appr-muted">+${notes.length - 1}</span>` : ""}`
            : '<span class="appr-muted">—</span>'}</td>
          <td class="num"><button type="button" class="small due-btn due-complete" data-action="approve-task" data-key="${esc(t.key)}">Approve</button></td>
          <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
        </tr>
        ${open ? t.entries.map(entryRowHtml).join("") : ""}`;
      }).join("")}
    </tbody>`).join("")}
  </table></div>`;
}

function entryRowHtml(e) {
  const editing = apprEditing && apprEditing.id === e.id ? apprEditing.mode : null;
  const date = `<td class="appr-date">${apprDate(e.date)}</td><td></td>`;
  if (editing === "edit") {
    return `<tr class="appr-entry editing" data-entry="${e.id}">${date}
      <td class="num"><input type="number" class="appr-hours" min="0" step="0.25" value="${Number(e.hours)}" /></td>
      <td><input type="text" class="appr-note-input" value="${esc(e.note || "")}" /></td>
      <td class="num appr-actions" colspan="2">
        <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
        <button type="button" class="small" data-action="save-entry" data-id="${e.id}">Save</button>
      </td></tr>`;
  }
  if (editing === "decline") {
    return `<tr class="appr-entry editing" data-entry="${e.id}">${date}
      <td class="num">${fmtHrs(Number(e.hours))}</td>
      <td><input type="text" class="appr-reason" placeholder="Reason (optional)" /></td>
      <td class="num appr-actions" colspan="2">
        <button type="button" class="link-btn" data-action="cancel-entry">Cancel</button>
        <button type="button" class="small danger" data-action="confirm-decline" data-id="${e.id}">Decline</button>
      </td></tr>`;
  }
  return `<tr class="appr-entry" data-entry="${e.id}">${date}
    <td class="num">${fmtHrs(Number(e.hours))}</td>
    <td class="appr-entry-note ${e.note ? "" : "appr-muted"}">${e.note ? esc(e.note) : "No note"}</td>
    <td class="num appr-actions" colspan="2">
      <button type="button" class="link-btn" data-action="edit-entry" data-id="${e.id}">Edit</button>
      <button type="button" class="link-btn appr-decline" data-action="decline-entry" data-id="${e.id}">Decline</button>
      <button type="button" class="link-btn appr-approve" data-action="approve-entry" data-id="${e.id}">Approve</button>
    </td></tr>`;
}

async function approveIds(ids, message) {
  try {
    await TimeEntries.approve(ids);
    showToast(message);
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

pendingBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) {
    const row = e.target.closest("tr.appr-row");
    if (row) {
      openApprovalKey = openApprovalKey === row.dataset.key ? null : row.dataset.key;
      renderPendingApproval();
    }
    return;
  }
  const groups = pendingGroups();
  const { action } = btn.dataset;
  if (action === "edit-entry" || action === "decline-entry") {
    apprEditing = { id: btn.dataset.id, mode: action === "edit-entry" ? "edit" : "decline" };
    renderPendingApproval();
    const input = pendingBody.querySelector(".appr-entry.editing input");
    if (input) input.focus();
    return;
  }
  if (action === "cancel-entry") {
    apprEditing = null;
    renderPendingApproval();
    return;
  }
  if (action === "save-entry") {
    const row = btn.closest("tr");
    const hours = Number(row.querySelector(".appr-hours").value);
    const note = row.querySelector(".appr-note-input").value.trim();
    if (!(hours > 0) || hours > 24) return showToast("Enter hours between 0 and 24.");
    try {
      await TimeEntries.update(btn.dataset.id, { hours, note });
      apprEditing = null;
      renderPendingApproval();
      showToast("Entry updated.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
    return;
  }
  if (action === "confirm-decline") {
    const reason = btn.closest("tr").querySelector(".appr-reason").value.trim();
    try {
      await TimeEntries.update(btn.dataset.id, { declined: true, declineReason: reason || null });
      apprEditing = null;
      renderPendingApproval();
      showToast("Declined — sent back to their Timesheet.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
    return;
  }
  if (action === "approve-entry") return approveIds([btn.dataset.id], "Approved.");
  if (action === "approve-task") {
    const t = groups.flatMap((g) => g.tasks).find((x) => x.key === btn.dataset.key);
    if (t) return approveIds(t.entries.map((x) => x.id), "Approved.");
  }
  if (action === "approve-person") {
    const g = groups.find((x) => x.personId === btn.dataset.id);
    if (g) return approveIds(g.entries.map((x) => x.id), `${g.name}'s hours approved.`);
  }
});

pendingBody.addEventListener("keydown", (e) => {
  if (!e.target.matches(".appr-entry input")) return;
  if (e.key === "Escape") { apprEditing = null; renderPendingApproval(); }
  if (e.key === "Enter") e.target.closest("tr").querySelector("button.small")?.click();
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
