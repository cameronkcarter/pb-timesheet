import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices } from "./db.js";
import {
  formatCurrency, formatDate, esc, fmtHrs,
  todayISO, toISODate, getWeekStart, addDays, projectColor, hoursBarHtml, dueItemHtml, sortProjects,
} from "./util.js";
import { paidAmount, billedAmount, assignedHours, isInternal } from "./rates.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createItemEditor, setItemCompleted, deleteItem } from "./subtasks.js";

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let navChecked = false;
let payOpen = false;            // the pay stubs panel under the stat boxes
const openStubs = new Set();    // pay stubs expanded to show their details
let showAllStubs = false;
let showCompleted = true; // completed subtasks show by default; can be hidden

const projectSummaryCards = document.getElementById("projectSummaryCards");
const toggleCompletedBtn = document.getElementById("toggleCompletedBtn");
const payToggle = document.getElementById("payToggle");
const payPanel = document.getElementById("payPanel");

wireLogout("logoutLink", "navBrandLink");

if (selectedPersonId) {
  People.listen((d) => {
    people = d;
    if (!navChecked) {
      navChecked = true;
      const me = people.find((p) => p.id === selectedPersonId);
      applyAdminNavVisibility(me);
      renderNavUserName(me);
    }
    render();
  });
  Projects.listen((d) => { projects = d; render(); });
  Tasks.listen((d) => { tasks = d; render(); });
  Assignments.listen((d) => { assignments = d; render(); });
  TimeEntries.listen((d) => { timeEntries = d; render(); });
  DueDates.listen((d) => { dueDates = d; render(); });
  Invoices.listen((d) => { invoices = d; render(); });
}

function render() {
  const personId = selectedPersonId;
  const person = people.find((p) => p.id === personId);
  if (!person) return;

  const myEntries = timeEntries.filter((e) => e.personId === personId);
  const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

  // This week (Sunday start), compared with last week.
  const weekStart = getWeekStart(todayISO());
  const weekOf = (start) => Array.from({ length: 7 }, (_, i) => toISODate(addDays(start, i)));
  const thisWeek = weekOf(weekStart);
  const lastWeek = weekOf(addDays(weekStart, -7));
  const weekHours = sumHours(myEntries.filter((e) => thisWeek.includes(e.date)));
  const lastWeekHours = sumHours(myEntries.filter((e) => lastWeek.includes(e.date)));
  document.getElementById("statWeekHours").textContent = fmtHrs(weekHours);
  document.getElementById("statWeekCaption").textContent = `Last week: ${fmtHrs(lastWeekHours)} hrs`;

  // Hours remaining across all your assigned tasks (billable projects).
  let assignedTotal = 0;
  let loggedTotal = 0;
  let remainingTotal = 0;
  assignments
    .filter((a) => a.personId === personId && !isInternal(projects.find((p) => p.id === a.projectId)))
    .forEach((a) => {
      const assigned = assignedHours(a);
      const logged = sumHours(myEntries.filter((e) => e.taskId === a.taskId));
      assignedTotal += assigned;
      loggedTotal += logged;
      remainingTotal += Math.max(0, assigned - logged);
    });
  document.getElementById("statRemaining").textContent = fmtHrs(remainingTotal);
  document.getElementById("statRemainingCaption").textContent = assignedTotal > 0
    ? `${fmtHrs(loggedTotal)} of ${fmtHrs(assignedTotal)} assigned hrs logged`
    : "No hours assigned yet";
  document.getElementById("statRemainingBar").style.width =
    `${assignedTotal > 0 ? Math.min(100, (loggedTotal / assignedTotal) * 100) : 0}%`;

  // Your pay that the client hasn't paid yet: not invoiced + invoiced.
  const payOf = (entries) => paidAmount(entries, { projects, people });
  const notInvoiced = payOf(myEntries.filter((e) => !e.invoiced));
  const invoicedUnpaid = payOf(myEntries.filter((e) => e.invoiced && !e.paid));
  document.getElementById("statOwed").textContent = formatCurrency(notInvoiced + invoicedUnpaid);
  document.getElementById("statNotInvoiced").textContent = formatCurrency(notInvoiced);
  document.getElementById("statInvoiced").textContent = formatCurrency(invoicedUnpaid);
  renderPay(myEntries);

  // Your subtasks; completed ones too unless hidden.
  const myOpenItems = dueDates.filter((d) => (d.personIds || []).includes(personId)
    && (showCompleted || !d.completed));
  // Internal projects (e.g. Proposals & Pursuits) are just for logging time
  // on the Timesheet, so they are left off the Dashboard.
  const myProjectIds = [...new Set([
    ...assignments.filter((a) => a.personId === personId).map((a) => a.projectId),
    ...myEntries.map((e) => e.projectId),
    ...myOpenItems.map((d) => d.projectId),
  ])].filter((id) => !isInternal(projects.find((p) => p.id === id)));
  // Same order as everywhere else: newest projects first.
  const order = sortProjects(projects).map((p) => p.id);
  myProjectIds.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  if (myProjectIds.length === 0) {
    projectSummaryCards.innerHTML = '<div class="card empty">No projects yet. Ask your PM to assign you to a task.</div>';
    return;
  }

  // Progress is shown in hours only (assigned vs. logged), so staff never see
  // billing dollars, just their hours and their own pay above. The project's
  // overall budget is shown as a percentage — that's the real limit, since
  // individual assignments grow as work goes on. Each task also lists the
  // person's assignments (dated to-dos) for it, so the work and the hours
  // for it sit together.
  const byDue = (a, b) => (!!a.completed - !!b.completed) || (a.dueDate < b.dueDate ? -1 : 1);
  const itemsHtml = (items) => items.length
    ? `<div class="due-list">${items.sort(byDue).map((d) => dueItemHtml(d, { canComplete: true, canEdit: canManage(d), canDelete: canManage(d) })).join("")}</div>`
    : "";

  projectSummaryCards.innerHTML = myProjectIds.map((projectId) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return "";
    const projectEntries = myEntries.filter((e) => e.projectId === projectId);
    const projectItems = myOpenItems.filter((d) => d.projectId === projectId);
    const myAssignments = assignments.filter((a) => a.personId === personId && a.projectId === projectId);
    // Tasks you have hours on, or something due on.
    const taskIds = [...new Set([
      ...myAssignments.map((a) => a.taskId),
      ...projectItems.filter((d) => d.taskId).map((d) => d.taskId),
    ])];
    const projectTasks = taskIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    const color = projectColor(project.id);
    const projectBudget = tasks.filter((t) => t.projectId === projectId).reduce((s, t) => s + Number(t.budget || 0), 0);
    const projectSpent = billedAmount(timeEntries.filter((e) => e.projectId === projectId), { projects, people });
    const budgetPct = projectBudget > 0 ? Math.round((projectSpent / projectBudget) * 100) : null;

    let totalAssigned = 0;
    let totalUsed = 0;
    const taskRows = projectTasks.map((task) => {
      const assignment = myAssignments.find((a) => a.taskId === task.id);
      const used = projectEntries
        .filter((e) => e.taskId === task.id)
        .reduce((s, e) => s + Number(e.hours || 0), 0);
      const assigned = assignment ? assignedHours(assignment, { projects, people }) : 0;
      totalAssigned += assigned;
      totalUsed += used;
      return `<div class="hours-row hours-row-with-items">
        <div class="hours-row-name" title="${esc(task.name)}">
          ${esc(task.name)}
          <button class="link-btn assign-link" data-action="add-subtask" data-project-id="${projectId}" data-task-id="${task.id}">+ Add subtask</button>
        </div>
        <div>
          ${assigned > 0 || used > 0 ? hoursBarHtml(used, assigned, color) : '<div class="empty" style="padding:0; font-size:12px;">No hours assigned</div>'}
          ${itemsHtml(projectItems.filter((d) => d.taskId === task.id))}
        </div>
      </div>`;
    }).join("");
    const generalItems = projectItems.filter((d) => !d.taskId);

    return `<div class="card">
      <div class="hours-card-header">
        <h2 style="margin:0;"><span class="cal-swatch" style="--c:${color};"></span>${esc(project.name)}${project.client ? ` <span class="empty" style="font-weight:400;">(${esc(project.client)})</span>` : ""}</h2>
        ${budgetPct != null ? `<div class="empty" style="padding:0;">Project budget: <strong class="${budgetPct > 100 ? "hours-over" : ""}">${budgetPct}% used</strong></div>` : ""}
      </div>
      ${totalAssigned > 0 ? `
        <div class="hours-total">
          <div class="summary-label">Your hours &middot; all tasks</div>
          ${hoursBarHtml(totalUsed, totalAssigned, color, true)}
        </div>` : ""}
      ${taskRows ? `<div class="hours-rows">${taskRows}</div>` : ""}
      ${generalItems.length ? `<div class="hours-row hours-row-with-items">
        <div class="hours-row-name">Other subtasks</div>
        <div>${itemsHtml(generalItems)}</div>
      </div>` : ""}
      ${!taskRows && !generalItems.length ? '<div class="empty">No hours assigned to you on this project yet.</div>' : ""}
    </div>`;
  }).join("");
}

// ---------- Pay stubs ----------
// One stub per invoice your hours were on (newest first), plus one for hours
// not invoiced yet. "Client paid" means the client paid Place Builders, not
// that your paycheck went out.
const STUB_LIMIT = 5;
const shortDate = (iso) => new Date(iso.slice(0, 10) + "T00:00:00")
  .toLocaleDateString("en-US", { month: "short", day: "numeric" });

function renderPay(myEntries) {
  payToggle.setAttribute("aria-expanded", String(payOpen));
  payToggle.classList.toggle("open", payOpen);
  payPanel.hidden = !payOpen;
  if (!payOpen) return;

  const ctx = { projects, people };
  const billable = myEntries.filter((e) => !isInternal(projects.find((p) => p.id === e.projectId)));
  const stubs = [];

  const pending = billable.filter((e) => !e.invoiced);
  if (pending.length) {
    const awaitingApproval = pending.filter((e) => !e.approved);
    stubs.push({
      key: "pending",
      title: "Not invoiced yet",
      sub: awaitingApproval.length
        ? `${fmtHrs(awaitingApproval.reduce((s, e) => s + Number(e.hours || 0), 0))} hrs awaiting approval`
        : "Approved, waiting for the next invoice",
      status: ["Not invoiced", "pending"],
      entries: pending,
      groupBy: "project",
    });
  }

  const byInvoice = new Map();
  billable.filter((e) => e.invoiced).forEach((e) => {
    const k = e.invoiceId || `${e.projectId}|${(e.invoicedDate || "").slice(0, 10)}`;
    if (!byInvoice.has(k)) byInvoice.set(k, []);
    byInvoice.get(k).push(e);
  });
  const invoiceStubs = [...byInvoice].map(([k, entries]) => {
    const inv = invoices.find((i) => i.id === k);
    const project = projects.find((p) => p.id === entries[0].projectId);
    const date = (inv && inv.date) || entries[0].invoicedDate || "";
    const paid = (inv && inv.paid) || entries.every((e) => e.paid);
    const paidDate = (inv && inv.paidDate) || entries.find((e) => e.paidDate)?.paidDate;
    return {
      key: k,
      date,
      color: project ? projectColor(project.id) : null,
      title: project ? project.name : (inv && inv.projectName) || "Project",
      sub: [inv && inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : null, inv && inv.periodLabel].filter(Boolean).join(" · "),
      status: paid ? [paidDate ? `Client paid ${shortDate(paidDate)}` : "Client paid", "paid"] : ["Awaiting client", "invoiced"],
      invoicedOn: date,
      paidOn: paid ? paidDate : null,
      entries,
      groupBy: "task",
    };
  }).sort((x, y) => (x.date < y.date ? 1 : -1));

  const shown = showAllStubs ? invoiceStubs : invoiceStubs.slice(0, STUB_LIMIT);
  stubs.push(...shown);

  if (!stubs.length) {
    payPanel.innerHTML = '<div class="pay-empty">No hours logged on billable projects yet.</div>';
    return;
  }

  payPanel.innerHTML = `<div class="pay-list">${stubs.map((stub) => {
    const hours = stub.entries.reduce((s, e) => s + Number(e.hours || 0), 0);
    const open = openStubs.has(stub.key);
    return `<div class="pay-stub ${open ? "open" : ""}">
      <button type="button" class="pay-stub-row" data-stub="${esc(stub.key)}" aria-expanded="${open}">
        <span class="pay-dot" style="${stub.color ? `--c:${stub.color};` : ""}"></span>
        <span class="pay-main">
          <span class="pay-title">${esc(stub.title)}</span>
          <span class="pay-sub">${esc(stub.sub || "")}</span>
        </span>
        <span class="pay-amount">
          <strong>${formatCurrency(payOf(stub.entries, ctx))}</strong>
          <span>${fmtHrs(hours)} hrs</span>
        </span>
        <span class="pay-status ${stub.status[1]}">${esc(stub.status[0])}</span>
        <span class="chev" aria-hidden="true">&#9662;</span>
      </button>
      ${open ? stubDetails(stub, ctx) : ""}
    </div>`;
  }).join("")}</div>
  ${invoiceStubs.length > STUB_LIMIT ? `<button type="button" class="link-btn pay-more" data-action="all-stubs">${showAllStubs ? "Show fewer" : `Show ${invoiceStubs.length - STUB_LIMIT} older`}</button>` : ""}`;
}

const payOf = (entries, ctx) => paidAmount(entries, ctx);

// Breakdown inside an open stub: when it was invoiced/paid, the dates worked,
// and hours + pay by task (or by project, for hours not invoiced yet).
function stubDetails(stub, ctx) {
  const dates = stub.entries.map((e) => e.date).sort();
  const days = new Set(dates).size;
  const facts = [
    stub.invoicedOn ? `Invoiced ${formatDate(stub.invoicedOn.slice(0, 10))}` : null,
    stub.invoicedOn ? (stub.paidOn ? `Client paid ${formatDate(stub.paidOn.slice(0, 10))}` : "Client hasn't paid yet") : null,
    `Worked ${dates[0] === dates[dates.length - 1] ? shortDate(dates[0]) : `${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])}`} · ${days} day${days === 1 ? "" : "s"}`,
  ].filter(Boolean);

  const groups = new Map();
  stub.entries.forEach((e) => {
    const k = stub.groupBy === "task" ? e.taskId : e.projectId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  const lines = [...groups].map(([k, entries]) => {
    const name = stub.groupBy === "task"
      ? (tasks.find((t) => t.id === k) || {}).name || "Task"
      : (projects.find((p) => p.id === k) || {}).name || "Project";
    const hrs = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
    return { name, hrs, pay: payOf(entries, ctx) };
  }).sort((x, y) => y.pay - x.pay);

  return `<div class="pay-details">
    <div class="pay-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    ${lines.map((l) => `<div class="pay-line">
      <span>${esc(l.name)}</span><span>${fmtHrs(l.hrs)} hrs</span><span>${formatCurrency(l.pay)}</span>
    </div>`).join("")}
  </div>`;
}

payToggle.addEventListener("click", () => {
  payOpen = !payOpen;
  render();
});

payPanel.addEventListener("click", (e) => {
  const row = e.target.closest("[data-stub]");
  if (row) {
    const k = row.dataset.stub;
    if (openStubs.has(k)) openStubs.delete(k); else openStubs.add(k);
    render();
    return;
  }
  if (e.target.closest('[data-action="all-stubs"]')) {
    showAllStubs = !showAllStubs;
    render();
  }
});

// The person who created a subtask, or an admin, can edit or delete it.
function canManage(d) {
  const me = people.find((p) => p.id === selectedPersonId);
  return !!me && (me.isAdmin || d.createdByPersonId === selectedPersonId);
}

const itemEditor = createItemEditor({
  getData: () => ({ people, tasks, projects }),
  sessionPersonId: selectedPersonId,
  // Projects you're on (not internal ones), newest first.
  projectChoices: () => sortProjects(projects.filter((p) => !isInternal(p) && (
    assignments.some((a) => a.projectId === p.id && a.personId === selectedPersonId)
    || dueDates.some((d) => d.projectId === p.id && (d.personIds || []).includes(selectedPersonId))))),
  canManage,
});

projectSummaryCards.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const d = dueDates.find((x) => x.id === id);
  if (action === "complete-duedate") setItemCompleted(id, true);
  if (action === "reopen-duedate") setItemCompleted(id, false);
  if (action === "edit-duedate" && d && canManage(d)) itemEditor.open(d);
  if (action === "delete-duedate" && d && canManage(d)) deleteItem(d);
  if (action === "add-subtask") {
    itemEditor.open(null, { mode: "subtask", projectId: btn.dataset.projectId, taskId: btn.dataset.taskId, personId: selectedPersonId });
  }
});

toggleCompletedBtn.addEventListener("click", () => {
  showCompleted = !showCompleted;
  toggleCompletedBtn.textContent = showCompleted ? "Hide completed" : "Show completed";
  render();
});


