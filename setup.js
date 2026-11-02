// The Setup tab (admins): adding projects, and each project's details, who
// it invoices, and its own bill and expense rates (if it doesn't use the
// defaults). Tasks and budgets are on the Projects tab; default rates are on
// the Staff tab.
import { People, Projects, Tasks, Assignments, TimeEntries, DueDates, Invoices, Expenses, Settings } from "./db.js";
import {
  formatCurrency, showToast, esc, confirmDialog, PROJECT_COLOR_CHOICES, projectColor, projectShortName, sortProjects,
} from "./util.js";
import { requireSession, wireLogout, enforceAdmin, renderNavUserName } from "./session.js";
import { personBillRate, isInternal } from "./rates.js";
import { expenseCategories, applyExpenseSettings } from "./expenses.js";
import { createProjectPicker } from "./project-picker.js";
import { removeProject } from "./project-editor.js";

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
let projectsLoaded = false;
const params = new URLSearchParams(location.search);
let selectedId = params.get("project");
let creating = params.has("new"); // filling in a new project
let shownId = null;      // the project the form was filled from ("new" while creating)
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
    render();
  });
  Projects.listen((d) => { projects = d; projectsLoaded = true; render(); });
  Assignments.listen((d) => { assignments = d; render(); });
  Settings.listen((d) => { applyExpenseSettings(d); render(); });
  Tasks.listen((d) => { tasks = d; });
  TimeEntries.listen((d) => { timeEntries = d; });
  DueDates.listen((d) => { dueDates = d; });
  Invoices.listen((d) => { invoices = d; });
  Expenses.listen((d) => { expenses = d; });
}

const $ = (id) => document.getElementById(id);
const form = $("setupForm");
const fields = {
  name: $("setupName"), client: $("setupClient"), projectNumber: $("setupNumber"), shortName: $("setupShortName"),
  pmPersonId: $("setupPm"), billToName: $("setupBillToName"), billToTitle: $("setupBillToTitle"), billToCompany: $("setupBillToCompany"),
  billToAddress1: $("setupBillToAddress1"), billToAddress2: $("setupBillToAddress2"), billToEmail: $("setupBillToEmail"),
};
const billRatesEl = $("setupBillRates");
const expenseRatesEl = $("setupExpenseRates");
const ratesEditor = $("ratesEditor");
const ratesSummary = $("ratesSummary");
const ratesToggle = $("ratesToggle");
const saveBtn = $("setupSave");
const revertBtn = $("setupRevert");
let color = null;     // picked swatch; null keeps the automatic color
let type = "rates";   // "rates" or "internal" (null on a new project until picked)
let extraPeople = []; // added with "Add someone" before saving
let ratesOpen = false;

const project = () => projects.find((p) => p.id === shownId);

// ---------- Picker and heading ----------
// The picker lists every project; "+ New Project" starts a blank form.
const picker = createProjectPicker({
  root: $("projectPicker"),
  getData: () => ({ projects, mine: myProjects(), selectedId: creating ? null : selectedId }),
  onPick: (id) => switchTo(id, false),
  action: '<button type="button" id="newProjectBtn" class="small">+ New Project</button>',
});

// Your projects as chips: ones you manage or are assigned to.
function myProjects() {
  const on = new Set(assignments.filter((a) => a.personId === sessionPersonId).map((a) => a.projectId));
  return sortProjects(projects.filter((p) => on.has(p.id) || p.pmPersonId === sessionPersonId));
}

async function switchTo(id, newProject) {
  if (updateDirty() && !(await confirmDialog("Your changes haven't been saved.", { title: "Discard changes?", confirmText: "Discard" }))) {
    picker.render();
    return;
  }
  creating = newProject;
  selectedId = newProject ? selectedId : id;
  history.replaceState(null, "", newProject ? "?new=1" : `?project=${id}`);
  shownId = null;
  render();
}
$("newProjectBtn").addEventListener("click", () => switchTo(null, true));

function renderHead() {
  const p = creating ? null : project();
  $("setupHead").style.setProperty("--c", p ? projectColor(p.id) : "var(--accent)");
  $("setupHeadName").textContent = p ? p.name : "New Project";
  const pm = p && people.find((x) => x.id === p.pmPersonId);
  $("setupHeadMeta").textContent = p
    ? [p.client || (isInternal(p) ? "Internal" : ""), pm ? `PM: ${pm.name}` : ""].filter(Boolean).join(" · ")
    : "Fill in the details below, then Create Project. Add its tasks and budgets on the Projects tab.";
  $("setupTasksLink").hidden = !p;
  if (p) $("setupTasksLink").href = `projects.html?project=${p.id}`;
}

// ---------- Details ----------
function renderSwatches() {
  const current = color || (shownId && !creating ? projectColor(shownId) : null);
  $("setupColor").innerHTML = PROJECT_COLOR_CHOICES.map((c) => `<button type="button" class="swatch ${c === current ? "on" : ""}"
    style="--c:${c};" data-color="${c}" role="radio" aria-checked="${c === current}" aria-label="Color ${c}"></button>`).join("");
}

function renderType() {
  $("setupType").querySelectorAll("button").forEach((b) => {
    const on = b.dataset.value === type;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  $("setupTypeHint").textContent = type === "internal" ? "Not billed or paid. Just tracks hours."
    : type === "rates" ? "Billed at each person's bill rate." : "Choose one.";
  const internal = type === "internal";
  $("setupBilling").hidden = internal;
  $("rates").hidden = internal || creating;
}

// ---------- Rates ----------
// Projects use everyone's default bill rate and each expense category's
// default rate, unless rates are set for the project here.
function billPeople(p) {
  const ids = new Set([
    ...assignments.filter((a) => a.projectId === p.id).map((a) => a.personId),
    p.pmPersonId, ...Object.keys(p.billRates || {}), ...extraPeople,
  ]);
  return people.filter((x) => ids.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
}

function rateRow(key, label, def, value, unit) {
  return `<div class="setup-rate-row" data-key="${esc(key)}">
    <span class="setup-rate-name">${esc(label)}</span>
    <span class="setup-rate-default">Default ${formatCurrency(def)}/${esc(unit)}</span>
    <div class="money-input"><span>$</span><input type="number" min="0" step="0.01" value="${value ?? ""}"
      aria-label="${esc(label)} rate on this project" /><span>/${esc(unit)}</span></div>
  </div>`;
}

function renderRateRows(p, billRates, expenseRates) {
  const list = billPeople(p);
  const others = people.filter((x) => !x.inactive && !list.some((y) => y.id === x.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  billRatesEl.innerHTML = list.map((x) => rateRow(x.id, x.name, personBillRate(x), billRates[x.id], "hr")).join("")
    + (list.length ? "" : '<div class="setup-none">No one is on this project yet.</div>')
    + (others.length ? `<select class="setup-add-person" aria-label="Add someone">
        <option value="">+ Add someone</option>${others.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
      </select>` : "");
  const unitCats = expenseCategories().filter((c) => c.unit && c.rate != null);
  expenseRatesEl.innerHTML = unitCats.map((c) => rateRow(c.name, c.name, c.rate, expenseRates[c.name], c.unit)).join("")
    || '<div class="setup-none">No expense categories have a rate.</div>';
}

// One line saying which rates differ from the defaults.
function renderRatesSummary() {
  const { billRates, expenseRates } = readForm();
  const lines = [
    ...Object.entries(billRates).map(([id, rate]) => {
      const x = people.find((y) => y.id === id);
      return x ? `${esc(x.name)} <strong>${formatCurrency(rate)}/hr</strong>` : "";
    }),
    ...Object.entries(expenseRates).map(([name, rate]) => {
      const c = expenseCategories().find((y) => y.name === name);
      return `${esc(name)} <strong>${formatCurrency(rate)}${c?.unit ? `/${esc(c.unit)}` : ""}</strong>`;
    }),
  ].filter(Boolean);
  ratesSummary.innerHTML = lines.length
    ? `<span class="rates-custom">Project rates</span> ${lines.join('<span class="rates-sep">·</span>')}<span class="rates-rest">Everything else uses default rates.</span>`
    : '<span class="rates-default">Using default rates</span>';
  ratesToggle.textContent = ratesOpen ? "Done" : lines.length ? "Change Rates" : "Set Project Rates";
}

ratesToggle.addEventListener("click", () => {
  ratesOpen = !ratesOpen;
  ratesEditor.hidden = !ratesOpen;
  renderRatesSummary();
});

// ---------- The form ----------
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
  saveBtn.disabled = !creating && !dirty;
  revertBtn.hidden = !creating && !dirty;
  $("setupDirty").textContent = dirty && !creating ? "Unsaved changes" : "";
  return dirty;
}

function fill(p) {
  shownId = p ? p.id : "new";
  extraPeople = [];
  const src = p || {};
  Object.entries(fields).forEach(([k, el]) => { if (k !== "pmPersonId") el.value = src[k] || ""; });
  fields.shortName.placeholder = p ? projectShortName({ name: p.name }) : "Roy 1900 W";
  const pmChoices = people.filter((x) => !x.inactive || x.id === src.pmPersonId).sort((a, b) => a.name.localeCompare(b.name));
  fields.pmPersonId.innerHTML = '<option value="">None</option>' + pmChoices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  fields.pmPersonId.value = src.pmPersonId || "";
  color = src.color || null;
  type = p ? (isInternal(p) ? "internal" : "rates") : null;
  renderSwatches();
  renderType();
  if (p) renderRateRows(p, p.billRates || {}, p.expenseRates || {});
  else { billRatesEl.innerHTML = ""; expenseRatesEl.innerHTML = ""; }
  ratesOpen = false;
  ratesEditor.hidden = true;
  renderRatesSummary();
  saveBtn.textContent = p ? "Save Changes" : "Create Project";
  $("setupRemove").hidden = !p;
  saved = JSON.stringify(readForm());
  updateDirty();
}

// Redraws from the database unless there are unsaved changes here.
function render() {
  if (!adminCheckDone || !projectsLoaded) return;
  if (!creating && !projects.some((p) => p.id === selectedId)) selectedId = sortProjects([...projects])[0]?.id || null;
  if (!creating && !selectedId) creating = true;
  picker.render();
  renderHead();
  const want = creating ? "new" : selectedId;
  if (shownId === want && updateDirty()) return;
  if (shownId === "new" && creating) return; // keep what's typed into a new project
  fill(creating ? null : projects.find((p) => p.id === selectedId));
  renderHead();
  if (!scrolledToHash && location.hash === "#rates" && !creating) {
    scrolledToHash = true;
    ratesOpen = true;
    ratesEditor.hidden = false;
    renderRatesSummary();
    $("rates").scrollIntoView({ block: "start" });
  }
}

form.addEventListener("input", () => { updateDirty(); if (ratesOpen) renderRatesSummary(); });
form.addEventListener("change", (e) => {
  if (e.target.matches(".setup-add-person") && e.target.value) {
    const id = e.target.value;
    const state = readForm();
    extraPeople.push(id);
    renderRateRows(project(), state.billRates, state.expenseRates);
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

revertBtn.addEventListener("click", () => {
  if (creating) {
    creating = false;
    history.replaceState(null, "", selectedId ? `?project=${selectedId}` : location.pathname);
    shownId = null;
    render();
    return;
  }
  fill(project());
});

saveBtn.addEventListener("click", async () => {
  const data = readForm();
  if (!data.name) {
    fields.name.focus();
    return showToast("Give the project a name.");
  }
  if (!type) return showToast("Choose Billed to a client or Internal.");
  saveBtn.disabled = true;
  try {
    if (creating) {
      const ref = await Projects.add({ ...data, numberTasks: !data.internal, expenseBudget: 0, subconsultants: [] });
      creating = false;
      selectedId = ref.id;
      shownId = null;
      history.replaceState(null, "", `?project=${ref.id}`);
      showToast("Project created. Add its tasks and budgets on the Projects tab.");
      render();
      return;
    }
    await Projects.update(shownId, data);
    saved = JSON.stringify(data);
    updateDirty();
    renderHead();
    showToast("Project saved.");
  } catch (err) {
    showToast("Error: " + err.message);
    updateDirty();
  }
});

$("setupRemove").addEventListener("click", async () => {
  const removed = await removeProject(shownId, { projects, tasks, assignments, dueDates, timeEntries, invoices, expenses });
  if (!removed) return;
  selectedId = null;
  shownId = null;
  history.replaceState(null, "", location.pathname);
  render();
});

window.addEventListener("beforeunload", (e) => {
  if (updateDirty()) e.preventDefault();
});
