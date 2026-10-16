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
let showClientPaid = false;     // client-paid rows are hidden unless asked for
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

  // Hours logged per week (Sunday start) for the last 8 weeks; this week last.
  const WEEKS = 8;
  const weekStart = getWeekStart(todayISO());
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const start = addDays(weekStart, (i - (WEEKS - 1)) * 7);
    const days = Array.from({ length: 7 }, (_, j) => toISODate(addDays(start, j)));
    return { start: toISODate(start), hours: sumHours(myEntries.filter((e) => days.includes(e.date))) };
  });
  const maxWeek = Math.max(1, ...weeks.map((w) => w.hours));
  document.getElementById("statWeekHours").textContent = fmtHrs(weeks[WEEKS - 1].hours);
  document.getElementById("weekChart").innerHTML = weeks.map((w, i) => {
    const current = i === WEEKS - 1;
    const label = current ? "This wk" : new Date(w.start + "T00:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
    return `<div class="week-col ${current ? "current" : ""}" title="Week of ${shortDate(w.start)}: ${fmtHrs(w.hours)} hrs">
      <span class="week-val">${w.hours ? fmtHrs(w.hours) : ""}</span>
      <div class="week-bar" style="height:${Math.max(w.hours ? 4 : 2, (w.hours / maxWeek) * 100)}%;"></div>
      <span class="week-label">${label}</span>
    </div>`;
  }).join("");

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
  // Internal projects (e.g. Proposals & Pursuits) only show when you have
  // subtasks on them; they sort last.
  const myProjectIds = [...new Set([
    ...assignments.filter((a) => a.personId === personId).map((a) => a.projectId),
    ...myEntries.map((e) => e.projectId),
    ...myOpenItems.map((d) => d.projectId),
  ])].filter((id) => !isInternal(projects.find((p) => p.id === id))
    || myOpenItems.some((d) => d.projectId === id));
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
    const internal = isInternal(project);
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
          ${internal
            ? (used > 0 ? `<div class="hours-logged-only">${fmtHrs(used)} hrs logged</div>` : "")
            : assigned > 0 || used > 0 ? hoursBarHtml(used, assigned, color) : '<div class="empty" style="padding:0; font-size:12px;">No hours assigned</div>'}
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
// A compact list under the Pay box: one row per invoice your hours were on
// (newest first), with rows on top for each project's hours not invoiced yet —
// what will go on that project's next invoice. "Client paid" means the client
// paid Place Builders, not that your paycheck went out.
const shortDate = (iso) => new Date(iso.slice(0, 10) + "T00:00:00")
  .toLocaleDateString("en-US", { month: "short", day: "numeric" });

function renderPay(myEntries) {
  payToggle.setAttribute("aria-expanded", String(payOpen));
  document.getElementById("payBox").classList.toggle("open", payOpen);
  payPanel.hidden = !payOpen;
  if (!payOpen) return;

  const ctx = { projects, people };
  const projectOf = (id) => projects.find((p) => p.id === id);
  const billable = myEntries.filter((e) => !isInternal(projectOf(e.projectId)));
  const hoursOf = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);

  // Not invoiced yet: one row per project.
  const upcoming = [...new Set(billable.filter((e) => !e.invoiced).map((e) => e.projectId))].map((pid) => {
    const entries = billable.filter((e) => !e.invoiced && e.projectId === pid);
    return { date: "", number: "", projectId: pid, entries, status: ["Not invoiced", "pending"] };
  });

  // Invoiced: one row per invoice.
  const byInvoice = new Map();
  billable.filter((e) => e.invoiced).forEach((e) => {
    const k = e.invoiceId || `${e.projectId}|${(e.invoicedDate || "").slice(0, 10)}`;
    if (!byInvoice.has(k)) byInvoice.set(k, []);
    byInvoice.get(k).push(e);
  });
  const invoiced = [...byInvoice].map(([k, entries]) => {
    const inv = invoices.find((i) => i.id === k);
    const paid = (inv && inv.paid) || entries.every((e) => e.paid);
    const paidDate = (inv && inv.paidDate) || entries.find((e) => e.paidDate)?.paidDate;
    return {
      date: (inv && inv.date) || entries[0].invoicedDate || "",
      number: (inv && inv.invoiceNumber) || "",
      projectId: entries[0].projectId,
      projectName: inv && inv.projectName,
      entries,
      paid,
      status: paid ? [paidDate ? `Client paid ${shortDate(paidDate)}` : "Client paid", "paid"] : ["Awaiting client", "invoiced"],
    };
  }).sort((x, y) => (x.date < y.date ? 1 : -1));

  const paidCount = invoiced.filter((r) => r.paid).length;
  const rows = [...upcoming, ...invoiced.filter((r) => showClientPaid || !r.paid)];
  const head = `<div class="pay-card-head">
    <h2>Pay stubs</h2>
    ${paidCount ? `<button type="button" class="link-btn" data-action="toggle-paid">${showClientPaid ? "Hide client-paid" : `Show client-paid (${paidCount})`}</button>` : ""}
    <button type="button" class="icon-btn" data-action="close-pay" aria-label="Close">&times;</button>
  </div>`;
  if (!rows.length) {
    payPanel.innerHTML = head + `<div class="pay-empty">${paidCount ? "All paid." : "No billable hours yet."}</div>`;
    return;
  }

  payPanel.innerHTML = head + `<div class="pay-scroll"><table class="pay-table">
    <thead><tr>
      <th class="col-num">Date</th><th class="col-num">Invoice #</th><th>Project</th>
      <th class="num">Hours</th><th class="num">Pay</th><th>Status</th>
    </tr></thead>
    <tbody>${rows.map((r) => {
      const project = projectOf(r.projectId);
      return `<tr>
        <td class="col-num ${r.date ? "" : "blank"}">${r.date ? shortDate(r.date) : "—"}</td>
        <td class="col-num ${r.number ? "" : "blank"}">${r.number ? esc(r.number) : "—"}</td>
        <td class="proj"><span class="pay-dot" style="--c:${project ? projectColor(project.id) : "#c9c2cf"};"></span>${esc(project ? project.name : r.projectName || "Project")}</td>
        <td class="num">${fmtHrs(hoursOf(r.entries))}</td>
        <td class="num"><strong>${formatCurrency(paidAmount(r.entries, ctx))}</strong></td>
        <td><span class="pay-status ${r.status[1]}">${esc(r.status[0])}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

payToggle.addEventListener("click", () => {
  payOpen = !payOpen;
  render();
});

payPanel.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "toggle-paid") showClientPaid = !showClientPaid;
  if (btn.dataset.action === "close-pay") payOpen = false;
  render();
});

// The person who created a subtask, or an admin, can edit or delete it.
function canManage(d) {
  const me = people.find((p) => p.id === selectedPersonId);
  return !!me && (me.isAdmin || d.createdByPersonId === selectedPersonId);
}

const itemEditor = createItemEditor({
  getData: () => ({ people, tasks, projects }),
  sessionPersonId: selectedPersonId,
  // Projects you're on, plus internal ones (open to all); newest first.
  projectChoices: () => sortProjects(projects.filter((p) => isInternal(p) || (
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


