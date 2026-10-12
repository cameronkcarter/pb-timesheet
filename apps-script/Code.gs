// ---------------------------------------------------------------------------
// Place Builders Timesheet -> Google Sheet invoice log
//
// This script lives inside the Google Sheet (Extensions > Apps Script), NOT on
// the website. The website POSTs invoice data to it whenever an invoice is
// generated or marked paid, and it appends rows to the sheet.
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
// If you edit this script later, use Deploy > Manage deployments > edit (pencil)
// > Version: New version, so the URL stays the same.
//
// Tabs:
//   Invoices       one row per invoice (paper trail; never rewritten except Paid Date)
//   Invoice Lines  one row per invoice x task x person (paper trail; append-only)
//   Task Budgets   current task budgets from the site + live invoiced/remaining formulas
//   Summary        live rollups by project, person, and task (formulas only)
// ---------------------------------------------------------------------------

const TABS = {
  invoices: {
    name: "Invoices",
    headers: ["Invoice Date", "Invoice #", "Project", "Billing Period", "Total", "Paid Date", "Added to Sheet", "Invoice ID"],
    formats: { A: "m/d/yyyy", E: "$#,##0.00", F: "m/d/yyyy", G: "m/d/yyyy h:mm am/pm" },
  },
  lines: {
    name: "Invoice Lines",
    headers: ["Invoice Date", "Invoice #", "Billing Period", "Project", "Task", "Person", "Hours", "Rate", "Amount",
      "Added to Sheet", "Note", "Invoice ID", "Project ID", "Task ID", "Person ID", "Line Key"],
    formats: { A: "m/d/yyyy", G: "0.00", H: "$#,##0.00", I: "$#,##0.00", J: "m/d/yyyy h:mm am/pm" },
  },
  budgets: {
    name: "Task Budgets",
    headers: ["Project", "Task", "Budget", "Invoiced to Date", "Hours Invoiced", "Remaining", "% Invoiced", "Project ID", "Task ID"],
    formats: { C: "$#,##0.00", D: "$#,##0.00", E: "0.00", F: "$#,##0.00", G: "0%" },
  },
};
const SUMMARY_TAB = "Summary";

// ---------- Entry points ----------

function setup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty("SYNC_SECRET");
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, "");
    props.setProperty("SYNC_SECRET", secret);
  }
  ensureSheets_(SpreadsheetApp.getActiveSpreadsheet());
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
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- Invoices + lines (append-only) ----------

function upsertInvoices_(ss, invoices, extraLines) {
  const now = new Date();
  const invSheet = ss.getSheetByName(TABS.invoices.name);
  const lineSheet = ss.getSheetByName(TABS.lines.name);

  // Invoice ID -> sheet row number, for dedup and Paid Date updates.
  const invIdCol = TABS.invoices.headers.indexOf("Invoice ID") + 1;
  const paidCol = TABS.invoices.headers.indexOf("Paid Date") + 1;
  const existingInv = {};
  columnValues_(invSheet, invIdCol).forEach((id, i) => { if (id) existingInv[id] = i + 2; });

  const lineKeyCol = TABS.lines.headers.indexOf("Line Key") + 1;
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

// ---------- Task budgets (rewritten every sync; formulas pull from Invoice Lines) ----------

function writeBudgets_(ss, budgets) {
  const sheet = ss.getSheetByName(TABS.budgets.name);
  const width = TABS.budgets.headers.length;
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, width).clearContent();
  if (budgets.length === 0) return 0;

  const sorted = budgets.slice().sort((a, b) =>
    a.projectName.localeCompare(b.projectName) || a.taskName.localeCompare(b.taskName));
  const rows = sorted.map((b, i) => {
    const r = i + 2;
    return [
      b.projectName, b.taskName, b.budget,
      `=SUMIFS('Invoice Lines'!I:I,'Invoice Lines'!N:N,I${r})`,
      `=SUMIFS('Invoice Lines'!G:G,'Invoice Lines'!N:N,I${r})`,
      `=C${r}-D${r}`,
      `=IF(C${r}>0,D${r}/C${r},"")`,
      b.projectId, b.taskId,
    ];
  });
  sheet.getRange(2, 1, rows.length, width).setValues(rows);
  return rows.length;
}

// ---------- Sheet scaffolding ----------

function ensureSheets_(ss) {
  Object.keys(TABS).forEach((key) => {
    const tab = TABS[key];
    let sheet = ss.getSheetByName(tab.name);
    if (!sheet) sheet = ss.insertSheet(tab.name);
    if (sheet.getRange(1, 1).getValue() !== tab.headers[0]) {
      sheet.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]).setFontWeight("bold").setBackground("#5c2670").setFontColor("#ffffff");
      sheet.setFrozenRows(1);
      Object.keys(tab.formats).forEach((col) => sheet.getRange(`${col}2:${col}`).setNumberFormat(tab.formats[col]));
    }
  });

  let summary = ss.getSheetByName(SUMMARY_TAB);
  if (!summary) summary = ss.insertSheet(SUMMARY_TAB);
  if (summary.getRange("A1").getValue() === "") buildSummary_(summary);

  // Drop the blank default tab a brand-new spreadsheet comes with.
  const blank = ss.getSheetByName("Sheet1");
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

function buildSummary_(sheet) {
  const title = (cell, text) => sheet.getRange(cell).setValue(text).setFontWeight("bold").setFontSize(12);

  title("A1", "By Project");
  sheet.getRange("A2").setFormula(
    "=QUERY('Task Budgets'!A:G,\"select A, sum(C), sum(D), sum(E), sum(F) where A is not null group by A order by A " +
    "label A 'Project', sum(C) 'Budget', sum(D) 'Invoiced', sum(E) 'Hours', sum(F) 'Remaining'\",1)");
  ["B", "C", "E"].forEach((c) => sheet.getRange(`${c}3:${c}`).setNumberFormat("$#,##0.00"));
  sheet.getRange("D3:D").setNumberFormat("0.00");

  title("G1", "By Person & Project");
  sheet.getRange("G2").setFormula(
    "=QUERY('Invoice Lines'!A:P,\"select D, F, sum(G), sum(I) where F is not null group by D, F order by D, F " +
    "label D 'Project', F 'Person', sum(G) 'Hours', sum(I) 'Pay'\",1)");
  sheet.getRange("I3:I").setNumberFormat("0.00");
  sheet.getRange("J3:J").setNumberFormat("$#,##0.00");

  title("L1", "By Person, Project & Task");
  sheet.getRange("L2").setFormula(
    "=QUERY('Invoice Lines'!A:P,\"select D, E, F, sum(G), sum(I) where F is not null group by D, E, F order by D, E, F " +
    "label D 'Project', E 'Task', F 'Person', sum(G) 'Hours', sum(I) 'Pay'\",1)");
  sheet.getRange("O3:O").setNumberFormat("0.00");
  sheet.getRange("P3:P").setNumberFormat("$#,##0.00");

  sheet.getRange("A2:P2").setFontWeight("bold");
  sheet.setFrozenRows(2);
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
