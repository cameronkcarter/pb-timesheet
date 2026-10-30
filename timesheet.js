import { People, Projects, Tasks, Assignments, TimeEntries } from "./db.js";
import {
  todayISO, toISODate, getWeekStart, monthKey, showToast, fmtHrs, confirmDialog, dateRange, entryDate,
  firstOfMonth, addMonths, addDays, formatMonthLabel, projectColor, projectShortName, sortProjects, esc,
  hoursBarHtml, hoursScale,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { assignedHours, isInternal } from "./rates.js";

// Three cards: a calendar of your hours (two weeks, or the whole month), the
// selected day (its entries and a form to log more), and the month's hours
// by project and task, each task opening to its entries. Entries in both
// places change with Edit -> Save.

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
let editingId = null;         // entry open for editing in the list (one at a time)
let formEditId = null;        // day entry loaded into the Log hours form by its Edit button
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
const calTodayBtn = document.getElementById("calToday");

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

const listTitle = document.getElementById("listTitle");
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
  calModeEl.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.value === calMode);
    b.setAttribute("aria-checked", b.dataset.value === calMode);
  });
  calTodayBtn.hidden = today >= toISODate(start) && today < toISODate(end) && selectedDay === today;

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

// Picking a day in the calendar leaves it where it is; anywhere else (Jump
// to today, a link) also brings that day into view.
function selectDay(iso, { moveCalendar = true } = {}) {
  if (formEditId && iso !== selectedDay) resetForm();
  selectedDay = iso;
  if (moveCalendar) calAnchor = iso;
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
  if (day) selectDay(day.dataset.date, { moveCalendar: false });
});
calModeEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (btn && btn.dataset.value !== calMode) setCalMode(btn.dataset.value);
});
document.getElementById("calPrev").addEventListener("click", () => shiftCalendar(-1));
document.getElementById("calNext").addEventListener("click", () => shiftCalendar(1));
calTodayBtn.addEventListener("click", () => selectDay(todayISO()));

// ---------- The selected day's entries ----------
// Each row's Edit opens its task, note and hours for changing (Save or
// Cancel); the same goes for entries in the list below. Invoiced entries
// are locked.

// While a row is open for editing, its table isn't redrawn under it (unless
// forced, e.g. by opening or closing the row).
const holdRedraw = (container, force) => !force && !!container.querySelector("tr.editing");

const isLocked = (e) => e.invoiced || e.paid;
const declineNote = (e) => (e.declined && !e.approved && e.declineReason ? `<div class="declined-note">${esc(e.declineReason)}</div>` : "");
// The note box grows to show the whole note (see fitNotes).
const noteInput = (e) => `<textarea class="cell edit-note" rows="1" placeholder="What did you work on?" aria-label="Note">${esc(e.note || "")}</textarea>`;
const hoursInput = (e) => `<input type="number" class="cell cell-hours edit-hours" min="0" step="0.25" value="${Number(e.hours || 0)}" aria-label="Hours" />`;
// A value shown the same size as its edit box, so opening a row moves nothing.
const cellText = (text, cls = "") => `<div class="cell ${cls}">${text}</div>`;
// Three fixed slots, so nothing shifts: Cancel (only while editing),
// Edit / Save, and x. The day table's Edit opens the Log hours form instead.
const dayActions = () => `<div class="row-btns">
    <button type="button" class="small secondary" data-action="form-edit">Edit</button>
    <button type="button" class="icon-btn" data-action="delete-entry" title="Delete" aria-label="Delete entry">&times;</button>
  </div>`;
const rowActions = (e) => {
  const editing = editingId === e.id;
  return `<div class="row-btns">
    <button type="button" class="link-btn ${editing ? "" : "invisible"}" data-action="cancel-entry" ${editing ? "" : 'tabindex="-1" aria-hidden="true"'}>Cancel</button>
    ${editing
      ? '<button type="button" class="small" data-action="save-entry">Save</button>'
      : '<button type="button" class="small secondary" data-action="edit-entry">Edit</button>'}
    <button type="button" class="icon-btn" data-action="delete-entry" title="Delete" aria-label="Delete entry">&times;</button>
  </div>`;
};
function fitNotes(container) {
  container.querySelectorAll("textarea.edit-note").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  });
}

function renderDay(force = false) {
  if (!selectedPersonId) return;
  const entries = myEntriesOn(selectedDay);
  dayHeading.innerHTML = `${esc(dayLabel(selectedDay))}${entries.length ? ` <span class="day-total">— ${fmtHrs(sumHrs(entries))} hrs logged</span>` : ""}`;
  if (holdRedraw(dayEntries, force)) return;
  if (entries.length === 0) {
    dayEntries.innerHTML = `<div class="empty day-empty">Nothing logged this day yet.</div>`;
    return;
  }
  dayEntries.innerHTML = `<div class="table-scroll"><table class="day-table entry-table">
      <colgroup><col class="c-project" /><col class="c-task" /><col /><col class="c-hours" /><col class="c-status" /><col class="c-actions" /></colgroup>
      <thead><tr><th>Project</th><th>Task</th><th>Note</th><th class="num">Hours</th><th>Status</th><th></th></tr></thead>
      <tbody>${entries.map(dayRowHtml).join("")}</tbody>
    </table></div>`;
  fitNotes(dayEntries);
}

function dayRowHtml(e) {
  const project = projects.find((p) => p.id === e.projectId);
  const task = tasks.find((t) => t.id === e.taskId);
  return `<tr class="${formEditId === e.id ? "in-form" : ""}" data-entry-id="${e.id}">
    <td class="day-project" title="${esc(project?.name || "")}"><span class="cal-swatch" style="--c:${projectColor(e.projectId)};"></span>${project ? esc(projectShortName(project)) : "—"}</td>
    <td class="cell-td">${cellText(task ? esc(task.name) : "—", "cell-task")}</td>
    <td class="cell-td">${cellText(esc(e.note || ""))}${declineNote(e)}</td>
    <td class="cell-td num">${cellText(fmtHrs(Number(e.hours || 0)), "cell-hours")}</td>
    <td class="day-status">${statusPill(e)}</td>
    <td class="cell-td">${isLocked(e) ? "" : dayActions()}</td>
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

// Opens one entry for editing (closing any other) or, with null, closes it.
function setEditing(id) {
  editingId = id;
  renderDay(true);
  renderList(true);
  const row = document.querySelector("tr.editing");
  row?.querySelector(".edit-hours")?.focus();
}

async function saveEntry(row) {
  const entry = timeEntries.find((x) => x.id === row.dataset.entryId);
  if (!entry) return setEditing(null);
  const hours = Number(row.querySelector(".edit-hours").value);
  const note = row.querySelector(".edit-note").value.trim();
  const taskId = row.querySelector(".edit-task")?.value || entry.taskId;
  if (!(hours > 0)) return showToast("Enter hours worked.");
  if (otherHoursOn(entry.date, entry.id) + hours > 24) return showToast("That's more than 24 hours for this day — check the hours.");
  if (!note) return showToast("Add a note describing what you worked on.");
  if (myEntriesOn(entry.date).some((x) => x.taskId === taskId && x.id !== entry.id)) {
    return showToast("You already have hours on that task this day — edit that entry instead.");
  }
  const changes = {};
  if (hours !== Number(entry.hours || 0)) changes.hours = hours;
  if (note !== (entry.note || "")) changes.note = note;
  if (taskId !== entry.taskId) changes.taskId = taskId;
  if (!Object.keys(changes).length) return setEditing(null);
  // Undo puts the old values (and any decline) back. An entry that was
  // approved stays sent for approval again.
  const before = { declined: !!entry.declined, declineReason: entry.declineReason || null };
  Object.keys(changes).forEach((k) => { before[k] = k === "hours" ? Number(entry.hours || 0) : entry[k] || ""; });
  try {
    await TimeEntries.update(entry.id, { ...changes, ...approvalFields(entry.projectId) });
    setEditing(null);
    showToast("Entry updated.", {
      action: "Undo",
      onAction: () => TimeEntries.update(entry.id, before).catch((err) => showToast("Error: " + err.message)),
    });
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// Delete after a confirm, with Undo (which adds it back; an approved entry
// comes back sent for approval again).
async function deleteEntry(entry) {
  if (!(await confirmDialog("", { title: "Delete this entry?", confirmText: "Delete", danger: true }))) return;
  const { id, createdAt, ...data } = entry;
  if (data.approved && !isInternal(projects.find((p) => p.id === data.projectId))) {
    Object.assign(data, { approved: false, approvedDate: null });
  }
  try {
    await TimeEntries.remove(id);
    if (formEditId === id) clearForm();
    showToast("Entry deleted.", {
      action: "Undo",
      onAction: () => TimeEntries.add(data).catch((err) => showToast("Error: " + err.message)),
    });
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

[dayEntries, listView].forEach((container) => {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    const row = btn?.closest("tr[data-entry-id]");
    if (!row) return;
    const action = btn.dataset.action;
    if (action === "edit-entry") setEditing(row.dataset.entryId);
    if (action === "form-edit") {
      const entry = timeEntries.find((x) => x.id === row.dataset.entryId);
      if (formEditId === entry?.id) clearForm();
      else if (entry) startFormEdit(entry);
    }
    if (action === "cancel-entry") setEditing(null);
    if (action === "save-entry") saveEntry(row);
    if (action === "delete-entry") {
      const entry = timeEntries.find((x) => x.id === row.dataset.entryId);
      if (entry) deleteEntry(entry);
    }
  });
  // Enter saves (rather than adding a line to the note); Escape cancels.
  container.addEventListener("keydown", (e) => {
    const row = e.target.closest("tr.editing");
    if (!row) return;
    if (e.key === "Enter" && !e.target.matches("select")) {
      e.preventDefault();
      saveEntry(row);
    }
    if (e.key === "Escape") setEditing(null);
  });
  container.addEventListener("input", (e) => {
    if (e.target.matches("textarea.edit-note")) fitNotes(e.target.parentElement);
  });
});

// Note boxes re-fit when the page width changes.
window.addEventListener("resize", () => {
  fitNotes(dayEntries);
  fitNotes(listView);
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
// tasks (e.g. finished proposals) are hidden unless the entry being edited
// is on one.
function myTaskOptions() {
  const editTaskId = formEditId && timeEntries.find((e) => e.id === formEditId)?.taskId;
  const open = tasks.filter((t) => t.projectId === selectedProjectId && (!t.closed || t.id === editTaskId)).sort(byTaskName);
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

// When editing an entry and switching it to a task that already has its own
// entry that day, the two would collide.
function editConflict() {
  const existing = existingEntry();
  return !!(formEditId && existing && existing.id !== formEditId);
}

// Loads a day entry into the Log hours form (Update Entry). Its Edit again,
// Escape or picking another day puts the form back.
function startFormEdit(entry) {
  if (editingId) setEditing(null);
  formEditId = entry.id;
  projectPicked = true;
  selectedProjectId = entry.projectId;
  selectedTaskId = entry.taskId;
  showOtherTasks = false;
  addingTask = false;
  entryHours.value = entry.hours;
  entryNote.value = entry.note || "";
  isDirty = true;
  renderLogForm();
  renderDay(true);
  // Bring the day (its entries, then Log hours with the entry in it) to the
  // top of the window, making room below it when the page is too short.
  const top = dayCard.getBoundingClientRect().top + window.scrollY - 12;
  document.body.style.minHeight = `${top + window.innerHeight}px`;
  window.scrollTo({ top, behavior: "smooth" });
  entryHours.focus({ preventScroll: true });
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
  const rows = [`<div class="ts-task-head"><span>Task — click to log hours</span><span>Your hours</span><span>${internal ? "" : "Assigned"}</span></div>`,
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
  const replacingId = formEditId || existing?.id;
  const notes = [];
  submitEntry.textContent = formEditId || existing ? "Update Entry" : "Log Hours";
  submitEntry.disabled = false;
  if (editConflict()) {
    notes.push("You already have hours on that task this day — edit that entry instead");
    submitEntry.disabled = true;
  } else if (existing && (existing.invoiced || existing.paid)) {
    notes.push("Already invoiced for this day — can't be changed");
    submitEntry.disabled = true;
  } else if (selectedTaskId) {
    if (existing && !formEditId) notes.push(`Replaces the ${fmtHrs(Number(existing.hours))} hrs already logged here`);
    const option = myTaskOptions().find((c) => c.task.id === selectedTaskId);
    const hours = Number(entryHours.value) || 0;
    if (hours > 0 && otherHoursOn(selectedDay, replacingId) + hours > 24) {
      notes.push("That's more than 24 hours for this day");
    }
    const assigned = option?.assignment ? assignedHours(option.assignment, { projects, people }) : 0;
    if (option?.assignment && assigned > 0 && hours > 0) {
      const after = loggedOnTask(selectedTaskId, replacingId) + hours;
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
    if (e.key === "Escape" && formEditId) clearForm();
  });
});

function resetForm() {
  entryHours.value = "";
  entryNote.value = "";
  isDirty = false;
  selectedTaskId = null;
  formEditId = null;
}

function clearForm() {
  resetForm();
  document.body.style.minHeight = "";
  renderLogForm();
  renderDay(true);
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
  if (editConflict()) return showToast("You already have hours on that task this day — edit that entry instead.");

  const existing = existingEntry();
  if (existing && (existing.invoiced || existing.paid)) {
    return showToast("This day/task has already been invoiced and can't be changed here.");
  }
  if (otherHoursOn(date, formEditId || existing?.id) + hours > 24) {
    return showToast("That's more than 24 hours for this day — check the hours.");
  }

  try {
    const editing = formEditId && timeEntries.find((e) => e.id === formEditId);
    if (editing) {
      // Can move the entry to another task or project on the same day. Undo
      // puts the old values (and any decline) back; an entry that was
      // approved stays sent for approval again.
      const before = {
        projectId: editing.projectId, taskId: editing.taskId, hours: Number(editing.hours || 0), note: editing.note || "",
        declined: !!editing.declined, declineReason: editing.declineReason || null,
      };
      await TimeEntries.update(editing.id, { projectId, taskId, hours, note, ...approvalFields(projectId) });
      showToast("Entry updated.", {
        action: "Undo",
        onAction: () => TimeEntries.update(editing.id, before).catch((err) => showToast("Error: " + err.message)),
      });
    } else if (existing) {
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
// to see its entries; Edit changes an entry's hours and note.
function renderList(force = false) {
  if (!selectedPersonId || holdRedraw(listView, force)) return;
  const anchor = new Date(calAnchor + "T00:00:00");
  const mine = myEntries();
  const month = mine.filter((e) => e.date.startsWith(monthKey(anchor)));
  listTitle.textContent = `— ${formatMonthLabel(anchor)}${month.length ? ` · ${fmtHrs(sumHrs(month))} hrs` : ""}`;
  if (!month.length) {
    listView.innerHTML = `<div class="empty">Nothing logged in ${esc(formatMonthLabel(anchor))}.</div>`;
    return;
  }
  const order = sortProjects(projects).map((p) => p.id);
  const projectIds = [...new Set(month.map((e) => e.projectId))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const taskName = (id) => tasks.find((t) => t.id === id)?.name || "—";

  listView.innerHTML = `<div class="pay-scroll"><table class="pay-table appr-table list-table entry-table">
    <colgroup><col class="c-date" /><col class="c-task" /><col class="c-hours" /><col /><col class="c-actions" /><col class="c-chev" /></colgroup>
    <thead><tr><th>Date</th><th>Task</th><th class="num">Hours</th><th>Notes</th><th></th><th></th></tr></thead>
    ${projectIds.map((pid) => {
      const project = projects.find((p) => p.id === pid);
      const pEntries = month.filter((e) => e.projectId === pid);
      const taskIds = [...new Set(pEntries.map((e) => e.taskId))].sort((a, b) => taskName(a).localeCompare(taskName(b), undefined, { numeric: true }));
      return `<tbody>
        <tr class="appr-group"><td colspan="2"><span class="pay-dot" style="--c:${projectColor(pid)};"></span><strong>${project ? esc(project.name) : "—"}</strong></td><td class="num">${fmtHrs(sumHrs(pEntries))}</td><td colspan="3"></td></tr>
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
          ${open ? tEntries.map((e) => {
            const editing = editingId === e.id;
            return `<tr class="appr-entry ${editing ? "editing" : ""}" data-entry-id="${e.id}">
              <td class="appr-date">${entryDate(e.date)}</td>
              <td class="appr-task">${statusPill(e)}</td>
              <td class="cell-td num">${editing ? hoursInput(e) : cellText(fmtHrs(Number(e.hours || 0)), "cell-hours")}</td>
              <td class="cell-td">${editing ? noteInput(e) : cellText(esc(e.note || ""))}${declineNote(e)}</td>
              <td class="cell-td" colspan="2">${isLocked(e) ? "" : rowActions(e)}</td>
            </tr>`;
          }).join("") : ""}`;
        }).join("")}
      </tbody>`;
    }).join("")}
  </table></div>`;
  fitNotes(listView);
}

listView.addEventListener("click", (e) => {
  const row = e.target.closest("tr.appr-row");
  if (!row) return;
  openListKey = openListKey === row.dataset.key ? null : row.dataset.key;
  renderList();
});
