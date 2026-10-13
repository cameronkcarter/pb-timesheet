import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, daysAgo, dueLabel,
  todayISO, toISODate, getWeekStart, addDays, monthKey, projectColor, hoursBarHtml,
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
const dueDatesTbody = document.querySelector("#dueDatesTable tbody");
const dueDatesEmpty = document.getElementById("dueDatesEmpty");

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

  renderDueDates(personId);

  // Internal projects (e.g. Proposals & Pursuits) are just for logging time
  // on the Timesheet, so they are left off the Dashboard.
  const myProjectIds = [...new Set([
    ...assignments.filter((a) => a.personId === personId).map((a) => a.projectId),
    ...myEntries.map((e) => e.projectId),
  ])].filter((id) => !isInternal(projects.find((p) => p.id === id)));

  if (myProjectIds.length === 0) {
    projectSummaryCards.innerHTML = '<div class="card empty">No projects yet. Ask your PM to assign you to a task.</div>';
    return;
  }

  // Progress is shown in hours only (assigned vs. logged), so staff never see
  // billing dollars, just their hours and their own pay above. The project's
  // overall budget is shown as a percentage — that's the real limit, since
  // individual assignments grow as work goes on.
  projectSummaryCards.innerHTML = myProjectIds.map((projectId) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return "";
    const projectEntries = myEntries.filter((e) => e.projectId === projectId);
    const projectAssignments = assignments
      .filter((a) => a.personId === personId && a.projectId === projectId)
      .sort((a, b) => {
        const taskA = tasks.find((t) => t.id === a.taskId);
        const taskB = tasks.find((t) => t.id === b.taskId);
        return (taskA?.name || "").localeCompare(taskB?.name || "");
      });
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
    const taskRows = projectAssignments.map((a) => {
      const task = tasks.find((t) => t.id === a.taskId);
      const used = projectEntries
        .filter((e) => e.taskId === a.taskId)
        .reduce((s, e) => s + Number(e.hours || 0), 0);
      const assigned = assignedHours(a, { projects, people });
      totalAssigned += assigned;
      totalUsed += used;
      return `<div class="hours-row">
        <div class="hours-row-name" title="${task ? task.name : ""}">${task ? task.name : "—"}</div>
        ${hoursBarHtml(used, assigned, color)}
      </div>`;
    }).join("");

    return `<div class="card">
      <div class="hours-card-header">
        <h2 style="margin:0;"><span class="cal-swatch" style="--c:${color};"></span>${project.name}${project.client ? ` <span class="empty" style="font-weight:400;">(${project.client})</span>` : ""}</h2>
        <div class="empty" style="padding:0;">${budgetPct != null ? `Project budget: <strong class="${budgetPct > 100 ? "hours-over" : ""}">${budgetPct}% used</strong> &middot; ` : ""}Your pay not yet invoiced: <strong>${formatCurrency(projectOwed)}</strong> &middot; Last invoiced: ${lastInvoicedLabel}</div>
      </div>
      ${taskRows ? `
        <div class="hours-total">
          <div class="summary-label">All tasks</div>
          ${hoursBarHtml(totalUsed, totalAssigned, color, true)}
        </div>
        <div class="hours-rows">${taskRows}</div>` : '<div class="empty">No hours assigned to you on this project yet.</div>'}
    </div>`;
  }).join("");
}

function renderDueDates(personId) {
  const mine = dueDates
    .filter((d) => (d.personIds || []).includes(personId) && !d.completed)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  if (mine.length === 0) {
    dueDatesTbody.innerHTML = "";
    dueDatesEmpty.style.display = "block";
    return;
  }
  dueDatesEmpty.style.display = "none";

  dueDatesTbody.innerHTML = mine.map((d) => {
    const project = projects.find((p) => p.id === d.projectId);
    return `<tr>
      <td>${d.title}</td>
      <td>${project ? project.name : "—"}</td>
      <td>${formatDate(d.dueDate)} <span class="empty">(${dueLabel(d.dueDate)})</span></td>
    </tr>`;
  }).join("");
}
