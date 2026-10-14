import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, daysAgo, showToast,
  todayISO, toISODate, getWeekStart, addDays, monthKey, projectColor, hoursBarHtml, dueItemHtml, sortProjects,
} from "./util.js";
import { paidAmount, billedAmount, assignedHours, isInternal } from "./rates.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";

const selectedPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let navChecked = false;

const projectSummaryCards = document.getElementById("projectSummaryCards");

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
}

function render() {
  const personId = selectedPersonId;
  const person = people.find((p) => p.id === personId);
  if (!person) return;

  const myEntries = timeEntries.filter((e) => e.personId === personId);
  const dollarsOf = (entries) => paidAmount(entries, { projects, people }); // the person's pay, not billing
  const pendingTotal = dollarsOf(myEntries.filter((e) => !e.approved && !e.invoiced));
  const approvedTotal = dollarsOf(myEntries.filter((e) => e.approved && !e.invoiced));
  const invoicedTotal = dollarsOf(myEntries.filter((e) => e.invoiced && !e.paid));
  const paidTotal = dollarsOf(myEntries.filter((e) => e.paid));

  const weekStart = getWeekStart(todayISO());
  const weekDates = Array.from({ length: 7 }, (_, i) => toISODate(addDays(weekStart, i)));
  const weekHours = myEntries
    .filter((e) => weekDates.includes(e.date))
    .reduce((s, e) => s + Number(e.hours || 0), 0);

  const currentMonthKey = monthKey(new Date());
  const monthHours = myEntries
    .filter((e) => e.date.startsWith(currentMonthKey))
    .reduce((s, e) => s + Number(e.hours || 0), 0);

  document.getElementById("statWeekHours").textContent = weekHours.toFixed(2);
  document.getElementById("statMonthCaption").textContent = `${monthHours.toFixed(2)} hrs this month`;
  document.getElementById("statPending").textContent = formatCurrency(pendingTotal);
  document.getElementById("statApproved").textContent = formatCurrency(approvedTotal);
  document.getElementById("statInvoiced").textContent = formatCurrency(invoicedTotal);
  document.getElementById("statPaid").textContent = formatCurrency(paidTotal);

  // Internal projects (e.g. Proposals & Pursuits) are just for logging time
  // on the Timesheet, so they are left off the Dashboard.
  // Your open assignments, plus ones completed in the last week (shown
  // greyed with Reopen, so a mis-click is easy to undo), then they drop off.
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const myOpenItems = dueDates.filter((d) => (d.personIds || []).includes(personId)
    && (!d.completed || (d.completedDate && d.completedDate >= weekAgo)));
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
    ? `<div class="due-list">${items.sort(byDue).map((d) => dueItemHtml(d, { canComplete: true })).join("")}</div>`
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

    const projectOwed = paidAmount(projectEntries.filter((e) => !e.invoiced), { projects, people });
    const lastInvoiced = projectEntries
      .filter((e) => e.invoiced && e.invoicedDate)
      .sort((a, b) => (a.invoicedDate < b.invoicedDate ? 1 : -1))[0];
    const lastInvoicedLabel = lastInvoiced
      ? `${formatDate(lastInvoiced.invoicedDate.slice(0, 10))} (${daysAgo(lastInvoiced.invoicedDate)})`
      : "—";
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
        <div class="hours-row-name" title="${task.name}">${task.name}</div>
        <div>
          ${assigned > 0 || used > 0 ? hoursBarHtml(used, assigned, color) : '<div class="empty" style="padding:0; font-size:12px;">No hours assigned</div>'}
          ${itemsHtml(projectItems.filter((d) => d.taskId === task.id))}
        </div>
      </div>`;
    }).join("");
    const generalItems = projectItems.filter((d) => !d.taskId);

    return `<div class="card">
      <div class="hours-card-header">
        <h2 style="margin:0;"><span class="cal-swatch" style="--c:${color};"></span>${project.name}${project.client ? ` <span class="empty" style="font-weight:400;">(${project.client})</span>` : ""}</h2>
        <div class="empty" style="padding:0;">${budgetPct != null ? `Project budget: <strong class="${budgetPct > 100 ? "hours-over" : ""}">${budgetPct}% used</strong> &middot; ` : ""}Your pay not yet invoiced: <strong>${formatCurrency(projectOwed)}</strong> &middot; Last invoiced: ${lastInvoicedLabel}</div>
      </div>
      ${totalAssigned > 0 ? `
        <div class="hours-total">
          <div class="summary-label">Your hours &middot; all tasks</div>
          ${hoursBarHtml(totalUsed, totalAssigned, color, true)}
        </div>` : ""}
      ${taskRows ? `<div class="hours-rows">${taskRows}</div>` : ""}
      ${generalItems.length ? `<div class="hours-row hours-row-with-items">
        <div class="hours-row-name">Other assignments</div>
        <div>${itemsHtml(generalItems)}</div>
      </div>` : ""}
      ${!taskRows && !generalItems.length ? '<div class="empty">No hours assigned to you on this project yet.</div>' : ""}
    </div>`;
  }).join("");
}

projectSummaryCards.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "complete-duedate") setItemCompleted(btn.dataset.id, true);
  if (btn.dataset.action === "reopen-duedate") setItemCompleted(btn.dataset.id, false);
});

// Mark an assignment complete (with Undo) or reopen it.
async function setItemCompleted(id, completed) {
  try {
    await DueDates.update(id, { completed, completedDate: completed ? new Date().toISOString() : null });
    if (completed) {
      showToast("Marked complete.", { actionLabel: "Undo", onAction: () => setItemCompleted(id, false) });
    } else {
      showToast("Reopened.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
}


