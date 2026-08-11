import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  formatDate, todayISO, toISODate, getWeekStart, suggestedWeeklyHours, monthKey, showToast,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility } from "./session.js";

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let selectedProjectId = null;
let selectedTaskId = null;
let navChecked = false;
let isDirty = false;

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");

const logCard = document.getElementById("logCard");
const logCardHeading = document.getElementById("logCardHeading");
const statProjectWeek = document.getElementById("statProjectWeek");
const statProjectMonth = document.getElementById("statProjectMonth");
const monthLabel = document.getElementById("monthLabel");
const statSuggested = document.getElementById("statSuggested");
const statRemaining = document.getElementById("statRemaining");
const noAssignmentsEmpty = document.getElementById("noAssignmentsEmpty");
const entryForm = document.getElementById("entryForm");
const taskSelect = document.getElementById("taskSelect");
const entryDate = document.getElementById("entryDate");
const entryHours = document.getElementById("entryHours");
const entryNote = document.getElementById("entryNote");

const tbody = document.querySelector("#entriesTable tbody");
const entriesEmpty = document.getElementById("entriesEmpty");

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

wireLogout("logoutLink", "navBrandLink");

if (selectedPersonId) {
  People.listen((data) => {
    people = data;
    if (!navChecked) {
      navChecked = true;
      applyAdminNavVisibility(people.find((p) => p.id === selectedPersonId));
    }
  });
  Projects.listen((data) => { projects = data; renderProjectCards(); });
  Tasks.listen((data) => { tasks = data; renderLogCard(); });
  Assignments.listen((data) => { assignments = data; renderProjectCards(); });
  TimeEntries.listen((data) => { timeEntries = data; renderLogCard(); renderEntries(); });
}

// ---------- Project cards ----------
function renderProjectCards() {
  const myProjectIds = [...new Set(
    assignments.filter((a) => a.personId === selectedPersonId).map((a) => a.projectId)
  )];
  const myProjects = projects.filter((p) => myProjectIds.includes(p.id));

  if (myProjects.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    logCard.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";

  projectCardsEl.innerHTML = myProjects.map((p) => `
    <div class="project-card ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}">
      <div class="name">${p.name}</div>
      <div class="client">${p.client || "&nbsp;"}</div>
    </div>
  `).join("");

  renderLogCard();
}

function confirmDiscardIfDirty() {
  if (!isDirty) return true;
  if (!confirm("You have an unsaved entry on this screen. Discard it?")) return false;
  isDirty = false;
  return true;
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card) return;
  if (!confirmDiscardIfDirty()) return;
  selectedProjectId = card.dataset.projectCard;
  selectedTaskId = null;
  renderProjectCards();
});

window.addEventListener("beforeunload", (e) => {
  if (!isDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---------- Log card ----------
function myTaskOptions() {
  const myAssignments = assignments.filter(
    (a) => a.personId === selectedPersonId && a.projectId === selectedProjectId
  );
  return myAssignments
    .map((a) => ({ assignment: a, task: tasks.find((t) => t.id === a.taskId) }))
    .filter((c) => c.task)
    .sort((a, b) => a.task.name.localeCompare(b.task.name));
}

function renderLogCard() {
  if (!selectedPersonId || !selectedProjectId) {
    logCard.style.display = "none";
    return;
  }
  logCard.style.display = "block";

  const project = projects.find((p) => p.id === selectedProjectId);
  logCardHeading.textContent = project ? project.name : "";

  const weekStart = toISODate(getWeekStart(todayISO()));
  const monthPrefix = monthKey(new Date());
  const myProjectEntries = timeEntries.filter(
    (e) => e.personId === selectedPersonId && e.projectId === selectedProjectId
  );
  const weekTotal = myProjectEntries
    .filter((e) => e.date >= weekStart)
    .reduce((s, e) => s + Number(e.hours || 0), 0);
  const monthTotal = myProjectEntries
    .filter((e) => e.date.startsWith(monthPrefix))
    .reduce((s, e) => s + Number(e.hours || 0), 0);
  statProjectWeek.textContent = weekTotal.toFixed(2);
  statProjectMonth.textContent = monthTotal.toFixed(2);
  monthLabel.textContent = `Logged This Month`;

  const columns = myTaskOptions();
  if (columns.length === 0) {
    noAssignmentsEmpty.style.display = "block";
    entryForm.style.display = "none";
    return;
  }
  noAssignmentsEmpty.style.display = "none";
  entryForm.style.display = "block";

  if (!selectedTaskId || !columns.some((c) => c.task.id === selectedTaskId)) {
    selectedTaskId = columns[0].task.id;
  }
  taskSelect.innerHTML = columns.map(({ task }) =>
    `<option value="${task.id}" ${task.id === selectedTaskId ? "selected" : ""}>${task.name}</option>`
  ).join("");

  if (!entryDate.value) entryDate.value = todayISO();

  renderTaskStats();
}

function renderTaskStats() {
  const columns = myTaskOptions();
  const chosen = columns.find((c) => c.task.id === selectedTaskId);
  if (!chosen) {
    statSuggested.textContent = "—";
    statRemaining.textContent = "—";
    return;
  }
  const { assignment, task } = chosen;
  const person = people.find((p) => p.id === selectedPersonId);
  const rate = person ? person.rate : 0;
  const suggested = suggestedWeeklyHours(assignment.capValue, rate, task.startDate, task.endDate);
  const allLogged = timeEntries
    .filter((e) => e.personId === selectedPersonId && e.taskId === task.id)
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const totalHours = rate > 0 ? (assignment.capValue || 0) / rate : 0;
  const remainingHours = totalHours - allLogged;

  statSuggested.textContent = suggested != null ? `${suggested.toFixed(1)} hrs` : "—";
  statRemaining.textContent = `${remainingHours.toFixed(1)} hrs`;
}

taskSelect.addEventListener("change", () => {
  selectedTaskId = taskSelect.value;
  renderTaskStats();
});

[entryHours, entryNote].forEach((el) => {
  el.addEventListener("input", () => {
    isDirty = entryHours.value.trim() !== "" || entryNote.value.trim() !== "";
  });
});

document.getElementById("submitEntry").addEventListener("click", async () => {
  const personId = selectedPersonId;
  const projectId = selectedProjectId;
  const taskId = selectedTaskId;
  const date = entryDate.value;
  const hours = Number(entryHours.value);
  const note = entryNote.value.trim();

  if (!projectId || !taskId) return showToast("Select a task first.");
  if (!date) return showToast("Choose a date.");
  if (!hours || hours <= 0) return showToast("Enter hours worked.");
  if (!note) return showToast("Add a note describing what you worked on.");

  const existing = timeEntries.find(
    (e) => e.personId === personId && e.taskId === taskId && e.date === date
  );

  if (existing && existing.invoiced) {
    return showToast("This day/task has already been invoiced and can't be changed here.");
  }

  try {
    if (existing) {
      await TimeEntries.update(existing.id, { hours, note, approved: false, approvedDate: null });
      showToast("Entry updated.");
    } else {
      await TimeEntries.add({ personId, projectId, taskId, date, hours, note });
      showToast("Hours logged.");
    }
    entryHours.value = "";
    entryNote.value = "";
    isDirty = false;
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Recent entries ----------
function renderEntries() {
  const mine = timeEntries
    .filter((e) => e.personId === selectedPersonId)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 15);

  if (mine.length === 0) {
    tbody.innerHTML = "";
    entriesEmpty.style.display = "block";
    entriesEmpty.textContent = "No entries logged yet.";
    return;
  }
  entriesEmpty.style.display = "none";

  const dayTotals = {};
  mine.forEach((e) => {
    dayTotals[e.date] = (dayTotals[e.date] || 0) + Number(e.hours || 0);
  });

  let lastDate = null;
  let shade = false;
  tbody.innerHTML = mine.map((e) => {
    const project = projects.find((p) => p.id === e.projectId);
    const task = tasks.find((t) => t.id === e.taskId);
    const statusPill = e.paid
      ? '<span class="pill green">Paid</span>'
      : e.invoiced
      ? '<span class="pill blue">Invoiced</span>'
      : e.approved
      ? '<span class="pill teal">Approved</span>'
      : '<span class="pill orange">Pending Approval</span>';
    const deleteBtn = e.invoiced
      ? ""
      : `<button class="danger small" data-id="${e.id}">Delete</button>`;

    const isNewDay = e.date !== lastDate;
    if (isNewDay) shade = !shade;
    lastDate = e.date;

    const dateCell = isNewDay
      ? `${formatDate(e.date)}${dayTotals[e.date] > Number(e.hours || 0) ? ` <span class="empty" style="padding:0;">(${dayTotals[e.date]} hrs)</span>` : ""}`
      : "";

    const noteHtml = e.note
      ? `<div class="empty" style="padding:2px 0 0;">${esc(e.note)}</div>`
      : "";

    return `<tr class="entry-row ${shade ? "shade" : ""} ${isNewDay ? "new-day" : ""}">
      <td>${dateCell}</td>
      <td>${project ? project.name : "—"}</td>
      <td>${task ? task.name : "—"}${noteHtml}</td>
      <td>${e.hours}</td>
      <td>${statusPill}</td>
      <td>${deleteBtn}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("button.danger").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this entry?")) return;
      try {
        await TimeEntries.remove(btn.dataset.id);
      } catch (err) {
        showToast("Error: " + err.message);
      }
    });
  });
}
