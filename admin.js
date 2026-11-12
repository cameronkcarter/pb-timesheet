// The Analytics tab (admins): analytics, and the data tools (Google Sheet
// sync, Excel backup). People and default expense rates are on the Staff
// tab.
import { Staff, People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses, Settings } from "./db.js";
import { formatCurrency, formatDate, showToast, esc } from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import { createAnalytics } from "./analytics.js";
import { createSheetSync } from "./sheet-sync.js";
import { expenseClientPaid } from "./expenses.js";
import { payRateOf } from "./rates.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let expenses = [];
let settings = {};
let staff = [];
let adminCheckDone = false;

wireLogout("logoutLink");

const analytics = createAnalytics({
  getData: () => ({ people, projects, tasks, timeEntries }),
});

if (sessionPersonId) {
  People.listen((d) => {
    people = d;
    if (!adminCheckDone) {
      adminCheckDone = true;
      const me = people.find((p) => p.id === sessionPersonId);
      if (!enforceAdmin(me)) return;
      renderNavUserName(me);
    }
    analytics.render();
    renderBackupRow();
    renderUsage();
  });
  Staff.listen((d) => { staff = d; renderUsage(); });
  Projects.listen((d) => { projects = d; analytics.render(); });
  Tasks.listen((d) => { tasks = d; analytics.render(); });
  Assignments.listen((d) => { assignments = d; });
  TimeEntries.listen((d) => { timeEntries = d; analytics.render(); renderUsage(); });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; renderSheetRow(); });
  Settings.listen((d) => { settings = d; renderSheetRow(); renderBackupRow(); });
  Expenses.listen((d) => { expenses = d; });
}

// ---------- Usage ----------
// Each active person's last visit (stamped by session.js) and when they last
// logged hours, longest-quiet first.
const usageBody = document.getElementById("usageBody");

// Firestore times arrive as Timestamps, or as plain {seconds} once copied
// into Test Mode; newer ones are ISO strings.
function toMs(t) {
  if (!t) return 0;
  if (typeof t === "string") return Date.parse(t) || 0;
  if (typeof t.toMillis === "function") return t.toMillis();
  return t.seconds ? t.seconds * 1000 : 0;
}

function ago(ms) {
  if (!ms) return '<span class="muted">Never</span>';
  const mins = Math.round((Date.now() - ms) / 60000);
  const when = new Date(ms);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let rel;
  if (mins < 60) rel = mins <= 1 ? "Just now" : `${mins} min ago`;
  else if (mins < 60 * 24) rel = `${Math.round(mins / 60)} hr ago`;
  else rel = `${Math.round(mins / 1440)} days ago`;
  if (rel === "1 days ago") rel = "Yesterday";
  const stale = mins > 7 * 1440;
  return `<span class="${stale ? "usage-stale" : ""}" title="${formatDate(when.toISOString().slice(0, 10))}, ${time}">${rel}</span>`;
}

function renderUsage() {
  if (!usageBody) return;
  const rows = people.filter((p) => !p.inactive).map((p) => {
    const seen = toMs(staff.find((x) => x.personId === p.id)?.lastSeenAt);
    const logged = timeEntries.filter((e) => e.personId === p.id).reduce((m, e) => Math.max(m, toMs(e.createdAt)), 0);
    return { name: p.name, seen, logged };
  }).sort((a, b) => a.seen - b.seen || a.name.localeCompare(b.name));
  usageBody.innerHTML = `<table class="usage-table"><thead><tr><th>Staff</th><th>Last Active</th><th>Last Logged Hours</th></tr></thead>
    <tbody>${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${ago(u.seen)}</td><td>${ago(u.logged)}</td></tr>`).join("")}</tbody></table>`;
}

function personById(id) {
  return people.find((p) => p.id === id);
}

// ---------- Backup ----------
// "Download Excel" uses what this page already loaded (no extra database
// reads): one readable tab per kind of record, with names instead of IDs,
// plus a last tab with an exact copy of every record for restoring.
const today = () => new Date().toISOString().slice(0, 10);

function recordBackup() {
  Settings.set({ lastBackup: new Date().toISOString(), lastBackupBy: sessionPersonId })
    .catch((err) => console.warn("Couldn't record the backup time:", err));
}

// The spreadsheet library is only loaded when someone exports.
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error("Couldn't load the spreadsheet tool. Check your connection."));
    document.head.appendChild(script);
  });
}

function excelSheets() {
  const name = (list, id) => list.find((x) => x.id === id)?.name || "";
  const personName = (id) => name(people, id);
  const projectName = (id) => name(projects, id);
  const taskName = (id) => name(tasks, id);
  const invoiceNumber = (id) => invoices.find((i) => i.id === id)?.invoiceNumber || "";
  const day = (v) => (v ? String(v.toDate ? v.toDate().toISOString() : v).slice(0, 10) : "");
  const yes = (v) => (v ? "Yes" : "");

  const hourStatus = (e) => e.paid ? "Client paid" : e.invoiced ? "Invoiced" : e.approved ? "Approved"
    : e.declined ? "Declined" : "Pending approval";
  const expenseStatus = (e) => expenseClientPaid(e, invoices) ? "Client paid" : e.invoiced ? "Invoiced" : e.approved ? "Approved"
    : e.declined ? "Declined" : "Pending approval";
  const byDate = (a, b) => (String(a.date || a.dueDate) < String(b.date || b.dueDate) ? -1 : 1);

  return {
    People: people.map((p) => ({
      Name: p.name, Email: p.email || "", "Pay rate": Number(p.rate || 0),
      "Bill rate": p.billRate == null ? "" : Number(p.billRate), Admin: yes(p.isAdmin), Active: p.inactive ? "No" : "Yes",
    })),
    Projects: projects.map((p) => ({
      Project: p.name, Client: p.client || "", "Project #": p.projectNumber || "", PM: personName(p.pmPersonId),
      Billing: p.internal ? "Internal" : "Staff bill rates", "Expenses budget": Number(p.expenseBudget || 0),
      Subconsultants: (p.subconsultants || []).map((s) => s.name + " (" + formatCurrency(s.budget) + ")").join("; "),
      "Bill to": [p.billToName, p.billToTitle, p.billToCompany, p.billToAddress1, p.billToAddress2, p.billToEmail].filter(Boolean).join(", "),
    })),
    Tasks: tasks.map((t) => ({
      Project: projectName(t.projectId), Task: t.name, Budget: Number(t.budget || 0),
      Start: t.startDate || "", End: t.endDate || "",
    })),
    "Assigned hours": assignments.map((a) => ({
      Project: projectName(a.projectId), Task: taskName(a.taskId), Person: personName(a.personId),
      "Assigned hours": Number(a.hours || 0),
    })),
    Hours: [...timeEntries].sort(byDate).map((e) => ({
      Date: e.date, Person: personName(e.personId), Project: projectName(e.projectId), Task: taskName(e.taskId),
      Hours: Number(e.hours || 0), "Pay rate": payRateOf(e, { projects, people }),
      "Billed rate": e.billRate == null ? "" : Number(e.billRate), Status: hourStatus(e),
      "Invoice #": invoiceNumber(e.invoiceId), Note: e.note || "", "Decline reason": e.declineReason || "",
    })),
    Expenses: [...expenses].sort(byDate).map((e) => {
      const project = projects.find((p) => p.id === e.projectId);
      return {
        Date: e.date, Project: projectName(e.projectId), Type: e.kind === "sub" ? "Sub expense" : "Expense",
        Category: e.category || "", Subconsultant: (project?.subconsultants || []).find((s) => s.id === e.subId)?.name || "",
        Description: e.description || "", "Paid by": e.kind === "sub" ? "" : personName(e.personId) || "Company",
        Quantity: e.quantity == null ? "" : Number(e.quantity), Rate: e.rate == null ? "" : Number(e.rate),
        Amount: Number(e.amount || 0), Status: expenseStatus(e), "Invoice #": invoiceNumber(e.invoiceId),
        "Paid to sub": e.kind === "sub" ? day(e.subPaidDate) : "",
      };
    }),
    Invoices: [...invoices].sort(byDate).map((i) => ({
      Date: i.date, "Invoice #": i.invoiceNumber, Project: i.projectName || projectName(i.projectId),
      "Billing period": i.periodLabel || "", Labor: Number(i.laborTotal ?? i.total ?? 0),
      Expenses: Number(i.expenseTotal || 0), Total: Number(i.total || 0),
      Status: i.void ? "Void" : i.paid ? "Paid" : "Outstanding", "Paid date": day(i.paidDate),
    })),
    "Subtasks & events": [...dueDates].sort(byDate).map((d) => ({
      Due: d.dueDate, Project: projectName(d.projectId), Task: taskName(d.taskId), Title: d.title,
      Type: (d.personIds || []).length ? "Subtask" : "Event",
      People: (d.personIds || []).map(personName).join(", "), Completed: day(d.completedDate) || yes(d.completed),
    })),
  };
}

document.getElementById("downloadExcel").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const XLSX = await loadXlsx();
    const book = XLSX.utils.book_new();
    Object.entries(excelSheets()).forEach(([title, rows]) => {
      const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "(none yet)": "" }]);
      // Columns wide enough for their longest value (capped).
      const cols = Object.keys(rows[0] || { "(none yet)": "" });
      sheet["!cols"] = cols.map((c) => ({ wch: Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)) + 2) }));
      XLSX.utils.book_append_sheet(book, sheet, title);
    });
    // Exact copy of every record (one row each), for restoring if ever needed.
    const raw = { people, projects, tasks, assignments, timeEntries, dueDates, invoices, expenses, staff };
    const asText = (v) => JSON.stringify(v, (k, x) => (x && typeof x.toDate === "function" ? x.toDate().toISOString() : x));
    const rawRows = Object.entries(raw).flatMap(([collection, list]) =>
      list.map((rec) => ({ Collection: collection, ID: rec.id, Data: asText(rec) })));
    const rawSheet = XLSX.utils.json_to_sheet(rawRows);
    rawSheet["!cols"] = [{ wch: 14 }, { wch: 24 }, { wch: 120 }];
    XLSX.utils.book_append_sheet(book, rawSheet, "Raw data (for restoring)");
    XLSX.writeFile(book, `Place Builders data ${today()}.xlsx`);
    recordBackup();
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Google Sheet ----------
// Invoices sync automatically; this shows where things stand and syncs on
// demand (e.g. after a failed sync).
const sheet = createSheetSync({
  getData: () => ({ invoices, timeEntries, tasks, people, projects }),
  onChange: () => renderSheetRow(),
});
const sheetRow = document.getElementById("sheetRow");
const sheetSyncStatus = document.getElementById("sheetSyncStatus");
const sheetSyncBtn = document.getElementById("sheetSyncBtn");
const sheetOpenLink = document.getElementById("sheetOpenLink");

function renderSheetRow() {
  const st = sheet.status();
  sheetRow.style.display = st.configured ? "" : "none";
  if (!st.configured) return;
  if (st.url) {
    sheetOpenLink.href = st.url;
    sheetOpenLink.style.display = "";
  }
  sheetSyncBtn.style.display = st.testMode ? "none" : "";
  sheetSyncBtn.disabled = st.syncing;
  sheetSyncBtn.textContent = st.syncing ? "Syncing…" : "Sync";
  const state = st.testMode ? "Off in Test Mode"
    : st.syncing ? "Syncing…"
      : st.error ? `<span style="color:var(--red);" title="${esc(st.error)}">Last sync failed</span>`
        : st.unsynced ? `<span style="color:#9a5a16; font-weight:600;">${st.unsynced} invoice${st.unsynced === 1 ? "" : "s"} not logged yet</span>`
          : `All ${st.total} invoices logged`;
  sheetSyncStatus.innerHTML = `${state} · Last synced ${whenText(settings.lastSheetSync)}`;
}

// "Oct 22, 3:14 PM", or "never".
function whenText(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const backupStatus = document.getElementById("backupStatus");
function renderBackupRow() {
  const who = settings.lastBackupBy && personById(settings.lastBackupBy)?.name;
  backupStatus.textContent = `Everything, as one file · Last downloaded ${whenText(settings.lastBackup)}${who ? ` by ${who}` : ""}`;
}

sheetSyncBtn.addEventListener("click", () => sheet.sync({ manual: true }));
renderSheetRow();
renderBackupRow();
