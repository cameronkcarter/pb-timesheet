// Project setup (admins), shown on the Projects tab in place of Tasks &
// Budgets and Timeline: the project's details, who it invoices, and its own
// bill and expense rates (if it doesn't use the defaults). Default rates are
// on the Staff tab.
import { Projects, Settings } from "./db.js";
import {
  formatCurrency, showToast, esc, PROJECT_COLOR_CHOICES, projectColor, projectShortName,
} from "./util.js";
import { personBillRate, isInternal } from "./rates.js";
import { expenseCategories, applyExpenseSettings } from "./expenses.js";
import { removeProject } from "./project-editor.js";

// getData() → { people, projects, tasks, assignments, dueDates, timeEntries, invoices, expenses }
// onCreated(id), onRemoved(), onCancelNew(), onSaved()
export function createSetupPanel({ getData, onCreated, onRemoved, onCancelNew, onSaved }) {
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

  let shownId = null;   // the project the form was filled from ("new" while creating)
  let saved = "";       // the form as last filled, to tell when it's changed
  let color = null;     // picked swatch; null keeps the automatic color
  let type = "rates";   // "rates" or "internal" (null on a new project until picked)
  let extraPeople = []; // added with "Add Staff" before saving
  let ratesOpen = false;
  let filledFrom = "";  // the project record the form was filled from

  const creating = () => shownId === "new";
  const project = () => getData().projects.find((p) => p.id === shownId);

  Settings.listen((d) => { applyExpenseSettings(d); });

  // ---------- Color ----------
  // Colors other projects use are crossed out, so no two look alike. If
  // every color is taken, all of them can be picked again.
  function takenColors() {
    const taken = new Map();
    getData().projects.forEach((p) => {
      if (p.id === shownId) return;
      const c = projectColor(p.id);
      if (!taken.has(c)) taken.set(c, projectShortName(p));
    });
    return PROJECT_COLOR_CHOICES.every((c) => taken.has(c)) ? new Map() : taken;
  }

  // A new project with no color picked gets the first one nobody has.
  function firstFreeColor() {
    const taken = takenColors();
    return PROJECT_COLOR_CHOICES.find((c) => !taken.has(c)) || null;
  }

  function renderSwatches() {
    const current = color || (!creating() ? projectColor(shownId) : null);
    const taken = takenColors();
    $("setupColor").innerHTML = PROJECT_COLOR_CHOICES.map((c) => {
      const by = c !== current && taken.get(c);
      return `<button type="button" class="swatch ${c === current ? "on" : ""} ${by ? "taken" : ""}"
        style="--c:${c};" data-color="${c}" role="radio" aria-checked="${c === current}" ${by ? "disabled" : ""}
        title="${by ? `Used by ${esc(by)}` : ""}" aria-label="${by ? `Color used by ${esc(by)}` : `Color ${c}`}"></button>`;
    }).join("");
  }

  // Every project here is billed to a client (Pursuits have their own tab).
  function renderType() {
    const internal = type === "internal";
    $("setupBilling").hidden = internal;
    $("rates").hidden = internal || creating();
  }

  // ---------- Rates ----------
  // Projects use everyone's default bill rate and each expense category's
  // default rate, unless rates are set for the project here.
  function billPeople(p) {
    const { people, assignments } = getData();
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
    const { people } = getData();
    const list = billPeople(p);
    const others = people.filter((x) => !x.inactive && !list.some((y) => y.id === x.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    billRatesEl.innerHTML = list.map((x) => rateRow(x.id, x.name, personBillRate(x), billRates[x.id], "hr")).join("")
      + (list.length ? "" : '<div class="setup-none">No one is on this project yet.</div>')
      + (others.length ? `<select class="setup-add-person" aria-label="Add staff">
          <option value="">+ Add Staff</option>${others.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
        </select>` : "");
    const unitCats = expenseCategories().filter((c) => c.unit && c.rate != null);
    expenseRatesEl.innerHTML = unitCats.map((c) => rateRow(c.name, c.name, c.rate, expenseRates[c.name], c.unit)).join("")
      || '<div class="setup-none">No expense categories have a rate.</div>';
  }

  // One line saying which rates differ from the defaults.
  function renderRatesSummary() {
    const { people } = getData();
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

  function isDirty() {
    const dirty = !!shownId && JSON.stringify(readForm()) !== saved;
    saveBtn.disabled = !creating() && !dirty;
    revertBtn.hidden = !creating() && !dirty;
    $("setupDirty").textContent = dirty && !creating() ? "Unsaved changes" : "";
    return dirty;
  }

  function fill(p) {
    const { people } = getData();
    shownId = p ? p.id : "new";
    extraPeople = [];
    const src = p || {};
    Object.entries(fields).forEach(([k, el]) => { if (k !== "pmPersonId") el.value = src[k] || ""; });
    fields.shortName.placeholder = p ? projectShortName({ name: p.name }) : "Roy 1900 W";
    const pmChoices = people.filter((x) => !x.inactive || x.id === src.pmPersonId).sort((a, b) => a.name.localeCompare(b.name));
    fields.pmPersonId.innerHTML = '<option value="">None</option>' + pmChoices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    fields.pmPersonId.value = src.pmPersonId || "";
    color = src.color || null;
    type = p && isInternal(p) ? "internal" : "rates";
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
    isDirty();
  }

  // Fill the form for a project (id) or a new one (null), unless it's
  // already showing that one with unsaved changes (or a new one in progress).
  // Refills only when the project itself changed, so an open rates editor
  // stays open while other data updates.
  function show(id) {
    const want = id || "new";
    const p = id ? getData().projects.find((x) => x.id === id) : null;
    const src = JSON.stringify(p || null);
    if (shownId === want && (want === "new" || isDirty() || src === filledFrom)) {
      renderSwatches();
      return;
    }
    fill(p);
    filledFrom = src;
  }

  form.addEventListener("input", () => { isDirty(); if (ratesOpen) renderRatesSummary(); });
  form.addEventListener("change", (e) => {
    if (e.target.matches(".setup-add-person") && e.target.value) {
      const id = e.target.value;
      const state = readForm();
      extraPeople.push(id);
      renderRateRows(project(), state.billRates, state.expenseRates);
      billRatesEl.querySelector(`.setup-rate-row[data-key="${id}"] input`)?.focus();
    }
    isDirty();
  });
  $("setupColor").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b || b.disabled) return;
    color = b.dataset.color;
    renderSwatches();
    isDirty();
  });

  revertBtn.addEventListener("click", () => {
    if (creating()) {
      shownId = null;
      onCancelNew();
      return;
    }
    fill(project());
    filledFrom = JSON.stringify(project() || null);
  });

  saveBtn.addEventListener("click", async () => {
    const data = readForm();
    if (!data.name) {
      fields.name.focus();
      return showToast("Give the project a name.");
    }
    saveBtn.disabled = true;
    try {
      if (creating()) {
        const ref = await Projects.add({
          ...data, color: data.color || firstFreeColor(),
          numberTasks: !data.internal, expenseBudget: 0, subconsultants: [],
        });
        shownId = null;
        showToast("Project created. Add its tasks and budgets.");
        onCreated(ref.id);
        return;
      }
      await Projects.update(shownId, data);
      saved = JSON.stringify(data);
      isDirty();
      showToast("Project saved.");
      onSaved();
    } catch (err) {
      showToast("Error: " + err.message);
      isDirty();
    }
  });

  $("setupRemove").addEventListener("click", async () => {
    const removed = await removeProject(shownId, getData());
    if (!removed) return;
    shownId = null;
    onRemoved();
  });

  return {
    show,
    isDirty: () => !!shownId && isDirty(),
    // Forget the form (leaving setup), so it refills next time.
    reset: () => { shownId = null; },
  };
}
