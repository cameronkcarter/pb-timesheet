// The Pursuits tab: the firm's internal projects (RFPs, business
// development, education, ...). Never billed; they track hours. Any staff
// can start a Pursuit and add tasks. A task is either unpaid (hours approve
// themselves) or payable (admins only): paid at the person's pay rate once
// the Pursuit's PM approves them, then an admin marks them paid. See rates.js.
import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses } from "./db.js";
import {
  esc, fmtHrs, showToast, todayISO, projectColor, projectShortName, sortProjects, formatCurrency,
  closeOnBackdropClick, confirmDialog, alertDialog, PROJECT_COLOR_CHOICES,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { isInternal, isPayableTask, payRateOf } from "./rates.js";
import { createProjectPicker } from "./project-picker.js";
import { removeProject } from "./project-editor.js";

const sessionPersonId = requireSession();
const $ = (id) => document.getElementById(id);

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let expenses = [];
let navChecked = false;
let selectedId = new URLSearchParams(location.search).get("project");
let expandedTaskId = null;
let showClosed = false;
let adding = false;

wireLogout("logoutLink");

if (sessionPersonId) {
  People.listen((d) => {
    people = d;
    if (!navChecked) {
      navChecked = true;
      applyAdminNavVisibility(me(), projects);
      renderNavUserName(me());
    }
    render();
  });
  Projects.listen((d) => { projects = d; applyAdminNavVisibility(me(), projects); render(); });
  Tasks.listen((d) => { tasks = d; render(); });
  TimeEntries.listen((d) => { timeEntries = d; render(); });
  Assignments.listen((d) => { assignments = d; });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; });
  Expenses.listen((d) => { expenses = d; });
}

const me = () => people.find((p) => p.id === sessionPersonId);
const isAdmin = () => !!me()?.isAdmin;
const pursuits = () => sortProjects(projects.filter(isInternal));
const current = () => projects.find((p) => p.id === selectedId && isInternal(p));
const sumHrs = (list) => list.reduce((s, e) => s + Number(e.hours || 0), 0);
const personName = (id) => people.find((p) => p.id === id)?.name || "—";

// This month / this year, by entry date.
const today = todayISO();
const inMonth = (e) => String(e.date).slice(0, 7) === today.slice(0, 7);
const inYear = (e) => String(e.date).slice(0, 4) === today.slice(0, 4);

// ---------- Picker and heading ----------
const picker = createProjectPicker({
  root: $("projectPicker"),
  getData: () => ({ projects: pursuits(), mine: pursuits(), selectedId }),
  onPick: (id) => {
    selectedId = id;
    expandedTaskId = null;
    adding = false;
    history.replaceState(null, "", `?project=${id}`);
    render();
  },
  action: '<button type="button" id="newPursuitBtn" class="small">+ New Pursuit</button>',
  label: "Pursuits",
});

function render() {
  if (!navChecked) return;
  renderMoveCard();
  const list = pursuits();
  if (!current()) selectedId = list[0]?.id || null;
  picker.render();
  $("pursuitsEmpty").style.display = list.length ? "none" : "block";
  $("projectHead").hidden = !selectedId;
  $("pursuitDetail").style.display = selectedId ? "block" : "none";
  if (!selectedId) return;
  renderHead();
  renderTasks();
  renderPeople();
}

function renderHead() {
  const p = current();
  const pm = people.find((x) => x.id === p.pmPersonId);
  const entries = timeEntries.filter((e) => e.projectId === p.id && !e.declined);
  const payable = tasks.filter((t) => t.projectId === p.id && t.payable).length;
  $("projectHead").style.setProperty("--c", projectColor(p.id));
  $("projectHeadName").textContent = p.name;
  $("projectHeadMeta").textContent = [
    pm ? `PM: ${pm.name}` : "",
    payable ? `${payable} payable ${payable === 1 ? "task" : "tasks"}` : "Unpaid",
  ].filter(Boolean).join(" · ");
  const stat = (v, label) => `<div><b>${v}</b>${label}</div>`;
  const ppl = new Set(entries.map((e) => e.personId)).size;
  $("projectStats").innerHTML = `<div class="project-stat-row">
    ${stat(`${fmtHrs(sumHrs(entries.filter(inMonth)))} hrs`, "this month")}
    ${stat(`${fmtHrs(sumHrs(entries.filter(inYear)))} hrs`, "this year")}
    ${stat(`${fmtHrs(sumHrs(entries))} hrs`, "total")}
    ${stat(ppl, ppl === 1 ? "person" : "people")}
  </div>`;
  document.querySelectorAll(".panel-project-tag").forEach((tag) => {
    tag.style.setProperty("--c", projectColor(p.id));
    tag.textContent = projectShortName(p);
    tag.title = p.name;
  });
}

// ---------- Tasks ----------
const payTag = (t) => (t.payable
  ? '<span class="pay-tag" title="Hours are paid at each person\'s pay rate once the PM approves them">Payable</span>'
  : '<span class="unpaid-tag" title="Hours are tracked, not paid">Not payable</span>');

function renderTasks() {
  const p = current();
  const all = tasks.filter((t) => t.projectId === p.id)
    .sort((a, b) => (!!a.closed - !!b.closed) || (!!b.payable - !!a.payable) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const closedCount = all.filter((t) => t.closed).length;
  const shown = all.filter((t) => showClosed || !t.closed || t.id === expandedTaskId);
  const toggle = $("toggleClosedBtn");
  toggle.hidden = !closedCount;
  toggle.textContent = showClosed ? "Hide closed" : `Show closed (${closedCount})`;
  $("addTaskForm").hidden = !adding;
  $("newTaskPayableLabel").hidden = !isAdmin();
  $("tasksEmpty").style.display = shown.length ? "none" : "block";
  $("tasksEmpty").textContent = all.length ? "All tasks are closed." : "No tasks yet. Add one for each RFP, event or effort.";
  $("pursuitTable").style.display = shown.length ? "" : "none";
  $("pursuitTable").querySelector("tbody").innerHTML = shown.map((t) => {
    const entries = timeEntries.filter((e) => e.taskId === t.id && !e.declined);
    const open = t.id === expandedTaskId;
    return `<tr class="task-row pursuit-row ${t.payable ? "payable" : ""} ${open ? "expanded" : ""} ${t.closed ? "task-closed" : ""}" data-task-row="${t.id}">
        <td><div class="task-cell" title="${esc(t.name)}"><span class="task-chevron" aria-hidden="true">&#9656;</span><span class="task-name">${esc(t.name)}</span>${t.closed ? '<span class="pill">Closed</span>' : ""}</div></td>
        <td>${payTag(t)}</td>
        <td class="num">${fmtHrs(sumHrs(entries.filter(inMonth)))}</td>
        <td class="num"><b>${fmtHrs(sumHrs(entries))}</b></td>
      </tr>${open ? `<tr class="task-detail"><td colspan="4" class="accordion-cell">${taskDetailHtml(t, entries)}</td></tr>` : ""}`;
  }).join("");
}

// Opened task: hours per person (payable: waiting / approved / paid), then
// its actions.
function taskDetailHtml(t, entries) {
  const ids = [...new Set(entries.map((e) => e.personId))].sort((a, b) => personName(a).localeCompare(personName(b)));
  const ctx = { projects, people };
  let table;
  if (!ids.length) table = '<div class="empty" style="padding:4px 0;">No hours on this task yet.</div>';
  else if (!t.payable) {
    table = `<div class="tp-list pursuit-people">
      <div class="tp-row tp-head"><div>Person</div><div class="num">This month</div><div class="num">Total</div></div>
      ${ids.map((id) => {
        const mine = entries.filter((e) => e.personId === id);
        return `<div class="tp-row"><div>${esc(personName(id))}</div><div class="num">${fmtHrs(sumHrs(mine.filter(inMonth)))}</div><div class="num">${fmtHrs(sumHrs(mine))}</div></div>`;
      }).join("")}
    </div>`;
  } else {
    const cell = (list) => (list.length ? fmtHrs(sumHrs(list)) : '<span class="zero">—</span>');
    table = `<div class="tp-list pursuit-people pursuit-pay">
      <div class="tp-row tp-head"><div>Person</div><div class="num">Waiting approval</div><div class="num">Approved</div><div class="num">Paid</div></div>
      ${ids.map((id) => {
        const mine = entries.filter((e) => e.personId === id);
        return `<div class="tp-row"><div>${esc(personName(id))}</div>
          <div class="num">${cell(mine.filter((e) => !e.approved))}</div>
          <div class="num">${cell(mine.filter((e) => e.approved && !e.paid))}</div>
          <div class="num">${cell(mine.filter((e) => e.paid))}</div></div>`;
      }).join("")}
    </div>`;
  }
  const toPay = entries.filter((e) => t.payable && e.approved && !e.paid);
  const payTotal = toPay.reduce((s, e) => s + Number(e.hours || 0) * payRateOf(e, ctx), 0);
  const actions = [
    isAdmin() && toPay.length ? `<button type="button" class="small" data-action="mark-paid" data-task-id="${t.id}">Mark ${fmtHrs(sumHrs(toPay))} hrs paid (${formatCurrency(payTotal)})</button>` : "",
    `<button type="button" class="link-btn" data-action="rename-task" data-task-id="${t.id}">Rename</button>`,
    isAdmin() ? `<button type="button" class="link-btn" data-action="toggle-payable" data-task-id="${t.id}">${t.payable ? "Make not payable" : "Make payable"}</button>` : "",
    `<button type="button" class="link-btn" data-action="${t.closed ? "reopen-task" : "close-task"}" data-task-id="${t.id}">${t.closed ? "Reopen task" : "Close task"}</button>`,
  ].filter(Boolean).join("");
  const note = t.payable
    ? `Paid at each person's pay rate once ${current().pmPersonId ? `${esc(personName(current().pmPersonId))} approves` : "the PM approves"} the hours.`
    : "Hours are tracked, not paid.";
  return `<div class="pursuit-detail-note">${note}</div>${table}<div class="pursuit-actions">${actions}</div>`;
}

$("pursuitTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) return taskAction(btn.dataset.action, tasks.find((t) => t.id === btn.dataset.taskId));
  const row = e.target.closest("tr.task-row");
  if (!row) return;
  expandedTaskId = expandedTaskId === row.dataset.taskRow ? null : row.dataset.taskRow;
  renderTasks();
});

async function taskAction(action, t) {
  if (!t) return;
  try {
    if (action === "close-task" || action === "reopen-task") {
      const closed = action === "close-task";
      await Tasks.update(t.id, { closed });
      showToast(closed ? "Task closed. It's off the Timesheet; its hours are kept." : "Task reopened.");
    }
    if (action === "rename-task") {
      const name = prompt("Task name", t.name);
      if (name && name.trim() && name.trim() !== t.name) await Tasks.update(t.id, { name: name.trim() });
    }
    if (action === "toggle-payable") {
      if (!t.payable) {
        if (!current().pmPersonId) {
          await alertDialog("Payable hours need a PM to approve them. Pick one with Edit first.", "No PM on this Pursuit");
          return;
        }
        const logged = timeEntries.filter((x) => x.taskId === t.id && !x.declined && !x.paid);
        const ok = await confirmDialog(logged.length
          ? `The ${fmtHrs(sumHrs(logged))} hrs already logged on it will go to ${personName(current().pmPersonId)} for approval and be paid too.`
          : `Hours will be paid at each person's pay rate once ${personName(current().pmPersonId)} approves them.`,
        { title: `Make "${t.name}" payable?`, confirmText: "Make Payable" });
        if (!ok) return;
        await Tasks.update(t.id, { payable: true });
        // Hours that approved themselves go back for the PM to approve.
        for (const x of logged.filter((x) => x.approved)) await TimeEntries.update(x.id, { approved: false, approvedDate: null });
        showToast("Task is payable.");
      } else {
        const paid = timeEntries.filter((x) => x.taskId === t.id && x.paid);
        if (!(await confirmDialog(paid.length ? "Hours already marked paid stay paid. New hours won't be." : "Its hours won't be paid.",
          { title: `Make "${t.name}" not payable?`, confirmText: "Make Not Payable" }))) return;
        await Tasks.update(t.id, { payable: false });
        // Unpaid hours don't need approval.
        for (const x of timeEntries.filter((x) => x.taskId === t.id && !x.paid && !x.approved && !x.declined)) {
          await TimeEntries.update(x.id, { approved: true, approvedDate: new Date().toISOString() });
        }
        showToast("Task is not payable.");
      }
    }
    if (action === "mark-paid") {
      const ctx = { projects, people };
      const toPay = timeEntries.filter((x) => x.taskId === t.id && x.approved && !x.paid && !x.declined);
      const total = toPay.reduce((s, x) => s + Number(x.hours || 0) * payRateOf(x, ctx), 0);
      if (!(await confirmDialog(`${fmtHrs(sumHrs(toPay))} hrs, ${formatCurrency(total)} at each person's current pay rate (locked in once paid).`,
        { title: "Mark these hours paid?", confirmText: "Mark Paid" }))) return;
      await TimeEntries.markPaid(toPay.map((x) => x.id), Object.fromEntries(toPay.map((x) => [x.id, payRateOf(x, ctx)])));
      showToast("Marked paid.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

$("toggleClosedBtn").addEventListener("click", () => { showClosed = !showClosed; renderTasks(); });
$("addTaskBtn").addEventListener("click", () => {
  adding = true;
  renderTasks();
  $("newTaskName").value = "";
  $("newTaskPayable").checked = false;
  $("newTaskName").focus();
});
$("cancelTaskBtn").addEventListener("click", () => { adding = false; renderTasks(); });
$("newTaskName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("saveTaskBtn").click();
  if (e.key === "Escape") $("cancelTaskBtn").click();
});
$("saveTaskBtn").addEventListener("click", async () => {
  const p = current();
  const name = $("newTaskName").value.trim();
  const payable = isAdmin() && $("newTaskPayable").checked;
  if (!name) return showToast("Give the task a name.");
  if (tasks.some((t) => t.projectId === p.id && !t.closed && t.name.toLowerCase() === name.toLowerCase())) {
    return showToast("There's already a task with that name.");
  }
  if (payable && !p.pmPersonId) {
    return alertDialog("Payable hours need a PM to approve them. Pick one with Edit first.", "No PM on this Pursuit");
  }
  try {
    await Tasks.add({
      projectId: p.id, name, budget: 0, startDate: null, endDate: null,
      closed: false, payable, createdByPersonId: sessionPersonId,
    });
    adding = false;
    renderTasks();
    showToast("Task added.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Hours by person ----------
function renderPeople() {
  const entries = timeEntries.filter((e) => e.projectId === selectedId && !e.declined);
  const ids = [...new Set(entries.map((e) => e.personId))].sort((a, b) => personName(a).localeCompare(personName(b)));
  $("peopleEmpty").style.display = ids.length ? "none" : "block";
  $("peopleTable").style.display = ids.length ? "" : "none";
  $("peopleTable").querySelector("tbody").innerHTML = ids.map((id) => {
    const mine = entries.filter((e) => e.personId === id);
    return `<tr><td>${esc(personName(id))}</td><td class="num">${fmtHrs(sumHrs(mine.filter(inMonth)))}</td>
      <td class="num">${fmtHrs(sumHrs(mine.filter(inYear)))}</td><td class="num"><b>${fmtHrs(sumHrs(mine))}</b></td></tr>`;
  }).join("");
}

// ---------- New / Edit Pursuit ----------
const modal = $("pursuitModal");
let editingId = null; // null = new
let pickedColor = null;

// Colors other projects use are crossed out (all open again if every one is taken).
function takenColors(exceptId) {
  const taken = new Map();
  projects.forEach((p) => { if (p.id !== exceptId && !taken.has(projectColor(p.id))) taken.set(projectColor(p.id), projectShortName(p)); });
  return PROJECT_COLOR_CHOICES.every((c) => taken.has(c)) ? new Map() : taken;
}
const firstFreeColor = (exceptId, also = []) => {
  const taken = takenColors(exceptId);
  return PROJECT_COLOR_CHOICES.find((c) => !taken.has(c) && !also.includes(c)) || PROJECT_COLOR_CHOICES[0];
};

function renderSwatches() {
  const taken = takenColors(editingId);
  $("pursuitColor").innerHTML = PROJECT_COLOR_CHOICES.map((c) => {
    const by = c !== pickedColor && taken.get(c);
    return `<button type="button" class="swatch ${c === pickedColor ? "on" : ""} ${by ? "taken" : ""}" style="--c:${c};" data-color="${c}"
      role="radio" aria-checked="${c === pickedColor}" ${by ? "disabled" : ""} title="${by ? `Used by ${esc(by)}` : ""}" aria-label="${by ? `Color used by ${esc(by)}` : `Color ${c}`}"></button>`;
  }).join("");
}

function openModal(p) {
  editingId = p ? p.id : null;
  $("pursuitModalTitle").textContent = p ? "Edit Pursuit" : "New Pursuit";
  $("pursuitName").value = p ? p.name : "";
  $("pursuitShortName").value = p?.shortName || "";
  $("pursuitShortName").placeholder = p ? projectShortName({ name: p.name }) : "";
  $("pursuitPmField").hidden = !isAdmin();
  const choices = people.filter((x) => !x.inactive || x.id === p?.pmPersonId).sort((a, b) => a.name.localeCompare(b.name));
  $("pursuitPm").innerHTML = '<option value="">None</option>' + choices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  $("pursuitPm").value = p?.pmPersonId || "";
  pickedColor = p ? projectColor(p.id) : firstFreeColor(null);
  renderSwatches();
  $("pursuitSave").textContent = p ? "Save" : "Create Pursuit";
  $("pursuitRemove").hidden = !p || !isAdmin();
  modal.style.display = "flex";
  $("pursuitName").focus();
}
const closeModal = () => { modal.style.display = "none"; };

$("pursuitColor").addEventListener("click", (e) => {
  const b = e.target.closest("[data-color]");
  if (!b || b.disabled) return;
  pickedColor = b.dataset.color;
  renderSwatches();
});
$("pursuitCancel").addEventListener("click", closeModal);
$("pursuitModalClose").addEventListener("click", closeModal);
closeOnBackdropClick(modal, closeModal);
$("editPursuitBtn").addEventListener("click", () => openModal(current()));
$("newPursuitBtn").addEventListener("click", () => openModal(null));

$("pursuitSave").addEventListener("click", async () => {
  const name = $("pursuitName").value.trim();
  if (!name) return showToast("Give it a name.");
  const data = { name, shortName: $("pursuitShortName").value.trim() || null, color: pickedColor };
  const pmPersonId = $("pursuitPm").value || null;
  try {
    if (!editingId) {
      const ref = await Projects.add({ ...data, internal: true, pmPersonId: isAdmin() ? pmPersonId : null, createdByPersonId: sessionPersonId });
      selectedId = ref.id;
      history.replaceState(null, "", `?project=${ref.id}`);
      showToast("Pursuit created. Add its tasks below.");
    } else {
      const p = current();
      if (isAdmin()) {
        if (!pmPersonId && tasks.some((t) => t.projectId === p.id && t.payable)) {
          return alertDialog("It has payable tasks, which need a PM to approve their hours.", "Pick a PM");
        }
        data.pmPersonId = pmPersonId;
      }
      await Projects.update(editingId, data);
      showToast("Saved.");
    }
    closeModal();
    render();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

$("pursuitRemove").addEventListener("click", async () => {
  closeModal();
  if (await removeProject(editingId, { projects, tasks, assignments, dueDates, timeEntries, invoices, expenses })) {
    selectedId = null;
    history.replaceState(null, "", location.pathname);
    render();
  }
});

// ---------- Moving the old P&P project's tasks (admins, once) ----------
// P&P held every internal task. Each task moves, with its hours, subtasks
// and assignments, into a Pursuit: RFPs, another category, or its own
// (e.g. Springdale Trails). Guesses are filled in; change any before moving.
const SOURCE_RE = /^(p\s*&\s*p|proposals?\s*(&|and)\s*pursuits?)$/i;
const sourceProject = () => projects.find((p) => isInternal(p) && SOURCE_RE.test(String(p.name).trim())
  && tasks.some((t) => t.projectId === p.id));
const CATEGORIES = ["RFPs", "Business Development", "Education"];
let moveOpen = false;

function guessFor(t) {
  if (/springdale/i.test(t.name) || /\d/.test(t.name)) return "own";
  return "cat:RFPs";
}

function renderMoveCard() {
  const card = $("moveCard");
  const src = isAdmin() && sourceProject();
  card.hidden = !src;
  if (!src) return;
  const list = tasks.filter((t) => t.projectId === src.id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!moveOpen) {
    card.innerHTML = `<div class="budget-header"><div><h2 style="margin:0;">Move ${esc(src.name)} into Pursuits</h2>
      <div class="appr-muted">${list.length} tasks to sort into RFPs, other categories, or their own Pursuit. Hours come along.</div></div>
      <button type="button" class="small" id="moveOpenBtn">Sort Tasks</button></div>`;
    $("moveOpenBtn").addEventListener("click", () => { moveOpen = true; renderMoveCard(); });
    return;
  }
  // Keep what's been picked while things redraw.
  const picked = Object.fromEntries([...card.querySelectorAll("select[data-task-id]")].map((s) => [s.dataset.taskId, s.value]));
  const others = pursuits().filter((p) => p.id !== src.id && !CATEGORIES.includes(p.name));
  const options = (t) => {
    const value = picked[t.id] || guessFor(t);
    const opt = (v, label) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(label)}</option>`;
    return [...CATEGORIES.map((c) => opt(`cat:${c}`, c)), opt("own", "Its own Pursuit"),
      ...others.map((p) => opt(`id:${p.id}`, p.name)), opt("stay", `Leave in ${src.name}`)].join("");
  };
  card.innerHTML = `<div class="budget-header"><h2 style="margin:0;">Move ${esc(src.name)} into Pursuits</h2>
      <button type="button" class="link-btn" id="moveCloseBtn">Close</button></div>
    <div class="appr-muted" style="margin-bottom:10px;">Pick where each task goes. Its hours, subtasks and assignments move with it. All stay unpaid.</div>
    <div class="tp-list move-list">
      <div class="tp-row tp-head"><div>Task</div><div class="num">Hours</div><div>Move to</div></div>
      ${list.map((t) => `<div class="tp-row"><div>${esc(t.name)}${t.closed ? ' <span class="pill">Closed</span>' : ""}</div>
        <div class="num">${fmtHrs(sumHrs(timeEntries.filter((e) => e.taskId === t.id)))}</div>
        <div><select data-task-id="${t.id}" aria-label="Move ${esc(t.name)} to">${options(t)}</select></div></div>`).join("")}
    </div>
    <div class="pursuit-actions"><button type="button" class="small" id="moveGoBtn">Move Tasks</button></div>`;
  $("moveCloseBtn").addEventListener("click", () => { moveOpen = false; renderMoveCard(); });
  $("moveGoBtn").addEventListener("click", () => moveTasks(src));
}

async function moveTasks(src) {
  const picks = [...$("moveCard").querySelectorAll("select[data-task-id]")].map((s) => ({ task: tasks.find((t) => t.id === s.dataset.taskId), to: s.value }))
    .filter((x) => x.task && x.to !== "stay");
  if (!picks.length) return;
  const newOnes = new Set(picks.filter((x) => x.to === "own").map((x) => x.task.name));
  picks.filter((x) => x.to.startsWith("cat:") && !pursuits().some((p) => p.name === x.to.slice(4))).forEach((x) => newOnes.add(x.to.slice(4)));
  if (!(await confirmDialog(`${picks.length} tasks move${newOnes.size ? `, creating ${newOnes.size} new Pursuit${newOnes.size === 1 ? "" : "s"} (${[...newOnes].join(", ")})` : ""}.`,
    { title: "Move these tasks?", confirmText: "Move Tasks" }))) return;
  $("moveGoBtn").disabled = true;
  const created = new Map(); // name -> id
  const usedColors = [];
  const pursuitFor = async (name) => {
    const existing = pursuits().find((p) => p.name === name) || (created.has(name) && { id: created.get(name) });
    if (existing) return existing.id;
    const color = firstFreeColor(null, usedColors);
    usedColors.push(color);
    const ref = await Projects.add({ name, shortName: null, color, internal: true, pmPersonId: null, createdByPersonId: sessionPersonId });
    created.set(name, ref.id);
    return ref.id;
  };
  try {
    for (const { task, to } of picks) {
      const projectId = to.startsWith("id:") ? to.slice(3) : await pursuitFor(to === "own" ? task.name : to.slice(4));
      await Tasks.update(task.id, { projectId });
      for (const e of timeEntries.filter((x) => x.taskId === task.id)) await TimeEntries.update(e.id, { projectId });
      for (const a of assignments.filter((x) => x.taskId === task.id)) await Assignments.update(a.id, { projectId });
      for (const d of dueDates.filter((x) => x.taskId === task.id)) await DueDates.update(d.id, { projectId });
    }
    const leftover = tasks.some((t) => t.projectId === src.id && !picks.some((x) => x.task.id === t.id))
      || dueDates.some((d) => d.projectId === src.id && !d.taskId) || timeEntries.some((e) => e.projectId === src.id && !picks.some((x) => x.task.id === e.taskId));
    if (!leftover) await Projects.remove(src.id);
    moveOpen = false;
    showToast(leftover ? "Tasks moved." : `Tasks moved. ${src.name} was empty, so it's removed.`);
    render();
  } catch (err) {
    showToast("Error: " + err.message);
    $("moveGoBtn").disabled = false;
  }
}
