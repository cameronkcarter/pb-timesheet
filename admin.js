import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import { formatCurrency, formatDate, showToast } from "./util.js";
import { requireSession, wireLogout, enforceAdmin } from "./session.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let adminCheckDone = false;

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
    }
    renderPeople();
    renderTasks();
    renderPendingApproval();
  });
  Projects.listen((d) => { projects = d; renderProjectCards(); renderPendingApproval(); });
  Tasks.listen((d) => { tasks = d; renderTasks(); renderPendingApproval(); });
  Assignments.listen((d) => { assignments = d; renderTasks(); });
  TimeEntries.listen((d) => { timeEntries = d; renderTasks(); renderPendingApproval(); });
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
  if (!name || !rate) return showToast("Enter a name and rate.");
  try {
    if (modalEditingPersonId) {
      await People.update(modalEditingPersonId, { name, rate, isAdmin });
      showToast("Person updated.");
    } else {
      await People.add({ name, rate, isAdmin });
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
  if (action === "remove-project") {
    if (!confirm("Remove this project? Its tasks and assignments will be orphaned.")) return;
    try { await Projects.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
});

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

  const projectTasks = project ? tasks.filter((t) => t.projectId === project.id) : [];
  modalTaskRows.innerHTML = projectTasks.length > 0
    ? projectTasks.map((t) => modalTaskRowHtml(t.id, t.name, t.budget, t.startDate, t.endDate)).join("")
    : modalTaskRowHtml();

  projectModal.style.display = "flex";
  modalProjectName.focus();
}

function closeProjectModal() {
  projectModal.style.display = "none";
}

document.getElementById("openAddProject").addEventListener("click", () => openProjectModal(null));
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
  if (!name) return showToast("Enter a project name.");
  try {
    let projectId = modalEditingProjectId;
    const projectData = { name, client, billToName, billToCompany, billToAddress1, billToAddress2, projectNumber };
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
      const taskBudget = Number(row.querySelector(".modalTaskBudget").value) || 0;
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
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Tasks + Assignments (merged) ----------
const tasksTbody = document.querySelector("#tasksTable tbody");
const tasksEmpty = document.getElementById("tasksEmpty");

function spentOnTask(taskId) {
  return timeEntries
    .filter((e) => e.taskId === taskId)
    .reduce((sum, e) => {
      const person = people.find((p) => p.id === e.personId);
      return sum + Number(e.hours || 0) * (person ? person.rate : 0);
    }, 0);
}

function assignedTotal(taskId) {
  return assignments
    .filter((a) => a.taskId === taskId)
    .reduce((sum, a) => sum + Number(a.capValue || 0), 0);
}

function assignedPill(diff) {
  if (Math.abs(diff) < 0.005) return `<span class="pill green">Balanced</span>`;
  if (diff > 0) return `<span class="pill orange">${formatCurrency(diff)} unassigned</span>`;
  return `<span class="pill red">${formatCurrency(-diff)} over</span>`;
}

function renderTasks() {
  const projectId = selectedProjectId;
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  if (projectTasks.length === 0) {
    tasksTbody.innerHTML = "";
    tasksEmpty.style.display = "block";
    return;
  }
  tasksEmpty.style.display = "none";

  tasksTbody.innerHTML = projectTasks.map((t) => {
    const spent = spentOnTask(t.id);
    const budget = Number(t.budget || 0);
    const assigned = assignedTotal(t.id);
    const diff = budget - assigned;

    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const over = spent > budget;
    const expanded = t.id === expandedTaskId;
    const mainRow = `<tr class="task-row ${expanded ? "expanded" : ""}" data-task-row="${t.id}">
      <td>${t.name}</td>
      <td>${formatCurrency(budget)}</td>
      <td>${formatCurrency(spent)}</td>
      <td>
        <div class="progress-bar"><div class="fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>
      </td>
      <td>${assignedPill(diff)}</td>
    </tr>`;

    if (!expanded) return mainRow;

    return mainRow + `<tr>
      <td colspan="5" class="accordion-cell">${renderAccordion(t, diff)}</td>
    </tr>`;
  }).join("");
}

function renderAccordion(task, diff) {
  const budget = Number(task.budget || 0);
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const assignedPersonIds = taskAssignments.map((a) => a.personId);
  const availablePeople = people.filter((p) => !assignedPersonIds.includes(p.id));

  const rows = taskAssignments.map((a) => {
    const person = people.find((p) => p.id === a.personId);
    const loggedHours = timeEntries
      .filter((e) => e.taskId === a.taskId && e.personId === a.personId)
      .reduce((sum, e) => sum + Number(e.hours || 0), 0);
    const rate = person ? person.rate : 0;
    const earned = loggedHours * rate;
    const remaining = (a.capValue || 0) - earned;

    return `<tr class="assignmentRow" data-assignment-id="${a.id}" data-person-id="${a.personId}" data-earned="${earned}">
      <td>${person ? esc(person.name) : "—"}</td>
      <td><input type="number" class="editAmount" min="0" step="1" data-person-id="${a.personId}" value="${a.capValue}" style="width:100px;" /></td>
      <td>${formatCurrency(earned)} <span class="empty">(${loggedHours.toFixed(2)} hrs)</span></td>
      <td class="remainingCell">${formatCurrency(remaining)}</td>
      <td class="row-actions">
        <button class="danger small" data-action="remove-assignment" data-id="${a.id}">Remove</button>
      </td>
    </tr>`;
  }).join("");

  const totalAssigned = taskAssignments.reduce((s, a) => s + Number(a.capValue || 0), 0);

  const addRow = availablePeople.length === 0
    ? `<div class="empty">Everyone on the team is already assigned to this task.</div>`
    : `<div class="inline-form" style="margin-top:12px;">
        <div>
          <label>Person</label>
          <select class="newAssignPerson">
            ${availablePeople.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
          </select>
        </div>
        <div>
          <label>Amount ($)</label>
          <input type="number" class="newAssignAmount" min="0" step="1" value="0" placeholder="${diff > 0 ? diff.toFixed(0) : "0"}" />
        </div>
        <div style="flex:0;">
          <label>&nbsp;</label>
          <button class="small" data-action="add-assignment" data-task-id="${task.id}" data-project-id="${task.projectId}">Add</button>
        </div>
      </div>`;

  const transferBox = taskAssignments.length >= 2
    ? `<div class="transfer-box">
        <div style="font-weight:600; margin-bottom:8px;">Transfer between people</div>
        <div class="inline-form">
          <div>
            <label>From</label>
            <select class="transferFrom">
              ${taskAssignments.map((a) => {
                const p = people.find((pp) => pp.id === a.personId);
                return `<option value="${a.personId}">${p ? esc(p.name) : "—"}</option>`;
              }).join("")}
            </select>
          </div>
          <div>
            <label>To</label>
            <select class="transferTo">
              ${taskAssignments.map((a) => {
                const p = people.find((pp) => pp.id === a.personId);
                return `<option value="${a.personId}">${p ? esc(p.name) : "—"}</option>`;
              }).join("")}
            </select>
          </div>
          <div>
            <label>Amount ($)</label>
            <input type="number" class="transferAmount" min="0" step="1" placeholder="500" />
          </div>
          <div style="flex:0;">
            <label>&nbsp;</label>
            <button type="button" class="small secondary" data-action="do-transfer" data-task-id="${task.id}">Transfer &rarr;</button>
          </div>
        </div>
      </div>`
    : "";

  return `
    <div class="assign-summary" data-task-budget="${budget}">
      Assigned: <strong class="assignSumAssigned">${formatCurrency(totalAssigned)}</strong> of ${formatCurrency(budget)} budget
      <span class="assignSumDiffPill">${assignedPill(budget - totalAssigned)}</span>
    </div>
    ${taskAssignments.length > 0 ? `<table style="margin-top:10px;">
      <thead><tr><th>Person</th><th>Assigned</th><th>Earned</th><th>Remaining</th><th style="width:100px;"></th></tr></thead>
      <tbody class="assignmentRows">${rows}</tbody>
    </table>
    <div class="row-actions" style="margin-top:10px;">
      <button class="small" data-action="save-assignments" data-task-id="${task.id}">Save Changes</button>
    </div>` : `<div class="empty">No one assigned to this task yet.</div>`}
    ${transferBox}
    <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border);">
      ${addRow}
    </div>
  `;
}

function liveRecomputeAssignments(accordionCell) {
  const summaryEl = accordionCell.querySelector(".assign-summary");
  if (!summaryEl) return;
  const budget = Number(summaryEl.dataset.taskBudget || 0);
  const inputs = [...accordionCell.querySelectorAll(".editAmount")];
  const total = inputs.reduce((s, inp) => s + (Number(inp.value) || 0), 0);
  summaryEl.querySelector(".assignSumAssigned").textContent = formatCurrency(total);
  summaryEl.querySelector(".assignSumDiffPill").innerHTML = assignedPill(budget - total);

  accordionCell.querySelectorAll(".assignmentRow").forEach((row) => {
    const input = row.querySelector(".editAmount");
    const earned = Number(row.dataset.earned || 0);
    row.querySelector(".remainingCell").textContent = formatCurrency((Number(input.value) || 0) - earned);
  });
}

tasksTbody.addEventListener("input", (e) => {
  if (!e.target.classList.contains("editAmount")) return;
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

  if (action === "remove-assignment") {
    if (!confirm("Remove this assignment?")) return;
    try { await Assignments.remove(id); } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "save-assignments") {
    const cell = btn.closest(".accordion-cell");
    try {
      for (const row of cell.querySelectorAll(".assignmentRow")) {
        const assignmentId = row.dataset.assignmentId;
        const capValue = Number(row.querySelector(".editAmount").value) || 0;
        const original = assignments.find((a) => a.id === assignmentId);
        if (original && Number(original.capValue) !== capValue) {
          await Assignments.update(assignmentId, { capValue });
        }
      }
      showToast("Assignments updated.");
    } catch (err) { showToast("Error: " + err.message); }
  }
  if (action === "do-transfer") {
    const cell = btn.closest(".accordion-cell");
    const box = btn.closest(".transfer-box");
    const fromId = box.querySelector(".transferFrom").value;
    const toId = box.querySelector(".transferTo").value;
    const amountInput = box.querySelector(".transferAmount");
    const amount = Number(amountInput.value);
    if (!fromId || !toId || fromId === toId) return showToast("Pick two different people.");
    if (!amount || amount <= 0) return showToast("Enter an amount to transfer.");
    const fromInput = cell.querySelector(`.editAmount[data-person-id="${fromId}"]`);
    const toInput = cell.querySelector(`.editAmount[data-person-id="${toId}"]`);
    if (!fromInput || !toInput) return;
    const fromVal = Number(fromInput.value) || 0;
    if (amount > fromVal) {
      const fromPerson = people.find((p) => p.id === fromId);
      return showToast(`${fromPerson ? fromPerson.name : "That person"} only has ${formatCurrency(fromVal)} assigned.`);
    }
    fromInput.value = (fromVal - amount).toFixed(2);
    toInput.value = ((Number(toInput.value) || 0) + amount).toFixed(2);
    amountInput.value = "";
    liveRecomputeAssignments(cell);
    showToast(`Moved ${formatCurrency(amount)} — click Save Changes to apply.`);
  }
  if (action === "add-assignment") {
    const taskId = btn.dataset.taskId;
    const projectId = btn.dataset.projectId;
    const container = btn.closest(".accordion-cell");
    const personId = container.querySelector(".newAssignPerson").value;
    const amountInput = container.querySelector(".newAssignAmount");
    const capValue = amountInput.value === "" ? 0 : Number(amountInput.value);
    if (!personId) return showToast("Select a person.");
    if (isNaN(capValue) || capValue < 0) return showToast("Enter a valid dollar amount.");
    try {
      await Assignments.add({ projectId, taskId, personId, capValue });
      showToast("Assigned.");
    } catch (err) { showToast("Error: " + err.message); }
  }
});

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
      <td colspan="4">${g.name} <span class="empty" style="padding:0;">(${g.entries.length} ${g.entries.length === 1 ? "entry" : "entries"})</span></td>
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
        <td>${task ? task.name : "—"}${noteHtml}</td>
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
