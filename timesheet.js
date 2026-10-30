import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  todayISO, toISODate, getWeekStart, monthKey, showToast, fmtHrs, confirmDialog,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor, projectShortName, sortProjects, esc,
  hoursBarHtml, hoursScale,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignedHours, isInternal } from "./rates.js";

// Three cards: a calendar of your hours (a week, or the whole month), the
// selected day (its entries, editable in place, and a form to log more), and
// a list of the month's entries to look back through. Clicking a list row
// opens its day.

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
let selectedDay = todayISO();
let calAnchor = selectedDay; // a day in the week or month the calendar shows
let calMode = "week";        // or "month"
let showOtherTasks = false;  // tasks on the project you're not assigned to
let addingTask = false;      // the "+ New task" box on internal projects
let listProjectId = null;    // project filter on the list (null: all)
let listQuery = "";
let dayRedrawPending = false; // a redraw skipped while editing an entry
try { if (localStorage.getItem("pb_timesheet_cal") === "month") calMode = "month"; } catch (_) { /* no storage */ }
// timesheet.html?day=YYYY-MM-DD opens that day (e.g. "Fix" on a declined entry).
const linkedDay = new URLSearchParams(location.search).get("day");
if (/^\d{4}-\d{2}-\d{2}$/.test(linkedDay || "")) {
  selectedDay = linkedDay;
  calAnchor = linkedDay;
}

const calendarEl = document.getElementById("calendar");
const calLabel = document.getElementById("calLabel");
const calModeEl = document.getElementById("calMode");

const dayCard = document.getElementById("dayCard");
const dayHeading = document.getElementById("dayHeading");
const dayEntries = document.getElementById("dayEntries");
const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const noAssignmentsEmpty = document.getElementById("noAssignmentsEmpty");
const entryForm = document.getElementById("entryForm");
const taskRowsEl = document.getElementById("taskRows");
const entryHours = document.getElementById("entryHours");
const entryNote = document.getElementById("entryNote");
const existingHint = document.getElementById("existingHint");
const submitEntry = document.getElementById("submitEntry");

const listTitle = document.getElementById("listTitle");
const listSearch = document.getElementById("listSearch");
const listFilters = document.getElementById("listFilters");
const listView = document.getElementById("listView");

const sumHrs = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);
const byTaskName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const projectName = (id) => projects.find((p) => p.id === id)?.name || "—";

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
  renderDay();
  renderLogForm();
  renderList();
}

window.addEventListener("beforeunload", (e) => {
  if (!isDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

function myEntries() {
  return timeEntries.filter((e) => e.personId === selectedPersonId);
}

function myEntriesOn(iso) {
  return myEntries().filter((e) => e.date === iso);
}

// Only what you can act on shows: declined (fix it) and invoiced or paid
// (locked). Pending and approved look the same.
function statusPill(e) {
  if (e.paid) return '<span class="pill green">Paid</span>';
  if (e.invoiced) return '<span class="pill blue">Invoiced</span>';
  if (e.declined && !e.approved) return '<span class="pill red">Declined</span>';
  return "";
}

// ---------- Calendar ----------
// Sunday to Saturday, weekends narrow. Each day shows its total hours and a
// thin bar split by project (hover a piece for the project).
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekLabel(start) {
  const last = addDays(start, 6);
  const fmt = (d, opts) => d.toLocaleDateString("en-US", opts);
  if (start.getFullYear() !== last.getFullYear()) {
    const full = { month: "short", day: "numeric", year: "numeric" };
    return `${fmt(start, full)} – ${fmt(last, full)}`;
  }
  const end = start.getMonth() === last.getMonth() ? last.getDate() : fmt(last, { month: "short", day: "numeric" });
  return `${fmt(start, { month: "short", day: "numeric" })} – ${end}, ${last.getFullYear()}`;
}

function projectBarHtml(entries) {
  const hours = {};
  entries.forEach((e) => { hours[e.projectId] = (hours[e.projectId] || 0) + Number(e.hours || 0); });
  return `<span class="cal-bar">${Object.keys(hours)
    .sort((a, b) => projectName(a).localeCompare(projectName(b)))
    .map((pid) => `<span style="flex:${hours[pid]}; background:${projectColor(pid)};" title="${esc(projectName(pid))} — ${fmtHrs(hours[pid])} hrs"></span>`)
    .join("")}</span>`;
}

function renderCalendar() {
  if (!selectedPersonId) return;
  const byDate = {};
  myEntries().forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const today = todayISO();
  const anchor = new Date(calAnchor + "T00:00:00");
  let start;
  let end;
  if (calMode === "week") {
    start = getWeekStart(calAnchor);
    end = addDays(start, 7);
    calLabel.textContent = weekLabel(start);
  } else {
    const first = firstOfMonth(anchor);
    start = getWeekStart(toISODate(first));
    end = addDays(getWeekStart(toISODate(addDays(addMonths(first, 1), -1))), 7);
    calLabel.textContent = formatMonthLabel(first);
  }
  calModeEl.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.value === calMode);
    b.setAttribute("aria-checked", b.dataset.value === calMode);
  });

  const month = monthKey(anchor);
  const cells = WEEKDAYS.map((d) => `<div class="cal-weekday">${d}</div>`);
  for (let d = start; d < end; d = addDays(d, 1)) {
    const iso = toISODate(d);
    const entries = byDate[iso] || [];
    const total = sumHrs(entries);
    const declined = entries.some((e) => e.declined && !e.approved);
    const out = calMode === "month" && !iso.startsWith(month);
    const classes = ["cal-day", out ? "out" : "", iso === today ? "today" : "", iso === selectedDay ? "selected" : ""].join(" ");
    cells.push(`<button type="button" class="${classes}" data-date="${iso}">
      <span class="cal-date">${d.getDate()}${declined ? '<i class="cal-declined" title="Declined hours"></i>' : ""}</span>
      ${total ? `<span class="cal-hrs">${fmtHrs(total)}<small> hrs</small></span>${projectBarHtml(entries)}` : ""}
    </button>`);
  }
  calendarEl.className = `cal-grid ${calMode}`;
  calendarEl.innerHTML = cells.join("");
}

function selectDay(iso) {
  selectedDay = iso;
  calAnchor = iso;
  renderAll();
}

function setCalMode(mode) {
  // Into a week: the selected day's, if it's in the month shown.
  if (mode === "week" && selectedDay.startsWith(monthKey(new Date(calAnchor + "T00:00:00")))) calAnchor = selectedDay;
  calMode = mode;
  try { localStorage.setItem("pb_timesheet_cal", mode); } catch (_) { /* no storage */ }
  renderCalendar();
  renderList();
}

function shiftCalendar(n) {
  const anchor = new Date(calAnchor + "T00:00:00");
  calAnchor = toISODate(calMode === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  renderCalendar();
  renderList();
}

calendarEl.addEventListener("click", (e) => {
  const day = e.target.closest(".cal-day");
  if (day) selectDay(day.dataset.date);
});
calModeEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (btn && btn.dataset.value !== calMode) setCalMode(btn.dataset.value);
});
document.getElementById("calPrev").addEventListener("click", () => shiftCalendar(-1));
document.getElementById("calNext").addEventListener("click", () => shiftCalendar(1));
document.getElementById("calToday").addEventListener("click", () => selectDay(todayISO()));

// ---------- The selected day's entries ----------
// Task, note and hours are edited in place and save when you leave the box
// (or pick a task). Invoiced entries are locked.
function renderDay() {
  if (!selectedPersonId) return;
  const entries = myEntriesOn(selectedDay);
  dayHeading.innerHTML = `${esc(dayLabel(selectedDay))}${entries.length ? ` <span class="day-total">— ${fmtHrs(sumHrs(entries))} hrs logged</span>` : ""}`;
  // Don't redraw under someone mid-edit; catch up when they leave the table.
  if (dayEntries.contains(document.activeElement) && document.activeElement.matches(".ts-edit")) {
    dayRedrawPending = true;
    return;
  }
  dayRedrawPending = false;
  if (entries.length === 0) {
    dayEntries.innerHTML = `<div class="empty day-empty">Nothing logged this day yet.</div>`;
    return;
  }
  dayEntries.innerHTML = `<div class="table-scroll"><table class="day-table">
      <colgroup><col class="c-project" /><col /><col class="c-hours" /><col class="c-status" /><col class="c-x" /></colgroup>
      <thead><tr><th>Project</th><th>Task</th><th class="num">Hours</th><th></th><th></th></tr></thead>
      <tbody>${entries.map(dayRowHtml).join("")}</tbody>
    </table></div>`;
}

function dayRowHtml(e) {
  const project = projects.find((p) => p.id === e.projectId);
  const task = tasks.find((t) => t.id === e.taskId);
  const reason = e.declined && !e.approved && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : "";
  const projectCell = `<td class="day-project" title="${esc(project?.name || "")}"><span class="cal-swatch" style="--c:${projectColor(e.projectId)};"></span>${project ? esc(projectShortName(project)) : "—"}</td>`;
  if (e.invoiced || e.paid) {
    return `<tr data-entry-id="${e.id}">${projectCell}
      <td><div class="day-task">${task ? esc(task.name) : "—"}</div><div class="day-note">${esc(e.note || "")}</div></td>
      <td class="num day-hours">${fmtHrs(Number(e.hours || 0))}</td>
      <td>${statusPill(e)}</td><td></td>
    </tr>`;
  }
  const options = tasks.filter((t) => t.projectId === e.projectId && (!t.closed || t.id === e.taskId)).sort(byTaskName);
  return `<tr data-entry-id="${e.id}">${projectCell}
    <td>
      <select class="ts-edit day-task" data-field="taskId" aria-label="Task" title="Click to change">
        ${options.map((t) => `<option value="${t.id}" ${t.id === e.taskId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>
      <input type="text" class="ts-edit day-note" data-field="note" value="${esc(e.note || "")}" placeholder="Add a note" aria-label="Note" title="Click to change" />
      ${reason}
    </td>
    <td class="num"><input type="number" class="ts-edit day-hours" data-field="hours" min="0" step="0.25" value="${Number(e.hours || 0)}" aria-label="Hours" title="Click to change" /></td>
    <td>${statusPill(e)}<span class="saved-tick"></span></td>
    <td><button type="button" class="icon-btn" data-delete-entry="${e.id}" title="Delete" aria-label="Delete entry">&times;</button></td>
  </tr>`;
}

// Saving any change resubmits the entry for approval (internal projects
// auto-approve) and clears a decline.
function approvalFields(projectId) {
  return {
    ...(isInternal(projects.find((p) => p.id === projectId))
      ? { approved: true, approvedDate: new Date().toISOString() }
      : { approved: false, approvedDate: null }),
    declined: false, declineReason: null,
  };
}

// Hours you have on a day, not counting one entry (the one being changed).
function otherHoursOn(iso, exceptId) {
  return sumHrs(myEntriesOn(iso).filter((e) => e.id !== exceptId));
}

async function saveEdit(el) {
  const row = el.closest("tr[data-entry-id]");
  const entry = timeEntries.find((x) => x.id === row?.dataset.entryId);
  if (!entry) return;
  const field = el.dataset.field;
  const revert = (msg) => {
    showToast(msg);
    el.value = field === "hours" ? Number(entry.hours || 0) : entry[field] || "";
  };
  let value = el.value;
  if (field === "hours") {
    value = Number(value);
    if (!(value > 0)) return revert("Enter hours worked.");
    if (otherHoursOn(entry.date, entry.id) + value > 24) return revert("That's more than 24 hours for this day — check the hours.");
  } else if (field === "note") {
    value = value.trim();
    if (!value) return revert("Add a note describing what you worked on.");
  } else if (field === "taskId" && myEntriesOn(entry.date).some((x) => x.taskId === value && x.id !== entry.id)) {
    return revert("You already have hours on that task this day — change that entry instead.");
  }
  if (String(entry[field] ?? "") === String(value)) return;
  try {
    await TimeEntries.update(entry.id, { [field]: value, ...approvalFields(entry.projectId) });
    const tick = row.querySelector(".saved-tick");
    if (tick) {
      tick.textContent = "Saved";
      tick.classList.add("show");
      setTimeout(() => tick.classList.remove("show"), 1200);
    }
  } catch (err) {
    revert("Error: " + err.message);
  }
}

dayEntries.addEventListener("change", (e) => {
  if (e.target.matches(".ts-edit")) saveEdit(e.target);
});
dayEntries.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input.ts-edit")) e.target.blur();
});
dayEntries.addEventListener("focusout", () => {
  setTimeout(() => {
    if (dayRedrawPending && !dayEntries.contains(document.activeElement)) renderDay();
  });
});

dayEntries.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-delete-entry]");
  if (!delBtn) return;
  if (!(await confirmDialog("", { title: "Delete this entry?", confirmText: "Delete", danger: true }))) return;
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
// tasks (e.g. finished proposals) are hidden.
function myTaskOptions() {
  const open = tasks.filter((t) => t.projectId === selectedProjectId && !t.closed).sort(byTaskName);
  if (selectedProjectIsInternal()) {
    return open.map((task) => ({ assignment: null, task, internal: true }));
  }
  return open
    .map((task) => ({ task, assignment: assignments.find((a) => a.personId === selectedPersonId && a.taskId === task.id) || null }))
    .sort((a, b) => (!a.assignment - !b.assignment) || byTaskName(a.task, b.task));
}

// The entry this person already has for the selected day + task, if any —
// logging again replaces it rather than adding a second one.
function existingEntry() {
  return myEntriesOn(selectedDay).find((e) => e.taskId === selectedTaskId);
}

function renderLogForm() {
  if (!selectedPersonId) return;
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

  projectCardsEl.innerHTML = mine.map((p) => `<button type="button" class="project-chip ${p.id === selectedProjectId ? "on" : ""}"
    data-project-card="${p.id}" style="--c:${projectColor(p.id)};" title="${esc(p.name)}"><i aria-hidden="true"></i>${esc(projectShortName(p))}</button>`).join("");

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
  renderTaskRows(options);
  renderExistingHint();
}

// Hours this person has logged on a task, optionally leaving out one entry
// (the one being replaced when re-logging the same day).
function loggedOnTask(taskId, exceptEntryId = null) {
  return sumHrs(myEntries().filter((e) => e.taskId === taskId && e.id !== exceptEntryId));
}

// One row per task: your hours on it as a bar (one scale for the project,
// like the Projects tab) and "logged / assigned".
function taskRowHtml(c, scale) {
  const active = c.task.id === selectedTaskId;
  const logged = loggedOnTask(c.task.id);
  const assigned = c.assignment ? assignedHours(c.assignment, { projects, people }) : 0;
  let bar = "";
  let text;
  if (c.internal) {
    text = `${fmtHrs(logged)} hrs logged`;
  } else if (!c.assignment) {
    text = logged ? `${fmtHrs(logged)} hrs · not assigned` : "Not assigned";
  } else if (assigned <= 0) {
    text = logged ? `${fmtHrs(logged)} hrs · none assigned` : "No hours assigned";
  } else {
    bar = hoursBarHtml(assigned, logged, scale, { label: false });
    text = `${fmtHrs(logged)} / ${fmtHrs(assigned)} hrs`;
  }
  const over = assigned > 0 && logged - assigned > 0.005;
  return `<button type="button" class="ts-task ${active ? "on" : ""} ${!c.internal && !c.assignment ? "unassigned" : ""}"
      data-task-id="${c.task.id}" role="radio" aria-checked="${active}">
    <span class="ts-radio" aria-hidden="true"></span>
    <span class="ts-task-name">${esc(c.task.name)}</span>
    <span class="ts-task-bar">${bar}</span>
    <span class="ts-task-hrs ${over ? "hb-over-txt" : ""}">${text}</span>
  </button>`;
}

function renderTaskRows(options) {
  const mine = options.filter((c) => c.internal || c.assignment);
  const others = options.filter((c) => !c.internal && !c.assignment);
  // Other tasks show when asked for, when you have none assigned here, or
  // when one of them is picked.
  const othersOpen = showOtherTasks || !mine.length || others.some((c) => c.task.id === selectedTaskId);
  const shown = [...mine, ...(othersOpen ? others : [])];
  const scale = hoursScale(shown.map((c) => ({
    assigned: c.assignment ? assignedHours(c.assignment, { projects, people }) : 0,
    logged: c.assignment ? loggedOnTask(c.task.id) : 0,
  })));
  const rows = shown.map((c) => taskRowHtml(c, scale));
  if (others.length && mine.length) {
    rows.push(`<button type="button" class="ts-task-more" data-action="other-tasks">
      ${othersOpen ? "Hide other tasks" : `+ ${others.length} other task${others.length === 1 ? "" : "s"}`}</button>`);
  }
  // Internal projects (e.g. Proposals & Pursuits): anyone can add a task,
  // like one per proposal, and close it from the Projects tab when done.
  if (selectedProjectIsInternal()) {
    rows.push(addingTask
      ? `<div class="ts-task-new">
          <input type="text" id="newTaskName" placeholder="New task name" autocomplete="off" />
          <button type="button" class="link-btn" data-action="cancel-new-task">Cancel</button>
          <button type="button" class="small" data-action="save-new-task">Add</button>
        </div>`
      : `<button type="button" class="ts-task-more" data-action="new-task">+ New task</button>`);
  }
  taskRowsEl.innerHTML = rows.join("");
  if (addingTask) taskRowsEl.querySelector("#newTaskName")?.focus();
}

async function saveNewTask() {
  const input = taskRowsEl.querySelector("#newTaskName");
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
// your PM).
function renderExistingHint() {
  const existing = selectedTaskId ? existingEntry() : null;
  const notes = [];
  submitEntry.textContent = existing ? "Update Entry" : "Log Hours";
  submitEntry.disabled = false;
  if (existing && (existing.invoiced || existing.paid)) {
    notes.push("Already invoiced for this day — can't be changed");
    submitEntry.disabled = true;
  } else if (selectedTaskId) {
    if (existing) notes.push(`Replaces the ${fmtHrs(Number(existing.hours))} hrs already logged here`);
    const option = myTaskOptions().find((c) => c.task.id === selectedTaskId);
    const hours = Number(entryHours.value) || 0;
    if (hours > 0 && otherHoursOn(selectedDay, existing?.id) + hours > 24) {
      notes.push("That's more than 24 hours for this day");
    }
    const assigned = option?.assignment ? assignedHours(option.assignment, { projects, people }) : 0;
    if (option?.assignment && assigned > 0 && hours > 0) {
      const after = loggedOnTask(selectedTaskId, existing?.id) + hours;
      if (after - assigned > 0.005) {
        notes.push(`${fmtHrs(after - assigned)} hrs past your ${fmtHrs(assigned)} assigned — that's OK, your PM will see it`);
      }
    } else if (option && !option.internal && !option.assignment) {
      notes.push("Not one of your assigned tasks — that's OK, your PM will see it");
    } else if (option?.assignment && assigned <= 0 && hours > 0) {
      notes.push("No hours assigned on this task yet — that's OK, your PM will see it");
    }
  }
  existingHint.className = notes.length ? "entry-status warn" : "entry-status";
  existingHint.innerHTML = notes.length
    ? `<span class="entry-status-icon" aria-hidden="true">&#9888;</span>${notes.map(esc).join(" &middot; ")}`
    : "";
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-chip");
  if (!card || card.dataset.projectCard === selectedProjectId) return;
  selectedProjectId = card.dataset.projectCard;
  projectPicked = true;
  selectedTaskId = null;
  showOtherTasks = false;
  addingTask = false;
  renderLogForm();
});

taskRowsEl.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "other-tasks") showOtherTasks = !showOtherTasks;
  if (action === "new-task") addingTask = true;
  if (action === "cancel-new-task") addingTask = false;
  if (action === "save-new-task") return saveNewTask();
  if (!action) {
    const row = e.target.closest("[data-task-id]");
    if (!row) return;
    selectedTaskId = row.dataset.taskId;
  }
  renderTaskRows(myTaskOptions());
  renderExistingHint();
  if (!action) entryHours.focus();
});

taskRowsEl.addEventListener("keydown", (e) => {
  if (e.target.id !== "newTaskName") return;
  if (e.key === "Enter") saveNewTask();
  if (e.key === "Escape") { addingTask = false; renderTaskRows(myTaskOptions()); }
});

[entryHours, entryNote].forEach((el) => {
  el.addEventListener("input", () => {
    isDirty = entryHours.value.trim() !== "" || entryNote.value.trim() !== "";
    renderExistingHint();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitEntry.click();
  });
});

function clearForm() {
  entryHours.value = "";
  entryNote.value = "";
  isDirty = false;
  selectedTaskId = null;
  renderLogForm();
}

submitEntry.addEventListener("click", async () => {
  const projectId = selectedProjectId;
  const taskId = selectedTaskId;
  const date = selectedDay;
  const hours = Number(entryHours.value);
  const note = entryNote.value.trim();

  if (!projectId || !taskId) return showToast("Choose a task first.");
  if (!hours || hours <= 0) return showToast("Enter hours worked.");
  if (!note) return showToast("Add a note describing what you worked on.");

  const existing = existingEntry();
  if (existing && (existing.invoiced || existing.paid)) {
    return showToast("This day/task has already been invoiced and can't be changed here.");
  }
  if (otherHoursOn(date, existing?.id) + hours > 24) {
    return showToast("That's more than 24 hours for this day — check the hours.");
  }

  try {
    if (existing) {
      await TimeEntries.update(existing.id, { hours, note, ...approvalFields(projectId) });
      showToast("Entry updated.");
    } else {
      const person = people.find((p) => p.id === selectedPersonId);
      await TimeEntries.add({
        personId: selectedPersonId, projectId, taskId, date, hours, note,
        rate: person ? person.rate : 0, ...approvalFields(projectId),
      });
      showToast("Hours logged.");
    }
    clearForm();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Your entries ----------
// The month the calendar shows, newest week first, filtered by project and
// a search of notes and task names. Click a row to open its day above.
function weekKey(iso) {
  return toISODate(getWeekStart(iso));
}

function renderList() {
  if (!selectedPersonId) return;
  const anchor = new Date(calAnchor + "T00:00:00");
  const month = myEntries().filter((e) => e.date.startsWith(monthKey(anchor)));
  listTitle.innerHTML = `${esc(formatMonthLabel(anchor))} <span class="day-total">— ${fmtHrs(sumHrs(month))} hrs</span>`;

  const order = sortProjects(projects).map((p) => p.id);
  const projectIds = [...new Set(month.map((e) => e.projectId))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (listProjectId && !projectIds.includes(listProjectId)) listProjectId = null;
  listFilters.innerHTML = projectIds.length < 2 ? "" : [
    `<button type="button" class="project-chip ${listProjectId ? "" : "on"}" data-list-project="">All projects</button>`,
    ...projectIds.map((pid) => {
      const p = projects.find((x) => x.id === pid);
      return `<button type="button" class="project-chip ${pid === listProjectId ? "on" : ""}" data-list-project="${pid}"
        style="--c:${projectColor(pid)};" title="${esc(p?.name || "")}"><i aria-hidden="true"></i>${esc(projectShortName(p) || "—")}</button>`;
    }),
  ].join("");

  const taskName = (id) => tasks.find((t) => t.id === id)?.name || "—";
  const q = listQuery.trim().toLowerCase();
  const shown = month
    .filter((e) => !listProjectId || e.projectId === listProjectId)
    .filter((e) => !q || `${e.note || ""} ${taskName(e.taskId)}`.toLowerCase().includes(q))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (!shown.length) {
    listView.innerHTML = `<div class="empty">${month.length ? "No entries match." : `Nothing logged in ${esc(formatMonthLabel(anchor))}.`}</div>`;
    return;
  }

  const weeks = [];
  shown.forEach((e) => {
    const key = weekKey(e.date);
    if (weeks.at(-1)?.key !== key) weeks.push({ key, entries: [] });
    weeks.at(-1).entries.push(e);
  });
  listView.innerHTML = weeks.map((w) => `<div class="ts-week">
      <span>${esc(weekLabel(new Date(w.key + "T00:00:00")))}</span><span>${fmtHrs(sumHrs(w.entries))} hrs</span>
    </div>
    ${w.entries.map((e) => `<button type="button" class="ts-list-row ${e.date === selectedDay ? "on" : ""}" data-date="${e.date}" data-entry-id="${e.id}">
      <span class="ts-list-date">${esc(dayLabel(e.date, { weekday: "short", month: "short", day: "numeric" }))}</span>
      <span class="ts-list-task"><span class="cal-swatch" style="--c:${projectColor(e.projectId)};" title="${esc(projectName(e.projectId))}"></span>${esc(taskName(e.taskId))}</span>
      <span class="ts-list-note">${statusPill(e)}${esc(e.note || "")}</span>
      <span class="ts-list-hrs">${fmtHrs(Number(e.hours || 0))}</span>
    </button>`).join("")}`).join("");
}

listFilters.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-list-project]");
  if (!chip) return;
  listProjectId = chip.dataset.listProject || null;
  renderList();
});

listSearch.addEventListener("input", () => {
  listQuery = listSearch.value;
  renderList();
});

// Opens the entry's day above, with its row highlighted.
listView.addEventListener("click", (e) => {
  const row = e.target.closest(".ts-list-row");
  if (!row) return;
  selectDay(row.dataset.date);
  dayCard.scrollIntoView({ behavior: "smooth", block: "start" });
  const tr = dayEntries.querySelector(`tr[data-entry-id="${row.dataset.entryId}"]`);
  if (tr) {
    tr.classList.add("flash");
    setTimeout(() => tr.classList.remove("flash"), 1600);
  }
});
