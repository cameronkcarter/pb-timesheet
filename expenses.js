// Project expenses and subconsultant invoices: shared helpers and the
// add/edit popup (used on the Dashboard and the Projects tab). Markup is
// created here so every page gets the same popup.
import { Expenses, Settings } from "./db.js";
import { showToast, closeOnBackdropClick, esc, formatCurrency, todayISO } from "./util.js";

export const CATEGORIES = ["Mileage", "Transit", "Lodging", "Meals", "Materials", "Other"];

// Categories billed per unit, with default rates (editable per expense).
// Others are just an amount. Admins set the default rates in Admin
// (settings/app: mileageRate, lodgingRate); these are the fallbacks.
export const UNIT_CATEGORIES = {
  Mileage: { label: "Miles", unit: "mi", per: "mile", rate: 0.7, setting: "mileageRate" },
  Lodging: { label: "Nights", unit: "nights", per: "night", rate: 150, setting: "lodgingRate" },
};
const FALLBACK_RATES = Object.fromEntries(Object.entries(UNIT_CATEGORIES).map(([k, u]) => [k, u.rate]));

export function applyExpenseRates(settings) {
  Object.entries(UNIT_CATEGORIES).forEach(([k, u]) => {
    const v = Number(settings[u.setting]);
    u.rate = v > 0 ? v : FALLBACK_RATES[k];
  });
}

// Everything paid for needs a receipt (emailed to the PM); mileage doesn't.
export const needsReceipt = (category) => category !== "Mileage";

// "42 mi × $0.70", or "" for amount-only expenses.
export function expenseQtyText(e) {
  if (e.quantity == null || e.rate == null) return "";
  const unit = UNIT_CATEGORIES[e.category]?.unit || "";
  return `${Math.round(Number(e.quantity) * 100) / 100}${unit ? " " + unit : ""} × ${formatCurrency(e.rate)}`;
}

// What an expense is, in a few words: "Mileage · Site visit".
export function expenseLabel(e, project) {
  if (e.kind === "sub") {
    const sub = (project?.subconsultants || []).find((s) => s.id === e.subId);
    return [sub ? sub.name : "Subconsultant", e.description].filter(Boolean).join(" · ");
  }
  return [e.category, e.description].filter(Boolean).join(" · ");
}

export function expenseStatus(e) {
  if (e.reimbursed) return ["Reimbursed", "paid"];
  if (e.invoiced) return ["Invoiced", "invoiced"];
  if (e.approved) return ["Approved", "paid"];
  if (e.declined) return ["Declined", "unsynced"];
  return ["Pending approval", "pending"];
}

// Expenses that count against a project's budgets (everything but declined).
export const countsToward = (e) => !e.declined;

const MARKUP = `
<div id="expenseModal" class="modal-overlay" style="display:none;">
  <div class="modal sheet-modal sheet-small item-sheet" role="dialog" aria-labelledby="expenseHeading">
    <div class="item-head">
      <h2 id="expenseHeading">New expense</h2>
      <button type="button" id="expenseClose" class="icon-btn" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <div id="expenseSubField">
        <label for="expenseSub" class="item-label">Subconsultant</label>
        <select id="expenseSub" class="item-select"></select>
      </div>
      <label for="expenseDescription" class="item-label">Description</label>
      <input type="text" id="expenseDescription" class="item-name" placeholder="e.g. Mileage to site visit" autocomplete="off" />

      <div class="item-label">Details</div>
      <div class="row-group">
        <label class="row-item" for="expenseProject">
          <span class="row-label">Project</span>
          <select id="expenseProject"></select>
        </label>
        <label class="row-item" for="expenseCategory" id="expenseCategoryRow">
          <span class="row-label">Category</span>
          <select id="expenseCategory"></select>
        </label>
        <label class="row-item" for="expenseDate">
          <span class="row-label">Date</span>
          <input type="date" id="expenseDate" />
        </label>
        <label class="row-item" for="expenseQuantity" id="expenseQuantityRow">
          <span class="row-label" id="expenseQuantityLabel">Quantity</span>
          <input type="number" id="expenseQuantity" min="0" step="any" placeholder="1" />
        </label>
        <label class="row-item" for="expenseRate" id="expenseRateRow">
          <span class="row-label" id="expenseRateLabel">Rate</span>
          <input type="number" id="expenseRate" min="0" step="0.01" placeholder="0.00" />
        </label>
        <label class="row-item" for="expenseAmount" id="expenseAmountRow">
          <span class="row-label">Amount</span>
          <input type="number" id="expenseAmount" min="0" step="0.01" placeholder="0.00" />
        </label>
        <label class="row-item" for="expensePaidBy" id="expensePaidByRow">
          <span class="row-label">Paid by</span>
          <select id="expensePaidBy"></select>
        </label>
      </div>
      <div class="expense-cost" id="expenseCost"></div>
      <a class="expense-receipt" id="expenseReceipt" style="display:none;"></a>
    </div>
    <div class="sheet-foot">
      <button type="button" id="expenseDelete" class="link-btn item-delete" style="display:none;">Delete</button>
      <button type="button" id="expenseCancel" class="secondary">Cancel</button>
      <button type="button" id="expenseSave">Save</button>
    </div>
  </div>
</div>`;

// getData() → { people, projects }. canPickPayer: admins/PMs can record an
// expense paid by someone else (or the company); staff record their own.
let editorCount = 0;

export function createExpenseEditor({ getData, sessionPersonId, projectChoices, canPickPayer }) {
  // A page can have more than one popup (e.g. Dashboard + its Approvals), so
  // each one's element IDs get their own prefix.
  const pre = editorCount++ ? `e${editorCount}-` : "";
  document.body.insertAdjacentHTML("beforeend", MARKUP.replace(/(id|for|aria-labelledby)="/g, `$1="${pre}`));
  const $ = (id) => document.getElementById(pre + id);
  const modal = $("expenseModal");
  const heading = $("expenseHeading");
  const subField = $("expenseSub");
  const description = $("expenseDescription");
  const projectSelect = $("expenseProject");
  const category = $("expenseCategory");
  const date = $("expenseDate");
  const quantity = $("expenseQuantity");
  const rate = $("expenseRate");
  const amount = $("expenseAmount");
  const paidBy = $("expensePaidBy");
  const cost = $("expenseCost");
  const quantityLabel = $("expenseQuantityLabel");
  const rateLabel = $("expenseRateLabel");
  const deleteBtn = $("expenseDelete");
  const saveBtn = $("expenseSave");
  const receipt = $("expenseReceipt");

  Settings.listen(applyExpenseRates);

  let editing = null;
  let kind = "project";

  category.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");

  function show(id, on) { $(id).style.display = on ? "" : "none"; }

  function fillSubs(projectId, selected) {
    const project = getData().projects.find((p) => p.id === projectId);
    const subs = project?.subconsultants || [];
    subField.innerHTML = subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
      || '<option value="">Add subconsultants in Edit project</option>';
    if (selected) subField.value = selected;
  }

  // Mileage/Lodging: quantity × rate (miles, nights). Others: an amount.
  function applyCategory(fromChange) {
    if (kind !== "project") return;
    const unit = UNIT_CATEGORIES[category.value];
    show("expenseQuantityRow", !!unit);
    show("expenseRateRow", !!unit);
    show("expenseAmountRow", !unit);
    if (unit) {
      quantityLabel.textContent = unit.label;
      rateLabel.textContent = `Rate / ${unit.per}`;
      const defaults = Object.values(UNIT_CATEGORIES).map((u) => u.rate);
      if (fromChange && (rate.value === "" || defaults.includes(Number(rate.value)))) rate.value = unit.rate;
    }
    updateCost();
  }

  // A link to email the receipt to the project's PM, subject filled in.
  function updateReceipt() {
    const { people, projects } = getData();
    const project = projects.find((p) => p.id === projectSelect.value);
    const pm = project && people.find((p) => p.id === project.pmPersonId);
    const on = kind === "project" && !!project && needsReceipt(category.value);
    receipt.style.display = on ? "" : "none";
    if (!on) return;
    const desc = description.value.trim();
    const subject = `Receipt: ${project.name}${desc ? " – " + desc : ""}`;
    receipt.href = `mailto:${pm && pm.email ? pm.email.trim() : ""}?subject=${encodeURIComponent(subject)}`;
    receipt.textContent = `Email the receipt to ${pm ? pm.name : "the PM"} →`;
  }

  function updateCost() {
    if (kind !== "project" || !UNIT_CATEGORIES[category.value]) { cost.textContent = ""; return; }
    const total = (Number(quantity.value) || 0) * (Number(rate.value) || 0);
    cost.textContent = total ? `Cost ${formatCurrency(total)}` : "";
  }

  // open(record) to edit; open(null, { kind, projectId, subId }) to add.
  function open(record, preset = {}) {
    const { people } = getData();
    editing = record;
    kind = record ? record.kind : preset.kind || "project";
    const projectId = record ? record.projectId : preset.projectId;
    heading.textContent = `${record ? "Edit" : "New"} ${kind === "sub" ? "subconsultant invoice" : "expense"}`;

    const choices = projectChoices();
    projectSelect.innerHTML = choices.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    projectSelect.value = projectId || (choices[0] && choices[0].id) || "";
    projectSelect.disabled = !!record;

    show("expenseSubField", kind === "sub");
    show("expenseCategoryRow", kind === "project");
    show("expenseQuantityRow", false);
    show("expenseRateRow", false);
    show("expenseAmountRow", kind === "sub");
    show("expensePaidByRow", kind === "project" && canPickPayer());
    if (kind === "sub") fillSubs(projectSelect.value, record ? record.subId : preset.subId);

    const active = people.filter((p) => !p.inactive || (record && p.id === record.personId))
      .sort((a, b) => a.name.localeCompare(b.name));
    paidBy.innerHTML = '<option value="">Company (no reimbursement)</option>' +
      active.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    paidBy.value = record ? record.personId || "" : sessionPersonId;

    description.value = record ? record.description || "" : "";
    category.value = record?.category || CATEGORIES[0];
    date.value = record ? record.date : todayISO();
    quantity.value = record?.quantity ?? "";
    rate.value = record?.rate ?? (UNIT_CATEGORIES[category.value]?.rate ?? "");
    amount.value = record && (kind === "sub" || record.quantity == null) ? record.amount : "";
    applyCategory(false);
    description.placeholder = kind === "sub" ? "e.g. Invoice #1042" : "e.g. Mileage to site visit";
    updateCost();
    updateReceipt();
    deleteBtn.style.display = record ? "" : "none";
    saveBtn.textContent = record ? "Save changes" : kind === "sub" ? "Add invoice" : "Add expense";
    modal.style.display = "flex";
    description.focus();
  }

  function close() { modal.style.display = "none"; }

  projectSelect.addEventListener("change", () => { if (kind === "sub") fillSubs(projectSelect.value); updateReceipt(); });
  category.addEventListener("change", () => { applyCategory(true); updateReceipt(); });
  description.addEventListener("input", updateReceipt);
  quantity.addEventListener("input", updateCost);
  rate.addEventListener("input", updateCost);
  $("expenseClose").addEventListener("click", close);
  $("expenseCancel").addEventListener("click", close);
  closeOnBackdropClick(modal, close);
  description.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

  deleteBtn.addEventListener("click", async () => {
    if (!editing || !confirm("Delete this expense? This can't be undone.")) return;
    try {
      await Expenses.remove(editing.id);
      close();
      showToast("Deleted.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    const projectId = projectSelect.value;
    const desc = description.value.trim();
    if (!projectId) return showToast("Choose a project.");
    if (!date.value) return showToast("Choose a date.");
    let data;
    if (kind === "sub") {
      const total = Number(amount.value);
      if (!subField.value) return showToast("Add the subconsultant to the project first (Edit project).");
      if (!(total > 0)) return showToast("Enter the amount.");
      // Subconsultant invoices are recorded by admins/PMs, so they're approved.
      data = { kind, projectId, subId: subField.value, description: desc, date: date.value, amount: total };
      if (!editing) Object.assign(data, { approved: true, approvedDate: new Date().toISOString() });
    } else {
      const unit = UNIT_CATEGORIES[category.value];
      if (!desc) return showToast("Add a description.");
      let money;
      if (unit) {
        const q = Number(quantity.value);
        const r = Number(rate.value);
        if (!(q > 0) || !(r > 0)) return showToast(`Enter the ${unit.label.toLowerCase()} and rate.`);
        money = { quantity: q, rate: r, amount: Math.round(q * r * 100) / 100 };
      } else {
        const total = Number(amount.value);
        if (!(total > 0)) return showToast("Enter the amount.");
        money = { quantity: null, rate: null, amount: Math.round(total * 100) / 100 };
      }
      data = {
        kind, projectId, category: category.value, description: desc, date: date.value, ...money,
        personId: canPickPayer() ? paidBy.value || null : sessionPersonId,
      };
      // Editing a declined expense resubmits it.
      if (editing && editing.declined) Object.assign(data, { declined: false, declineReason: null });
    }
    try {
      if (editing) await Expenses.update(editing.id, data);
      else await Expenses.add({ ...data, createdByPersonId: sessionPersonId });
      close();
      showToast(editing ? "Expense updated." : kind === "sub" ? "Invoice recorded."
        : needsReceipt(data.category) ? "Expense added. Remember to email the receipt." : "Expense added.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  return { open };
}
