import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  todayISO, toISODate, getWeekStart, monthKey, showToast, fmtHrs, dateRange, entryDate,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor, sortProjects, esc,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignedHours, isInternal } from "./rates.js";

// The page is one calendar: click a day to see what you logged that day and
// log more hours for it (project -> task -> hours + note) right below. The
// List view shows the month's hours grouped by project and task instead.

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let selectedProjectId = null;
let selectedTaskId = null;
let projectPicked = false; // until you pick one, the first (newest) project is selected
let navChecked = false;
let isDirty = false;
let editingEntryId = null; // entry loaded into the form by its Edit button
let calMonth = firstOfMonth(new Date()); // month shown in the calendar
let selectedDay = todayISO();
let showOtherTasks = false; // tasks on the project you're not assigned to
let addingTask = false;     // the "+ New task" box on internal projects
let view = "calendar";      // or "list"
let openListKey = null;     // "<projectId>|<taskId>" open in the List view
try { if (localStorage.getItem("pb_timesheet_view") === "list") view = "list"; } catch (_) { /* no storage */ }

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

function fmtHours(n) {
  return String(Math.round(n * 100) / 100);
}

function dayLabel(iso, opts = { weekday: "long", month: "short", day: "numeric", year: "numeric" }) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);
}

wireLogout("logoutLink");

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
  renderList();
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
  if (e.declined) return '<span class="pill red">Declined</span>';
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
    const noteHtml = (e.note ? `<div class="empty" style="padding:2px 0 0;">${esc(e.note)}</div>` : "") +
      (e.declined && !e.approved && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : "");
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
  if (editingEntryId && iso !== selectedDay) resetForm();
  selectedDay = iso;
  calMonth = firstOfMonth(new Date(iso + "T00:00:00"));
  renderAll();
}

calendarEl.addEventListener("click", (e) => {
  const day = e.target.closest(".cal-day");
  if (day) selectDay(day.dataset.date);
});

document.getElementById("calPrev").addEventListener("click", () => { calMonth = addMonths(calMonth, -1); renderCalendar(); renderList(); });
document.getElementById("calNext").addEventListener("click", () => { calMonth = addMonths(calMonth, 1); renderCalendar(); renderList(); });
document.getElementById("calToday").addEventListener("click", () => selectDay(todayISO()));

// Loads an entry into the log form (switching to its day in the calendar).
function startEdit(entry) {
  if (view !== "calendar") setView("calendar");
  if (entry.date !== selectedDay) selectDay(entry.date);
  editingEntryId = entry.id;
  projectPicked = true;
  selectedProjectId = entry.projectId;
  selectedTaskId = entry.taskId;
  entryHours.value = entry.hours;
  entryNote.value = entry.note || "";
  isDirty = true;
  renderLogForm();
  entryHours.focus();
}

dayEntries.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-entry]");
  if (editBtn) {
    const entry = timeEntries.find((x) => x.id === editBtn.dataset.editEntry);
    if (entry) startEdit(entry);
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

// Every open task on the project. On billable projects your assigned tasks
// come first; the rest ("other tasks") can still be logged to — assignments
// are the plan, not a gate — and your PM sees those hours flagged. Closed
// tasks (e.g. finished proposals) are hidden unless an entry being edited
// is on one.
function myTaskOptions() {
  const byName = (a, b) => a.task.name.localeCompare(b.task.name);
  const open = tasks.filter((t) => t.projectId === selectedProjectId && (!t.closed || t.id === selectedTaskId));
  if (selectedProjectIsInternal()) {
    return open.map((task) => ({ assignment: null, task, internal: true })).sort(byName);
  }
  return open
    .map((task) => ({ task, assignment: assignments.find((a) => a.personId === selectedPersonId && a.taskId === task.id) || null }))
    .sort((a, b) => (!a.assignment - !b.assignment) || byName(a, b));
}

// The entry this person already has for the selected day + task, if any —
// logging again replaces it rather than adding a second one.
function existingEntry() {
  return timeEntries.find((e) =>
    e.personId === selectedPersonId && e.taskId === selectedTaskId && e.date === selectedDay);
}

// When editing an entry and switching it to a task that already has its own
// entry that day, the two would collide.
function editConflict() {
  const existing = existingEntry();
  return !!(editingEntryId && existing && existing.id !== editingEntryId);
}

// Hours already logged on the selected day, not counting the entry a save replaces.
function otherHoursThatDay(replacingId) {
  return timeEntries
    .filter((e) => e.personId === selectedPersonId && e.date === selectedDay && e.id !== replacingId)
    .reduce((s, e) => s + Number(e.hours || 0), 0);
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
  if (!projectPicked || !selectedProjectId) selectedProjectId = mine[0].id;

  projectCardsEl.innerHTML = mine.map((p) => `
    <div class="project-card project-card-colored ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}" style="--c:${projectColor(p.id)};">
      <div class="name">${esc(p.name)}</div>
      <div class="client">${p.client ? esc(p.client) : isInternal(p) ? "Internal" : "&nbsp;"}</div>
    </div>`).join("");

  if (!selectedProjectId) {
    noAssignmentsEmpty.style.display = "none";
    entryForm.style.display = "none";
    return;
  }

  const options = myTaskOptions();
  if (options.length === 0 && !selectedProjectIsInternal()) {
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

// One card per task, showing your hours on it: "8 of 20 hrs" with a bar when
// assigned (amber past the assignment), just what you've logged otherwise.
function taskCardHtml(c) {
  const active = c.task.id === selectedTaskId;
  const logged = loggedOnTask(c.task.id);
  let label;
  let value;
  let bar = "";
  const assignedHrs = c.assignment ? assignedHours(c.assignment, { projects, people }) : 0;
  if (c.internal) {
    label = "You've logged";
    value = `${fmtHours(logged)} hrs`;
  } else if (c.assignment && assignedHrs <= 0) {
    // On the task, but no hours handed out yet.
    label = "No hours assigned";
    value = logged ? `${fmtHours(logged)} hrs` : "—";
  } else if (c.assignment) {
    const assigned = assignedHours(c.assignment, { projects, people });
    const over = logged - assigned > 0.005;
    label = over ? `${fmtHours(logged - assigned)} hrs past assigned` : "Your hours";
    value = `<span class="${over ? "hours-over" : ""}">${fmtHours(logged)}</span> <span class="task-of">of ${fmtHours(assigned)} hrs</span>`;
    const pct = assigned > 0 ? Math.min(100, (logged / assigned) * 100) : 100;
    bar = `<div class="task-card-bar ${over ? "over" : ""}"><div style="width:${pct}%"></div></div>`;
  } else {
    label = "Not assigned";
    value = logged ? `${fmtHours(logged)} hrs` : "—";
  }
  return `<div class="project-card task-card ${active ? "active" : ""} ${!c.internal && !c.assignment ? "unassigned" : ""}" data-task-card="${c.task.id}">
    <div class="name">${esc(c.task.name)}</div>
    <div class="task-card-stats">
      <div><span class="summary-label">${label}</span><div class="summary-value">${value}</div></div>
    </div>
    ${bar}
  </div>`;
}

function renderTaskCards(options) {
  const mine = options.filter((c) => c.internal || c.assignment);
  const others = options.filter((c) => !c.internal && !c.assignment);
  // Other tasks show when asked for, when you have none assigned here, or
  // when one of them is picked.
  const othersOpen = showOtherTasks || !mine.length || others.some((c) => c.task.id === selectedTaskId);
  const cards = [...mine, ...(othersOpen ? others : [])].map(taskCardHtml);
  if (others.length && mine.length) {
    cards.push(`<button type="button" class="project-card task-card task-card-more" data-action="other-tasks">
      ${othersOpen ? "Hide other tasks" : `+ ${others.length} other task${others.length === 1 ? "" : "s"}`}</button>`);
  }
  // Internal projects (e.g. Proposals & Pursuits): anyone can add a task,
  // like one per proposal, and close it from the Projects tab when done.
  if (selectedProjectIsInternal()) {
    cards.push(addingTask
      ? `<div class="project-card task-card task-card-new">
          <input type="text" id="newTaskName" placeholder="New task name" autocomplete="off" />
          <div class="row-actions">
            <button type="button" class="link-btn" data-action="cancel-new-task">Cancel</button>
            <button type="button" class="small" data-action="save-new-task">Add</button>
          </div>
        </div>`
      : `<button type="button" class="project-card task-card task-card-more" data-action="new-task">+ New task</button>`);
  }
  taskCardsEl.innerHTML = cards.join("");
  if (addingTask) taskCardsEl.querySelector("#newTaskName")?.focus();
}

async function saveNewTask() {
  const input = taskCardsEl.querySelector("#newTaskName");
  const name = input ? input.value.trim() : "";
  if (!name) return showToast("Give the task a name.");
  if (tasks.some((t) => t.projectId === selectedProjectId && !t.closed && t.name.toLowerCase() === name.toLowerCase())) {
    return showToast("There's already a task with that name.");
  }
  try {
    const ref = await Tasks.add({
      projectId: selectedProjectId, name, budget: 0, startDate: null, endDate: null,
      closed: false, createdByPersonId: selectedPersonId,
    });
    addingTask = false;
    selectedTaskId = ref.id;
    renderLogForm();
    showToast("Task added.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
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
  const replacingId = editingEntryId || (existing ? existing.id : null);
  const notes = [];
  if (editConflict()) {
    notes.push("You already have hours on that task this day — edit that entry instead");
    submitEntry.textContent = "Save Changes";
    submitEntry.disabled = true;
  } else if (existing && existing.invoiced) {
    notes.push("Already invoiced for this day — can't be changed");
    submitEntry.textContent = "Log Hours";
    submitEntry.disabled = true;
  } else {
    if (existing && !editingEntryId) notes.push(`Replaces the ${existing.hours} hrs already logged here`);
    submitEntry.textContent = editingEntryId ? "Save Changes" : existing ? "Update Entry" : "Log Hours";
    submitEntry.disabled = false;

    const option = myTaskOptions().find((c) => c.task.id === selectedTaskId);
    const hours = Number(entryHours.value) || 0;
    if (hours > 0 && otherHoursThatDay(replacingId) + hours > 24) {
      notes.push("That's more than 24 hours for this day");
    }
    const assigned = option && option.assignment ? assignedHours(option.assignment, { projects, people }) : 0;
    if (option && option.assignment && assigned > 0 && hours > 0) {
      const after = loggedOnTask(selectedTaskId, replacingId) + hours;
      if (after - assigned > 0.005) {
        notes.push(`${fmtHours(after - assigned)} hrs past your ${fmtHours(assigned)} assigned — that's OK, your PM will see it`);
      }
    } else if (option && !option.internal && !option.assignment) {
      notes.push("Not one of your assigned tasks — that's OK, your PM will see it");
    } else if (option && option.assignment && assigned <= 0 && hours > 0) {
      notes.push("No hours assigned on this task yet — that's OK, your PM will see it");
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
  projectPicked = true;
  selectedTaskId = null;
  showOtherTasks = false;
  addingTask = false;
  renderLogForm();
});

taskCardsEl.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "other-tasks") showOtherTasks = !showOtherTasks;
  if (action === "new-task") addingTask = true;
  if (action === "cancel-new-task") addingTask = false;
  if (action === "save-new-task") return saveNewTask();
  if (!action) {
    const card = e.target.closest("[data-task-card]");
    if (!card) return;
    selectedTaskId = card.dataset.taskCard;
  }
  renderTaskCards(myTaskOptions());
  renderExistingHint();
});

taskCardsEl.addEventListener("keydown", (e) => {
  if (e.target.id !== "newTaskName") return;
  if (e.key === "Enter") saveNewTask();
  if (e.key === "Escape") { addingTask = false; renderTaskCards(myTaskOptions()); }
});

[entryHours, entryNote].forEach((el) => {
  el.addEventListener("input", () => {
    isDirty = entryHours.value.trim() !== "" || entryNote.value.trim() !== "";
    renderExistingHint();
  });
});

function resetForm() {
  entryHours.value = "";
  entryNote.value = "";
  isDirty = false;
  editingEntryId = null;
  selectedTaskId = null;
}

function clearForm() {
  resetForm();
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
  if (editConflict()) return showToast("You already have hours on that task this day — edit that entry instead.");

  const existing = existingEntry();
  if (existing && existing.invoiced) {
    return showToast("This day/task has already been invoiced and can't be changed here.");
  }
  if (otherHoursThatDay(editingEntryId || (existing ? existing.id : null)) + hours > 24) {
    return showToast("That's more than 24 hours for this day — check the hours.");
  }

  const autoApprove = selectedProjectIsInternal();
  const approval = {
    ...(autoApprove
      ? { approved: true, approvedDate: new Date().toISOString() }
      : { approved: false, approvedDate: null }),
    declined: false, declineReason: null, // an edit resubmits a declined entry
  };
  try {
    if (editingEntryId) {
      // Editing can move an entry to another task on the same day.
      await TimeEntries.update(editingEntryId, { projectId, taskId, hours, note, ...approval });
      showToast("Entry updated.");
    } else if (existing) {
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

// ---------- List view ----------
// The month's hours grouped by project, then task (with all-time totals, so
// e.g. hours on one proposal add up across months). Click a task to see each
// entry and its note; Edit opens it in the calendar's log form.
const listView = document.getElementById("listView");
const calView = document.getElementById("calView");
const viewToggle = document.getElementById("viewToggle");

function setView(v) {
  view = v;
  try { localStorage.setItem("pb_timesheet_view", v); } catch (_) { /* no storage */ }
  viewToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === v));
  listView.hidden = v !== "list";
  calView.hidden = v === "list";
  renderList();
}

const sumHrs = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

function renderList() {
  if (view !== "list" || !selectedPersonId) return;
  const mine = timeEntries.filter((e) => e.personId === selectedPersonId);
  const month = mine.filter((e) => e.date.startsWith(monthKey(calMonth)));
  if (!month.length) {
    listView.innerHTML = `<div class="empty">Nothing logged in ${esc(formatMonthLabel(calMonth))}.</div>`;
    return;
  }
  const order = sortProjects(projects).map((p) => p.id);
  const projectIds = [...new Set(month.map((e) => e.projectId))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const taskName = (id) => tasks.find((t) => t.id === id)?.name || "—";

  listView.innerHTML = `<div class="list-total">${fmtHrs(sumHrs(month))} hrs in ${esc(formatMonthLabel(calMonth))}</div>
    <div class="pay-scroll"><table class="pay-table appr-table list-table">
    <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
    <thead><tr><th>Date</th><th>Task</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
    ${projectIds.map((pid) => {
      const project = projects.find((p) => p.id === pid);
      const pEntries = month.filter((e) => e.projectId === pid);
      const taskIds = [...new Set(pEntries.map((e) => e.taskId))].sort((a, b) => taskName(a).localeCompare(taskName(b)));
      return `<tbody>
        <tr class="appr-group"><td colspan="6"><span class="pay-dot" style="--c:${projectColor(pid)};"></span><strong>${project ? esc(project.name) : "—"}</strong> <span class="appr-muted">${fmtHrs(sumHrs(pEntries))} hrs</span></td></tr>
        ${taskIds.map((tid) => {
          const key = `${pid}|${tid}`;
          const open = openListKey === key;
          const tEntries = pEntries.filter((e) => e.taskId === tid).sort((a, b) => (a.date < b.date ? -1 : 1));
          const allTime = sumHrs(mine.filter((e) => e.taskId === tid));
          const thisMonth = sumHrs(tEntries);
          return `<tr class="appr-row ${open ? "open" : ""}" data-key="${esc(key)}">
            <td class="appr-date">${dateRange(tEntries)}</td>
            <td class="appr-task">${esc(taskName(tid))}</td>
            <td class="num appr-subtotal">${fmtHrs(thisMonth)}</td>
            <td class="appr-note appr-muted">${tEntries.length} ${tEntries.length === 1 ? "entry" : "entries"}${allTime - thisMonth > 0.005 ? ` · ${fmtHrs(allTime)} hrs all time` : ""}</td>
            <td></td>
            <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
          </tr>
          ${open ? tEntries.map((e) => `<tr class="appr-entry">
            <td class="appr-date">${entryDate(e.date)}</td>
            <td class="appr-task">${statusPill(e)}</td>
            <td class="num">${fmtHrs(Number(e.hours))}</td>
            <td class="appr-entry-note ${e.note ? "" : "appr-muted"}">${e.note ? esc(e.note) : "No note"}${e.declined && !e.approved && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : ""}</td>
            <td class="num appr-actions" colspan="2">${e.invoiced ? "" : `<button type="button" class="link-btn" data-list-edit="${e.id}">Edit</button>`}</td>
          </tr>`).join("") : ""}`;
        }).join("")}
      </tbody>`;
    }).join("")}
  </table></div>`;
}

listView.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-list-edit]");
  if (edit) {
    const entry = timeEntries.find((x) => x.id === edit.dataset.listEdit);
    if (entry) {
      startEdit(entry);
      document.querySelector(".day-log")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  const row = e.target.closest("tr.appr-row");
  if (!row) return;
  openListKey = openListKey === row.dataset.key ? null : row.dataset.key;
  renderList();
});

viewToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (btn && btn.dataset.value !== view) setView(btn.dataset.value);
});

setView(view);
