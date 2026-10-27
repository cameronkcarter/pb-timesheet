import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Staff, Expenses, Settings, normEmail } from "./db.js";
import { formatCurrency, showToast, closeOnBackdropClick, esc, confirmDialog } from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName, isTestMode } from "./session.js";
import { createAnalytics } from "./analytics.js";
import { createSheetSync } from "./sheet-sync.js";
import { DEFAULT_BILL_RATE, personPayRate, personBillRate } from "./rates.js";
import { expenseCategories, applyExpenseSettings } from "./expenses.js";

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
let adminCheckDone = false;
let staff = [];
let staffLoaded = false;

let modalEditingPersonId = null;

wireLogout("logoutLink");

// Approvals moved to the Dashboard (so project managers who aren't admins
// can approve too); Admin has analytics instead (see analytics.js).
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
    renderPeople();
    analytics.render();
    syncStaff();
  });
  Staff.listen((d) => { staff = d; staffLoaded = true; syncStaff(); });
  Projects.listen((d) => { projects = d; analytics.render(); });
  Tasks.listen((d) => { tasks = d; analytics.render(); });
  Assignments.listen((d) => { assignments = d; });
  TimeEntries.listen((d) => { timeEntries = d; analytics.render(); });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; renderSheetRow(); });
  Settings.listen((d) => { settings = d; renderSheetRow(); renderBackupRow(); renderCategories(); });
  Expenses.listen((d) => { expenses = d; });
}

// ---------- Expense categories ----------
// The categories staff pick from when recording an expense (see expenses.js):
// name, an optional default rate per unit (e.g. $0.70 / mile — entered as a
// quantity; no unit means an amount), and whether to prompt for a receipt. Each change saves the whole list; a new row saves once it has a
// name. Past expenses keep the category they were recorded with.
const categoryRows = document.getElementById("categoryRows");
let unsavedCategory = false; // a just-added row with no name yet

function renderCategories() {
  applyExpenseSettings(settings);
  if (categoryRows.contains(document.activeElement)) return;
  const list = expenseCategories();
  const rowHtml = (c) => `<div class="cat-grid cat-row">
      <input type="text" class="cat-name" value="${esc(c.name)}" placeholder="Category name" aria-label="Name" />
      <div class="money-input ${c.unit ? "" : "disabled"}"><span>$</span><input type="number" class="cat-rate" min="0" step="0.01"
        value="${c.unit && c.rate != null ? c.rate : ""}" ${c.unit ? "" : "disabled"} aria-label="Default rate" /></div>
      <div class="cat-per"><span>/</span><input type="text" class="cat-unit" value="${esc(c.unit || "")}" placeholder="none" aria-label="Unit" /></div>
      <label class="cat-receipt"><input type="checkbox" class="cat-receipt-box" ${c.receipt ? "checked" : ""} aria-label="Ask for a receipt" /></label>
      <button type="button" class="icon-btn cat-remove" title="Remove category" aria-label="Remove category">&times;</button>
    </div>`;
  categoryRows.innerHTML = list.map(rowHtml).join("")
    + (unsavedCategory ? rowHtml({ name: "", unit: "", rate: null, receipt: true }) : "");
}

function readCategories() {
  return [...categoryRows.querySelectorAll(".cat-row")].map((row) => {
    const unit = row.querySelector(".cat-unit").value.trim().toLowerCase();
    const rate = Number(row.querySelector(".cat-rate").value);
    return {
      name: row.querySelector(".cat-name").value.trim(),
      unit,
      rate: unit && rate > 0 ? rate : null,
      receipt: row.querySelector(".cat-receipt-box").checked,
    };
  });
}

async function saveCategories(list, message = "Saved.") {
  const named = list.filter((c) => c.name);
  const names = named.map((c) => c.name.toLowerCase());
  if (names.some((n, i) => names.indexOf(n) !== i)) return showToast("Two categories have the same name.");
  if (!named.length) return showToast("Keep at least one category.");
  unsavedCategory = list.length > named.length;
  try {
    await Settings.set({ expenseCategories: named });
    showToast(message);
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// Typing a unit turns the rate box on (clearing it turns it off).
categoryRows.addEventListener("input", (e) => {
  if (!e.target.classList.contains("cat-unit")) return;
  const row = e.target.closest(".cat-row");
  const on = !!e.target.value.trim();
  row.querySelector(".cat-rate").disabled = !on;
  row.querySelector(".money-input").classList.toggle("disabled", !on);
});

categoryRows.addEventListener("change", (e) => {
  const list = readCategories();
  if (list.some((c) => c.unit && !c.rate) && e.target.classList.contains("cat-rate")) return showToast("Enter a default rate above $0.");
  saveCategories(list);
});

categoryRows.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) e.target.blur(); });

// Saving re-renders once focus leaves the list.
categoryRows.addEventListener("focusout", () => setTimeout(() => { if (!categoryRows.contains(document.activeElement)) renderCategories(); }, 0));

categoryRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".cat-remove");
  if (!btn) return;
  const row = btn.closest(".cat-row");
  const name = row.querySelector(".cat-name").value.trim();
  row.remove();
  if (!name) { unsavedCategory = false; renderCategories(); return; }
  saveCategories(readCategories(), `Removed "${name}". Past expenses keep it.`);
});

document.getElementById("addCategory").addEventListener("click", () => {
  unsavedCategory = true;
  renderCategories();
  categoryRows.querySelector(".cat-row:last-child .cat-name").focus();
});

// ---------- People (table + modal) ----------
const peopleTbody = document.querySelector("#peopleTable tbody");
const peopleEmpty = document.getElementById("peopleEmpty");

const personModal = document.getElementById("personModal");
const personModalTitle = document.getElementById("personModalTitle");
const modalPersonName = document.getElementById("modalPersonName");
const modalPersonRate = document.getElementById("modalPersonRate");
const modalPersonBillRate = document.getElementById("modalPersonBillRate");
const modalPersonAdmin = document.getElementById("modalPersonAdmin");
const modalPersonEmail = document.getElementById("modalPersonEmail");

function renderPeople() {
  if (people.length === 0) {
    peopleTbody.innerHTML = "";
    peopleEmpty.style.display = "block";
    return;
  }
  peopleEmpty.style.display = "none";
  // Active people by pay rate (highest first), then deactivated people.
  const byPay = [...people].sort((a, b) =>
    (!!a.inactive - !!b.inactive) || personPayRate(b) - personPayRate(a) || a.name.localeCompare(b.name));
  peopleTbody.innerHTML = byPay.map((p, i) => `
    <tr class="${i % 2 === 1 ? "stripe-row" : ""} ${p.inactive ? "inactive-row" : ""}">
      <td>${esc(p.name)}${p.isAdmin ? ' <span class="pill orange">Admin</span>' : ""}${p.inactive ? ' <span class="pill">Inactive</span>' : ""}
        <div class="person-email ${p.email ? "" : "missing"}">${p.email ? esc(p.email) : "No email"}</div></td>
      <td>${formatCurrency(personPayRate(p))}/hr</td>
      <td>${formatCurrency(personBillRate(p))}/hr${p.billRate == null ? ' <span class="empty" style="padding:0;">(not set — using pay rate)</span>' : ""}</td>
      <td><div class="row-actions" style="justify-content:flex-end;">
        <button class="small secondary" data-action="edit-person" data-id="${p.id}">Edit</button>
        ${p.inactive
          ? `<button class="small secondary" data-action="reactivate-person" data-id="${p.id}">Reactivate</button>`
          : `<button class="danger small" data-action="remove-person" data-id="${p.id}">Remove</button>`}
      </div></td>
    </tr>`).join("");
}

peopleTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === "edit-person") {
    const p = people.find((pr) => pr.id === id);
    openPersonModal(p);
  }
  if (action === "remove-person") await removePerson(id);
  if (action === "reactivate-person") {
    try { await People.update(id, { inactive: false }); showToast("Reactivated."); } catch (err) { showToast("Error: " + err.message); }
  }
});

// Keep the Google sign-in list (Staff) matching People: one entry per active
// person with an email, carrying their admin flag. Runs whenever either
// changes, so adding an email, toggling admin or deactivating someone
// updates who can sign in.
let syncing = false;
async function syncStaff() {
  if (!staffLoaded || syncing || isTestMode()) return;
  const me = people.find((p) => p.id === sessionPersonId);
  if (!me || !me.isAdmin) return;
  const want = new Map(people
    .filter((p) => !p.inactive && normEmail(p.email))
    .map((p) => [normEmail(p.email), { personId: p.id, isAdmin: !!p.isAdmin }]));
  const ops = [];
  want.forEach((data, email) => {
    const cur = staff.find((s) => s.id === email);
    if (!cur || cur.personId !== data.personId || !!cur.isAdmin !== data.isAdmin) ops.push(Staff.set(email, data));
  });
  staff.filter((s) => !want.has(s.id)).forEach((s) => ops.push(Staff.remove(s.id)));
  people.filter((p) => p.password).forEach((p) => ops.push(People.update(p.id, { password: null })));
  if (!ops.length) return;
  syncing = true;
  try { await Promise.all(ops); } catch (err) { showToast("Error updating sign-in list: " + err.message); }
  syncing = false;
}

// People with logged hours or task assignments can't be deleted without
// breaking history (timesheets, invoices), so they're deactivated instead:
// hidden from login and from pickers, but kept on past records.
async function removePerson(id) {
  const person = personById(id);
  if (!person) return;
  if (id === sessionPersonId) return showToast("You can't remove yourself.");
  const hasHistory = timeEntries.some((e) => e.personId === id) || assignments.some((a) => a.personId === id);
  try {
    if (hasHistory) {
      if (!(await confirmDialog(`${person.name} has logged hours or task assignments, so they can't be deleted without losing history. Deactivated, they can't log in or be assigned work, but their past hours stay on record. You can reactivate them later.`, { title: `Deactivate ${person.name}?`, confirmText: "Deactivate" }))) return;
      await People.update(id, { inactive: true });
      showToast(`${person.name} deactivated.`);
    } else {
      if (!(await confirmDialog("This can't be undone.", { title: `Remove ${person.name}?`, confirmText: "Remove", danger: true }))) return;
      await People.remove(id);
      showToast(`${person.name} removed.`);
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

function openPersonModal(person) {
  modalEditingPersonId = person ? person.id : null;
  personModalTitle.textContent = person ? "Edit person" : "New person";
  modalPersonName.value = person ? person.name : "";
  modalPersonRate.value = person ? person.rate : "";
  // New people start at the firm's standard bill rate.
  modalPersonBillRate.value = person ? (person.billRate ?? "") : DEFAULT_BILL_RATE;
  modalPersonAdmin.checked = person ? !!person.isAdmin : false;
  modalPersonEmail.value = person ? (person.email || "") : "";
  personModal.style.display = "flex";
  modalPersonName.focus();
}

function closePersonModal() {
  personModal.style.display = "none";
}

document.getElementById("openAddPerson").addEventListener("click", () => openPersonModal(null));
document.getElementById("modalCancelPerson").addEventListener("click", closePersonModal);
document.getElementById("modalClosePerson").addEventListener("click", closePersonModal);
closeOnBackdropClick(personModal, closePersonModal);

document.getElementById("modalSavePerson").addEventListener("click", async () => {
  const name = modalPersonName.value.trim();
  const rate = Number(modalPersonRate.value);
  const billRate = modalPersonBillRate.value === "" ? null : Number(modalPersonBillRate.value);
  const isAdmin = modalPersonAdmin.checked;
  const email = normEmail(modalPersonEmail.value) || null;
  if (!name || !rate) return showToast("Enter a name and pay rate.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showToast("Enter a valid email.");
  if (email && people.some((p) => p.id !== modalEditingPersonId && normEmail(p.email) === email)) {
    return showToast("Someone else already has that email.");
  }
  if (billRate != null && !(billRate >= 0)) return showToast("Enter a valid bill rate.");
  try {
    if (modalEditingPersonId) {
      await People.update(modalEditingPersonId, { name, email, rate, billRate, isAdmin, password: null });
      showToast("Person updated.");
    } else {
      await People.add({ name, email, rate, billRate, isAdmin });
      showToast("Person added.");
    }
    closePersonModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

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
  const expenseStatus = (e) => e.reimbursed ? "Reimbursed" : e.invoiced ? "Invoiced" : e.approved ? "Approved"
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
      "Bill to": [p.billToName, p.billToCompany, p.billToAddress1, p.billToAddress2].filter(Boolean).join(", "),
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
      Hours: Number(e.hours || 0), "Pay rate": e.rate == null ? "" : Number(e.rate),
      "Billed rate": e.billRate == null ? "" : Number(e.billRate), Status: hourStatus(e),
      "Invoice #": invoiceNumber(e.invoiceId), Note: e.note || "", "Decline reason": e.declineReason || "",
    })),
    Expenses: [...expenses].sort(byDate).map((e) => {
      const project = projects.find((p) => p.id === e.projectId);
      return {
        Date: e.date, Project: projectName(e.projectId), Type: e.kind === "sub" ? "Subconsultant invoice" : "Expense",
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
