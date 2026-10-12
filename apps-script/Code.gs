// ---------------------------------------------------------------------------
// Place Builders Timesheet -> Google Sheet invoice log
//
// This script lives inside the Google Sheet (Extensions > Apps Script), NOT on
// the website. The website POSTs invoice data to it whenever an invoice is
// generated or marked paid, and it records it in the sheet.
//
// ONE-TIME SETUP
//   1. Paste this whole file into Extensions > Apps Script (replace what's there).
//   2. Pick "setup" in the function dropdown at the top and click Run. Approve
//      the permission prompt. The execution log at the bottom prints a secret
//      passphrase — copy it.
//   3. Deploy > New deployment > gear icon > Web app.
//        Execute as: Me      Who has access: Anyone
//      Click Deploy and copy the Web app URL (ends in /exec).
//   4. Paste the URL and the secret into sheets.js on the website.
//
// UPDATING THIS SCRIPT LATER
//   Paste the new version, save, then Deploy > Manage deployments > pencil icon
//   > Version: New version > Deploy (keeps the same URL). Then run "setup"
//   once to apply any sheet layout changes.
//
// How the sheet is organized:
//   Hidden "Log:" tabs are the paper trail — raw records (with the IDs used to
//   avoid duplicates) that are only ever appended to, plus Paid Date filled in.
//   The visible tabs are reports rebuilt from those logs on every sync, so
//   don't type into them; anything typed there is overwritten.
//
//   Invoices      one row per invoice, with running totals vs. project budget
//   Staff Time    one row per person per invoice (hours + pay)
//   Task Budgets  each task's budget vs. amount invoiced so far
//   Summary       rollups by project, person, and task (live formulas)
// ---------------------------------------------------------------------------

const LOG = {
  invoices: {
    name: "Log: Invoices",
    headers: ["Invoice Date", "Invoice #", "Project", "Billing Period", "Total", "Paid Date", "Added to Sheet", "Invoice ID"],
  },
  lines: {
    name: "Log: Lines",
    headers: ["Invoice Date", "Invoice #", "Billing Period", "Project", "Task", "Person", "Hours", "Rate", "Amount",
      "Added to Sheet", "Note", "Invoice ID", "Project ID", "Task ID", "Person ID", "Line Key"],
  },
  budgets: {
    name: "Log: Budgets",
    headers: ["Project", "Task", "Budget", "Project ID", "Task ID"],
  },
};

const REPORTS = {
  invoices: {
    name: "Invoices",
    headers: ["Invoice Date", "Invoice #", "Project", "Billing Period", "Hours Invoiced", "Amount Invoiced",
      "Invoiced to Date", "Remaining Budget", "Paid Date", "Note"],
    formats: { A: "m/d/yyyy", E: "0.00", F: "$#,##0.00", G: "$#,##0.00", H: "$#,##0.00", I: "m/d/yyyy" },
  },
  staff: {
    name: "Staff Time",
    headers: ["Invoice Date", "Invoice #", "Project", "Billing Period", "Person", "Hours", "Rate", "Amount", "Note"],
    formats: { A: "m/d/yyyy", F: "0.00", G: "$#,##0.00", H: "$#,##0.00" },
  },
  budgets: {
    name: "Task Budgets",
    headers: ["Project", "Task", "Budget", "Invoiced to Date", "Hours Invoiced", "Remaining", "% Invoiced"],
    formats: { C: "$#,##0.00", D: "$#,##0.00", E: "0.00", F: "$#,##0.00", G: "0%" },
  },
};
const SUMMARY_TAB = "Summary";
const TAB_ORDER = ["Invoices", "Staff Time", "Task Budgets", "Summary"];
const PURPLE = "#5c2670";

// ---------- Entry points ----------

function setup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty("SYNC_SECRET");
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, "");
    props.setProperty("SYNC_SECRET", secret);
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  rebuildReports_(ss);
  TAB_ORDER.forEach((name, i) => {
    ss.setActiveSheet(ss.getSheetByName(name));
    ss.moveActiveSheet(i + 1);
  });
  Logger.log("Setup complete. Your secret passphrase is:\n\n" + secret + "\n\nPaste it into SHEET_SECRET in sheets.js.");
}

// Visiting the web app URL in a browser just confirms it's running.
function doGet() {
  return json_({ ok: true, message: "Place Builders invoice sheet sync is running." });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "Bad request body" });
  }
  const secret = PropertiesService.getScriptProperties().getProperty("SYNC_SECRET");
  if (!secret || body.secret !== secret) return json_({ ok: false, error: "Unauthorized" });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureSheets_(ss);
    const result = { ok: true };
    if (body.invoices) Object.assign(result, upsertInvoices_(ss, body.invoices, body.extraLines || []));
    if (body.budgets) result.budgetRows = writeBudgets_(ss, body.budgets);
    if (body.invoices || body.budgets) rebuildReports_(ss);
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- Logs: invoices + lines (append-only) ----------

function upsertInvoices_(ss, invoices, extraLines) {
  const now = new Date();
  const invSheet = ss.getSheetByName(LOG.invoices.name);
  const lineSheet = ss.getSheetByName(LOG.lines.name);

  // Invoice ID -> sheet row number, for dedup and Paid Date updates.
  const invIdCol = LOG.invoices.headers.indexOf("Invoice ID") + 1;
  const paidCol = LOG.invoices.headers.indexOf("Paid Date") + 1;
  const existingInv = {};
  columnValues_(invSheet, invIdCol).forEach((id, i) => { if (id) existingInv[id] = i + 2; });

  const lineKeyCol = LOG.lines.headers.indexOf("Line Key") + 1;
  const existingLines = new Set(columnValues_(lineSheet, lineKeyCol).filter(String));

  const newInvRows = [];
  const newLineRows = [];
  let paidUpdated = 0;

  invoices.forEach((inv) => {
    const row = existingInv[inv.invoiceId];
    if (row) {
      const current = invSheet.getRange(row, paidCol).getValue();
      const currentStr = current instanceof Date ? isoDate_(current) : String(current || "");
      if ((inv.paidDate || "") !== currentStr) {
        invSheet.getRange(row, paidCol).setValue(toDate_(inv.paidDate));
        paidUpdated++;
      }
    } else {
      newInvRows.push([
        toDate_(inv.date), inv.invoiceNumber, inv.projectName, inv.periodLabel, inv.total,
        toDate_(inv.paidDate), now, inv.invoiceId,
      ]);
      existingInv[inv.invoiceId] = -1;
    }
    (inv.lines || []).forEach((l) => {
      const line = Object.assign({}, l, {
        invoiceDate: inv.date, invoiceNumber: inv.invoiceNumber, periodLabel: inv.periodLabel,
        projectName: inv.projectName, projectId: inv.projectId, invoiceId: inv.invoiceId,
      });
      if (!existingLines.has(line.lineKey)) { newLineRows.push(lineRow_(line, now)); existingLines.add(line.lineKey); }
    });
  });

  extraLines.forEach((l) => {
    if (!existingLines.has(l.lineKey)) { newLineRows.push(lineRow_(l, now)); existingLines.add(l.lineKey); }
  });

  appendRows_(invSheet, newInvRows);
  appendRows_(lineSheet, newLineRows);
  return { invoicesAdded: newInvRows.length, linesAdded: newLineRows.length, paidUpdated: paidUpdated };
}

function lineRow_(l, now) {
  return [
    toDate_(l.invoiceDate), l.invoiceNumber || "", l.periodLabel || "", l.projectName, l.taskName, l.personName,
    l.hours, l.rate, l.amount, now, l.note || "", l.invoiceId || "", l.projectId || "", l.taskId || "",
    l.personId || "", l.lineKey,
  ];
}

// Current task budgets from the site (a snapshot, replaced every sync).
function writeBudgets_(ss, budgets) {
  const sheet = ss.getSheetByName(LOG.budgets.name);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, LOG.budgets.headers.length).clearContent();
  const rows = budgets.map((b) => [b.projectName, b.taskName, b.budget, b.projectId, b.taskId]);
  appendRows_(sheet, rows);
  return rows.length;
}

// ---------- Reports (rebuilt from the logs every sync) ----------

function rebuildReports_(ss) {
  const invoices = readLog_(ss, LOG.invoices);
  const lines = readLog_(ss, LOG.lines);
  const budgets = readLog_(ss, LOG.budgets);

  const round2 = (n) => Math.round(n * 100) / 100;
  const time = (d) => (d instanceof Date ? d.getTime() : 0);
  const byDateThenNumber = (a, b) => time(a.date) - time(b.date) || String(a.number).localeCompare(String(b.number));

  // --- Invoices: real invoices plus any "no invoice record" lines, which the
  // site counts as already billed, so running totals match the app.
  const hoursByInvoice = {};
  lines.forEach((l) => {
    if (l["Invoice ID"]) hoursByInvoice[l["Invoice ID"]] = (hoursByInvoice[l["Invoice ID"]] || 0) + Number(l.Hours || 0);
  });
  const invoiceRecords = invoices.map((inv) => ({
    date: inv["Invoice Date"], number: inv["Invoice #"], project: inv.Project, period: inv["Billing Period"],
    hours: hoursByInvoice[inv["Invoice ID"]] || 0, amount: Number(inv.Total || 0), paid: inv["Paid Date"], note: "",
  })).concat(lines.filter((l) => !l["Invoice ID"]).map((l) => ({
    date: l["Invoice Date"], number: "", project: l.Project, period: l["Billing Period"],
    hours: Number(l.Hours || 0), amount: Number(l.Amount || 0), paid: "", note: l.Note,
  }))).sort(byDateThenNumber);

  const budgetByProject = {};
  budgets.forEach((b) => { budgetByProject[b.Project] = (budgetByProject[b.Project] || 0) + Number(b.Budget || 0); });
  const runningByProject = {};
  const invoiceRows = invoiceRecords.map((r) => {
    runningByProject[r.project] = (runningByProject[r.project] || 0) + r.amount;
    const toDate = runningByProject[r.project];
    return [r.date, r.number, r.project, r.period, round2(r.hours), r.amount, round2(toDate),
      round2((budgetByProject[r.project] || 0) - toDate), r.paid, r.note];
  });
  writeReport_(ss, REPORTS.invoices, invoiceRows);

  // --- Staff Time: tasks combined, one row per person per invoice.
  const staff = {};
  lines.forEach((l) => {
    const key = (l["Invoice ID"] || l["Line Key"]) + "|" + (l["Person ID"] || l.Person);
    if (!staff[key]) {
      staff[key] = { date: l["Invoice Date"], number: l["Invoice #"], project: l.Project, period: l["Billing Period"],
        person: l.Person, hours: 0, amount: 0, note: l.Note || "" };
    }
    staff[key].hours += Number(l.Hours || 0);
    staff[key].amount += Number(l.Amount || 0);
  });
  const staffRows = Object.keys(staff).map((k) => staff[k])
    .sort((a, b) => byDateThenNumber(a, b) || a.person.localeCompare(b.person))
    .map((s) => [s.date, s.number, s.project, s.period, s.person, round2(s.hours),
      s.hours > 0 ? round2(s.amount / s.hours) : "", round2(s.amount), s.note]);
  writeReport_(ss, REPORTS.staff, staffRows);

  // --- Task Budgets: matched to invoiced lines by task ID, so renaming a task
  // on the site doesn't break its history.
  const invoicedByTask = {};
  lines.forEach((l) => {
    const id = l["Task ID"];
    if (!invoicedByTask[id]) invoicedByTask[id] = { amount: 0, hours: 0 };
    invoicedByTask[id].amount += Number(l.Amount || 0);
    invoicedByTask[id].hours += Number(l.Hours || 0);
  });
  const budgetRows = budgets
    .slice()
    .sort((a, b) => String(a.Project).localeCompare(String(b.Project)) || String(a.Task).localeCompare(String(b.Task)))
    .map((b) => {
      const budget = Number(b.Budget || 0);
      const inv = invoicedByTask[b["Task ID"]] || { amount: 0, hours: 0 };
      return [b.Project, b.Task, budget, round2(inv.amount), round2(inv.hours), round2(budget - inv.amount),
        budget > 0 ? inv.amount / budget : ""];
    });
  writeReport_(ss, REPORTS.budgets, budgetRows);

  buildSummary_(ss.getSheetByName(SUMMARY_TAB));
}

function readLog_(ss, log) {
  const sheet = ss.getSheetByName(log.name);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, log.headers.length).getValues().map((row) => {
    const obj = {};
    log.headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function writeReport_(ss, report, rows) {
  const sheet = ss.getSheetByName(report.name);
  const width = report.headers.length;
  sheet.clear();
  sheet.getBandings().forEach((b) => b.remove());

  sheet.getRange(1, 1, 1, width).setValues([report.headers]);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, width).setValues(rows);
  Object.keys(report.formats).forEach((col) => sheet.getRange(`${col}2:${col}`).setNumberFormat(report.formats[col]));

  const banding = sheet.getRange(1, 1, Math.max(rows.length, 1) + 1, width)
    .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  banding.setHeaderRowColor(PURPLE);
  sheet.getRange(1, 1, 1, width).setFontWeight("bold").setFontColor("#ffffff");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, width);
}

function buildSummary_(sheet) {
  sheet.clear();
  const title = (cell, text) => sheet.getRange(cell).setValue(text).setFontWeight("bold").setFontSize(12).setFontColor(PURPLE);

  title("A1", "By Project");
  sheet.getRange("A2").setFormula(
    "=QUERY('Task Budgets'!A:F,\"select A, sum(C), sum(D), sum(E), sum(F) where A is not null group by A order by A " +
    "label A 'Project', sum(C) 'Budget', sum(D) 'Invoiced', sum(E) 'Hours', sum(F) 'Remaining'\",1)");
  ["B", "C", "E"].forEach((c) => sheet.getRange(`${c}3:${c}`).setNumberFormat("$#,##0.00"));
  sheet.getRange("D3:D").setNumberFormat("0.00");

  title("G1", "By Person & Project");
  sheet.getRange("G2").setFormula(
    "=QUERY('Staff Time'!A:H,\"select C, E, sum(F), sum(H) where E is not null group by C, E order by C, E " +
    "label C 'Project', E 'Person', sum(F) 'Hours', sum(H) 'Pay'\",1)");
  sheet.getRange("I3:I").setNumberFormat("0.00");
  sheet.getRange("J3:J").setNumberFormat("$#,##0.00");

  title("L1", "By Project & Task");
  sheet.getRange("L2").setFormula(
    "=QUERY('Task Budgets'!A:F,\"select A, B, C, D, E, F where A is not null order by A, B " +
    "label A 'Project', B 'Task', C 'Budget', D 'Invoiced', E 'Hours', F 'Remaining'\",1)");
  ["N", "O", "Q"].forEach((c) => sheet.getRange(`${c}3:${c}`).setNumberFormat("$#,##0.00"));
  sheet.getRange("P3:P").setNumberFormat("0.00");

  sheet.getRange("A2:Q2").setFontWeight("bold").setBackground("#eeeeee");
  sheet.setFrozenRows(2);
  sheet.setColumnWidths(1, 17, 110);
  [1, 7, 12, 13].forEach((c) => sheet.setColumnWidth(c, 200));
}

// ---------- Sheet scaffolding ----------

function ensureSheets_(ss) {
  migrateV1_(ss);

  Object.keys(LOG).forEach((key) => {
    const log = LOG[key];
    let sheet = ss.getSheetByName(log.name);
    if (!sheet) {
      sheet = ss.insertSheet(log.name);
      sheet.getRange(1, 1, 1, log.headers.length).setValues([log.headers]).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    if (!sheet.isSheetHidden()) sheet.hideSheet();
  });

  Object.keys(REPORTS).map((k) => REPORTS[k].name).concat([SUMMARY_TAB]).forEach((name) => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  // Drop the blank default tab a brand-new spreadsheet comes with.
  const blank = ss.getSheetByName("Sheet1");
  if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

// The first version of this script wrote raw rows (with ID columns) straight
// into the visible tabs. Keep those rows as the hidden logs instead.
function migrateV1_(ss) {
  const oldInvoices = ss.getSheetByName("Invoices");
  if (oldInvoices && !ss.getSheetByName(LOG.invoices.name) && oldInvoices.getRange(1, 8).getValue() === "Invoice ID") {
    oldInvoices.setName(LOG.invoices.name);
  }
  const oldLines = ss.getSheetByName("Invoice Lines");
  if (oldLines && !ss.getSheetByName(LOG.lines.name)) oldLines.setName(LOG.lines.name);

  const oldBudgets = ss.getSheetByName("Task Budgets");
  if (oldBudgets && oldBudgets.getRange(1, 9).getValue() === "Task ID") {
    const last = oldBudgets.getLastRow();
    const rows = last < 2 ? [] : oldBudgets.getRange(2, 1, last - 1, 9).getValues()
      .map((r) => [r[0], r[1], r[2], r[7], r[8]]);
    let log = ss.getSheetByName(LOG.budgets.name);
    if (!log) {
      log = ss.insertSheet(LOG.budgets.name);
      log.getRange(1, 1, 1, LOG.budgets.headers.length).setValues([LOG.budgets.headers]).setFontWeight("bold");
      log.setFrozenRows(1);
      appendRows_(log, rows);
    }
    ss.deleteSheet(oldBudgets);
  }
}

// ---------- Helpers ----------

function columnValues_(sheet, col) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map((r) => r[0]);
}

function appendRows_(sheet, rows) {
  if (rows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

// "YYYY-MM-DD" (or a full ISO timestamp) -> Date at local midnight, or "" if empty.
function toDate_(str) {
  if (!str) return "";
  const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isoDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
