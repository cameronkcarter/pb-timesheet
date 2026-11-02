// The Project setup tab (admins): a project's details, who it invoices, and
// its own bill and expense rates; then the defaults for every project
// (expense categories). Tasks and budgets are on the Projects tab.
import { People, Projects, Assignments, Settings } from "./db.js";
import {
  formatCurrency, showToast, esc, confirmDialog, PROJECT_COLOR_CHOICES, projectColor, projectShortName, sortProjects,
} from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import { personBillRate, isInternal } from "./rates.js";
import { expenseCategories, applyExpenseSettings } from "./expenses.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let assignments = [];
let settings = {};
let adminCheckDone = false;
let selectedId = new URLSearchParams(location.search).get("project");
let shownId = null;      // the project the form was filled from
let saved = "";          // the form as last filled, to tell when it's changed
let scrolledToHash = false;

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
    renderProject();
  });
  Projects.listen((d) => { projects = d; renderProject(); });
  Assignments.listen((d) => { assignments = d; renderProject(); });
  Settings.listen((d) => { settings = d; renderCategories(); renderProject(); });
}

// ---------- One project ----------
const $ = (id) => document.getElementById(id);
const picker = $("setupProject");
const cards = $("setupProjectCards");
const fields = {
  name: $("setupName"), client: $("setupClient"), projectNumber: $("setupNumber"), shortName: $("setupShortName"),
  pmPersonId: $("setupPm"), billToName: $("setupBillToName"), billToCompany: $("setupBillToCompany"),
  billToAddress1: $("setupBillToAddress1"), billToAddress2: $("setupBillToAddress2"), billToEmail: $("setupBillToEmail"),
};
const billRatesEl = $("setupBillRates");
const expenseRatesEl = $("setupExpenseRates");
const saveBtn = $("setupSave");
const revertBtn = $("setupRevert");
const dirtyNote = $("setupDirty");
let color = null;   // picked swatch; null keeps the automatic color
let type = "rates"; // "rates" or "internal"
let extraPeople = []; // added with "Add someone" before saving

const project = () => projects.find((p) => p.id === shownId);

function renderPicker() {
  const list = sortProjects([...projects]);
  if (!list.some((p) => p.id === selectedId)) selectedId = list[0]?.id || null;
  picker.innerHTML = list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  picker.value = selectedId || "";
  $("setupTasksLink").href = `projects.html${selectedId ? `?project=${selectedId}` : ""}`;
}

function renderSwatches() {
  const current = color || (shownId ? projectColor(shownId) : null);
  $("setupColor").innerHTML = PROJECT_COLOR_CHOICES.map((c) => `<button type="button" class="swatch ${c === current ? "on" : ""}"
    style="--c:${c};" data-color="${c}" role="radio" aria-checked="${c === current}" aria-label="Color ${c}"></button>`).join("");
}

function renderType() {
  $("setupType").querySelectorAll("button").forEach((b) => {
    const on = b.dataset.value === type;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  const internal = type === "internal";
  $("setupBilling").hidden = internal;
  $("rates").hidden = internal;
}

// People who bill to this project: assigned to a task, its PM, anyone with a
// rate set here, and anyone just added.
function billPeople(p) {
  const ids = new Set([
    ...assignments.filter((a) => a.projectId === p.id).map((a) => a.personId),
    p.pmPersonId, ...Object.keys(p.billRates || {}), ...extraPeople,
  ]);
  return people.filter((x) => ids.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
}

function rateRow(key, label, usual, value, unit = "hr") {
  return `<div class="setup-rate-row" data-key="${esc(key)}">
    <span class="setup-rate-name">${esc(label)}</span>
    <span class="setup-rate-usual">usually ${formatCurrency(usual)}/${esc(unit)}</span>
    <div class="money-input"><span>$</span><input type="number" min="0" step="0.01" value="${value ?? ""}"
      placeholder="usual" aria-label="${esc(label)} rate on this project" /><span>/${esc(unit)}</span></div>
  </div>`;
}

function renderRates(p) {
  const list = billPeople(p);
  const others = people.filter((x) => !x.inactive && !list.some((y) => y.id === x.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  billRatesEl.innerHTML = list.map((x) => rateRow(x.id, x.name, personBillRate(x), p.billRates?.[x.id])).join("")
    + (others.length ? `<select class="setup-add-person" aria-label="Add someone">
        <option value="">+ Add someone</option>${others.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
      </select>` : "")
    + (list.length ? "" : '<div class="setup-none">No one is on this project yet.</div>');
  const unitCats = expenseCategories().filter((c) => c.unit && c.rate != null);
  expenseRatesEl.innerHTML = unitCats.map((c) => rateRow(c.name, c.name, c.rate, p.expenseRates?.[c.name], c.unit)).join("")
    || '<div class="setup-none">No categories have a rate (add a unit in Defaults below).</div>';
}

// The form as data: what Save writes.
function readForm() {
  const rates = (el) => Object.fromEntries([...el.querySelectorAll(".setup-rate-row")]
    .map((row) => [row.dataset.key, row.querySelector("input").value])
    .filter(([, v]) => v !== "" && Number(v) >= 0)
    .map(([k, v]) => [k, Number(v)]));
  const data = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()]));
  data.shortName = data.shortName || null;
  data.pmPersonId = data.pmPersonId || null;
  return { ...data, color, internal: type === "internal", billRates: rates(billRatesEl), expenseRates: rates(expenseRatesEl) };
}

function updateDirty() {
  const dirty = !!shownId && JSON.stringify(readForm()) !== saved;
  saveBtn.disabled = !dirty;
  revertBtn.hidden = !dirty;
  dirtyNote.textContent = dirty ? "Unsaved changes" : "";
  return dirty;
}

function fill(p) {
  shownId = p.id;
  extraPeople = [];
  Object.entries(fields).forEach(([k, el]) => { if (k !== "pmPersonId") el.value = p[k] || ""; });
  fields.shortName.placeholder = projectShortName({ name: p.name });
  const pmChoices = people.filter((x) => !x.inactive || x.id === p.pmPersonId).sort((a, b) => a.name.localeCompare(b.name));
  fields.pmPersonId.innerHTML = '<option value="">None</option>' + pmChoices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  fields.pmPersonId.value = p.pmPersonId || "";
  color = p.color || null;
  type = isInternal(p) ? "internal" : "rates";
  renderSwatches();
  renderType();
  renderRates(p);
  saved = JSON.stringify(readForm());
  updateDirty();
}

// Redraws from the database unless there are unsaved changes here.
function renderProject() {
  if (!adminCheckDone || !projects.length) return;
  renderPicker();
  cards.hidden = !selectedId;
  if (!selectedId) return;
  if (shownId === selectedId && updateDirty()) return;
  fill(projects.find((p) => p.id === selectedId));
  if (!scrolledToHash && location.hash === "#rates") {
    scrolledToHash = true;
    $("rates").scrollIntoView({ block: "start" });
  }
}

picker.addEventListener("change", async () => {
  if (updateDirty() && !(await confirmDialog("Your changes to this project haven't been saved.", { title: "Discard changes?", confirmText: "Discard" }))) {
    picker.value = selectedId;
    return;
  }
  selectedId = picker.value;
  history.replaceState(null, "", `?project=${selectedId}`);
  shownId = null;
  renderProject();
});

cards.addEventListener("input", updateDirty);
cards.addEventListener("change", (e) => {
  if (e.target.matches(".setup-add-person") && e.target.value) {
    const state = readForm();
    extraPeople.push(e.target.value);
    const id = e.target.value;
    renderRates({ ...project(), billRates: state.billRates });
    billRatesEl.querySelector(`.setup-rate-row[data-key="${id}"] input`)?.focus();
  }
  updateDirty();
});
$("setupColor").addEventListener("click", (e) => {
  const b = e.target.closest("[data-color]");
  if (!b) return;
  color = b.dataset.color;
  renderSwatches();
  updateDirty();
});
$("setupType").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-value]");
  if (!b) return;
  type = b.dataset.value;
  renderType();
  updateDirty();
});

revertBtn.addEventListener("click", () => fill(project()));
saveBtn.addEventListener("click", async () => {
  const data = readForm();
  if (!data.name) {
    fields.name.focus();
    return showToast("Give the project a name.");
  }
  saveBtn.disabled = true;
  try {
    await Projects.update(shownId, data);
    saved = JSON.stringify(data);
    updateDirty();
    showToast("Project saved.");
  } catch (err) {
    showToast("Error: " + err.message);
    updateDirty();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (updateDirty()) e.preventDefault();
});

// ---------- Defaults: expense categories ----------
// The categories staff pick from when recording an expense (see expenses.js):
// name, the group invoices show it as, an optional default rate per unit
// (e.g. $0.70 / mile — entered as a quantity; no unit means an amount), and
// whether to prompt for a receipt. Each change saves the whole list; a new
// row saves once it has a name. Past expenses keep the category they were
// recorded with.
const categoryRows = $("categoryRows");
let unsavedCategory = false; // a just-added row with no name yet

function renderCategories() {
  applyExpenseSettings(settings);
  if (categoryRows.contains(document.activeElement)) return;
  const rowHtml = (c) => `<div class="cat-grid cat-row">
      <input type="text" class="cat-name" value="${esc(c.name)}" placeholder="Category name" aria-label="Name" />
      <input type="text" class="cat-group" value="${esc(c.group || "")}" placeholder="${esc(c.name || "Same as name")}" aria-label="Invoice group" />
      <div class="money-input ${c.unit ? "" : "disabled"}"><span>$</span><input type="number" class="cat-rate" min="0" step="0.01"
        value="${c.unit && c.rate != null ? c.rate : ""}" ${c.unit ? "" : "disabled"} aria-label="Default rate" /></div>
      <div class="cat-per"><span>/</span><input type="text" class="cat-unit" value="${esc(c.unit || "")}" placeholder="none" aria-label="Unit" /></div>
      <label class="cat-receipt"><input type="checkbox" class="cat-receipt-box" ${c.receipt ? "checked" : ""} aria-label="Ask for a receipt" /></label>
      <button type="button" class="icon-btn cat-remove" title="Remove category" aria-label="Remove category">&times;</button>
    </div>`;
  categoryRows.innerHTML = expenseCategories().map(rowHtml).join("")
    + (unsavedCategory ? rowHtml({ name: "", group: "", unit: "", rate: null, receipt: true }) : "");
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
categoryRows.addEventListener("focusout", () => setTimeout(() => {
  if (categoryRows.contains(document.activeElement)) return;
  renderCategories();
  renderProject();
}, 0));

categoryRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".cat-remove");
  if (!btn) return;
  const row = btn.closest(".cat-row");
  const name = row.querySelector(".cat-name").value.trim();
  row.remove();
  if (!name) { unsavedCategory = false; renderCategories(); return; }
  saveCategories(readCategories(), `Removed "${name}". Past expenses keep it.`);
});

$("addCategory").addEventListener("click", () => {
  unsavedCategory = true;
  renderCategories();
  categoryRows.querySelector(".cat-row:last-child .cat-name").focus();
});
