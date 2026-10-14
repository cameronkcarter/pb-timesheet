import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  todayISO, toISODate, getWeekStart, monthKey, showToast,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor, sortProjects,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignedHours, isInternal } from "./rates.js";

// The page is one calendar: click a day to see what you logged that day and
// log more hours for it (project -> task -> hours + note) right below.

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

const calendarEl = document.getElementById("calendar");
const calLegend = document.getElementById("calLegend");
const calMonthLabel = document.getElementById("calMonthLabel");

const dayHeading = document.getElementById("dayHeading");
const dayEntries = document.getElementById("dayEntries");
const logTitle = document.getElementById("logTitle");
const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const noAssignmentsEmpty = document.getElementById("noAssignmentsEmpty");
const entryForm = document.getElementById("entryForm");
const taskCardsEl = document.getElementById("taskCards");
const entryHours = document.getElementById("entryHours");
const entryNote = document.getElementById("entryNote");
const existingHint = document.getElementById("existingHint");
const submitEntry = document.getElementById("submitEntry");
const cancelEdit = document.getElementById("cancelEdit");

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtHours(n) {
  return String(Math.round(n * 100) / 100);
}

function dayLabel(iso, opts = { weekday: "long", month: "short", day: "numeric", year: "numeric" }) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);
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
    renderLogForm();
  });
  Projects.listen((data) => { projects = data; renderAll(); });
  Tasks.listen((data) => { tasks = data; renderAll(); });
  Assignments.listen((data) => { assignments = data; renderLogForm(); });
  TimeEntries.listen((data) => { timeEntries = data; renderAll(); });
}

function renderAll() {
  renderCalendar();
  renderLogForm();
}

window.addEventListener("beforeunload", (e) => {
  if (!isDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---------- Calendar ----------
// Each day shows one small chip per project (colored by project): solid once
// approved (or later), a pale tint while still pending approval.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  // Sunday-start weeks covering the whole month.
  let cursor = getWeekStart(toISODate(calMonth));
  const cells = WEEKDAYS.map((d) => `<div class="cal-weekday">${d}</div>`).concat('<div class="cal-weekday cal-week-col">Week</div>');
  const monthProjectIds = new Set();
  do {
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const iso = toISODate(cursor);
      const entries = byDate[iso] || [];
      const dayTotal = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
      weekTotal += dayTotal;
      const inMonth = iso.startsWith(monthPrefix);
      if (inMonth) {
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
    ${legendProjects.map((p) => `<span><span class="cal-swatch" style="--c:${projectColor(p.id)};"></span>${esc(p.name)}</span>`).join("")}
    <span class="cal-legend-key"><span class="cal-chip" style="--c:#746b7a;">2</span> Approved</span>
    <span class="cal-legend-key"><span class="cal-chip pending" style="--c:#746b7a;">2</span> Pending approval</span>`;

  renderDayEntries(byDate[selectedDay] || []);
}

function renderDayEntries(entries) {
  const total = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  dayHeading.innerHTML = `${dayLabel(selectedDay)}${entries.length ? ` <span class="empty" style="padding:0; font-weight:400;">— ${fmtHours(total)} hrs logged</span>` : ""}`;
  if (entries.length === 0) {
    dayEntries.innerHTML = `<div class="empty" style="padding-top:0;">Nothing logged this day yet.</div>`;
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
      <td>${e.invoiced ? "" : `<div class="row-actions">
        <button class="small secondary" data-edit-entry="${e.id}">Edit</button>
        <button class="danger small" data-delete-entry="${e.id}">Delete</button>
      </div>`}</td>
    </tr>`;
  }).join("");
  dayEntries.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Project</th><th>Task</th><th>Hours</th><th>Status</th><th style="width:140px;"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function selectDay(iso) {
  selectedDay = iso;
  calMonth = firstOfMonth(new Date(iso + "T00:00:00"));
  renderAll();
}

calendarEl.addEventListener("click", (e) => {
  const day = e.target.closest(".cal-day");
  if (day) selectDay(day.dataset.date);
});

document.getElementById("calPrev").addEventListener("click", () => { calMonth = addMonths(calMonth, -1); renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calMonth = addMonths(calMonth, 1); renderCalendar(); });
document.getElementById("calToday").addEventListener("click", () => selectDay(todayISO()));

dayEntries.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-entry]");
  if (editBtn) {
    const entry = timeEntries.find((x) => x.id === editBtn.dataset.editEntry);
    if (!entry) return;
    selectedProjectId = entry.projectId;
    selectedTaskId = entry.taskId;
    entryHours.value = entry.hours;
    entryNote.value = entry.note || "";
    isDirty = true;
    renderLogForm();
    entryHours.focus();
    return;
  }
  const delBtn = e.target.closest("[data-delete-entry]");
  if (!delBtn) return;
  if (!confirm("Delete this entry?")) return;
  try {
    await TimeEntries.remove(delBtn.dataset.deleteEntry);
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Log hours for the selected day ----------
// Projects you can log to: the ones you're assigned on, plus every internal
// project (e.g. Proposals & Pursuits), which is open to everyone.
function myProjects() {
  const ids = new Set(assignments.filter((a) => a.personId === selectedPersonId).map((a) => a.projectId));
  return sortProjects(projects.filter((p) => ids.has(p.id) || isInternal(p)));
}

function selectedProjectIsInternal() {
  return isInternal(projects.find((p) => p.id === selectedProjectId));
}

function myTaskOptions() {
  if (selectedProjectIsInternal()) {
    // No assignments on internal projects: every task is available.
    return tasks
      .filter((t) => t.projectId === selectedProjectId)
      .map((task) => ({ assignment: null, task }))
      .sort((a, b) => a.task.name.localeCompare(b.task.name));
  }
  return assignments
    .filter((a) => a.personId === selectedPersonId && a.projectId === selectedProjectId)
    .map((a) => ({ assignment: a, task: tasks.find((t) => t.id === a.taskId) }))
    .filter((c) => c.task)
    .sort((a, b) => a.task.name.localeCompare(b.task.name));
}

// The entry this person already has for the selected day + task, if any —
// logging again replaces it rather than adding a second one.
function existingEntry() {
  return timeEntries.find((e) =>
    e.personId === selectedPersonId && e.taskId === selectedTaskId && e.date === selectedDay);
}

function renderLogForm() {
  if (!selectedPersonId) return;
  logTitle.textContent = `Log hours for ${dayLabel(selectedDay, { weekday: "long", month: "long", day: "numeric" })}`;

  const mine = myProjects();
  if (mine.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    noAssignmentsEmpty.style.display = "none";
    entryForm.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";
  if (selectedProjectId && !mine.some((p) => p.id === selectedProjectId)) selectedProjectId = null;
  if (!selectedProjectId && mine.length === 1) selectedProjectId = mine[0].id;

  projectCardsEl.innerHTML = mine.map((p) => `
    <div class="project-card project-card-colored ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}" style="--c:${projectColor(p.id)};">
      <div class="name">${esc(p.name)}</div>
      <div class="client">${p.client ? esc(p.client) : "&nbsp;"}</div>
    </div>`).join("");

  if (!selectedProjectId) {
    noAssignmentsEmpty.style.display = "none";
    entryForm.style.display = "none";
    return;
  }

  const options = myTaskOptions();
  if (options.length === 0) {
    noAssignmentsEmpty.style.display = "block";
    entryForm.style.display = "none";
    return;
  }
  noAssignmentsEmpty.style.display = "none";
  entryForm.style.display = "block";
  // No task is picked automatically; the person chooses one each time.
  if (selectedTaskId && !options.some((c) => c.task.id === selectedTaskId)) selectedTaskId = null;
  renderTaskCards(options);
  renderExistingHint();
}

// Hours this person has logged on a task, optionally leaving out one entry
// (the one being replaced when re-logging the same day).
function loggedOnTask(taskId, exceptEntryId = null) {
  return timeEntries
    .filter((e) => e.personId === selectedPersonId && e.taskId === taskId && e.id !== exceptEntryId)
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);
}

function renderTaskCards(options) {
  taskCardsEl.innerHTML = options.map((c) => {
    const active = c.task.id === selectedTaskId;
    const logged = loggedOnTask(c.task.id);
    if (!c.assignment) {
      // Internal task: just how much you've logged.
      return `<div class="project-card task-card ${active ? "active" : ""}" data-task-card="${c.task.id}">
        <div class="name">${esc(c.task.name)}</div>
        <div class="task-card-stats">
          <div><span class="summary-label">You've logged</span><div class="summary-value">${fmtHours(logged)} hrs</div></div>
        </div>
      </div>`;
    }
    const assigned = assignedHours(c.assignment, { projects, people });
    const over = logged - assigned > 0.005;
    return `<div class="project-card task-card ${active ? "active" : ""}" data-task-card="${c.task.id}">
      <div class="name">${esc(c.task.name)}</div>
      <div class="task-card-stats">
        <div><span class="summary-label">Assigned</span><div class="summary-value">${fmtHours(assigned)} hrs</div></div>
        <div><span class="summary-label">Logged</span><div class="summary-value ${over ? "hours-over" : ""}">${fmtHours(logged)} hrs</div></div>
      </div>
    </div>`;
  }).join("");
}

// Notes under the form: replacing an existing entry for this day, and/or
// going past the hours assigned on this task (allowed — it's flagged for
// admins so they can add hours).
function renderExistingHint() {
  if (!selectedTaskId) {
    existingHint.className = "entry-status info";
    existingHint.innerHTML = '<span class="entry-status-icon" aria-hidden="true">&uarr;</span>Choose a task above to log hours';
    submitEntry.textContent = "Log Hours";
    submitEntry.disabled = true;
    cancelEdit.style.visibility = isDirty ? "visible" : "hidden";
    return;
  }
  const existing = existingEntry();
  const notes = [];
  if (existing && existing.invoiced) {
    notes.push("Already invoiced for this day — can't be changed");
    submitEntry.textContent = "Log Hours";
    submitEntry.disabled = true;
  } else {
    if (existing) notes.push(`Replaces the ${existing.hours} hrs already logged here`);
    submitEntry.textContent = existing ? "Update Entry" : "Log Hours";
    submitEntry.disabled = false;

    const option = myTaskOptions().find((c) => c.task.id === selectedTaskId);
    const hours = Number(entryHours.value) || 0;
    if (option && option.assignment && hours > 0) {
      const assigned = assignedHours(option.assignment, { projects, people });
      const after = loggedOnTask(selectedTaskId, existing ? existing.id : null) + hours;
      if (after - assigned > 0.005) {
        notes.push(`${fmtHours(after - assigned)} hrs over your ${fmtHours(assigned)} assigned — OK, your PM will see it.`);
      }
    }
  }
  existingHint.className = notes.length ? "entry-status warn" : "entry-status";
  existingHint.innerHTML = notes.length
    ? `<span class="entry-status-icon" aria-hidden="true">&#9888;</span>${notes.map(esc).join(" &middot; ")}`
    : "";
  cancelEdit.style.visibility = isDirty ? "visible" : "hidden";
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card || card.dataset.projectCard === selectedProjectId) return;
  selectedProjectId = card.dataset.projectCard;
  selectedTaskId = null;
  renderLogForm();
});

taskCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".task-card");
  if (!card) return;
  selectedTaskId = card.dataset.taskCard;
  renderTaskCards(myTaskOptions());
  renderExistingHint();
});

[entryHours, entryNote].forEach((el) => {
  el.addEventListener("input", () => {
    isDirty = entryHours.value.trim() !== "" || entryNote.value.trim() !== "";
    renderExistingHint();
  });
});

function clearForm() {
  entryHours.value = "";
  entryNote.value = "";
  isDirty = false;
  selectedTaskId = null;
  renderLogForm();
}

cancelEdit.addEventListener("click", clearForm);

submitEntry.addEventListener("click", async () => {
  const personId = selectedPersonId;
  const projectId = selectedProjectId;
  const taskId = selectedTaskId;
  const date = selectedDay;
  const hours = Number(entryHours.value);
  const note = entryNote.value.trim();

  if (!projectId || !taskId) return showToast("Choose a task first.");
  if (!hours || hours <= 0) return showToast("Enter hours worked.");
  if (!note) return showToast("Add a note describing what you worked on.");

  const existing = existingEntry();
  if (existing && existing.invoiced) {
    return showToast("This day/task has already been invoiced and can't be changed here.");
  }

  const autoApprove = selectedProjectIsInternal();
  const approval = autoApprove
    ? { approved: true, approvedDate: new Date().toISOString() }
    : { approved: false, approvedDate: null };
  try {
    if (existing) {
      await TimeEntries.update(existing.id, { hours, note, ...approval });
      showToast("Entry updated.");
    } else {
      const person = people.find((p) => p.id === personId);
      await TimeEntries.add({ personId, projectId, taskId, date, hours, note, rate: person ? person.rate : 0, ...approval });
      showToast("Hours logged.");
    }
    clearForm();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});
