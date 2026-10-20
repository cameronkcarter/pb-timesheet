import { People, Projects, Tasks, TimeEntries, Invoices } from "./db.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import {
  formatCurrency, showToast, fmtHrs,
  lastDayOfMonth, formatShortMDY, toISODate, sortProjects, esc, projectColor,
} from "./util.js";
import { sheetSyncEnabled, buildSheetPayload, postToSheet, SHEET_WEBHOOK_URL, SHEET_URL } from "./sheets.js";
import { isTestMode } from "./session.js";
import { billRateOf, paidAmount } from "./rates.js";

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
let adminCheckDone = false;

const invoiceBody = document.getElementById("invoiceBody");
const nextBody = document.getElementById("nextBody");
const pastBody = document.getElementById("pastBody");
const nextTotal = document.getElementById("nextTotal");
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
    if (!open.length) return null;
    const dates = (entries.length ? entries : pending).map((e) => e.date).sort();
    const draft = drafts[project.id] || {};
    return {
      key: `next:${project.id}`, kind: "next", project, entries, pending,
      from: dates[0], to: dates[dates.length - 1],
      number: draft.number ?? nextInvoiceNumber(),
      label: draft.label ?? periodLabelFor(dates[0], dates[dates.length - 1]),
      amount: groupByPerson(entries).reduce((s, r) => s + r.total, 0),
    };
  }).filter(Boolean);
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
    return row.entries.length
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
    return `${fieldsHtml(row)}
      ${peopleHtml(row.key, row.entries)}
      <div class="inv-actions">
        ${row.pending.length ? `<a class="entry-status warn inv-warn" href="admin.html#pendingApprovalCard"><span class="entry-status-icon" aria-hidden="true">&#9888;</span>${fmtHrs(sumHours(row.pending))} hrs awaiting approval won't be included &middot; <u>Approve</u></a>` : ""}
        <button type="button" class="secondary" data-action="preview" ${row.entries.length ? "" : "disabled"}>Preview PDF</button>
        <button type="button" data-action="generate" ${row.entries.length ? "" : "disabled"}>Generate invoice</button>
      </div>`;
  }
  const inv = row.inv;
  const canPdf = !inv.historical && inv.taskRows && inv.laborRows;
  return `${inv.periodLabel ? `<div class="inv-note">${esc(inv.periodLabel)}</div>` : ""}
    ${peopleHtml(row.key, row.entries, inv.laborRows)}
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
function computeInvoiceData(project, entries) {
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

  return { taskRows, feeTotal, billedTotal, currentTotal, remainingTotal, pctTotal, laborRows, laborTotal };
}

// ---------- PDF generation ----------
async function loadImageAsDataURL(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
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
    const logoData = await loadImageAsDataURL("Place%20Builder%20Logo.png");
    doc.addImage(logoData, "PNG", rightX - 26, 6, 26, 26);
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
  summaryBody.push(["Expense Total", "", "", "", "", ""]);
  const projectTotalRowIndex = summaryBody.length;
  summaryBody.push(["Project Total", formatCurrency(data.feeTotal), formatCurrency(data.billedTotal), formatCurrency(data.currentTotal), `${data.pctTotal}%`, formatCurrency(data.remainingTotal)]);

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

  doc.autoTable({
    startY: y,
    theme: "grid",
    head: [["Expenses (Description)", "Quantity", "Cost", "Total"]],
    body: [["", "", "", ""], ["Expense Total", "", "", "-"]],
    styles: tableStyles,
    headStyles,
    columnStyles: {
      0: { cellWidth: 110 },
      1: { cellWidth: 24, halign: "right" },
      2: { cellWidth: 24, halign: "right" },
      3: { cellWidth: 24, halign: "right" },
    },
    didParseCell: (hd) => {
      if (hd.section === "body" && hd.row.index === 1) {
        hd.cell.styles.fontStyle = "bold";
        hd.cell.styles.fillColor = [246, 246, 248];
      }
    },
    didDrawCell: (hd) => {
      if (hd.section === "body" && hd.column.index === 3 && hd.row.index === 1) {
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
  doc.text(formatCurrency(data.laborTotal), rightX - 2, y + 5, { align: "right" });

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

  const periodKey = `${data.invoiceDate.getFullYear()}.${String(data.invoiceDate.getMonth() + 1).padStart(2, "0")}`;
  const prefix = data.isPreview ? "PREVIEW_" : "";
  doc.save(`${prefix}Place Builders Invoice_${data.project.name}_${periodKey}.pdf`);
}

async function generate(row, isPreview, btn) {
  const { project, entries } = row;
  if (!project || entries.length === 0) return;
  const periodLabel = row.label.trim() || periodLabelFor(row.from, row.to);
  const invoiceNumber = row.number.trim() || nextInvoiceNumber();
  if (!isPreview && invoices.some((i) => i.invoiceNumber === invoiceNumber) &&
    !confirm(`Invoice # ${invoiceNumber} has already been used. Use it again anyway?`)) return;

  const buttons = [...invoiceBody.querySelectorAll(".inv-actions button")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const computed = computeInvoiceData(project, entries);
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
        total: computed.laborTotal,
        sheetSynced: false,
      });
      const billRates = Object.fromEntries(entries.map((e) => [e.id, entryRate(e)]));
      await TimeEntries.markInvoiced(entries.map((e) => e.id), ref.id, billRates);
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
      laborTotal: inv.total,
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
