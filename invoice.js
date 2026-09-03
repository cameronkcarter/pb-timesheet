import { People, Projects, Tasks, TimeEntries, Invoices } from "./db.js";
import { requireSession, wireLogout, enforceAdmin } from "./session.js";
import {
  formatCurrency, formatDate, daysAgo, showToast,
  lastDayOfMonth, formatMonthLabel, formatMonthShort, formatShortMDY, toISODate,
} from "./util.js";

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
    }
    renderMonths();
  });
  Projects.listen((d) => { projects = d; renderProjectCards(); });
  Tasks.listen((d) => { tasks = d; renderMonths(); });
  TimeEntries.listen((d) => { timeEntries = d; renderMonths(); });
  Invoices.listen((d) => { invoices = d; renderHistory(); });
}

function rateOf(personId) {
  const p = people.find((pp) => pp.id === personId);
  return p ? p.rate : 0;
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

  renderMonths();
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

// ---------- Outstanding (uninvoiced) hours, grouped by month ----------
function entriesForMonth(monthKeyStr) {
  if (!selectedProjectId) return [];
  return timeEntries.filter((e) =>
    e.projectId === selectedProjectId && e.approved && !e.invoiced && e.date.startsWith(monthKeyStr)
  );
}

function notesForPersonMonth(personId, monthKeyStr) {
  return entriesForMonth(monthKeyStr)
    .filter((e) => e.personId === personId && e.note)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function groupByPerson(entries) {
  const byPerson = {};
  entries.forEach((e) => {
    byPerson[e.personId] = (byPerson[e.personId] || 0) + Number(e.hours || 0);
  });
  return Object.entries(byPerson).map(([personId, hours]) => {
    const person = people.find((p) => p.id === personId);
    const rate = rateOf(personId);
    return { personId, name: person ? person.name : "—", hours, rate, total: hours * rate };
  });
}

function outstandingMonthKeys() {
  if (!selectedProjectId) return [];
  const entries = timeEntries.filter((e) => e.projectId === selectedProjectId && e.approved && !e.invoiced);
  const keys = new Set(entries.map((e) => e.date.slice(0, 7)));
  return [...keys].sort(); // oldest first, so forgotten months surface at the top
}

function monthSectionHtml(monthKeyStr) {
  const monthDate = new Date(monthKeyStr + "-01T00:00:00");
  const laborRows = groupByPerson(entriesForMonth(monthKeyStr));
  const grand = laborRows.reduce((s, r) => s + r.total, 0);

  const rowsHtml = laborRows.map((r) => {
    const notesKey = `${monthKeyStr}|${r.personId}`;
    const isOpen = expandedNotesKey === notesKey;
    const notes = notesForPersonMonth(r.personId, monthKeyStr);
    return `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${r.hours.toFixed(2)}</td>
        <td>${formatCurrency(r.rate)}</td>
        <td>${formatCurrency(r.total)}</td>
        <td><button class="small secondary" data-action="toggle-notes" data-key="${notesKey}">${isOpen ? "Hide notes" : "View notes"}</button></td>
      </tr>
      ${isOpen ? `<tr class="notes-row"><td colspan="5">
        ${notes.length === 0
          ? '<div class="empty">No notes logged for this person this month.</div>'
          : notes.map((e) => `<div>${formatDate(e.date)} — ${Number(e.hours).toFixed(2)}h: ${esc(e.note)}</div>`).join("")}
      </td></tr>` : ""}
    `;
  }).join("");

  return `<div class="card month-section">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h2 style="margin:0;">${formatMonthLabel(monthDate)}</h2>
      <span class="pill orange">Not yet invoiced</span>
    </div>
    <table style="margin-top:16px;">
      <thead><tr><th>Person</th><th>Hours</th><th>Rate</th><th>Total</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr><td>Total</td><td></td><td></td><td>${formatCurrency(grand)}</td><td></td></tr></tfoot>
    </table>
    <div class="row-actions" style="margin-top:16px;">
      <button class="secondary" data-action="preview" data-month="${monthKeyStr}">Preview PDF (Test)</button>
      <button data-action="generate" data-month="${monthKeyStr}">Generate Invoice</button>
    </div>
  </div>`;
}

function renderMonths() {
  if (!selectedProjectId || projects.length === 0) {
    outstandingHeading.style.display = "none";
    monthsContainer.innerHTML = "";
    monthsEmpty.style.display = "none";
    return;
  }

  const monthKeys = outstandingMonthKeys();
  if (monthKeys.length === 0) {
    outstandingHeading.style.display = "none";
    monthsContainer.innerHTML = "";
    monthsEmpty.style.display = "block";
    return;
  }

  outstandingHeading.style.display = "block";
  monthsEmpty.style.display = "none";
  monthsContainer.innerHTML = monthKeys.map(monthSectionHtml).join("");
}

monthsContainer.addEventListener("click", async (e) => {
  const notesBtn = e.target.closest('[data-action="toggle-notes"]');
  if (notesBtn) {
    const key = notesBtn.dataset.key;
    expandedNotesKey = expandedNotesKey === key ? null : key;
    renderMonths();
    return;
  }

  const actionBtn = e.target.closest('[data-action="preview"], [data-action="generate"]');
  if (!actionBtn) return;
  const monthKeyStr = actionBtn.dataset.month;
  const isPreview = actionBtn.dataset.action === "preview";
  await generate(isPreview, monthKeyStr);
});

// ---------- Shared invoice math ----------
function computeInvoiceData(project, entries) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const allEntriesForProject = timeEntries.filter((e) => e.projectId === project.id);

  const taskRows = projectTasks.map((t) => {
    const budget = Number(t.budget || 0);
    const billed = allEntriesForProject
      .filter((e) => e.taskId === t.id && e.invoiced)
      .reduce((s, e) => s + Number(e.hours || 0) * rateOf(e.personId), 0);
    const current = entries
      .filter((e) => e.taskId === t.id)
      .reduce((s, e) => s + Number(e.hours || 0) * rateOf(e.personId), 0);
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
    `${r.name} - for work completed in ${data.periodLabel}`,
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

async function generate(isPreview, monthKeyStr) {
  const project = projects.find((p) => p.id === selectedProjectId);
  const entries = entriesForMonth(monthKeyStr);
  if (!project || entries.length === 0) return;
  const monthDate = new Date(monthKeyStr + "-01T00:00:00");

  const monthButtons = [...monthsContainer.querySelectorAll(`[data-month="${monthKeyStr}"]`)];
  monthButtons.forEach((b) => { b.disabled = true; });
  try {
    const computed = computeInvoiceData(project, entries);
    const invoiceDate = new Date();
    const dueDate = lastDayOfMonth(invoiceDate);
    const invoiceNumber = toISODate(invoiceDate);
    const periodLabel = formatMonthShort(monthDate);

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
        periodLabel: formatMonthLabel(monthDate),
        taskRows: computed.taskRows,
        laborRows: computed.laborRows,
        feeTotal: computed.feeTotal,
        billedTotal: computed.billedTotal,
        currentTotal: computed.currentTotal,
        remainingTotal: computed.remainingTotal,
        pctTotal: computed.pctTotal,
        total: computed.laborTotal,
      });
      await TimeEntries.markInvoiced(entries.map((e) => e.id), ref.id);
      showToast("Invoice generated.");
    } else {
      showToast("Preview downloaded — nothing was marked invoiced.");
    }
  } catch (err) {
    showToast("Error: " + err.message);
    monthButtons.forEach((b) => { b.disabled = false; });
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
    const statusPill = inv.paid
      ? `<span class="pill green">Paid</span>`
      : `<span class="pill orange">Outstanding</span>`;
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
      await Invoices.update(id, { paid: true, paidDate: new Date().toISOString() });
      showToast("Invoice marked as paid.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }
});
