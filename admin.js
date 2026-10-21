import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Staff, Expenses, normEmail } from "./db.js";
import { formatCurrency, showToast, closeOnBackdropClick, esc } from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName, isTestMode } from "./session.js";
import { createApprovals } from "./approvals.js";
import { createSheetSync } from "./sheet-sync.js";
import { DEFAULT_BILL_RATE, personPayRate, personBillRate } from "./rates.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let dueDates = [];
let invoices = [];
let expenses = [];
let adminCheckDone = false;
let staff = [];
let staffLoaded = false;

let modalEditingPersonId = null;

wireLogout("logoutLink");

// Pending approval: hours on the projects you manage (see approvals.js).
const approvals = createApprovals({
  getData: () => ({ people, projects, tasks, assignments, timeEntries, expenses }),
  sessionPersonId,
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
    approvals.render();
    syncStaff();
  });
  Staff.listen((d) => { staff = d; staffLoaded = true; syncStaff(); });
  Projects.listen((d) => { projects = d; approvals.render(); });
  Tasks.listen((d) => { tasks = d; approvals.render(); });
  Assignments.listen((d) => { assignments = d; approvals.render(); });
  TimeEntries.listen((d) => { timeEntries = d; approvals.render(); });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; renderSheetRow(); });
  Expenses.listen((d) => { expenses = d; approvals.render(); });
}

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
      if (!confirm(`${person.name} has logged hours or task assignments, so they can't be deleted without losing history.\n\nDeactivate them instead? They won't be able to log in or be assigned work, but their past hours stay on record. You can reactivate them later.`)) return;
      await People.update(id, { inactive: true });
      showToast(`${person.name} deactivated.`);
    } else {
      if (!confirm(`Permanently remove ${person.name}?`)) return;
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
// Downloads everything (from what this page already loaded, so no extra
// database reads) as one JSON file to keep somewhere safe.
document.getElementById("downloadBackup").addEventListener("click", () => {
  const data = { exportedAt: new Date().toISOString(), people, projects, tasks, assignments, timeEntries, dueDates, invoices, expenses, staff };
  // Firestore timestamps become ISO dates.
  const json = JSON.stringify(data, (k, v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : v), 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `place-builders-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
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
  sheetSyncStatus.innerHTML = st.testMode ? "Off in Test Mode"
    : st.syncing ? "Syncing…"
      : st.error ? `<span style="color:var(--red);" title="${esc(st.error)}">Last sync failed</span>`
        : st.unsynced ? `<span style="color:#9a5a16; font-weight:600;">${st.unsynced} invoice${st.unsynced === 1 ? "" : "s"} not logged yet</span>`
          : `All ${st.total} invoices logged`;
}

sheetSyncBtn.addEventListener("click", () => sheet.sync({ manual: true }));
renderSheetRow();
