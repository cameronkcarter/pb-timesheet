// The Staff tab (admins): everyone's pay rate, default bill rate, email and
// admin access, then the default expense rates. A project can bill someone
// (or an expense) at its own rate, set in Setup.
import { People, Assignments, TimeEntries, Staff, Settings, normEmail } from "./db.js";
import { formatCurrency, showToast, closeOnBackdropClick, esc, confirmDialog } from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName, isTestMode } from "./session.js";
import { DEFAULT_BILL_RATE, personPayRate, personBillRate } from "./rates.js";
import { expenseCategories, applyExpenseSettings, categoryGroup } from "./expenses.js";

const sessionPersonId = requireSession();

let people = [];
let assignments = [];
let timeEntries = [];
let adminCheckDone = false;
let staff = [];
let staffLoaded = false;

let modalEditingPersonId = null;

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
    renderPeople();
    syncStaff();
  });
  Staff.listen((d) => { staff = d; staffLoaded = true; syncStaff(); });
  Assignments.listen((d) => { assignments = d; });
  TimeEntries.listen((d) => { timeEntries = d; });
  Settings.listen((d) => { applyExpenseSettings(d); renderCategories(); });
}

// ---------- People ----------
const peopleTbody = document.querySelector("#peopleTable tbody");
const peopleEmpty = document.getElementById("peopleEmpty");

const personModal = document.getElementById("personModal");
const personModalTitle = document.getElementById("personModalTitle");
const modalPersonName = document.getElementById("modalPersonName");
const modalPersonRate = document.getElementById("modalPersonRate");
const modalPersonBillRate = document.getElementById("modalPersonBillRate");
const modalPersonEmail = document.getElementById("modalPersonEmail");
const modalRemovePerson = document.getElementById("modalRemovePerson");

function renderPeople() {
  peopleEmpty.style.display = people.length ? "none" : "block";
  // Active people by pay rate (highest first), then deactivated people.
  const byPay = [...people].sort((a, b) =>
    (!!a.inactive - !!b.inactive) || personPayRate(b) - personPayRate(a) || a.name.localeCompare(b.name));
  peopleTbody.innerHTML = byPay.map((p) => `
    <tr class="${p.inactive ? "inactive-row" : ""}" data-id="${p.id}">
      <td class="staff-name">${esc(p.name)}${p.inactive ? ' <span class="pill">Inactive</span>' : ""}</td>
      <td class="staff-email ${p.email ? "" : "missing"}">${p.email ? esc(p.email) : "No email"}</td>
      <td class="num">${formatCurrency(personPayRate(p))}/hr</td>
      <td class="num">${formatCurrency(personBillRate(p))}/hr</td>
      <td class="c-check"><input type="checkbox" class="staff-admin" ${p.isAdmin ? "checked" : ""} ${p.inactive || p.id === sessionPersonId ? "disabled" : ""}
        aria-label="${esc(p.name)} is an admin" title="${p.id === sessionPersonId ? "You can't remove your own admin access" : "Admins see Invoices, Setup, Staff and Analytics"}" /></td>
      <td class="c-actions">${p.inactive
        ? `<button type="button" class="small secondary" data-action="reactivate-person">Reactivate</button>`
        : `<button type="button" class="small secondary" data-action="edit-person">Edit</button>`}</td>
    </tr>`).join("");
}

peopleTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  if (btn.dataset.action === "edit-person") openPersonModal(personById(id));
  if (btn.dataset.action === "reactivate-person") {
    try { await People.update(id, { inactive: false }); showToast("Reactivated."); } catch (err) { showToast("Error: " + err.message); }
  }
});

// The Admin box saves right away.
peopleTbody.addEventListener("change", async (e) => {
  if (!e.target.matches(".staff-admin")) return;
  const person = personById(e.target.closest("tr").dataset.id);
  const isAdmin = e.target.checked;
  try {
    await People.update(person.id, { isAdmin });
    showToast(`${person.name} ${isAdmin ? "is now an admin" : "is no longer an admin"}.`);
  } catch (err) {
    e.target.checked = !isAdmin;
    showToast("Error: " + err.message);
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
  if (!person) return false;
  if (id === sessionPersonId) { showToast("You can't remove yourself."); return false; }
  const hasHistory = timeEntries.some((e) => e.personId === id) || assignments.some((a) => a.personId === id);
  try {
    if (hasHistory) {
      if (!(await confirmDialog(`${person.name} has logged hours or task assignments, so they can't be deleted without losing history. Deactivated, they can't log in or be assigned work, but their past hours stay on record. You can reactivate them later.`, { title: `Deactivate ${person.name}?`, confirmText: "Deactivate" }))) return false;
      await People.update(id, { inactive: true });
      showToast(`${person.name} deactivated.`);
    } else {
      if (!(await confirmDialog("This can't be undone.", { title: `Remove ${person.name}?`, confirmText: "Remove", danger: true }))) return false;
      await People.remove(id);
      showToast(`${person.name} removed.`);
    }
    return true;
  } catch (err) {
    showToast("Error: " + err.message);
    return false;
  }
}

function openPersonModal(person) {
  modalEditingPersonId = person ? person.id : null;
  personModalTitle.textContent = person ? "Edit Staff" : "Add Staff";
  modalPersonName.value = person ? person.name : "";
  modalPersonRate.value = person ? person.rate : "";
  // New people start at the firm's standard bill rate.
  modalPersonBillRate.value = person ? (person.billRate ?? "") : DEFAULT_BILL_RATE;
  modalPersonEmail.value = person ? (person.email || "") : "";
  modalRemovePerson.hidden = !person || person.id === sessionPersonId;
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
modalRemovePerson.addEventListener("click", async () => {
  if (await removePerson(modalEditingPersonId)) closePersonModal();
});

document.getElementById("modalSavePerson").addEventListener("click", async () => {
  const name = modalPersonName.value.trim();
  const rate = Number(modalPersonRate.value);
  const billRate = modalPersonBillRate.value === "" ? null : Number(modalPersonBillRate.value);
  const email = normEmail(modalPersonEmail.value) || null;
  if (!name || !rate) return showToast("Enter a name and pay rate.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showToast("Enter a valid email.");
  if (email && people.some((p) => p.id !== modalEditingPersonId && normEmail(p.email) === email)) {
    return showToast("Someone else already has that email.");
  }
  if (billRate != null && !(billRate >= 0)) return showToast("Enter a valid bill rate.");
  try {
    if (modalEditingPersonId) {
      await People.update(modalEditingPersonId, { name, email, rate, billRate, password: null });
      showToast("Person updated.");
    } else {
      await People.add({ name, email, rate, billRate, isAdmin: false });
      showToast("Staff added.");
    }
    closePersonModal();
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

function personById(id) {
  return people.find((p) => p.id === id);
}

// ---------- Default expense rates ----------
// The categories staff pick from when recording an expense (see expenses.js).
// Invoices show a category's group (Mileage and Meals both show as "Travel");
// a category with no group (Materials) shows as itself. Each has an optional
// default rate per unit (e.g. $0.70 / mile — entered as a quantity; no unit
// means an amount) and whether to prompt for a receipt. Each change saves
// the whole list. Past expenses keep the category they were recorded with.
//
// One row per category. Its Group box lists the groups already in use, so
// putting rows together is picking the same group; typing a new name starts
// one; clearing it leaves the category on its own. Rows sharing a group sit
// together in a tinted band.
const categoryRows = document.getElementById("categoryRows");
let adding = false; // a blank row from "+ Add Category", until it's named

// A category's group, or "" when it has none (a group named after the
// category itself, from older settings, counts as none).
function groupOf(c) {
  const group = categoryGroup(c.name);
  return group && group !== c.name ? group : "";
}

// Grouped categories first (by group), then the ones on their own.
function sortedCategories() {
  const list = expenseCategories().map((c) => ({ ...c, group: groupOf(c) }));
  return list.sort((a, b) => (!a.group - !b.group) || a.group.localeCompare(b.group) || 0);
}

function renderCategories() {
  if (categoryRows.contains(document.activeElement)) return;
  const list = sortedCategories();
  if (adding) list.push({ name: "", group: "", unit: "", rate: null, receipt: true, isNew: true });
  const groups = [...new Set(list.map((c) => c.group).filter(Boolean))].sort();
  let band = 0;
  categoryRows.innerHTML = `<datalist id="catGroups">${groups.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>`
    + list.map((c, i) => {
      // A new band starts with each group (each ungrouped row is its own).
      if (i > 0 && (!c.group || c.group !== list[i - 1].group)) band += 1;
      const first = !c.group || i === 0 || list[i - 1].group !== c.group;
      const last = !c.group || i === list.length - 1 || list[i + 1].group !== c.group;
      return `<div class="cat-grid cat-row ${c.group ? "grouped" : ""} ${first ? "first" : ""} ${last ? "last" : ""}" data-band="${band}">
        <input type="text" class="cat-group" list="catGroups" value="${esc(c.group)}" placeholder="No group" aria-label="Group" />
        <input type="text" class="cat-name" value="${esc(c.name)}" placeholder="Category name" aria-label="Category" ${c.isNew ? "data-new" : ""} />
        <div class="money-input ${c.unit ? "" : "disabled"}"><span>$</span><input type="number" class="cat-rate" min="0" step="0.01"
          value="${c.unit && c.rate != null ? c.rate : ""}" ${c.unit ? "" : "disabled"} aria-label="Default rate" /></div>
        <div class="cat-per"><span>/</span><input type="text" class="cat-unit" value="${esc(c.unit || "")}" placeholder="none" aria-label="Unit" /></div>
        <label class="cat-receipt"><input type="checkbox" class="cat-receipt-box" ${c.receipt ? "checked" : ""} aria-label="Ask for a receipt" /></label>
        <button type="button" class="icon-btn cat-remove" title="Remove" aria-label="Remove">&times;</button>
      </div>`;
    }).join("")
    + '<button type="button" class="link-btn cat-add">+ Add Category</button>';
}

function readCategories() {
  return [...categoryRows.querySelectorAll(".cat-row")].map((row) => {
    const unit = row.querySelector(".cat-unit").value.trim().toLowerCase();
    const rate = Number(row.querySelector(".cat-rate").value);
    return {
      name: row.querySelector(".cat-name").value.trim(),
      group: row.querySelector(".cat-group").value.trim(),
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
  if (list.length === named.length) adding = false;
  try {
    // A group with the category's own name is the same as no group.
    await Settings.set({ expenseCategories: named.map((c) => ({ ...c, group: c.group === c.name ? "" : c.group })) });
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
  // A new row waits for its name before saving.
  if (e.target.closest(".cat-row")?.querySelector("[data-new]") && !e.target.closest(".cat-row").querySelector(".cat-name").value.trim()) return;
  saveCategories(list);
});

categoryRows.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) e.target.blur(); });

// Saving re-renders once focus leaves the list (rows re-sort into groups).
categoryRows.addEventListener("focusout", () => setTimeout(() => {
  if (!categoryRows.contains(document.activeElement)) renderCategories();
}, 0));

categoryRows.addEventListener("click", (e) => {
  if (e.target.closest(".cat-add")) {
    adding = true;
    renderCategories();
    categoryRows.querySelector(".cat-name[data-new]").focus();
    return;
  }
  const btn = e.target.closest(".cat-remove");
  if (!btn) return;
  const row = btn.closest(".cat-row");
  const name = row.querySelector(".cat-name").value.trim();
  row.remove();
  if (!name) { adding = false; renderCategories(); return; }
  saveCategories(readCategories(), `Removed "${name}". Past expenses keep it.`);
});
