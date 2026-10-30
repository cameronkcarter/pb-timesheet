import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  todayISO, toISODate, getWeekStart, monthKey, showToast, fmtHrs, confirmDialog, dateRange, entryDate,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor, projectShortName, sortProjects, esc,
  hoursBarHtml, hoursScale,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignedHours, isInternal } from "./rates.js";

// Three cards: a calendar of your hours (two weeks, or the whole month), the
// selected day (its entries, editable in place, and a form to log more), and
// the month's hours by project and task, each task opening to its entries
// (also editable in place).

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
let calMode = "weeks";       // last week and this one, or "month"
let showOtherTasks = false;  // tasks on the project you're not assigned to
let addingTask = false;      // the "+ New task" box on internal projects
let openListKey = null;      // "<projectId>|<taskId>" open in the list
let redrawPending = false;   // a redraw skipped while editing an entry
try { if (localStorage.getItem("pb_timesheet_cal") === "month") calMode = "month"; } catch (_) { /* no storage */ }
// timesheet.html?day=YYYY-MM-DD opens that day (e.g. "Fix" on a declined entry).
const linkedDay = new URLSearchParams(location.search).get("day");
if (/^\d{4}-\d{2}-\d{2}$/.test(linkedDay || "")) {
  selectedDay = linkedDay;
  calAnchor = linkedDay;
}

const calendarEl = document.getElementById("calendar");
const calLabel = document.getElementById("calLabel");
const calModeBtn = document.getElementById("calMode");
const calBackBtn = document.getElementById("calBack");

const dayCard = document.getElementById("dayCard");
const dayHeading = document.getElementById("dayHeading");
const dayEntries = document.getElementById("dayEntries");
const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const projectSelectedEl = document.getElementById("projectSelected");
const noAssignmentsEmpty = document.getElementById("noAssignmentsEmpty");
const entryForm = document.getElementById("entryForm");
const taskRowsEl = document.getElementById("taskRows");
const entryHours = document.getElementById("entryHours");
const entryNote = document.getElementById("entryNote");
const existingHint = document.getElementById("existingHint");
const submitEntry = document.getElementById("submitEntry");

const dayEditTip = document.getElementById("dayEditTip");
const listTitle = document.getElementById("listTitle");
const listEditTip = document.getElementById("listEditTip");
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

function statusPill(e) {
  if (e.paid) return '<span class="pill green">Paid</span>';
  if (e.invoiced) return '<span class="pill blue">Invoiced</span>';
  if (e.approved) return '<span class="pill teal">Approved</span>';
  if (e.declined) return '<span class="pill red">Declined</span>';
  return '<span class="pill orange">Pending Approval</span>';
}

// The day's entries show only what you can act on: declined (fix it) and
// invoiced or paid (locked).
function flagPill(e) {
  return e.paid || e.invoiced || (e.declined && !e.approved) ? statusPill(e) : "";
}

// ---------- Calendar ----------
// Last week and this one (or the whole month), Sunday to Saturday with
// weekends narrow. Each day shows its total hours and a thin bar split by
// project (hover a piece for the project).
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Oct 18 – 31, 2026" for the days from start up to (not including) end.
function rangeLabel(start, end) {
  const last = addDays(end, -1);
  const fmt = (d, opts) => d.toLocaleDateString("en-US", opts);
  if (start.getFullYear() !== last.getFullYear()) {
    const full = { month: "short", day: "numeric", year: "numeric" };
    return `${fmt(start, full)} – ${fmt(last, full)}`;
  }
  const lastText = start.getMonth() === last.getMonth() ? last.getDate() : fmt(last, { month: "short", day: "numeric" });
  return `${fmt(start, { month: "short", day: "numeric" })} – ${lastText}, ${last.getFullYear()}`;
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
  if (calMode === "weeks") {
    start = addDays(getWeekStart(calAnchor), -7);
    end = addDays(start, 14);
    calLabel.textContent = rangeLabel(start, end);
  } else {
    const first = firstOfMonth(anchor);
    start = getWeekStart(toISODate(first));
    end = addDays(getWeekStart(toISODate(addDays(addMonths(first, 1), -1))), 7);
    calLabel.textContent = formatMonthLabel(first);
  }
  calModeBtn.textContent = calMode === "weeks" ? "Show month" : "Show 2 weeks";
  calBackBtn.hidden = today >= toISODate(start) && today < toISODate(end) && selectedDay === today;

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
  // Into two weeks: the selected day's, if it's in the month shown.
  if (mode === "weeks" && selectedDay.startsWith(monthKey(new Date(calAnchor + "T00:00:00")))) calAnchor = selectedDay;
  calMode = mode;
  try { localStorage.setItem("pb_timesheet_cal", mode); } catch (_) { /* no storage */ }
  renderCalendar();
  renderList();
}

function shiftCalendar(n) {
  const anchor = new Date(calAnchor + "T00:00:00");
  calAnchor = toISODate(calMode === "weeks" ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  renderCalendar();
  renderList();
}

calendarEl.addEventListener("click", (e) => {
  const day = e.target.closest(".cal-day");
  if (day) selectDay(day.dataset.date);
});
calModeBtn.addEventListener("click", () => setCalMode(calMode === "weeks" ? "month" : "weeks"));
document.getElementById("calPrev").addEventListener("click", () => shiftCalendar(-1));
document.getElementById("calNext").addEventListener("click", () => shiftCalendar(1));
calBackBtn.addEventListener("click", () => selectDay(todayISO()));

// ---------- The selected day's entries ----------
// Task, note and hours are edited in place and save when you leave the box
// (or pick a task). Invoiced entries are locked.

// True while someone is typing in an entry's box in this container, so it
// isn't redrawn under them; it catches up when they leave (see focusout).
function editingIn(container) {
  if (container.contains(document.activeElement) && document.activeElement.matches(".ts-edit")) {
    redrawPending = true;
    return true;
  }
  return false;
}

const isLocked = (e) => e.invoiced || e.paid;
const declineNote = (e) => (e.declined && !e.approved && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : "");
const noteInput = (e) => `<input type="text" class="ts-edit day-note" data-field="note" value="${esc(e.note || "")}" placeholder="Add a note" aria-label="Note" title="Click to change" />`;
const hoursInput = (e) => `<input type="number" class="ts-edit day-hours" data-field="hours" min="0" step="0.25" value="${Number(e.hours || 0)}" aria-label="Hours" title="Click to change" />`;
const deleteBtn = (e) => `<span class="saved-tick"></span><button type="button" class="icon-btn" data-delete-entry="${e.id}" title="Delete" aria-label="Delete entry">&times;</button>`;

function renderDay() {
  if (!selectedPersonId) return;
  const entries = myEntriesOn(selectedDay);
  dayHeading.innerHTML = `${esc(dayLabel(selectedDay))}${entries.length ? ` <span class="day-total">— ${fmtHrs(sumHrs(entries))} hrs logged</span>` : ""}`;
  dayEditTip.hidden = !entries.some((e) => !isLocked(e));
  if (editingIn(dayEntries)) return;
  if (entries.length === 0) {
    dayEntries.innerHTML = `<div class="empty day-empty">Nothing logged this day yet.</div>`;
    return;
  }
  dayEntries.innerHTML = `<div class="table-scroll"><table class="day-table">
      <colgroup><col class="c-project" /><col class="c-task" /><col /><col class="c-hours" /><col class="c-x" /></colgroup>
      <thead><tr><th>Project</th><th>Task</th><th>Note</th><th class="num">Hours</th><th></th></tr></thead>
      <tbody>${entries.map(dayRowHtml).join("")}</tbody>
    </table></div>`;
}

function dayRowHtml(e) {
  const project = projects.find((p) => p.id === e.projectId);
  const task = tasks.find((t) => t.id === e.taskId);
  const projectCell = `<td class="day-project" title="${esc(project?.name || "")}"><span class="cal-swatch" style="--c:${projectColor(e.projectId)};"></span>${project ? esc(projectShortName(project)) : "—"}</td>`;
  if (isLocked(e)) {
    return `<tr data-entry-id="${e.id}">${projectCell}
      <td><div class="day-task">${task ? esc(task.name) : "—"}</div>${flagPill(e)}</td>
      <td><div class="day-note">${esc(e.note || "")}</div></td>
      <td class="num day-hours">${fmtHrs(Number(e.hours || 0))}</td><td></td>
    </tr>`;
  }
  const options = tasks.filter((t) => t.projectId === e.projectId && (!t.closed || t.id === e.taskId)).sort(byTaskName);
  return `<tr data-entry-id="${e.id}">${projectCell}
    <td>
      <select class="ts-edit day-task" data-field="taskId" aria-label="Task" title="Click to change">
        ${options.map((t) => `<option value="${t.id}" ${t.id === e.taskId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>${flagPill(e)}
    </td>
    <td>${noteInput(e)}${declineNote(e)}</td>
    <td class="num">${hoursInput(e)}</td>
    <td class="num day-x">${deleteBtn(e)}</td>
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

[dayEntries, listView].forEach((container) => {
  container.addEventListener("change", (e) => {
    if (e.target.matches(".ts-edit")) saveEdit(e.target);
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input.ts-edit")) e.target.blur();
  });
  container.addEventListener("focusout", () => {
    setTimeout(() => {
      if (redrawPending && !document.activeElement?.matches(".ts-edit")) {
        redrawPending = false;
        renderDay();
        renderList();
      }
    });
  });
  container.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-delete-entry]");
    if (!delBtn) return;
    if (!(await confirmDialog("", { title: "Delete this entry?", confirmText: "Delete", danger: true }))) return;
    try {
      await TimeEntries.remove(delBtn.dataset.deleteEntry);
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });
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
    projectSelectedEl.hidden = true;
    projectCardsEmpty.style.display = "block";
    noAssignmentsEmpty.style.display = "none";
    entryForm.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";
  if (selectedProjectId && !mine.some((p) => p.id === selectedProjectId)) selectedProjectId = null;
  if (!projectPicked || !selectedProjectId) selectedProjectId = mine[0].id;

  // Your projects as chips (short names), then the picked one's full name,
  // client and PM underneath.
  projectCardsEl.innerHTML = mine.map((p) => `<button type="button" class="project-chip ${p.id === selectedProjectId ? "on" : ""}"
    data-project-card="${p.id}" style="--c:${projectColor(p.id)};" title="${esc(p.name)}"><i aria-hidden="true"></i>${esc(projectShortName(p))}</button>`).join("");
  const picked = mine.find((p) => p.id === selectedProjectId);
  const pm = picked && people.find((x) => x.id === picked.pmPersonId);
  projectSelectedEl.hidden = !picked;
  if (picked) {
    projectSelectedEl.style.setProperty("--c", projectColor(picked.id));
    projectSelectedEl.innerHTML = `<div class="name">${esc(picked.name)}</div>
      <div class="meta">${esc([picked.client || (isInternal(picked) ? "Internal" : ""), pm ? `PM: ${pm.name}` : ""].filter(Boolean).join(" · "))}</div>`;
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
  renderTaskRows(options);
  renderExistingHint();
}

// Hours this person has logged on a task, optionally leaving out one entry
// (the one being replaced when re-logging the same day).
function loggedOnTask(taskId, exceptEntryId = null) {
  return sumHrs(myEntries().filter((e) => e.taskId === taskId && e.id !== exceptEntryId));
}

// One card per task (click to pick it): your hours on it as a bar with
// logged / left under it (one scale for the project, like the Dashboard and
// Projects tab), then the hours you're assigned.
function taskRowHtml(c, scale) {
  const active = c.task.id === selectedTaskId;
  const logged = loggedOnTask(c.task.id);
  const assigned = c.assignment ? assignedHours(c.assignment, { projects, people }) : 0;
  let hours;
  if (c.internal) hours = `<div class="hb-label"><b>${fmtHrs(logged)} hrs logged</b></div>`;
  else if (!c.assignment) hours = `<div class="hb-label">Not assigned${logged ? ` · <b>${fmtHrs(logged)} hrs logged</b>` : ""}</div>`;
  else hours = hoursBarHtml(assigned, logged, scale);
  return `<button type="button" class="ts-task ${active ? "on" : ""} ${!c.internal && !c.assignment ? "unassigned" : ""}"
      data-task-id="${c.task.id}" role="radio" aria-checked="${active}">
    <span class="ts-task-name">${esc(c.task.name)}</span>
    <span class="ts-task-bar">${hours}</span>
    <span class="ts-task-hrs">${c.assignment ? `${fmtHrs(assigned)} hrs` : ""}</span>
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
  const internal = selectedProjectIsInternal();
  const rows = [`<div class="ts-task-head"><span>Task — click one to log hours</span><span>Your hours</span><span>${internal ? "" : "Assigned"}</span></div>`,
    ...shown.map((c) => taskRowHtml(c, scale))];
  if (others.length && mine.length) {
    rows.push(`<button type="button" class="ts-task-more" data-action="other-tasks">
      ${othersOpen ? "Hide other tasks" : `+ ${others.length} other task${others.length === 1 ? "" : "s"}`}</button>`);
  }
  // Internal projects (e.g. Proposals & Pursuits): anyone can add a task,
  // like one per proposal, and close it from the Projects tab when done.
  if (internal) {
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

// ---------- The month's hours ----------
// The month the calendar shows, grouped by project, then task (with all-time
// totals, so e.g. hours on one proposal add up across months). Click a task
// to see its entries; their hours and notes edit in place.
function renderList() {
  if (!selectedPersonId || editingIn(listView)) return;
  const anchor = new Date(calAnchor + "T00:00:00");
  const mine = myEntries();
  const month = mine.filter((e) => e.date.startsWith(monthKey(anchor)));
  listTitle.textContent = `— ${formatMonthLabel(anchor)}${month.length ? ` · ${fmtHrs(sumHrs(month))} hrs` : ""}`;
  listEditTip.hidden = !month.some((e) => !isLocked(e));
  if (!month.length) {
    listView.innerHTML = `<div class="empty">Nothing logged in ${esc(formatMonthLabel(anchor))}.</div>`;
    return;
  }
  const order = sortProjects(projects).map((p) => p.id);
  const projectIds = [...new Set(month.map((e) => e.projectId))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const taskName = (id) => tasks.find((t) => t.id === id)?.name || "—";

  listView.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table list-table">
    <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-x" /><col class="c-chev" /></colgroup>
    <thead><tr><th>Date</th><th>Task</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
    ${projectIds.map((pid) => {
      const project = projects.find((p) => p.id === pid);
      const pEntries = month.filter((e) => e.projectId === pid);
      const taskIds = [...new Set(pEntries.map((e) => e.taskId))].sort((a, b) => taskName(a).localeCompare(taskName(b), undefined, { numeric: true }));
      return `<tbody>
        <tr class="appr-group"><td colspan="6"><span class="pay-dot" style="--c:${projectColor(pid)};"></span><strong>${project ? esc(project.name) : "—"}</strong> <span class="appr-muted">${fmtHrs(sumHrs(pEntries))} hrs</span></td></tr>
        ${taskIds.map((tid) => {
          const key = `${pid}|${tid}`;
          const open = openListKey === key;
          const tEntries = pEntries.filter((e) => e.taskId === tid).sort((a, b) => (a.date < b.date ? -1 : 1));
          const allTime = sumHrs(mine.filter((e) => e.taskId === tid));
          const thisMonth = sumHrs(tEntries);
          const declined = tEntries.some((e) => e.declined && !e.approved);
          return `<tr class="appr-row ${open ? "open" : ""}" data-key="${esc(key)}">
            <td class="appr-date">${dateRange(tEntries)}</td>
            <td class="appr-task">${esc(taskName(tid))}</td>
            <td class="num appr-subtotal">${fmtHrs(thisMonth)}</td>
            <td class="appr-note appr-muted">${declined ? '<span class="pill red">Declined</span> ' : ""}${tEntries.length} ${tEntries.length === 1 ? "entry" : "entries"}${allTime - thisMonth > 0.005 ? ` · ${fmtHrs(allTime)} hrs all time` : ""}</td>
            <td></td>
            <td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>
          </tr>
          ${open ? tEntries.map((e) => `<tr class="appr-entry" data-entry-id="${e.id}">
            <td class="appr-date">${entryDate(e.date)}</td>
            <td class="appr-task">${statusPill(e)}</td>
            <td class="num">${isLocked(e) ? fmtHrs(Number(e.hours || 0)) : hoursInput(e)}</td>
            <td class="appr-entry-note">${isLocked(e) ? esc(e.note || "") : noteInput(e)}${declineNote(e)}</td>
            <td class="num day-x" colspan="2">${isLocked(e) ? "" : deleteBtn(e)}</td>
          </tr>`).join("") : ""}`;
        }).join("")}
      </tbody>`;
    }).join("")}
  </table></div>`;
}

listView.addEventListener("click", (e) => {
  const row = e.target.closest("tr.appr-row");
  if (!row) return;
  openListKey = openListKey === row.dataset.key ? null : row.dataset.key;
  renderList();
});
