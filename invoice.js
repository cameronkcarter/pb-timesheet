import { People, Projects, Tasks, TimeEntries, Invoices, Expenses } from "./db.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import {
  formatCurrency, showToast, fmtHrs,
  lastDayOfMonth, formatShortMDY, toISODate, sortProjects, esc, projectColor,
} from "./util.js";
import { sheetSyncEnabled, buildSheetPayload, postToSheet, SHEET_WEBHOOK_URL, SHEET_URL } from "./sheets.js";
import { isTestMode } from "./session.js";
import { billRateOf, paidAmount } from "./rates.js";
import { expenseLabel, expenseQtyText, createExpenseEditor } from "./expenses.js";

const sessionPersonId = requireSession();

// Static firm details for the "Please Send Payment To" block and contact
// disclaimer on generated invoices. Edit here if these ever change.
const FIRM = {
  name: "Place Builders LLC",
  address1: "1059 Blair St",
  address2: "Salt Lake City, Utah 84111",
  contactName: "Kirby Snideman",
  contactPhone: "(801) 745-7476",
  contactEmail: "kirby@place.builders",
};
const PURPLE = [92, 38, 112];

let people = [];
let projects = [];
let tasks = [];
let timeEntries = [];
let invoices = [];
let expenses = [];
let adminCheckDone = false;

const invoiceBody = document.getElementById("invoiceBody");
const nextBody = document.getElementById("nextBody");
const pastBody = document.getElementById("pastBody");
const nextTotal = document.getElementById("nextTotal");
const subBody = document.getElementById("subBody");
const subTotal = document.getElementById("subTotal");
const pastTotal = document.getElementById("pastTotal");
const togglePaidBtn = document.getElementById("togglePaid");

wireLogout("logoutLink");

if (sessionPersonId) {
  People.listen((d) => {
    people = d;
    if (!adminCheckDone) {
      adminCheckDone = true;
      const me = people.find((p) => p.id === sessionPersonId);
      if (!enforceAdmin(me)) return;
      renderNavUserName(me);
    }
    render();
  });
  Projects.listen((d) => { projects = d; render(); });
  Tasks.listen((d) => { tasks = d; render(); });
  TimeEntries.listen((d) => { timeEntries = d; render(); });
  Invoices.listen((d) => { invoices = d; render(); renderSheetSync(); });
  Expenses.listen((d) => { expenses = d; render(); });
}

// Invoices charge each person's bill rate; hours already invoiced keep the
// rate they were billed at (see rates.js).
function entryRate(e) {
  return billRateOf(e, { projects, people });
}

// Default invoice number: today's date (e.g. 2026-10-14), made unique across
// all invoices by adding -2, -3… when the date is already taken.
function nextInvoiceNumber() {
  const base = toISODate(new Date());
  const used = new Set(invoices.map((i) => i.invoiceNumber));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ---------- Invoices tables ----------
// "Unbilled hours": a row per billable project for approved hours not invoiced
// yet (its next invoice). "Sent invoices": ones already generated, newest first,
// paid ones hidden unless asked for. Clicking a row shows each person's
// hours (with their notes). The next invoice's # and billing period can be
// edited until it's generated; after that they're locked.
const drafts = {};        // projectId -> { number, label } typed over
let openRow = null;       // "next:<projectId>" or "inv:<invoiceId>"
let openNotes = null;     // personId whose notes show in the open row
let showPaid = false;
let renderDeferred = false;

// Internal projects (e.g. Proposals & Pursuits) are never invoiced.
function billableProjects() {
  return sortProjects(projects.filter((p) => !p.internal));
}

function periodLabelFor(from, to) {
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  const month = (d) => d.toLocaleDateString("en-US", { month: "long" });
  if (a.getFullYear() !== b.getFullYear()) return `${month(a)} ${a.getFullYear()} – ${month(b)} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${month(a)} – ${month(b)} ${b.getFullYear()}`;
  return `${month(a)} ${a.getFullYear()}`;
}

function groupByPerson(entries) {
  const byPerson = {};
  entries.forEach((e) => {
    const rate = entryRate(e);
    const hours = Number(e.hours || 0);
    if (!byPerson[e.personId]) byPerson[e.personId] = { hours: 0, total: 0, rate };
    byPerson[e.personId].hours += hours;
    byPerson[e.personId].total += hours * rate;
    byPerson[e.personId].rate = rate; // display the most recent entry's rate
  });
  return Object.entries(byPerson).map(([personId, agg]) => {
    const person = people.find((p) => p.id === personId);
    return { personId, name: person ? person.name : "—", hours: agg.hours, rate: agg.rate, total: agg.total };
  });
}

const sumHours = (entries) => entries.reduce((s, e) => s + Number(e.hours || 0), 0);
const shortDate = (iso) => new Date(String(iso).slice(0, 10) + "T00:00:00")
  .toLocaleDateString("en-US", { month: "short", day: "numeric" });

// Next invoice per project: its approved, uninvoiced hours.
function nextRows() {
  return billableProjects().map((project) => {
    const open = timeEntries.filter((e) => e.projectId === project.id && !e.invoiced && !e.declined);
    const entries = open.filter((e) => e.approved);
    const pending = open.filter((e) => !e.approved);
    const openExp = expenses.filter((e) => e.projectId === project.id && !e.invoiced && !e.declined);
    const exps = openExp.filter((e) => e.approved);
    const pendingExps = openExp.filter((e) => !e.approved);
    if (!open.length && !openExp.length) return null;
    const ready = [...entries, ...exps];
    const dates = (ready.length ? ready : [...pending, ...pendingExps]).map((e) => e.date).sort();
    const draft = drafts[project.id] || {};
    return {
      key: `next:${project.id}`, kind: "next", project, entries, pending, exps, pendingExps,
      from: dates[0], to: dates[dates.length - 1],
      number: draft.number ?? nextInvoiceNumber(),
      label: draft.label ?? periodLabelFor(dates[0], dates[dates.length - 1]),
      amount: groupByPerson(entries).reduce((s, r) => s + r.total, 0) + sumAmount(exps),
    };
  }).filter(Boolean);
}

const sumAmount = (list) => list.reduce((t, e) => t + Number(e.amount || 0), 0);

// Lines for an invoice's Expenses table: each project expense, then each
// subconsultant invoice. [{ description, quantity, rate, amount }]
function expenseRowsFor(project, exps) {
  const byDate = (a, b) => (a.date < b.date ? -1 : 1);
  const projectLines = exps.filter((e) => e.kind !== "sub").sort(byDate).map((e) => ({
    kind: "project", date: e.date, label: expenseLabel(e, project), qtyText: expenseQtyText(e),
    description: expenseLabel(e, project),
    quantity: e.quantity == null ? null : Number(e.quantity),
    rate: e.rate == null ? null : Number(e.rate),
    amount: Number(e.amount || 0),
  }));
  const subLines = exps.filter((e) => e.kind === "sub").sort(byDate).map((e) => ({
    kind: "sub", date: e.date, label: expenseLabel(e, project), qtyText: "",
    description: `Subconsultant: ${expenseLabel(e, project)}`, quantity: null, rate: null,
    amount: Number(e.amount || 0),
  }));
  return [...projectLines, ...subLines];
}

// Expenses on an invoice, grouped into project expenses and subconsultants
// — same columns as the expense list on the Projects tab.
function expenseTableHtml(rows) {
  if (!rows.length) return "";
  const group = (kind, title) => {
    const list = rows.filter((r) => (r.kind || (r.description.startsWith("Subconsultant:") ? "sub" : "project")) === kind);
    if (!list.length) return "";
    return `<tr class="inv-group"><td colspan="4">${title}</td></tr>` + list.map((r) => `<tr>
      <td>${r.date ? shortDate(r.date) : ""}</td>
      <td>${esc(r.label || r.description.replace(/^Subconsultant: /, ""))}</td>
      <td class="num">${r.qtyText || (r.quantity != null && r.rate != null ? `${fmtHrs(r.quantity)} × ${formatCurrency(r.rate)}` : "—")}</td>
      <td class="num">${formatCurrency(r.amount)}</td>
    </tr>`).join("");
  };
  const total = rows.reduce((t, r) => t + Number(r.amount || 0), 0);
  return `<table class="inv-people inv-expenses">
    <thead><tr><th class="c-date">Date</th><th>Expense</th><th class="num">Quantity</th><th class="num">Amount</th></tr></thead>
    <tbody>
      ${group("project", "Project expenses")}
      ${group("sub", "Subconsultants")}
      <tr class="inv-exp-total"><td colspan="3">Expenses total</td><td class="num">${formatCurrency(total)}</td></tr>
    </tbody>
  </table>`;
}

// The Work Summary page: what each person did, grouped by task.
// [{ task, hours, items: [{ date, name, hours, note }] }]
function workRowsFor(project, entries) {
  const byTask = new Map();
  entries.forEach((e) => {
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  });
  return [...byTask].map(([taskId, list]) => ({
    task: tasks.find((t) => t.id === taskId)?.name || "Task",
    hours: sumHours(list),
    items: list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((e) => ({
      date: e.date,
      name: people.find((p) => p.id === e.personId)?.name || "—",
      hours: Number(e.hours || 0),
      note: e.note || "",
    })),
  })).sort((a, b) => a.task.localeCompare(b.task));
}

function invoiceRows() {
  return [...invoices]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((inv) => {
      const entries = timeEntries.filter((e) => e.invoiceId === inv.id);
      return {
        key: `inv:${inv.id}`, kind: "inv", inv, entries,
        project: projects.find((p) => p.id === inv.projectId),
        number: inv.invoiceNumber,
        label: inv.periodLabel || "",
        amount: Number(inv.total || 0),
        hours: entries.length ? sumHours(entries) : (inv.laborRows || []).reduce((s, r) => s + Number(r.hours || 0), 0),
      };
    });
}

function statusHtml(row) {
  if (row.kind === "next") {
    return row.entries.length || row.exps.length
      ? '<span class="pay-status paid">Ready</span>'
      : '<span class="pay-status pending">Needs approval</span>';
  }
  const inv = row.inv;
  return (inv.paid
    ? `<span class="pay-status paid">Paid${inv.paidDate ? " " + shortDate(inv.paidDate) : ""}</span>`
    : '<span class="pay-status invoiced">Outstanding</span>') +
    (sheetSyncEnabled() && !inv.sheetSynced ? ' <span class="pay-status unsynced" title="Not yet logged in the Google Sheet — click Sync">Not in sheet</span>' : "");
}

// Each person's hours, bill rate, amount billed and pay, then the firm's
// overhead (billed minus pay), with each person's notes on request.
function peopleHtml(rowKey, entries, fallbackRows) {
  const rows = (entries.length ? groupByPerson(entries) : (fallbackRows || []))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) return '<div class="empty">No hours.</div>';
  const ctx = { projects, people };
  const payOf = (personId) => entries.length
    ? paidAmount(entries.filter((e) => e.personId === personId), ctx) : null;
  const totalPay = entries.length ? paidAmount(entries, ctx) : null;
  const totalBilled = rows.reduce((s, r) => s + r.total, 0);
  return `<table class="inv-people">
    <thead><tr><th>Person</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Billed</th><th class="num">Pay</th><th></th></tr></thead>
    <tbody>${rows.map((r) => {
      const notes = entries.filter((e) => e.personId === r.personId && e.note)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const open = openNotes === r.personId;
      return `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${fmtHrs(r.hours)}</td>
        <td class="num">${formatCurrency(r.rate)}</td>
        <td class="num">${formatCurrency(r.total)}</td>
        <td class="num">${payOf(r.personId) == null ? "—" : formatCurrency(payOf(r.personId))}</td>
        <td class="num">${notes.length ? `<button type="button" class="link-btn" data-action="notes" data-person="${r.personId}">Notes (${notes.length}) <span class="chev ${open ? "up" : ""}">&#9662;</span></button>` : ""}</td>
      </tr>
      ${open && notes.length ? `<tr class="inv-notes"><td colspan="6">${notes.map((e) =>
        `<div><span>${shortDate(e.date)} · ${fmtHrs(Number(e.hours))} hrs</span>${esc(e.note)}</div>`).join("")}</td></tr>` : ""}`;
    }).join("")}
    ${totalPay != null ? `<tr class="inv-overhead">
      <td>Overhead</td><td></td><td></td><td></td>
      <td class="num">${formatCurrency(totalBilled - totalPay)}</td><td></td>
    </tr>` : ""}</tbody>
  </table>`;
}

function fieldsHtml(row) {
  return `<div class="inv-fields">
    <label>Invoice #<input type="text" data-field="number" value="${esc(row.number)}" /></label>
    <label>Billing period<input type="text" data-field="label" value="${esc(row.label)}" /></label>
  </div>`;
}

function detailHtml(row) {
  if (row.kind === "next") {
    const waiting = [
      row.pending.length ? `${fmtHrs(sumHours(row.pending))} hrs` : "",
      row.pendingExps.length ? `${formatCurrency(sumAmount(row.pendingExps))} in expenses` : "",
    ].filter(Boolean).join(" and ");
    const canGenerate = row.entries.length || row.exps.length;
    return `${fieldsHtml(row)}
      ${row.entries.length ? peopleHtml(row.key, row.entries) : ""}
      ${expenseTableHtml(expenseRowsFor(row.project, row.exps))}
      <div class="inv-actions">
        ${waiting ? `<a class="entry-status warn inv-warn" href="admin.html#pendingApprovalCard"><span class="entry-status-icon" aria-hidden="true">&#9888;</span>${waiting} awaiting approval won't be included &middot; <u>See hours to approve</u></a>` : ""}
        <button type="button" class="secondary" data-action="preview" ${canGenerate ? "" : "disabled"}>Preview PDF</button>
        <button type="button" data-action="generate" ${canGenerate ? "" : "disabled"}>Generate invoice</button>
      </div>`;
  }
  const inv = row.inv;
  const canPdf = !inv.historical && inv.taskRows && inv.laborRows;
  return `${inv.periodLabel ? `<div class="inv-note">${esc(inv.periodLabel)}</div>` : ""}
    ${peopleHtml(row.key, row.entries, inv.laborRows)}
    ${expenseTableHtml(inv.expenseRows || [])}
    <div class="inv-actions">
      ${canPdf ? '<button type="button" class="secondary" data-action="pdf">Download PDF</button>' : ""}
      ${!inv.paid ? '<button type="button" data-action="mark-paid">Mark paid</button>' : ""}
    </div>`;
}

function render() {
  // Don't redraw under someone typing in an invoice # or billing period.
  if (invoiceBody.contains(document.activeElement) && document.activeElement.matches("input")) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;

  renderSubInvoices();
  const next = nextRows();
  const past = invoiceRows();
  const paidCount = past.filter((r) => r.inv.paid).length;
  const shownPast = past.filter((r) => showPaid || !r.inv.paid);

  const ready = next.reduce((s, r) => s + r.amount, 0);
  const outstanding = past.filter((r) => !r.inv.paid).reduce((s, r) => s + r.amount, 0);
  nextTotal.textContent = next.length ? `${formatCurrency(ready)} ready` : "";
  pastTotal.textContent = outstanding ? `${formatCurrency(outstanding)} outstanding` : "";
  togglePaidBtn.style.display = paidCount ? "" : "none";
  togglePaidBtn.textContent = showPaid ? "Hide paid" : `Show paid (${paidCount})`;

  const chevCell = (open) => `<td class="num"><span class="chev ${open ? "up" : ""}">&#9662;</span></td>`;
  const projectCell = (row) => {
    const name = row.project ? row.project.name : (row.inv && row.inv.projectName) || "Project";
    return `<td class="proj"><span class="pay-dot" style="--c:${row.project ? projectColor(row.project.id) : "#c9c2cf"};"></span>${esc(name)}</td>`;
  };

  nextBody.innerHTML = next.length ? `<div class="pay-scroll"><table class="pay-table inv-table">
    <thead><tr><th>Project</th><th class="num">Hours</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
    <tbody>${next.map((row) => {
      const open = openRow === row.key;
      // Projects with only unapproved hours show those hours, and no amount yet.
      const waiting = !row.entries.length;
      return `<tr class="inv-row next ${open ? "open" : ""}" data-row="${esc(row.key)}">
        ${projectCell(row)}
        <td class="num">${fmtHrs(sumHours(waiting ? row.pending : row.entries))}</td>
        <td class="num ${waiting ? "blank" : ""}">${waiting ? "—" : `<strong>${formatCurrency(row.amount)}</strong>`}</td>
        <td>${statusHtml(row)}</td>
        ${chevCell(open)}
      </tr>
      ${open ? `<tr class="inv-detail"><td colspan="5">${detailHtml(row)}</td></tr>` : ""}`;
    }).join("")}</tbody>
  </table></div>` : '<div class="empty">Nothing to invoice.</div>';

  pastBody.innerHTML = shownPast.length ? `<div class="pay-scroll"><table class="pay-table inv-table">
    <thead><tr><th>Date</th><th>Invoice #</th><th>Project</th><th class="num">Hours</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
    <tbody>${shownPast.map((row) => {
      const open = openRow === row.key;
      return `<tr class="inv-row ${open ? "open" : ""}" data-row="${esc(row.key)}">
        <td>${shortDate(row.inv.date)}</td>
        <td>${esc(row.inv.invoiceNumber)}</td>
        ${projectCell(row)}
        <td class="num">${fmtHrs(row.hours)}</td>
        <td class="num"><strong>${formatCurrency(row.amount)}</strong></td>
        <td>${statusHtml(row)}</td>
        ${chevCell(open)}
      </tr>
      ${open ? `<tr class="inv-detail"><td colspan="7">${detailHtml(row)}</td></tr>` : ""}`;
    }).join("")}</tbody>
  </table></div>` : `<div class="empty">${paidCount ? "All paid." : "No invoices yet."}</div>`;
}

// ---------- Subconsultant invoices ----------
// Invoices received from subconsultants: recorded here (or on the Projects
// tab), then billed to the client on that project's next invoice.
function renderSubInvoices() {
  const subs = expenses.filter((e) => e.kind === "sub").sort((a, b) => (a.date < b.date ? 1 : -1));
  const unbilled = subs.filter((e) => !e.invoiced).reduce((t, e) => t + Number(e.amount || 0), 0);
  subTotal.textContent = unbilled ? `${formatCurrency(unbilled)} unbilled` : "";
  if (!subs.length) {
    subBody.innerHTML = '<div class="empty">None recorded yet.</div>';
    return;
  }
  subBody.innerHTML = `<div class="pay-scroll"><table class="pay-table inv-table">
    <thead><tr><th>Date</th><th>Project</th><th>Subconsultant</th><th>Description</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
    <tbody>${subs.map((e) => {
      const project = projects.find((p) => p.id === e.projectId);
      const sub = (project?.subconsultants || []).find((x) => x.id === e.subId);
      const inv = e.invoiceId && invoices.find((i) => i.id === e.invoiceId);
      return `<tr class="inv-row">
        <td>${shortDate(e.date)}</td>
        <td class="proj"><span class="pay-dot" style="--c:${project ? projectColor(project.id) : "#c9c2cf"};"></span>${esc(project ? project.name : "Project")}</td>
        <td>${esc(sub ? sub.name : "—")}</td>
        <td>${esc(e.description || "—")}</td>
        <td class="num"><strong>${formatCurrency(e.amount)}</strong></td>
        <td>${e.invoiced
          ? `<span class="pay-status invoiced">Billed${inv ? " · " + esc(inv.invoiceNumber) : ""}</span>`
          : '<span class="pay-status pending">Unbilled</span>'}</td>
        <td class="num">${e.invoiced ? "" : `<button type="button" class="link-btn" data-action="edit-sub" data-id="${e.id}">Edit</button>`}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

const subEditor = createExpenseEditor({
  getData: () => ({ people, projects }),
  sessionPersonId,
  projectChoices: () => billableProjects().filter((p) => (p.subconsultants || []).length),
  canPickPayer: () => false,
});

document.getElementById("recordSubInvoice").addEventListener("click", () => {
  if (!billableProjects().some((p) => (p.subconsultants || []).length)) {
    return showToast("Add subconsultants to a project first (Projects → Edit project).");
  }
  subEditor.open(null, { kind: "sub" });
});

subBody.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="edit-sub"]');
  if (!btn) return;
  const rec = expenses.find((x) => x.id === btn.dataset.id);
  if (rec) subEditor.open(rec);
});

function currentRow() {
  return [...nextRows(), ...invoiceRows()].find((r) => r.key === openRow);
}

invoiceBody.addEventListener("focusout", () => {
  setTimeout(() => { if (renderDeferred && !invoiceBody.contains(document.activeElement)) render(); }, 0);
});

invoiceBody.addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  if (!field || !openRow) return;
  const [kind, id] = openRow.split(":");
  if (kind !== "next") return;
  drafts[id] = { ...(drafts[id] || {}), [field]: e.target.value };
});

invoiceBody.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset.field) e.target.blur();
});

invoiceBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) {
    const tr = e.target.closest("tr.inv-row");
    if (tr) {
      openRow = openRow === tr.dataset.row ? null : tr.dataset.row;
      openNotes = null;
      render();
    }
    return;
  }
  const row = currentRow();
  const action = btn.dataset.action;
  if (action === "notes") {
    openNotes = openNotes === btn.dataset.person ? null : btn.dataset.person;
    render();
    return;
  }
  if (!row) return;
  if (action === "preview" || action === "generate") return generate(row, action === "preview", btn);
  if (action === "pdf") return downloadPdf(row.inv);
  if (action === "mark-paid") return markPaid(row.inv);
});

togglePaidBtn.addEventListener("click", () => {
  showPaid = !showPaid;
  render();
});

// ---------- Shared invoice math ----------
function computeInvoiceData(project, entries, exps = []) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const allEntriesForProject = timeEntries.filter((e) => e.projectId === project.id);

  const taskRows = projectTasks.map((t) => {
    const budget = Number(t.budget || 0);
    const billed = allEntriesForProject
      .filter((e) => e.taskId === t.id && e.invoiced)
      .reduce((s, e) => s + Number(e.hours || 0) * entryRate(e), 0);
    const current = entries
      .filter((e) => e.taskId === t.id)
      .reduce((s, e) => s + Number(e.hours || 0) * entryRate(e), 0);
    const pct = budget > 0 ? Math.round(((billed + current) / budget) * 100) : 0;
    const remaining = budget - billed - current;
    return { name: t.name, budget, billed, current, pct, remaining };
  });

  const feeTotal = taskRows.reduce((s, r) => s + r.budget, 0);
  const billedTotal = taskRows.reduce((s, r) => s + r.billed, 0);
  const currentTotal = taskRows.reduce((s, r) => s + r.current, 0);
  const remainingTotal = taskRows.reduce((s, r) => s + r.remaining, 0);
  const pctTotal = feeTotal > 0 ? Math.round(((billedTotal + currentTotal) / feeTotal) * 100) : 0;

  const laborRows = groupByPerson(entries);
  const laborTotal = laborRows.reduce((s, r) => s + r.total, 0);

  // Expenses: project expenses budget + subconsultant budgets.
  const expBudget = Number(project.expenseBudget || 0) +
    (project.subconsultants || []).reduce((t, sub) => t + Number(sub.budget || 0), 0);
  const expBilled = sumAmount(expenses.filter((e) => e.projectId === project.id && e.invoiced));
  const expCurrent = sumAmount(exps);
  const expenseSummary = {
    budget: expBudget, billed: expBilled, current: expCurrent,
    remaining: expBudget - expBilled - expCurrent,
    pct: expBudget > 0 ? Math.round(((expBilled + expCurrent) / expBudget) * 100) : 0,
  };
  const expenseRows = expenseRowsFor(project, exps);

  return {
    taskRows, feeTotal, billedTotal, currentTotal, remainingTotal, pctTotal, laborRows, laborTotal,
    expenseSummary, expenseRows, expenseTotal: expCurrent, workRows: workRowsFor(project, entries),
  };
}

// ---------- PDF generation ----------
// The logo, shrunk to print size (about 1 inch) as a compressed JPEG on
// white. Embedding the full-size PNG made every invoice tens of megabytes.
let logoPromise = null;
function loadLogo() {
  if (!logoPromise) {
    logoPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const size = 300;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      img.onerror = reject;
      img.src = "Place%20Builder%20Logo.png";
    });
  }
  return logoPromise;
}

// The PDF's built-in font can't draw some characters (en/em dashes, curly
// quotes, emoji…); swap in plain ones.
function pdfText(text) {
  return String(text || "")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
}

// Page 2: what was done, grouped by task — each entry's date, person, hours
// and note — in the same purple-header style as page 1.
async function addWorkSummaryPage(doc, data, { marginX, rightX, tableStyles, headStyles }) {
  doc.addPage();
  doc.setFont(undefined, "bold");
  doc.setFontSize(22);
  doc.setTextColor(...PURPLE);
  doc.text("WORK SUMMARY", marginX, 24);
  try {
    const logoData = await loadLogo();
    doc.addImage(logoData, "JPEG", rightX - 26, 6, 26, 26, "pb-logo");
  } catch (err) {
    // logo is a nice-to-have
  }
  doc.setFont(undefined, "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text(pdfText(`${data.project.name}  |  ${data.periodLabel}  |  Invoice #${data.invoiceNumber}`), marginX, 31);

  const body = [];
  const groupRows = new Set();
  data.workRows.forEach((g) => {
    groupRows.add(body.length);
    body.push([{ content: pdfText(`${g.task}  (${(Math.round(g.hours * 100) / 100).toFixed(2)} hrs)`), colSpan: 4 }]);
    g.items.forEach((it) => body.push([
      formatShortMDY(new Date(it.date + "T00:00:00")),
      pdfText(it.name),
      it.hours.toFixed(2),
      pdfText(it.note) || "-",
    ]));
  });

  doc.autoTable({
    startY: 38,
    theme: "grid",
    head: [["Date", "Staff", "Hours", "Work Performed"]],
    body,
    styles: { ...tableStyles, valign: "top" },
    headStyles,
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 32 },
      2: { cellWidth: 14, halign: "right" },
      3: { cellWidth: "auto" },
    },
    didParseCell: (hd) => {
      if (hd.section === "body" && groupRows.has(hd.row.index)) {
        hd.cell.styles.fontStyle = "bold";
        hd.cell.styles.fillColor = [240, 232, 245];
      }
    },
  });
}

async function buildPdf(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  const rightX = pageWidth - marginX;

  doc.setFont(undefined, "bold");
  doc.setFontSize(26);
  doc.setTextColor(...PURPLE);
  doc.text("INVOICE", marginX, 24);

  if (data.isPreview) {
    doc.setFontSize(10);
    doc.setTextColor(200, 40, 40);
    doc.text("PREVIEW — not yet invoiced", marginX, 31);
  }

  try {
    const logoData = await loadLogo();
    doc.addImage(logoData, "JPEG", rightX - 26, 6, 26, 26, "pb-logo");
  } catch (err) {
    // logo is a nice-to-have; continue without it if it fails to load
  }

  const tableStyles = {
    fontSize: 8,
    cellPadding: { top: 1, right: 2, bottom: 1, left: 2 },
    lineColor: [0, 0, 0],
    lineWidth: 0.1,
    textColor: [0, 0, 0],
  };
  const headStyles = { fillColor: PURPLE, textColor: 255, fontStyle: "bold", fontSize: 8 };

  let y = 36;
  doc.setFillColor(...PURPLE);
  doc.rect(marginX, y, rightX - marginX, 5, "F");
  doc.setFontSize(8.5);
  doc.setFont(undefined, "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("BILL TO", marginX + 2, y + 3.6);
  doc.text("DETAILS", marginX + 100, y + 3.6);

  y += 11;
  doc.setTextColor(0, 0, 0);
  doc.setFont(undefined, "normal");
  doc.setFontSize(9);
  const billLines = [
    data.project.billToName, data.project.billToCompany,
    data.project.billToAddress1, data.project.billToAddress2,
  ].filter(Boolean);
  billLines.forEach((line, i) => doc.text(line, marginX, y + i * 5));

  const detailsLabelX = marginX + 100;
  const details = [
    ["Inv. #", data.invoiceNumber],
    ["Date", formatShortMDY(data.invoiceDate)],
    ["Due", formatShortMDY(data.dueDate)],
    ["Project", data.project.name],
    // The PDF's built-in font can't draw en/em dashes, so use plain hyphens.
    ["Period", data.periodLabel.replace(/[–—]/g, "-")],
  ];
  if (data.project.projectNumber) {
    details.push(["Project #", data.project.projectNumber]);
  }
  doc.setFont(undefined, "bold");
  const maxLabelWidth = Math.max(...details.map(([label]) => doc.getTextWidth(label)));
  const detailsValueX = detailsLabelX + maxLabelWidth + 3;
  details.forEach(([label, value], i) => {
    doc.setFont(undefined, "bold");
    doc.text(label, detailsLabelX, y + i * 5);
    doc.setFont(undefined, "normal");
    doc.text(String(value), detailsValueX, y + i * 5);
  });

  y += Math.max(billLines.length, details.length) * 5 + 6;

  const summaryBody = data.taskRows.map((r) => [
    r.name,
    formatCurrency(r.budget),
    r.billed ? formatCurrency(r.billed) : "",
    r.current ? formatCurrency(r.current) : "",
    r.budget > 0 ? `${r.pct}%` : "",
    formatCurrency(r.remaining),
  ]);
  const feeTotalRowIndex = summaryBody.length;
  summaryBody.push(["Fee Total", formatCurrency(data.feeTotal), formatCurrency(data.billedTotal), formatCurrency(data.currentTotal), `${data.pctTotal}%`, formatCurrency(data.remainingTotal)]);
  const exp = data.expenseSummary || { budget: 0, billed: 0, current: data.expenseTotal || 0, remaining: 0, pct: 0 };
  const money = (v) => (v ? formatCurrency(v) : "");
  summaryBody.push(["Expense Total", money(exp.budget), money(exp.billed), money(exp.current), exp.budget > 0 ? `${exp.pct}%` : "", money(exp.remaining)]);
  const projectTotalRowIndex = summaryBody.length;
  const projBudget = data.feeTotal + exp.budget;
  const projBilled = data.billedTotal + exp.billed;
  const projCurrent = data.currentTotal + exp.current;
  const projPct = projBudget > 0 ? Math.round(((projBilled + projCurrent) / projBudget) * 100) : 0;
  summaryBody.push(["Project Total", formatCurrency(projBudget), formatCurrency(projBilled), formatCurrency(projCurrent), `${projPct}%`, formatCurrency(projBudget - projBilled - projCurrent)]);

  const summaryLastCol = 5;
  doc.autoTable({
    startY: y,
    theme: "grid",
    head: [["Project Summary", "Budget", "Previously Billed", "Current Invoice", "% Complete", "Remaining"]],
    body: summaryBody,
    styles: tableStyles,
    headStyles,
    columnStyles: {
      0: { cellWidth: 62 },
      1: { cellWidth: 23, halign: "right" },
      2: { cellWidth: 27, halign: "right" },
      3: { cellWidth: 27, halign: "right" },
      4: { cellWidth: 20, halign: "right" },
      5: { cellWidth: 23, halign: "right" },
    },
    didParseCell: (hd) => {
      if (hd.section !== "body") return;
      if (hd.column.index === 3) {
        hd.cell.styles.fillColor = [247, 240, 250];
      }
      if (hd.row.index === feeTotalRowIndex || hd.row.index === projectTotalRowIndex) {
        hd.cell.styles.fontStyle = "bold";
        hd.cell.styles.fillColor = [246, 246, 248];
      }
      if (hd.row.index === projectTotalRowIndex && hd.column.index === 3) {
        hd.cell.styles.fillColor = [225, 225, 230];
      }
    },
    didDrawCell: (hd) => {
      if (hd.section === "body" && hd.column.index === summaryLastCol &&
          (hd.row.index === feeTotalRowIndex || hd.row.index === projectTotalRowIndex)) {
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.5);
        doc.line(marginX, hd.cell.y, rightX, hd.cell.y);
      }
    },
  });

  y = doc.lastAutoTable.finalY + 8;

  const laborBody = data.laborRows.map((r) => [
    r.name,
    r.hours.toFixed(2),
    formatCurrency(r.rate),
    formatCurrency(r.total),
  ]);
  const laborTotalRowIndex = laborBody.length;
  laborBody.push(["Labor Total", "", "", formatCurrency(data.laborTotal)]);

  doc.autoTable({
    startY: y,
    theme: "grid",
    head: [["Labor (Staff)", "Hours", "Rate", "Total"]],
    body: laborBody,
    styles: tableStyles,
    headStyles,
    columnStyles: {
      0: { cellWidth: 110 },
      1: { cellWidth: 24, halign: "right" },
      2: { cellWidth: 24, halign: "right" },
      3: { cellWidth: 24, halign: "right" },
    },
    didParseCell: (hd) => {
      if (hd.section === "body" && hd.row.index === laborTotalRowIndex) {
        hd.cell.styles.fontStyle = "bold";
        hd.cell.styles.fillColor = [246, 246, 248];
      }
    },
    didDrawCell: (hd) => {
      if (hd.section === "body" && hd.column.index === 3 && hd.row.index === laborTotalRowIndex) {
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.5);
        doc.line(marginX, hd.cell.y, rightX, hd.cell.y);
      }
    },
  });

  y = doc.lastAutoTable.finalY + 8;

  const expenseTotal = data.expenseTotal || 0;
  const expenseLines = (data.expenseRows || []).map((r) => [
    pdfText(r.description),
    r.quantity == null ? "" : String(Math.round(r.quantity * 100) / 100),
    r.rate == null ? "" : formatCurrency(r.rate),
    formatCurrency(r.amount),
  ]);
  const expenseTotalRowIndex = expenseLines.length || 1;
  doc.autoTable({
    startY: y,
    theme: "grid",
    head: [["Expenses (Description)", "Quantity", "Cost", "Total"]],
    body: [
      ...(expenseLines.length ? expenseLines : [["", "", "", ""]]),
      ["Expense Total", "", "", expenseTotal ? formatCurrency(expenseTotal) : "-"],
    ],
    styles: tableStyles,
    headStyles,
    columnStyles: {
      0: { cellWidth: 110 },
      1: { cellWidth: 24, halign: "right" },
      2: { cellWidth: 24, halign: "right" },
      3: { cellWidth: 24, halign: "right" },
    },
    didParseCell: (hd) => {
      if (hd.section === "body" && hd.row.index === expenseTotalRowIndex) {
        hd.cell.styles.fontStyle = "bold";
        hd.cell.styles.fillColor = [246, 246, 248];
      }
    },
    didDrawCell: (hd) => {
      if (hd.section === "body" && hd.column.index === 3 && hd.row.index === expenseTotalRowIndex) {
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.5);
        doc.line(marginX, hd.cell.y, rightX, hd.cell.y);
      }
    },
  });

  y = doc.lastAutoTable.finalY + 10;

  doc.setFillColor(...PURPLE);
  doc.rect(marginX, y, rightX - marginX, 7, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text("AMOUNT DUE", marginX + 2, y + 5);
  doc.text(formatCurrency(data.laborTotal + expenseTotal), rightX - 2, y + 5, { align: "right" });

  y += 16;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.setFont(undefined, "bold");
  doc.text("Please Send Payment To:", marginX, y);
  doc.setFont(undefined, "normal");
  doc.text(FIRM.name, marginX, y + 4.3);
  doc.text(FIRM.address1, marginX, y + 8.6);
  doc.text(FIRM.address2, marginX, y + 12.9);

  const disclaimerY = pageHeight - 30;
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text("If you have any questions about this invoice, please contact", pageWidth / 2, disclaimerY, { align: "center" });
  doc.setFont(undefined, "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`${FIRM.contactName} at ${FIRM.contactPhone} or ${FIRM.contactEmail}`, pageWidth / 2, disclaimerY + 5, { align: "center" });

  if (data.workRows && data.workRows.length) {
    await addWorkSummaryPage(doc, data, { marginX, rightX, tableStyles, headStyles });
  }

  const periodKey = `${data.invoiceDate.getFullYear()}.${String(data.invoiceDate.getMonth() + 1).padStart(2, "0")}`;
  const prefix = data.isPreview ? "PREVIEW_" : "";
  doc.save(`${prefix}Place Builders Invoice_${data.project.name}_${periodKey}.pdf`);
}

async function generate(row, isPreview, btn) {
  const { project, entries, exps } = row;
  if (!project || (entries.length === 0 && exps.length === 0)) return;
  const periodLabel = row.label.trim() || periodLabelFor(row.from, row.to);
  const invoiceNumber = row.number.trim() || nextInvoiceNumber();
  if (!isPreview && invoices.some((i) => i.invoiceNumber === invoiceNumber) &&
    !confirm(`Invoice # ${invoiceNumber} has already been used. Use it again anyway?`)) return;

  const buttons = [...invoiceBody.querySelectorAll(".inv-actions button")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const computed = computeInvoiceData(project, entries, exps);
    const invoiceDate = new Date();
    const dueDate = lastDayOfMonth(invoiceDate);

    await buildPdf({
      project, invoiceNumber, invoiceDate, dueDate,
      periodLabel, isPreview, ...computed,
    });

    if (!isPreview) {
      const ref = await Invoices.add({
        projectId: project.id,
        projectName: project.name,
        invoiceNumber,
        date: toISODate(invoiceDate),
        dueDate: toISODate(dueDate),
        periodLabel,
        periodStart: row.from,
        periodEnd: row.to,
        taskRows: computed.taskRows,
        laborRows: computed.laborRows,
        feeTotal: computed.feeTotal,
        billedTotal: computed.billedTotal,
        currentTotal: computed.currentTotal,
        remainingTotal: computed.remainingTotal,
        pctTotal: computed.pctTotal,
        laborTotal: computed.laborTotal,
        expenseRows: computed.expenseRows,
        expenseSummary: computed.expenseSummary,
        expenseTotal: computed.expenseTotal,
        total: Math.round((computed.laborTotal + computed.expenseTotal) * 100) / 100,
        sheetSynced: false,
      });
      const billRates = Object.fromEntries(entries.map((e) => [e.id, entryRate(e)]));
      if (entries.length) await TimeEntries.markInvoiced(entries.map((e) => e.id), ref.id, billRates);
      if (exps.length) await Expenses.markInvoiced(exps.map((e) => e.id), ref.id);
      delete drafts[project.id];
      openRow = `inv:${ref.id}`;
      showToast("Invoice generated.");
      syncSheet();
    } else {
      showToast("Preview downloaded — nothing was marked invoiced.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    render();
  }
}

// Re-download a past invoice's PDF from what was saved when it was made.
async function downloadPdf(inv) {
  const project = projects.find((p) => p.id === inv.projectId) || { name: inv.projectName || "Project" };
  try {
    await buildPdf({
      project,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: new Date(inv.date + "T00:00:00"),
      dueDate: new Date((inv.dueDate || inv.date) + "T00:00:00"),
      periodLabel: inv.periodLabel || "",
      isPreview: false,
      taskRows: inv.taskRows,
      feeTotal: inv.feeTotal,
      billedTotal: inv.billedTotal,
      currentTotal: inv.currentTotal,
      remainingTotal: inv.remainingTotal,
      pctTotal: inv.pctTotal,
      laborRows: inv.laborRows,
      laborTotal: inv.laborTotal ?? inv.total,
      expenseRows: inv.expenseRows || [],
      expenseSummary: inv.expenseSummary,
      expenseTotal: inv.expenseTotal || 0,
      workRows: workRowsFor(project, timeEntries.filter((e) => e.invoiceId === inv.id)),
    });
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

async function markPaid(inv) {
  if (!confirm("Mark this invoice as paid? Its hours will show as client-paid.")) return;
  try {
    const linkedEntries = timeEntries.filter((entry) => entry.invoiceId === inv.id);
    await TimeEntries.markPaid(linkedEntries.map((entry) => entry.id));
    await Invoices.update(inv.id, { paid: true, paidDate: new Date().toISOString(), sheetSynced: false });
    showToast("Invoice marked as paid.");
    syncSheet();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// ---------- Google Sheet log ----------
const sheetSyncBar = document.getElementById("sheetSyncBar");
const sheetSyncStatus = document.getElementById("sheetSyncStatus");
const sheetSyncBtn = document.getElementById("sheetSyncBtn");
const sheetOpenLink = document.getElementById("sheetOpenLink");

let sheetSyncing = false;
let sheetSyncQueued = false;
let sheetSyncError = null;

function renderSheetSync() {
  if (!SHEET_WEBHOOK_URL) {
    sheetSyncBar.style.display = "none";
    return;
  }
  sheetSyncBar.style.display = "flex";
  if (SHEET_URL) {
    sheetOpenLink.href = SHEET_URL;
    sheetOpenLink.style.display = "";
  }
  if (isTestMode()) {
    sheetSyncStatus.innerHTML = '<span class="empty" style="padding:0;">Off in Test Mode</span>';
    sheetSyncBtn.style.display = "none";
    return;
  }
  sheetSyncBtn.disabled = sheetSyncing;
  sheetSyncBtn.textContent = sheetSyncing ? "Syncing…" : "Sync Now";
  const unsynced = invoices.filter((i) => !i.sheetSynced).length;
  if (sheetSyncing) {
    sheetSyncStatus.textContent = "Syncing…";
  } else if (sheetSyncError) {
    sheetSyncStatus.innerHTML = `<span style="color:var(--red);" title="${esc(sheetSyncError)}">Last sync failed</span>`;
  } else if (unsynced > 0) {
    sheetSyncStatus.innerHTML = `<span class="pill orange">${unsynced} not yet logged</span>`;
  } else {
    sheetSyncStatus.innerHTML = `<span class="pill green">All ${invoices.length} logged</span>`;
  }
}

// Sends every invoice, task budget, and paid date to the sheet. The Apps
// Script skips rows it already has, so this is safe to run any time. Calls
// that arrive mid-sync are queued into one follow-up run so nothing is missed.
async function syncSheet({ manual = false } = {}) {
  if (!sheetSyncEnabled()) return;
  if (sheetSyncing) { sheetSyncQueued = true; return; }
  sheetSyncing = true;
  sheetSyncError = null;
  renderSheetSync();
  try {
    const payload = buildSheetPayload({ invoices, timeEntries, tasks, people, projects });
    const result = await postToSheet(payload);
    // Only flag invoices whose state still matches what was sent, in case one
    // was marked paid (or added) while the request was in flight.
    const sent = new Map(payload.invoices.map((i) => [i.invoiceId, i.paidDate]));
    const toFlag = invoices.filter((i) => !i.sheetSynced && sent.has(i.id) &&
      sent.get(i.id) === (i.paid && i.paidDate ? i.paidDate.slice(0, 10) : ""));
    await Promise.all(toFlag.map((i) => Invoices.update(i.id, { sheetSynced: true })));
    if (manual) {
      showToast(`Sheet synced: ${result.invoicesAdded} new invoices, ${result.linesAdded} new lines.`);
    }
  } catch (err) {
    sheetSyncError = err.message;
    showToast("Couldn't update the Google Sheet (nothing else was affected). Click Sync Now to retry.");
  } finally {
    sheetSyncing = false;
    renderSheetSync();
    render();
    if (sheetSyncQueued) {
      sheetSyncQueued = false;
      syncSheet();
    }
  }
}

sheetSyncBtn.addEventListener("click", () => syncSheet({ manual: true }));
