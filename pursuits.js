// The Pursuits tab: the firm's own work (RFPs, business development,
// education, ...). Never billed; it tracks hours. The same picker as
// Projects on top (open Pursuits as chips, closed ones in a dropdown), the
// picked one below with its total hours and its tasks, each with a Close button.
//
// Anyone can start a Pursuit, add and rename tasks, and close or reopen
// tasks and Pursuits. A Pursuit is Unpaid (hours approve themselves) or
// Payable (admins only): hours are paid at each person's pay rate once its
// PM approves them, then an admin marks them paid. See rates.js.
//
// Admins also see what the hours cost at each person's pay rate: the real
// cost on a payable Pursuit, and on an unpaid one what the time would have
// cost (its "time value"). A Pursuit and each task can have a target cost
// (targetCost). Pay rates are private, so other staff see only hours.
import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses } from "./db.js";
import {
  esc, fmtHrs, showToast, projectColor, projectShortName, formatCurrency,
  closeOnBackdropClick, confirmDialog, alertDialog, PROJECT_COLOR_CHOICES,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { isInternal, payRateOf, personPayRate } from "./rates.js";
import { removeProject } from "./project-editor.js";
import { createProjectPicker } from "./project-picker.js";

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
let picker = null; // set below; listeners can fire before it exists
let showClosedTasks = false;

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
const current = () => projects.find((p) => p.id === selectedId && isInternal(p));
const sumHrs = (list) => list.reduce((s, e) => s + Number(e.hours || 0), 0);
const personName = (id) => people.find((p) => p.id === id)?.name || "—";
const hoursOn = (filter) => sumHrs(timeEntries.filter((e) => !e.declined && filter(e)));
const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
// What hours cost at pay rate: locked once paid, else the current rate.
const costOf = (list) => list.reduce((s, e) => s + Number(e.hours || 0)
  * (e.paid && e.rate != null ? Number(e.rate) : personPayRate(people.find((x) => x.id === e.personId))), 0);
// "$1,200 of $2,000" with a bar; over target turns red.
function targetHtml(cost, target, cls = "") {
  if (!target) return "";
  const pct = Math.min(100, (cost / target) * 100);
  const over = cost > target;
  return `<div class="pursuit-target ${cls} ${over ? "over" : ""}"><span class="pursuit-target-bar"><span style="width:${pct}%"></span></span>
    <span>${over ? `${money(cost - target)} over` : `${money(target - cost)} left`} of ${money(target)} target</span></div>`;
}
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

// The standing categories first (RFPs at the top), then the rest A–Z.
const PINNED = ["RFPs", "Business Development", "Education"];
function sortPursuits(list) {
  const rank = (p) => { const i = PINNED.indexOf(p.name); return i === -1 ? PINNED.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}
const openPursuits = () => sortPursuits(projects.filter((p) => isInternal(p) && !p.closed));
const closedPursuits = () => sortPursuits(projects.filter((p) => isInternal(p) && p.closed));

const payTag = (p) => (p.payable
  ? `<span class="pay-tag">Payable</span>`
  : `<span class="unpaid-tag">Unpaid</span>`);

function select(id) {
  selectedId = id;
  expandedTaskId = null;
  showClosedTasks = false;
  history.replaceState(null, "", `?project=${id}`);
  render();
}

function render() {
  if (!navChecked) return;
  renderMoveCard();
  if (!current()) selectedId = openPursuits()[0]?.id || closedPursuits()[0]?.id || null;
  const any = projects.some(isInternal);
  $("pursuitsEmpty").style.display = any ? "none" : "block";
  $("pursuitsLayout").hidden = !any;
  picker?.render();
  if (!any) return;
  renderHero();
  renderTasks();
}

// ---------- Picking one ----------
picker = createProjectPicker({
  root: $("pursuitPicker"),
  getData: () => ({ projects: projects.filter(isInternal), mine: openPursuits(), more: closedPursuits(), selectedId }),
  onPick: (id) => select(id),
  action: '<button type="button" id="newPursuitBtn" class="small">+ New Pursuit</button>',
  label: "Open Pursuits",
  moreLabel: "Closed Pursuits",
  placeholder: "Find a Pursuit",
  noun: "Pursuits",
});

// ---------- The open Pursuit ----------
function renderHero() {
  const p = current();
  const hero = $("pursuitHero");
  hero.hidden = !p;
  if (!p) { hero.innerHTML = ""; return; }
  const entries = timeEntries.filter((e) => e.projectId === p.id && !e.declined);
  const pm = people.find((x) => x.id === p.pmPersonId);
  const byPerson = [...new Set(entries.map((e) => e.personId))]
    .map((id) => ({ id, hrs: sumHrs(entries.filter((e) => e.personId === id)) }))
    .sort((a, b) => b.hrs - a.hrs);
  // Payable: where the hours stand, and (admins) paying them.
  let payLine = "";
  if (p.payable) {
    const waiting = entries.filter((e) => !e.approved);
    const toPay = entries.filter((e) => e.approved && !e.paid);
    const paid = entries.filter((e) => e.paid);
    const owed = toPay.reduce((s, e) => s + Number(e.hours || 0) * payRateOf(e, { projects, people }), 0);
    payLine = `<div class="pursuit-pay-line">
      <span>${fmtHrs(sumHrs(waiting))} hrs waiting for ${pm ? esc(pm.name) : "the PM"}</span>
      <span>${fmtHrs(sumHrs(toPay))} hrs approved, not paid</span>
      <span>${fmtHrs(sumHrs(paid))} hrs paid</span>
      ${isAdmin() && toPay.length ? `<button type="button" class="small" data-action="mark-paid">Mark ${fmtHrs(sumHrs(toPay))} hrs paid (${formatCurrency(owed)})</button>` : ""}
    </div>`;
  }
  hero.style.setProperty("--c", projectColor(p.id));
  hero.classList.toggle("closed", !!p.closed);
  hero.innerHTML = `
    <div class="pursuit-hero-top">
      <h2>${esc(p.name)}</h2>
      ${p.payable ? '<span class="pay-tag big">Payable</span>'
        : isAdmin() ? '<button type="button" class="unpaid-tag big tag-btn" data-action="make-payable" title="Make it payable">Unpaid</button>'
        : '<span class="unpaid-tag big">Unpaid</span>'}
      ${p.closed ? '<span class="closed-tag">Closed</span>' : ""}
      <div class="pursuit-hero-actions">
        <button type="button" class="small secondary" data-action="edit-pursuit">Edit Pursuit</button>
        ${p.closed
          ? '<button type="button" class="close-btn" data-action="reopen-pursuit">Reopen Pursuit</button>'
          : '<button type="button" class="close-btn" data-action="close-pursuit">✓ Close Pursuit</button>'}
      </div>
    </div>
    <div class="pursuit-hero-total"><span><b>${fmtHrs(sumHrs(entries))}</b> hrs</span>
      ${isAdmin() ? `<span class="pursuit-cost ${p.payable ? "" : "value"}" title="${p.payable ? "Hours × each person's pay rate" : "What these hours would cost at each person's pay rate"}"><b>${money(costOf(entries))}</b> ${p.payable ? "cost" : "time value"}</span>` : ""}
      ${byPerson.map((x) => `<span class="pursuit-person">${esc(personName(x.id))} <b>${fmtHrs(x.hrs)}</b></span>`).join("")}</div>
    ${isAdmin() ? targetHtml(costOf(entries), Number(p.targetCost || 0)) : ""}
    ${payLine}`;
}

$("pursuitHero").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const p = current();
  const action = btn.dataset.action;
  try {
    if (action === "edit-pursuit") openPursuitModal(p);
    if (action === "make-payable") {
      if (!(await confirmDialog("Its hours will be paid at each person's pay rate once a PM approves them, including hours already logged. Next, pick the PM.",
        { title: `Make ${p.name} payable?`, confirmText: "Continue" }))) return;
      openPursuitModal(p, { payable: true });
    }
    if (action === "close-pursuit") {
      const open = tasks.filter((t) => t.projectId === p.id && !t.closed).length;
      if (!(await confirmDialog(`It comes off everyone's Timesheet${open ? `, with its ${open} open task${open === 1 ? "" : "s"}` : ""}. Its hours are kept, and you can reopen it anytime.`,
        { title: `Close ${p.name}?`, confirmText: "Close Pursuit" }))) return;
      await Projects.update(p.id, { closed: true });
      showToast(`${p.name} closed.`, { action: "Undo", onAction: () => Projects.update(p.id, { closed: false }) });
    }
    if (action === "reopen-pursuit") {
      await Projects.update(p.id, { closed: false });
      showToast(`${p.name} reopened.`);
    }
    if (action === "mark-paid") {
      const ctx = { projects, people };
      const toPay = timeEntries.filter((x) => x.projectId === p.id && x.approved && !x.paid && !x.declined);
      const total = toPay.reduce((s, x) => s + Number(x.hours || 0) * payRateOf(x, ctx), 0);
      if (!(await confirmDialog(`${fmtHrs(sumHrs(toPay))} hrs, ${formatCurrency(total)} at each person's current pay rate (locked in once paid).`,
        { title: "Mark these hours paid?", confirmText: "Mark Paid" }))) return;
      await TimeEntries.markPaid(toPay.map((x) => x.id), Object.fromEntries(toPay.map((x) => [x.id, payRateOf(x, ctx)])));
      showToast("Marked paid.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- Tasks ----------
// Open tasks with their hours and a Close button; closed ones below a toggle.
function taskRow(t) {
  const entries = timeEntries.filter((e) => e.taskId === t.id && !e.declined);
  const open = t.id === expandedTaskId;
  const ppl = [...new Set(entries.map((e) => e.personId))];
  const detail = open ? `<div class="pursuit-task-detail">${ppl.length
    ? ppl.map((id) => ({ id, hrs: sumHrs(entries.filter((e) => e.personId === id)) }))
      .sort((a, b) => b.hrs - a.hrs)
      .map((x) => `<div><span>${esc(personName(x.id))}</span><b>${fmtHrs(x.hrs)} hrs${isAdmin() ? ` · ${money(costOf(entries.filter((e) => e.personId === x.id)))}` : ""}</b></div>`).join("")
    : '<div class="appr-muted">No hours yet.</div>'}</div>` : "";
  return `<div class="pursuit-task ${t.closed ? "closed" : ""} ${open ? "open" : ""}" data-task-id="${t.id}">
      <button type="button" class="pursuit-task-main" data-action="expand" aria-expanded="${open}">
        <span class="task-chevron" aria-hidden="true">&#9656;</span>
        <span class="pursuit-task-name">${esc(t.name)}</span>
        <span class="pursuit-task-who">${ppl.length ? `${ppl.length} ${ppl.length === 1 ? "person" : "people"}` : ""}</span>
        <span class="pursuit-task-hrs"><b>${fmtHrs(sumHrs(entries))}</b> hrs</span>
        ${isAdmin() ? `<span class="pursuit-task-cost">${money(costOf(entries))}</span>` : ""}
      </button>
      ${t.closed
        ? `<button type="button" class="small secondary" data-action="reopen-task">Reopen</button>`
        : `<button type="button" class="close-btn" data-action="close-task" title="Done with it: it comes off the Timesheet, hours are kept">&#10003; Close</button>`}
    </div>${isAdmin() ? targetHtml(costOf(entries), Number(t.targetCost || 0), "task") : ""}${detail}`;
}

function renderTasks() {
  const p = current();
  if (!p) return;
  const all = tasks.filter((t) => t.projectId === p.id).sort(byName);
  const open = all.filter((t) => !t.closed);
  const closed = all.filter((t) => t.closed);
  $("openCount").textContent = open.length ? `${open.length}` : "";
  $("openTasks").innerHTML = open.map(taskRow).join("")
    || `<div class="empty">${closed.length ? "All tasks are closed." : "No tasks yet. Add one for each RFP, event or effort."}</div>`;
  const toggle = $("closedTasksToggle");
  toggle.hidden = !closed.length;
  toggle.innerHTML = `Closed Tasks (${closed.length}) <span class="chev ${showClosedTasks ? "up" : ""}">&#9662;</span>`;
  toggle.setAttribute("aria-expanded", String(showClosedTasks));
  $("closedTasks").hidden = !showClosedTasks || !closed.length;
  $("closedTasks").innerHTML = showClosedTasks ? closed.map(taskRow).join("") : "";
}

$("closedTasksToggle").addEventListener("click", () => { showClosedTasks = !showClosedTasks; renderTasks(); });

[$("openTasks"), $("closedTasks")].forEach((el) => el.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const t = tasks.find((x) => x.id === btn.closest("[data-task-id]").dataset.taskId);
  if (!t) return;
  if (btn.dataset.action === "expand") {
    expandedTaskId = expandedTaskId === t.id ? null : t.id;
    renderTasks();
    return;
  }
  const closed = btn.dataset.action === "close-task";
  try {
    await Tasks.update(t.id, { closed });
    showToast(closed ? `Closed ${t.name}.` : `Reopened ${t.name}.`,
      closed ? { action: "Undo", onAction: () => Tasks.update(t.id, { closed: false }) } : {});
  } catch (err) {
    showToast("Error: " + err.message);
  }
}));

// ---------- Edit Tasks ----------
// Rename, add, close/reopen, and remove tasks with no hours.
const tasksModal = $("tasksModal");
const rowsEl = $("tasksModalRows");

function editRow(t = null) {
  const hrs = t ? hoursOn((e) => e.taskId === t.id) : 0;
  // Admins can remove a task with no hours or subtasks; anyone else closes it.
  const removable = !t || (isAdmin() && !timeEntries.some((e) => e.taskId === t.id) && !dueDates.some((d) => d.taskId === t.id));
  return `<div class="edit-task-row" data-task-id="${t?.id || ""}">
    <input type="text" class="edit-task-name" value="${esc(t?.name || "")}" placeholder="Task name, e.g. Moab ATP RFP" aria-label="Task name" />
    <span class="num appr-muted">${t ? fmtHrs(hrs) : ""}</span>
    ${isAdmin() ? `<input type="number" class="edit-task-target" min="0" step="100" value="${t?.targetCost || ""}" placeholder="—" aria-label="Target cost" />` : ""}
    <label class="edit-task-closed"><input type="checkbox" ${t?.closed ? "checked" : ""} aria-label="Closed" /></label>
    <button type="button" class="icon-btn" data-action="remove-row" ${removable ? "" : `disabled title="${isAdmin() ? "It has hours or subtasks; close it instead" : "Close it instead"}"`} aria-label="Remove task">&times;</button>
  </div>`;
}

function openTasksModal(addRow = false) {
  const p = current();
  $("tasksModalName").textContent = p.name;
  tasksModal.classList.toggle("with-target", isAdmin());
  const list = tasks.filter((t) => t.projectId === p.id).sort((a, b) => (!!a.closed - !!b.closed) || byName(a, b));
  rowsEl.innerHTML = list.map(editRow).join("") + (addRow || !list.length ? editRow() : "");
  tasksModal.style.display = "flex";
  (addRow ? rowsEl.lastElementChild : rowsEl.firstElementChild)?.querySelector("input")?.focus();
}
const closeTasksModal = () => { tasksModal.style.display = "none"; };

$("editTasksBtn").addEventListener("click", () => openTasksModal(false));
$("quickAddBtn").addEventListener("click", () => openTasksModal(true));
$("tasksModalAdd").addEventListener("click", () => {
  rowsEl.insertAdjacentHTML("beforeend", editRow());
  rowsEl.lastElementChild.querySelector("input").focus();
});
rowsEl.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="remove-row"]');
  if (btn && !btn.disabled) btn.closest(".edit-task-row").remove();
});
rowsEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".edit-task-name")) $("tasksModalAdd").click();
});
$("tasksModalCancel").addEventListener("click", closeTasksModal);
$("tasksModalClose").addEventListener("click", closeTasksModal);
closeOnBackdropClick(tasksModal, closeTasksModal);

$("tasksModalSave").addEventListener("click", async () => {
  const p = current();
  const rows = [...rowsEl.querySelectorAll(".edit-task-row")].map((r) => ({
    id: r.dataset.taskId, name: r.querySelector(".edit-task-name").value.trim(), closed: r.querySelector(".edit-task-closed input").checked,
    target: r.querySelector(".edit-task-target") ? Number(r.querySelector(".edit-task-target").value) || null : undefined,
  }));
  const names = rows.filter((r) => r.name).map((r) => r.name.toLowerCase());
  if (new Set(names).size !== names.length) return showToast("Two tasks have the same name.");
  const kept = new Set(rows.map((r) => r.id).filter(Boolean));
  // Tasks as they were (new ones added below must not look removed).
  const before = tasks.filter((x) => x.projectId === p.id);
  try {
    for (const r of rows) {
      const t = tasks.find((x) => x.id === r.id);
      if (t) {
        const changes = {};
        if (r.name && r.name !== t.name) changes.name = r.name;
        if (r.closed !== !!t.closed) changes.closed = r.closed;
        if (r.target !== undefined && r.target !== (t.targetCost || null)) changes.targetCost = r.target;
        if (Object.keys(changes).length) await Tasks.update(t.id, changes);
      } else if (r.name) {
        await Tasks.add({ projectId: p.id, name: r.name, budget: 0, startDate: null, endDate: null, closed: r.closed, createdByPersonId: sessionPersonId,
          ...(r.target ? { targetCost: r.target } : {}) });
      }
    }
    // Removed rows (only ones with no hours or subtasks could be).
    for (const t of before.filter((x) => !kept.has(x.id))) {
      for (const a of assignments.filter((x) => x.taskId === t.id)) await Assignments.remove(a.id);
      await Tasks.remove(t.id);
    }
    closeTasksModal();
    showToast("Tasks saved.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

// ---------- New / Edit Pursuit ----------
const modal = $("pursuitModal");
let editingId = null; // null = new
let pickedColor = null;
let payable = false;

// Colors other Pursuits use are crossed out (projects don't count: they're
// dots, Pursuits are diamonds). All open again if every one is taken.
function takenColors(exceptId) {
  const taken = new Map();
  projects.forEach((p) => { if (isInternal(p) && p.id !== exceptId && !taken.has(projectColor(p.id))) taken.set(projectColor(p.id), projectShortName(p)); });
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

// Unpaid / Payable. Only admins can pick Payable (and its PM).
function renderPay() {
  $("pursuitPay").querySelectorAll("button").forEach((b) => {
    const on = (b.dataset.value === "payable") === payable;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
    b.disabled = !isAdmin() && b.dataset.value === "payable" && !payable;
  });
  $("pursuitPayHint").textContent = payable
    ? "Hours are paid at each person's pay rate once the PM approves them."
    : `Hours are tracked, not paid.${isAdmin() ? "" : " Only admins can make a Pursuit payable."}`;
  $("pursuitPmField").hidden = !payable;
  $("pursuitPm").disabled = !isAdmin();
}

function openPursuitModal(p, { payable: makePayable = false } = {}) {
  editingId = p ? p.id : null;
  $("pursuitModalTitle").textContent = p ? "Edit Pursuit" : "New Pursuit";
  $("pursuitName").value = p ? p.name : "";
  $("pursuitShortName").value = p?.shortName || "";
  $("pursuitShortName").placeholder = p ? projectShortName({ name: p.name }) : "";
  const choices = people.filter((x) => !x.inactive || x.id === p?.pmPersonId).sort((a, b) => a.name.localeCompare(b.name));
  $("pursuitPm").innerHTML = '<option value="">Pick a PM</option>' + choices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  $("pursuitPm").value = p?.pmPersonId || "";
  payable = !!p?.payable || makePayable;
  renderPay();
  $("pursuitTargetField").hidden = !isAdmin();
  $("pursuitTarget").value = p?.targetCost || "";
  pickedColor = p ? projectColor(p.id) : firstFreeColor(null);
  renderSwatches();
  $("pursuitSave").textContent = p ? "Save" : "Create Pursuit";
  $("pursuitRemove").hidden = !p || !isAdmin();
  modal.style.display = "flex";
  (makePayable ? $("pursuitPm") : $("pursuitName")).focus();
}
const closeModal = () => { modal.style.display = "none"; };

$("pursuitPay").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-value]");
  if (!b || b.disabled) return;
  payable = b.dataset.value === "payable";
  renderPay();
});
$("pursuitColor").addEventListener("click", (e) => {
  const b = e.target.closest("[data-color]");
  if (!b || b.disabled) return;
  pickedColor = b.dataset.color;
  renderSwatches();
});
$("pursuitCancel").addEventListener("click", closeModal);
$("pursuitModalClose").addEventListener("click", closeModal);
closeOnBackdropClick(modal, closeModal);
$("newPursuitBtn").addEventListener("click", () => openPursuitModal(null));

$("pursuitSave").addEventListener("click", async () => {
  const name = $("pursuitName").value.trim();
  if (!name) return showToast("Give it a name.");
  const pmPersonId = $("pursuitPm").value || null;
  if (payable && !pmPersonId) return showToast("Pick a PM to approve the hours.");
  const data = { name, shortName: $("pursuitShortName").value.trim() || null, color: pickedColor };
  try {
    if (!editingId) {
      const ref = await Projects.add({
        ...data, internal: true, closed: false, createdByPersonId: sessionPersonId,
        payable: isAdmin() && payable, pmPersonId: isAdmin() && payable ? pmPersonId : null,
        ...(isAdmin() && Number($("pursuitTarget").value) ? { targetCost: Number($("pursuitTarget").value) } : {}),
      });
      closeModal();
      select(ref.id);
      showToast("Pursuit created. Add its tasks.");
      return;
    }
    const p = current();
    if (isAdmin() && payable !== !!p.payable) {
      const open = timeEntries.filter((x) => x.projectId === p.id && !x.declined && !x.paid);
      if (payable) {
        // Hours that approved themselves go to the PM, and will be paid.
        if (!(await confirmDialog(open.length
          ? `The ${fmtHrs(sumHrs(open))} hrs already logged on it go to ${personName(pmPersonId)} for approval and will be paid.`
          : `Hours will be paid at each person's pay rate once ${personName(pmPersonId)} approves them.`,
        { title: `Make ${name} payable?`, confirmText: "Make Payable" }))) return;
        for (const x of open.filter((x) => x.approved)) await TimeEntries.update(x.id, { approved: false, approvedDate: null });
      } else {
        if (!(await confirmDialog("Hours already paid stay paid. Other hours won't be paid.", { title: `Make ${name} unpaid?`, confirmText: "Make Unpaid" }))) return;
        for (const x of open.filter((x) => !x.approved)) await TimeEntries.update(x.id, { approved: true, approvedDate: new Date().toISOString() });
      }
    }
    if (isAdmin()) Object.assign(data, { targetCost: Number($("pursuitTarget").value) || null, payable, pmPersonId: payable ? pmPersonId : p.pmPersonId || null });
    await Projects.update(editingId, data);
    closeModal();
    showToast("Saved.");
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
  const list = tasks.filter((t) => t.projectId === src.id).sort(byName);
  if (!moveOpen) {
    card.innerHTML = `<div class="budget-header"><div><h2 style="margin:0;">Move ${esc(src.name)} into Pursuits</h2>
      <div class="appr-muted">${list.length} tasks to sort into RFPs, other categories, or their own Pursuit. Hours come along.</div></div>
      <button type="button" class="small" id="moveOpenBtn">Sort Tasks</button></div>`;
    $("moveOpenBtn").addEventListener("click", () => { moveOpen = true; renderMoveCard(); });
    return;
  }
  // Keep what's been picked while things redraw.
  const picked = Object.fromEntries([...card.querySelectorAll("select[data-task-id]")].map((s) => [s.dataset.taskId, s.value]));
  const others = sortPursuits(projects.filter((p) => isInternal(p) && p.id !== src.id && !PINNED.includes(p.name)));
  const options = (t) => {
    const value = picked[t.id] || guessFor(t);
    const opt = (v, label) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(label)}</option>`;
    return [...PINNED.map((c) => opt(`cat:${c}`, c)), opt("own", "Its own Pursuit"),
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
  const exists = (name) => projects.some((p) => isInternal(p) && p.name === name);
  const newOnes = new Set(picks.filter((x) => x.to === "own").map((x) => x.task.name));
  picks.filter((x) => x.to.startsWith("cat:") && !exists(x.to.slice(4))).forEach((x) => newOnes.add(x.to.slice(4)));
  if (!(await confirmDialog(`${picks.length} tasks move${newOnes.size ? `, creating ${newOnes.size} new Pursuit${newOnes.size === 1 ? "" : "s"} (${[...newOnes].join(", ")})` : ""}.`,
    { title: "Move these tasks?", confirmText: "Move Tasks" }))) return;
  moveOpen = false;
  const created = new Map(); // name -> id
  const usedColors = [];
  const pursuitFor = async (name) => {
    const existing = projects.find((p) => isInternal(p) && p.name === name);
    if (existing) return existing.id;
    if (created.has(name)) return created.get(name);
    const color = firstFreeColor(null, usedColors);
    usedColors.push(color);
    const ref = await Projects.add({ name, shortName: null, color, internal: true, payable: false, closed: false, pmPersonId: null, createdByPersonId: sessionPersonId });
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
    const movedIds = new Set(picks.map((x) => x.task.id));
    const leftover = tasks.some((t) => t.projectId === src.id && !movedIds.has(t.id))
      || dueDates.some((d) => d.projectId === src.id && !d.taskId)
      || timeEntries.some((e) => e.projectId === src.id && !movedIds.has(e.taskId));
    if (!leftover) await Projects.remove(src.id);
    if (selectedId === src.id) selectedId = null;
    showToast(leftover ? "Tasks moved." : `Tasks moved. ${src.name} was empty, so it's removed.`);
    render();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}
