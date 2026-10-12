import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  formatDate, todayISO, toISODate, getWeekStart, suggestedWeeklyHours, monthKey, showToast,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignmentRate } from "./rates.js";

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
let calMonth = firstOfMonth(new Date()); // month shown in the calendar
let selectedDay = todayISO();

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");

const logCard = document.getElementById("logCard");
const logCardHeading = document.getElementById("logCardHeading");
const statProjectWeek = document.getElementById("statProjectWeek");
const statProjectMonth = document.getElementById("statProjectMonth");
const monthLabel = document.getElementById("monthLabel");
const noAssignmentsEmpty = document.getElementById("noAssignmentsEmpty");
const entryForm = document.getElementById("entryForm");
const taskCardsEl = document.getElementById("taskCards");
const entryDate = document.getElementById("entryDate");
const entryHours = document.getElementById("entryHours");
const entryNote = document.getElementById("entryNote");

const calendarEl = document.getElementById("calendar");
const calLegend = document.getElementById("calLegend");
const calMonthLabel = document.getElementById("calMonthLabel");
const dayDetail = document.getElementById("dayDetail");

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

wireLogout("logoutLink", "navBrandLink");

if (selectedPersonId) {
  People.listen((data) => {
    people = data;
    if (!navChecked) {
      navChecked = true;
      const me = people.find((p) => p.id === selectedPersonId);
      applyAdminNavVisibility(me);
      renderNavUserName(me);
    }
  });
  Projects.listen((data) => { projects = data; renderProjectCards(); renderCalendar(); });
  Tasks.listen((data) => { tasks = data; renderLogCard(); renderCalendar(); });
  Assignments.listen((data) => { assignments = data; renderProjectCards(); });
  TimeEntries.listen((data) => { timeEntries = data; renderLogCard(); renderCalendar(); });
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

  if (!entryDate.value) entryDate.value = todayISO();

  renderTaskCards(columns);
}

function taskStatsFor({ assignment, task }) {
  const person = people.find((p) => p.id === selectedPersonId);
  const rate = assignmentRate(projects.find((p) => p.id === task.projectId), person);
  const suggested = suggestedWeeklyHours(assignment.capValue, rate, task.startDate, task.endDate);
  const allLogged = timeEntries
    .filter((e) => e.personId === selectedPersonId && e.taskId === task.id)
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const totalHours = rate > 0 ? (assignment.capValue || 0) / rate : 0;
  const remainingHours = totalHours - allLogged;
  return {
    suggestedLabel: suggested != null ? `${suggested.toFixed(1)} hrs` : "—",
    remainingLabel: `${remainingHours.toFixed(1)} hrs`,
  };
}

function renderTaskCards(columns) {
  taskCardsEl.innerHTML = columns.map((c) => {
    const active = c.task.id === selectedTaskId;
    const { suggestedLabel, remainingLabel } = taskStatsFor(c);
    return `<div class="project-card task-card ${active ? "active" : ""}" data-task-card="${c.task.id}">
      <div class="name">${c.task.name}</div>
      <div class="task-card-stats">
        <div><span class="summary-label">Suggested</span><div class="summary-value">${suggestedLabel}/wk</div></div>
        <div><span class="summary-label">Remaining</span><div class="summary-value">${remainingLabel}</div></div>
      </div>
    </div>`;
  }).join("");
}

taskCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".task-card");
  if (!card) return;
  selectedTaskId = card.dataset.taskCard;
  renderTaskCards(myTaskOptions());
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
      const person = people.find((p) => p.id === personId);
      await TimeEntries.add({ personId, projectId, taskId, date, hours, note, rate: person ? person.rate : 0 });
      showToast("Hours logged.");
    }
    entryHours.value = "";
    entryNote.value = "";
    isDirty = false;
    selectDay(date);
  } catch (err) {
    showToast("Error: " + err.message);
  }
});


// ---------- Hours calendar ----------
// Each day shows one small chip per project (colored by project): solid once
// approved (or later), outlined while still pending approval. Clicking a day
// lists that day's entries below and sets it as the date to log hours for.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtHours(n) {
  return String(Math.round(n * 100) / 100);
}

function statusPill(e) {
  if (e.paid) return '<span class="pill green">Paid</span>';
  if (e.invoiced) return '<span class="pill blue">Invoiced</span>';
  if (e.approved) return '<span class="pill teal">Approved</span>';
  return '<span class="pill orange">Pending Approval</span>';
}

function myEntriesByDate() {
  const byDate = {};
  timeEntries
    .filter((e) => e.personId === selectedPersonId)
    .forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  return byDate;
}

function dayChipsHtml(entries) {
  // One chip per project + pending/approved state, in project-name order.
  const groups = {};
  entries.forEach((e) => {
    const pending = !e.approved && !e.invoiced;
    const key = `${e.projectId}|${pending}`;
    if (!groups[key]) groups[key] = { projectId: e.projectId, pending, hours: 0 };
    groups[key].hours += Number(e.hours || 0);
  });
  const name = (id) => projects.find((p) => p.id === id)?.name || "—";
  return Object.values(groups)
    .sort((a, b) => name(a.projectId).localeCompare(name(b.projectId)) || a.pending - b.pending)
    .map((g) => `<span class="cal-chip ${g.pending ? "pending" : ""}" style="--c:${projectColor(g.projectId)};"
      title="${esc(name(g.projectId))} — ${fmtHours(g.hours)} hrs${g.pending ? " (pending approval)" : ""}">${fmtHours(g.hours)}</span>`)
    .join("");
}

function renderCalendar() {
  if (!selectedPersonId) return;
  const byDate = myEntriesByDate();
  const today = todayISO();
  const monthPrefix = monthKey(calMonth);
  calMonthLabel.textContent = formatMonthLabel(calMonth);

  // Monday-start weeks covering the whole month.
  let cursor = getWeekStart(toISODate(calMonth));
  const cells = WEEKDAYS.map((d) => `<div class="cal-weekday">${d}</div>`).concat('<div class="cal-weekday cal-week-col">Week</div>');
  const monthProjectIds = new Set();
  let monthTotal = 0;
  do {
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const iso = toISODate(cursor);
      const entries = byDate[iso] || [];
      const dayTotal = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
      weekTotal += dayTotal;
      const inMonth = iso.startsWith(monthPrefix);
      if (inMonth) {
        monthTotal += dayTotal;
        entries.forEach((e) => monthProjectIds.add(e.projectId));
      }
      const classes = ["cal-day", inMonth ? "" : "out", iso === today ? "today" : "", iso === selectedDay ? "selected" : ""].join(" ");
      cells.push(`<button type="button" class="${classes}" data-date="${iso}">
        <span class="cal-date">${cursor.getDate()}</span>
        <span class="cal-chips">${dayChipsHtml(entries)}</span>
      </button>`);
      cursor = addDays(cursor, 1);
    }
    cells.push(`<div class="cal-week-total cal-week-col">${weekTotal ? fmtHours(weekTotal) : ""}</div>`);
  } while (toISODate(cursor).startsWith(monthPrefix));
  calendarEl.innerHTML = cells.join("");

  const legendProjects = projects.filter((p) => monthProjectIds.has(p.id));
  calLegend.innerHTML = `
    <span class="cal-legend-total">${fmtHours(monthTotal)} hrs this month</span>
    ${legendProjects.map((p) => `<span><span class="cal-swatch" style="--c:${projectColor(p.id)};"></span>${esc(p.name)}</span>`).join("")}
    <span class="cal-legend-key"><span class="cal-chip" style="--c:#746b7a;">2</span> Approved</span>
    <span class="cal-legend-key"><span class="cal-chip pending" style="--c:#746b7a;">2</span> Pending approval</span>`;

  renderDayDetail(byDate[selectedDay] || []);
}

function renderDayDetail(entries) {
  const total = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const heading = new Date(selectedDay + "T00:00:00")
    .toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  if (entries.length === 0) {
    dayDetail.innerHTML = `<h3>${heading}</h3><div class="empty">Nothing logged this day.</div>`;
    return;
  }
  const rows = entries.map((e) => {
    const project = projects.find((p) => p.id === e.projectId);
    const task = tasks.find((t) => t.id === e.taskId);
    const noteHtml = e.note ? `<div class="empty" style="padding:2px 0 0;">${esc(e.note)}</div>` : "";
    return `<tr>
      <td><span class="cal-swatch" style="--c:${projectColor(e.projectId)};"></span>${project ? esc(project.name) : "—"}</td>
      <td>${task ? esc(task.name) : "—"}${noteHtml}</td>
      <td>${e.hours}</td>
      <td>${statusPill(e)}</td>
      <td>${e.invoiced ? "" : `<button class="danger small" data-delete-entry="${e.id}">Delete</button>`}</td>
    </tr>`;
  }).join("");
  dayDetail.innerHTML = `<h3>${heading} <span class="empty" style="padding:0; font-weight:400;">— ${fmtHours(total)} hrs</span></h3>
    <table>
      <thead><tr><th>Project</th><th>Task</th><th>Hours</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function selectDay(iso) {
  selectedDay = iso;
  calMonth = firstOfMonth(new Date(iso + "T00:00:00"));
  if (entryForm.style.display !== "none") entryDate.value = iso;
  renderCalendar();
}

calendarEl.addEventListener("click", (e) => {
  const day = e.target.closest(".cal-day");
  if (day) selectDay(day.dataset.date);
});

document.getElementById("calPrev").addEventListener("click", () => { calMonth = addMonths(calMonth, -1); renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calMonth = addMonths(calMonth, 1); renderCalendar(); });
document.getElementById("calToday").addEventListener("click", () => selectDay(todayISO()));

dayDetail.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-delete-entry]");
  if (!btn) return;
  if (!confirm("Delete this entry?")) return;
  try {
    await TimeEntries.remove(btn.dataset.deleteEntry);
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
