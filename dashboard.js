import { People, Projects, Tasks, Assignments, TimeEntries, DueDates } from "./db.js";
import {
  formatCurrency, formatDate, daysAgo, dueLabel,
  todayISO, toISODate, getWeekStart, addDays, monthKey,
} from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility } from "./session.js";

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
      applyAdminNavVisibility(people.find((p) => p.id === selectedPersonId));
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
  const dollarsOf = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0) * person.rate, 0);
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

  const myProjectIds = [...new Set([
    ...assignments.filter((a) => a.personId === personId).map((a) => a.projectId),
    ...myEntries.map((e) => e.projectId),
  ])];

  if (myProjectIds.length === 0) {
    projectSummaryCards.innerHTML = '<div class="card empty">No projects yet. Ask your PM to assign you to a task.</div>';
    return;
  }

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
    const projectOwed = projectEntries.filter((e) => !e.invoiced)
      .reduce((s, e) => s + Number(e.hours || 0) * person.rate, 0);
    const lastInvoiced = projectEntries
      .filter((e) => e.invoiced && e.invoicedDate)
      .sort((a, b) => (a.invoicedDate < b.invoicedDate ? 1 : -1))[0];
    const lastInvoicedLabel = lastInvoiced
      ? `${formatDate(lastInvoiced.invoicedDate.slice(0, 10))} (${daysAgo(lastInvoiced.invoicedDate)})`
      : "—";

    let totalEarned = 0;
    let totalAssigned = 0;

    const taskRows = projectAssignments.map((a) => {
      const task = tasks.find((t) => t.id === a.taskId);
      const logged = timeEntries
        .filter((e) => e.taskId === a.taskId && e.personId === personId)
        .reduce((s, e) => s + Number(e.hours || 0), 0);
      const used = logged * person.rate;
      totalEarned += used;
      totalAssigned += Number(a.capValue || 0);
      const remaining = (a.capValue || 0) - used;
      const pct = a.capValue > 0 ? Math.min(100, (used / a.capValue) * 100) : 0;
      const over = used > a.capValue;
      const usedLabel = `${formatCurrency(used)} / ${formatCurrency(a.capValue)}`;
      const remainingLabel = `${formatCurrency(remaining)} remaining`;
      return `<tr>
        <td>${task ? task.name : "—"}</td>
        <td>${usedLabel}</td>
        <td>
          <div class="progress-bar"><div class="fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>
          <div class="empty" style="padding:2px 0 0;">${remainingLabel}</div>
        </td>
      </tr>`;
    }).join("");

    const totalPct = totalAssigned > 0 ? Math.min(100, (totalEarned / totalAssigned) * 100) : 0;
    const totalOver = totalEarned > totalAssigned;
    const totalRemaining = totalAssigned - totalEarned;

    return `<div class="card">
      <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px;">
        <h2 style="margin:0;">${project.name}${project.client ? ` <span class="empty" style="font-weight:400;">(${project.client})</span>` : ""}</h2>
        <div class="empty" style="text-align:right;">Owed: ${formatCurrency(projectOwed)} &middot; Last invoiced: ${lastInvoicedLabel}</div>
      </div>
      ${taskRows ? `
        <div style="margin-top:12px;">
          <div class="summary-label">Overall Progress</div>
          <div class="summary-value">${formatCurrency(totalEarned)} / ${formatCurrency(totalAssigned)}</div>
          <div class="progress-bar large"><div class="fill ${totalOver ? "over" : ""}" style="width:${totalPct}%"></div></div>
          <div class="empty" style="padding-top:4px;">${formatCurrency(totalRemaining)} remaining</div>
        </div>
        <table style="margin-top:14px;">
          <thead><tr><th>Task</th><th>Earned / Assigned</th><th>Remaining</th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>` : '<div class="empty">No hour assignment set for this project.</div>'}
    </div>`;
  }).join("");
}

function renderDueDates(personId) {
  const mine = dueDates
    .filter((d) => (d.personIds || []).includes(personId))
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
