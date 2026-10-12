import { People, Projects, Tasks, TimeEntries, Invoices } from "./db.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import {
  formatCurrency, formatDate, daysAgo, showToast,
  lastDayOfMonth, formatShortMDY, toISODate,
} from "./util.js";
import { sheetSyncEnabled, buildSheetPayload, postToSheet, SHEET_WEBHOOK_URL, SHEET_URL } from "./sheets.js";
import { isTestMode } from "./session.js";
import { billRateOf, paidAmount } from "./rates.js";

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
let selectedProjectId = null;
let adminCheckDone = false;
let expandedInvoiceId = null;
let expandedNotesKey = null;

const projectCardsEl = document.getElementById("projectCards");
const projectCardsEmpty = document.getElementById("projectCardsEmpty");
const outstandingHeading = document.getElementById("outstandingHeading");
const monthsContainer = document.getElementById("monthsContainer");
const monthsEmpty = document.getElementById("monthsEmpty");
const historyCard = document.getElementById("historyCard");
const historyTbody = document.querySelector("#historyTable tbody");
const historyEmpty = document.getElementById("historyEmpty");

wireLogout("logoutLink", "navBrandLink");

if (sessionPersonId) {
  People.listen((d) => {
    people = d;
    if (!adminCheckDone) {
      adminCheckDone = true;
      const me = people.find((p) => p.id === sessionPersonId);
      if (!enforceAdmin(me)) return;
      renderNavUserName(me);
    }
    renderDraft();
  });
  Projects.listen((d) => { projects = d; renderProjectCards(); });
  Tasks.listen((d) => { tasks = d; renderDraft(); });
  TimeEntries.listen((d) => { timeEntries = d; renderDraft(); });
  Invoices.listen((d) => { invoices = d; renderHistory(); renderSheetSync(); });
}

// Invoices charge the project's bill rate, or each person's pay rate on
// projects without one; hours already invoiced keep the rate they were billed
// at (see rates.js).
function entryRate(e) {
  return billRateOf(e, { projects, people });
}

// ---------- Project cards ----------
function renderProjectCards() {
  if (projects.length === 0) {
    projectCardsEl.innerHTML = "";
    projectCardsEmpty.style.display = "block";
    outstandingHeading.style.display = "none";
    monthsContainer.innerHTML = "";
    monthsEmpty.style.display = "none";
    historyCard.style.display = "none";
    return;
  }
  projectCardsEmpty.style.display = "none";

  if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
    selectedProjectId = projects[0].id;
  }

  projectCardsEl.innerHTML = projects.map((p) => `
    <div class="project-card ${p.id === selectedProjectId ? "active" : ""}" data-project-card="${p.id}">
      <div class="name">${p.name}</div>
      <div class="client">${p.client || "&nbsp;"}</div>
    </div>
  `).join("");

  renderDraft();
  renderHistory();
}

projectCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card) return;
  selectedProjectId = card.dataset.projectCard;
  expandedInvoiceId = null;
  expandedNotesKey = null;
  renderProjectCards();
});

// ---------- Ready to invoice (all approved, uninvoiced hours) ----------
// One draft invoice per project covering every approved hour not yet invoiced.
// The date range defaults to the earliest/latest such hours but can be
// narrowed, and the billing period label (e.g. "August – September 2026")
// follows the range unless it's been typed over.
let draft = null; // { projectId, from, to, label, rangeTouched, labelTouched }

function uninvoicedEntries({ approved }) {
  if (!selectedProjectId) return [];
  return timeEntries.filter((e) =>
    e.projectId === selectedProjectId && !e.invoiced && !!e.approved === approved);
}

function inDraftRange(e) {
  return !!draft && e.date >= draft.from && e.date <= draft.to;
}

function draftEntries() {
  return uninvoicedEntries({ approved: true }).filter(inDraftRange);
}

function periodLabelFor(from, to) {
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  const month = (d) => d.toLocaleDateString("en-US", { month: "long" });
  if (a.getFullYear() !== b.getFullYear()) return `${month(a)} ${a.getFullYear()} – ${month(b)} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${month(a)} – ${month(b)} ${b.getFullYear()}`;
  return `${month(a)} ${a.getFullYear()}`;
}

function notesForPerson(personId) {
  return draftEntries()
    .filter((e) => e.personId === personId && e.note)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
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

function hoursSummary(entries) {
  const hours = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  return `${hours.toFixed(2)} hrs (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`;
}

function renderDraft() {
  if (!selectedProjectId || projects.length === 0) {
    outstandingHeading.style.display = "none";
    monthsContainer.innerHTML = "";
    monthsEmpty.style.display = "none";
    return;
  }

  const approved = uninvoicedEntries({ approved: true });
  const pending = uninvoicedEntries({ approved: false });
  if (approved.length === 0) {
    draft = null;
    outstandingHeading.style.display = "none";
    monthsContainer.innerHTML = "";
    monthsEmpty.style.display = "block";
    monthsEmpty.textContent = pending.length
      ? `Nothing ready to invoice — ${hoursSummary(pending)} still waiting for approval in Admin.`
      : "No uninvoiced hours for this project — everything logged so far has already been invoiced.";
    return;
  }
  outstandingHeading.style.display = "block";
  monthsEmpty.style.display = "none";

  const dates = approved.map((e) => e.date).sort();
  if (!draft || draft.projectId !== selectedProjectId) {
    draft = { projectId: selectedProjectId, rangeTouched: false, labelTouched: false };
  }
  if (!draft.rangeTouched) {
    draft.from = dates[0];
    draft.to = dates[dates.length - 1];
  }
  if (!draft.labelTouched) draft.label = periodLabelFor(draft.from, draft.to);

  if (!monthsContainer.querySelector("#draftFrom")) {
    monthsContainer.innerHTML = `<div class="card">
      <div class="inline-form">
        <div>
          <label for="draftFrom">Hours from</label>
          <input type="date" id="draftFrom" />
        </div>
        <div>
          <label for="draftTo">Through</label>
          <input type="date" id="draftTo" />
        </div>
        <div style="flex:2;">
          <label for="draftLabel">Billing period (shown on the invoice)</label>
          <input type="text" id="draftLabel" />
        </div>
      </div>
      <div id="draftBody"></div>
      <div class="row-actions" style="margin-top:16px;">
        <button class="secondary" data-action="preview">Preview PDF (Test)</button>
        <button data-action="generate">Generate Invoice</button>
      </div>
    </div>`;
  }
  const setIfIdle = (id, value) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = value;
  };
  setIfIdle("draftFrom", draft.from);
  setIfIdle("draftTo", draft.to);
  setIfIdle("draftLabel", draft.label);
  renderDraftBody(approved, pending);
}

function renderDraftBody(approved, pending) {
  const body = document.getElementById("draftBody");
  const entries = approved.filter(inDraftRange);
  const laborRows = groupByPerson(entries).sort((a, b) => a.name.localeCompare(b.name));
  const grand = laborRows.reduce((s, r) => s + r.total, 0);
  const hours = laborRows.reduce((s, r) => s + r.hours, 0);

  const notices = [];
  const pendingInRange = pending.filter(inDraftRange);
  if (pendingInRange.length) {
    notices.push(`${hoursSummary(pendingInRange)} in this range ${pendingInRange.length === 1 ? "is" : "are"} still pending approval and won't be included — approve in Admin first.`);
  }
  const outside = approved.filter((e) => !inDraftRange(e));
  if (outside.length) {
    notices.push(`${hoursSummary(outside)} of approved hours fall outside this range and will stay uninvoiced. <a href="#" data-action="reset-range">Include all</a>`);
  }

  const rowsHtml = laborRows.map((r) => {
    const isOpen = expandedNotesKey === r.personId;
    const notes = notesForPerson(r.personId);
    return `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${r.hours.toFixed(2)}</td>
        <td>${formatCurrency(r.rate)}</td>
        <td>${formatCurrency(r.total)}</td>
        <td><button class="small secondary" data-action="toggle-notes" data-key="${r.personId}">${isOpen ? "Hide notes" : "View notes"}</button></td>
      </tr>
      ${isOpen ? `<tr class="notes-row"><td colspan="5">
        ${notes.length === 0
          ? '<div class="empty">No notes logged for this person in this range.</div>'
          : notes.map((e) => `<div>${formatDate(e.date)} — ${Number(e.hours).toFixed(2)}h: ${esc(e.note)}</div>`).join("")}
      </td></tr>` : ""}`;
  }).join("");

  // Admin-only page, so show what the firm keeps when billing above pay rates.
  const staffPay = paidAmount(entries, people);
  const overheadHtml = entries.length && Math.abs(grand - staffPay) > 0.005
    ? `<div class="empty" style="padding-top:10px;">Staff pay for these hours: ${formatCurrency(staffPay)} &middot; Firm overhead: <strong>${formatCurrency(grand - staffPay)}</strong></div>`
    : "";

  body.innerHTML = `
    ${notices.map((n) => `<div class="draft-notice">${n}</div>`).join("")}
    ${entries.length === 0
      ? '<div class="empty">No approved hours in this date range.</div>'
      : `<table style="margin-top:16px;">
          <thead><tr><th>Person</th><th>Hours</th><th>Rate</th><th>Total</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr><td>Total</td><td>${hours.toFixed(2)}</td><td></td><td>${formatCurrency(grand)}</td><td></td></tr></tfoot>
        </table>`}
    ${overheadHtml}`;
  monthsContainer.querySelectorAll('[data-action="preview"], [data-action="generate"]')
    .forEach((b) => { b.disabled = entries.length === 0; });
}

monthsContainer.addEventListener("input", (e) => {
  if (!draft) return;
  if (e.target.id === "draftFrom" || e.target.id === "draftTo") {
    const value = e.target.value;
    if (!value) return;
    draft.rangeTouched = true;
    if (e.target.id === "draftFrom") draft.from = value; else draft.to = value;
    if (!draft.labelTouched) {
      draft.label = periodLabelFor(draft.from, draft.to);
      document.getElementById("draftLabel").value = draft.label;
    }
    renderDraft();
  }
  if (e.target.id === "draftLabel") {
    draft.label = e.target.value;
    draft.labelTouched = e.target.value.trim() !== "";
  }
});

monthsContainer.addEventListener("click", async (e) => {
  const notesBtn = e.target.closest('[data-action="toggle-notes"]');
  if (notesBtn) {
    const key = notesBtn.dataset.key;
    expandedNotesKey = expandedNotesKey === key ? null : key;
    renderDraft();
    return;
  }
  if (e.target.closest('[data-action="reset-range"]')) {
    e.preventDefault();
    draft.rangeTouched = false;
    draft.labelTouched = false;
    document.getElementById("draftLabel").blur();
    renderDraft();
    return;
  }
  const actionBtn = e.target.closest('[data-action="preview"], [data-action="generate"]');
  if (!actionBtn) return;
  await generate(actionBtn.dataset.action === "preview");
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

async function generate(isPreview) {
  const project = projects.find((p) => p.id === selectedProjectId);
  const entries = draftEntries();
  if (!project || entries.length === 0) return;
  if (draft.from > draft.to) return showToast("The start date is after the end date.");
  const periodLabel = draft.label.trim() || periodLabelFor(draft.from, draft.to);

  const buttons = [...monthsContainer.querySelectorAll('[data-action="preview"], [data-action="generate"]')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const computed = computeInvoiceData(project, entries);
    const invoiceDate = new Date();
    const dueDate = lastDayOfMonth(invoiceDate);
    const invoiceNumber = toISODate(invoiceDate);

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
        periodStart: draft.from,
        periodEnd: draft.to,
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
      draft = null;
      showToast("Invoice generated.");
      syncSheet();
    } else {
      showToast("Preview downloaded — nothing was marked invoiced.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    renderDraft();
  }
}

// ---------- Invoice history ----------
function renderHistory() {
  if (!selectedProjectId) {
    historyCard.style.display = "none";
    return;
  }
  historyCard.style.display = "block";

  const projectInvoices = invoices
    .filter((i) => i.projectId === selectedProjectId)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (projectInvoices.length === 0) {
    historyTbody.innerHTML = "";
    historyEmpty.style.display = "block";
    return;
  }
  historyEmpty.style.display = "none";

  historyTbody.innerHTML = projectInvoices.map((inv) => {
    const statusPill = (inv.paid
      ? `<span class="pill green">Paid</span>`
      : `<span class="pill orange">Outstanding</span>`) +
      (sheetSyncEnabled() && !inv.sheetSynced ? ` <span class="pill red" title="Not yet logged in the Google Sheet — click Sync Now">Not in sheet</span>` : "");
    const mainRow = `<tr class="task-row" data-invoice-row="${inv.id}">
      <td>${inv.periodLabel || "—"}</td>
      <td>${inv.invoiceNumber}</td>
      <td>${formatDate(inv.date)}</td>
      <td>${formatCurrency(inv.total)}</td>
      <td>${statusPill}</td>
      <td class="row-actions">
        ${!inv.paid ? `<button class="small" data-action="mark-paid" data-id="${inv.id}">Mark Paid</button>` : `<span class="empty">${inv.paidDate ? "Paid " + daysAgo(inv.paidDate) : ""}</span>`}
      </td>
    </tr>`;

    if (inv.id !== expandedInvoiceId) return mainRow;

    const taskLines = inv.taskBreakdown
      ? inv.taskBreakdown.map((r) => `<div>${r.name} — ${formatCurrency(r.amount)}</div>`).join("")
      : (inv.taskRows || []).map((r) =>
          `<div>${r.name} — Budget ${formatCurrency(r.budget)}, Billed ${formatCurrency(r.billed)}, Current ${formatCurrency(r.current)}, Complete ${r.pct}%, Remaining ${formatCurrency(r.remaining)}</div>`
        ).join("");
    const laborLines = (inv.laborRows || []).map((r) =>
      `<div>${r.name} — ${r.hours.toFixed(2)} hrs @ ${formatCurrency(r.rate)} = ${formatCurrency(r.total)}</div>`
    ).join("");

    return mainRow + `<tr>
      <td colspan="6" class="accordion-cell">
        <div style="font-weight:600; margin-bottom:4px;">${inv.historical ? "Work Breakdown" : "Project Summary"}</div>
        ${taskLines || '<div class="empty">No task data saved for this invoice.</div>'}
        <div style="font-weight:600; margin:10px 0 4px;">Labor</div>
        ${laborLines || '<div class="empty">No labor data saved for this invoice.</div>'}
        <div style="font-weight:600; margin-top:10px;">Total: ${formatCurrency(inv.total)}</div>
      </td>
    </tr>`;
  }).join("");
}

historyTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) {
    const row = e.target.closest("tr.task-row");
    if (row) {
      const id = row.dataset.invoiceRow;
      expandedInvoiceId = expandedInvoiceId === id ? null : id;
      renderHistory();
    }
    return;
  }

  const { action, id } = btn.dataset;
  if (action === "mark-paid") {
    if (!confirm("Mark this invoice as paid? This will also mark its hours as paid on the Timesheet.")) return;
    try {
      const linkedEntries = timeEntries.filter((entry) => entry.invoiceId === id);
      await TimeEntries.markPaid(linkedEntries.map((entry) => entry.id));
      await Invoices.update(id, { paid: true, paidDate: new Date().toISOString(), sheetSynced: false });
      showToast("Invoice marked as paid.");
      syncSheet();
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }
});

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
    sheetSyncStatus.innerHTML = '<span class="empty" style="padding:0;">Sheet syncing is off in Test Mode.</span>';
    sheetSyncBtn.style.display = "none";
    return;
  }
  sheetSyncBtn.disabled = sheetSyncing;
  sheetSyncBtn.textContent = sheetSyncing ? "Syncing…" : "Sync Now";
  const unsynced = invoices.filter((i) => !i.sheetSynced).length;
  if (sheetSyncing) {
    sheetSyncStatus.textContent = "Sending invoices to the sheet…";
  } else if (sheetSyncError) {
    sheetSyncStatus.innerHTML = `<span style="color:var(--red);">Last sync failed: ${esc(sheetSyncError)}</span>`;
  } else if (unsynced > 0) {
    sheetSyncStatus.innerHTML = `<span class="pill orange">${unsynced} ${unsynced === 1 ? "invoice" : "invoices"} not yet in the sheet</span>`;
  } else {
    sheetSyncStatus.innerHTML = `<span class="pill green">All ${invoices.length} invoices logged</span>`;
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
    renderHistory();
    if (sheetSyncQueued) {
      sheetSyncQueued = false;
      syncSheet();
    }
  }
}

sheetSyncBtn.addEventListener("click", () => syncSheet({ manual: true }));
