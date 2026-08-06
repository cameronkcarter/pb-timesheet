import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  formatDate, formatShortDate, formatWeekday,
  todayISO, toISODate, getWeekStart, addDays, suggestedWeeklyHours, showToast,
} from "./util.js";
import { requireSession, clearSession, applyAdminNavVisibility } from "./session.js";

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let selectedProjectId = null;
let currentWeekStart = getWeekStart(todayISO());
let navChecked = false;

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");

const weekCard = document.getElementById("weekCard");
const weekRangeLabel = document.getElementById("weekRangeLabel");
const weekLoggedHoursEl = document.getElementById("weekLoggedHours");
const monthLabel = document.getElementById("monthLabel");
const monthLoggedHoursEl = document.getElementById("monthLoggedHours");
const taskHeaderRow = document.getElementById("taskHeaderRow");
const weekGridBody = document.getElementById("weekGridBody");
const taskTotalRow = document.getElementById("taskTotalRow");
const weekGridEmpty = document.getElementById("weekGridEmpty");

const tbody = document.querySelector("#entriesTable tbody");
const entriesEmpty = document.getElementById("entriesEmpty");

document.getElementById("logoutLink").addEventListener("click", (e) => {
  e.preventDefault();
  clearSession();
  window.location.href = "index.html";
});

if (selectedPersonId) {
  People.listen((data) => {
    people = data;
    if (!navChecked) {
      navChecked = true;
      applyAdminNavVisibility(people.find((p) => p.id === selectedPersonId));
    }
  });
  Projects.listen((data) => { projects = data; renderProjectCards(); });
  Tasks.listen((data) => { tasks = data; renderWeekGrid(); });
  Assignments.listen((data) => { assignments = data; renderProjectCards(); });
  TimeEntries.listen((data) => { timeEntries = data; renderWeekGrid(); renderEntries(); });
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
    weekCard.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";

  projectCardsEl.innerHTML = myProjects.map((p) => `
    <div class="project-card ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}">
      <div class="name">${p.name}</div>
      <div class="client">${p.client || "&nbsp;"}</div>
    </div>
  `).join("");

  renderWeekGrid();
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card) return;
  selectedProjectId = card.dataset.projectCard;
  currentWeekStart = getWeekStart(todayISO());
  renderProjectCards();
});

// ---------- Week grid ----------
document.getElementById("prevWeek").addEventListener("click", () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeekGrid();
});
document.getElementById("nextWeek").addEventListener("click", () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeekGrid();
});

function weekDays() {
  return Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
}

function myTaskColumns() {
  const myAssignments = assignments.filter(
    (a) => a.personId === selectedPersonId && a.projectId === selectedProjectId
  );
  return myAssignments
    .map((a) => ({ assignment: a, task: tasks.find((t) => t.id === a.taskId) }))
    .filter((c) => c.task)
    .sort((a, b) => a.task.name.localeCompare(b.task.name));
}

function renderWeekGrid() {
  if (!selectedPersonId || !selectedProjectId) {
    weekCard.style.display = "none";
    return;
  }
  weekCard.style.display = "block";

  const person = people.find((p) => p.id === selectedPersonId);
  const rate = person ? person.rate : 0;
  const columns = myTaskColumns();
  const days = weekDays();
  const todayStr = todayISO();

  weekRangeLabel.textContent = `${formatShortDate(days[0])} – ${formatShortDate(days[6])}`;

  if (columns.length === 0) {
    taskHeaderRow.innerHTML = "";
    weekGridBody.innerHTML = "";
    taskTotalRow.innerHTML = "";
    weekGridEmpty.style.display = "block";
    weekLoggedHoursEl.textContent = "0.00";
    updateMonthTotal(columns);
    return;
  }
  weekGridEmpty.style.display = "none";

  taskHeaderRow.innerHTML = "<th>Day</th>" + columns.map(({ assignment, task }) => {
    const suggested = suggestedWeeklyHours(assignment.capValue, rate, task.startDate, task.endDate);
    const allLogged = timeEntries
      .filter((e) => e.personId === selectedPersonId && e.taskId === task.id)
      .reduce((sum, e) => sum + Number(e.hours || 0), 0);
    const totalHours = rate > 0 ? (assignment.capValue || 0) / rate : 0;
    const remainingHours = totalHours - allLogged;
    return `<th>
      <div class="task-header-name">${task.name}</div>
      <div class="task-header-meta">Suggested: ${suggested != null ? suggested.toFixed(1) : "—"} hrs/wk</div>
      <div class="task-header-meta">Remaining: ${remainingHours.toFixed(1)} hrs</div>
    </th>`;
  }).join("") + "<th>Day Total</th>";

  weekGridBody.innerHTML = days.map((d) => {
    const iso = toISODate(d);
    const isToday = iso === todayStr;
    const cells = columns.map(({ task }) => {
      const hours = timeEntries
        .filter((e) => e.personId === selectedPersonId && e.taskId === task.id && e.date === iso)
        .reduce((sum, e) => sum + Number(e.hours || 0), 0);
      return `<td><input type="number" class="hourCell" data-date="${iso}" data-task-id="${task.id}" min="0" step="0.25" value="${hours || ""}" placeholder="0" /></td>`;
    }).join("");
    return `<tr class="${isToday ? "today-row" : ""}">
      <td><span class="weekday">${formatWeekday(d)}</span> ${formatShortDate(d)}</td>
      ${cells}
      <td class="day-total" data-date="${iso}">0.00</td>
    </tr>`;
  }).join("");

  taskTotalRow.innerHTML = "<td>Total</td>" +
    columns.map(({ task }) => `<td class="task-total" data-task-id="${task.id}">0.00</td>`).join("") +
    `<td class="grand-total">0.00</td>`;

  recomputeGridTotals();
}

function recomputeGridTotals() {
  const cells = [...weekGridBody.querySelectorAll(".hourCell")];
  const dayTotals = {};
  const taskTotals = {};
  let grand = 0;

  cells.forEach((input) => {
    const v = Number(input.value) || 0;
    dayTotals[input.dataset.date] = (dayTotals[input.dataset.date] || 0) + v;
    taskTotals[input.dataset.taskId] = (taskTotals[input.dataset.taskId] || 0) + v;
    grand += v;
  });

  weekGridBody.querySelectorAll(".day-total").forEach((td) => {
    td.textContent = (dayTotals[td.dataset.date] || 0).toFixed(2);
  });
  taskTotalRow.querySelectorAll(".task-total").forEach((td) => {
    td.textContent = (taskTotals[td.dataset.taskId] || 0).toFixed(2);
  });
  const grandTotalEl = taskTotalRow.querySelector(".grand-total");
  if (grandTotalEl) grandTotalEl.textContent = grand.toFixed(2);

  weekLoggedHoursEl.textContent = grand.toFixed(2);
  updateMonthTotal(myTaskColumns());
}

weekGridBody.addEventListener("input", (e) => {
  if (e.target.classList.contains("hourCell")) recomputeGridTotals();
});

function updateMonthTotal(columns) {
  const monthPrefix = toISODate(currentWeekStart).slice(0, 7);
  const monthName = currentWeekStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  monthLabel.textContent = `Logged in ${monthName}`;

  if (!selectedPersonId || !selectedProjectId) {
    monthLoggedHoursEl.textContent = "0.00";
    return;
  }

  const weekDateStrs = weekDays().map((d) => toISODate(d));

  const savedMonthTotal = timeEntries
    .filter((e) =>
      e.personId === selectedPersonId &&
      e.projectId === selectedProjectId &&
      e.date.startsWith(monthPrefix) &&
      !weekDateStrs.includes(e.date)
    )
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);

  let liveWeekMonthTotal = 0;
  weekGridBody.querySelectorAll(".hourCell").forEach((input) => {
    if (input.dataset.date.startsWith(monthPrefix)) {
      liveWeekMonthTotal += Number(input.value) || 0;
    }
  });

  monthLoggedHoursEl.textContent = (savedMonthTotal + liveWeekMonthTotal).toFixed(2);
}

document.getElementById("saveWeek").addEventListener("click", async () => {
  const personId = selectedPersonId;
  const projectId = selectedProjectId;
  if (!personId || !projectId) return;

  const cells = [...weekGridBody.querySelectorAll(".hourCell")];
  try {
    for (const input of cells) {
      const date = input.dataset.date;
      const taskId = input.dataset.taskId;
      const hours = Number(input.value) || 0;
      const existing = timeEntries.find(
        (e) => e.personId === personId && e.taskId === taskId && e.date === date
      );
      if (hours > 0) {
        if (existing) {
          if (Number(existing.hours) !== hours) await TimeEntries.update(existing.id, { hours });
        } else {
          await TimeEntries.add({ personId, projectId, taskId, date, hours });
        }
      } else if (existing) {
        await TimeEntries.remove(existing.id);
      }
    }
    showToast("Week saved.");
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
      : '<span class="pill orange">Pending</span>';
    const deleteBtn = e.invoiced
      ? ""
      : `<button class="danger small" data-id="${e.id}">Delete</button>`;

    const isNewDay = e.date !== lastDate;
    if (isNewDay) shade = !shade;
    lastDate = e.date;

    const dateCell = isNewDay
      ? `${formatDate(e.date)}${dayTotals[e.date] > Number(e.hours || 0) ? ` <span class="empty" style="padding:0;">(${dayTotals[e.date]} hrs)</span>` : ""}`
      : "";

    return `<tr class="entry-row ${shade ? "shade" : ""} ${isNewDay ? "new-day" : ""}">
      <td>${dateCell}</td>
      <td>${project ? project.name : "—"}</td>
      <td>${task ? task.name : "—"}</td>
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
