// Project expenses and subconsultant invoices: shared helpers and the
// add/edit popup (used on the Dashboard and the Projects tab). Markup is
// created here so every page gets the same popup.
import { Expenses, Settings } from "./db.js";
import { showToast, closeOnBackdropClick, esc, formatCurrency, todayISO, confirmDialog } from "./util.js";

// Expense categories are set by admins (Admin > Expense categories, saved as
// settings/app.expenseCategories). Each is { name, unit, rate, receipt }:
//   unit    — "mile", "night"…: entered as a quantity × rate (rate is the
//             default, editable per expense). Blank: entered as an amount.
//   receipt — prompt to email the receipt to the project's PM.
// Expenses store the category's name (and unit), so renaming or removing a
// category never changes past expenses.
export const DEFAULT_CATEGORIES = [
  { name: "Mileage", unit: "mile", rate: 0.7, receipt: false },
  { name: "Transit", unit: "", rate: null, receipt: true },
  { name: "Lodging", unit: "night", rate: 150, receipt: true },
  { name: "Meals", unit: "", rate: null, receipt: true },
  { name: "Materials", unit: "", rate: null, receipt: true },
  { name: "Other", unit: "", rate: null, receipt: true },
];

let categories = DEFAULT_CATEGORIES;

export function applyExpenseSettings(settings) {
  const list = (settings.expenseCategories || []).filter((c) => c && c.name);
  categories = list.length ? list : DEFAULT_CATEGORIES;
}

export const expenseCategories = () => categories;
export const categoryInfo = (name) => categories.find((c) => c.name === name) || null;
const unitOf = (name) => categoryInfo(name)?.unit || "";

// "mile" → "miles" (for 0 or more than 1).
export const plural = (unit, n = 2) => (unit && Number(n) !== 1 && !unit.endsWith("s") ? `${unit}s` : unit);

// "42 miles × $0.70", or "" for amount-only expenses.
export function expenseQtyText(e) {
  if (e.quantity == null || e.rate == null) return "";
  const unit = e.unit || unitOf(e.category);
  return `${Math.round(Number(e.quantity) * 100) / 100}${unit ? " " + plural(unit, e.quantity) : ""} × ${formatCurrency(e.rate)}`;
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
      <textarea id="expenseDescription" class="item-name item-text" rows="1" placeholder="e.g. Mileage to site visit" autocomplete="off"></textarea>

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
      <div class="expense-receipt" id="expenseReceipt" style="display:none;"></div>
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

  Settings.listen(applyExpenseSettings);

  let editing = null;
  let kind = "project";

  // The category's settings; an expense whose category was since removed
  // keeps working as it was entered.
  function info(name) {
    const found = categoryInfo(name);
    if (found || !editing || editing.category !== name) return found;
    return { name, unit: editing.unit || (editing.quantity != null ? "unit" : ""), rate: editing.rate, receipt: false };
  }

  function fillCategories(current) {
    const names = expenseCategories().map((c) => c.name);
    if (current && !names.includes(current)) names.push(current);
    category.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  }

  function show(id, on) { $(id).style.display = on ? "" : "none"; }

  function fillSubs(projectId, selected) {
    const project = getData().projects.find((p) => p.id === projectId);
    const subs = project?.subconsultants || [];
    subField.innerHTML = subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
      || '<option value="">Add subconsultants in Edit project</option>';
    if (selected) subField.value = selected;
  }

  // Categories with a unit: quantity × rate (miles, nights…). Others: an amount.
  function applyCategory(fromChange) {
    if (kind !== "project") return;
    const c = info(category.value);
    const unit = c && c.unit;
    show("expenseQuantityRow", !!unit);
    show("expenseRateRow", !!unit);
    show("expenseAmountRow", !unit);
    if (unit) {
      const u = plural(unit);
      quantityLabel.textContent = u.charAt(0).toUpperCase() + u.slice(1);
      rateLabel.textContent = `Rate / ${unit}`;
      // Switching category swaps in its default rate, unless one was typed.
      const defaults = expenseCategories().map((x) => Number(x.rate)).filter((r) => r > 0);
      if (fromChange && (rate.value === "" || defaults.includes(Number(rate.value)))) rate.value = c.rate ?? "";
    }
    updateCost();
  }

  // A reminder to email the receipt to the project's PM.
  function updateReceipt() {
    const { people, projects } = getData();
    const project = projects.find((p) => p.id === projectSelect.value);
    const pm = project && people.find((p) => p.id === project.pmPersonId);
    const on = kind === "project" && !!project && !!info(category.value)?.receipt;
    receipt.style.display = on ? "" : "none";
    if (!on) return;
    receipt.textContent = `Email the receipt to ${pm ? pm.name : "the project manager"}.`;
  }

  function updateCost() {
    if (kind !== "project" || !info(category.value)?.unit) { cost.textContent = ""; return; }
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
    fillCategories(record?.category);
    category.value = record?.category || expenseCategories()[0].name;
    date.value = record ? record.date : todayISO();
    quantity.value = record?.quantity ?? "";
    rate.value = record?.rate ?? (info(category.value)?.rate ?? "");
    amount.value = record && (kind === "sub" || record.quantity == null) ? record.amount : "";
    applyCategory(false);
    description.placeholder = kind === "sub" ? "e.g. Invoice #1042" : "e.g. Mileage to site visit";
    updateCost();
    updateReceipt();
    deleteBtn.style.display = record ? "" : "none";
    saveBtn.textContent = record ? "Save changes" : kind === "sub" ? "Add invoice" : "Add expense";
    modal.style.display = "flex";
    fitDescription();
    description.focus();
  }

  // The description wraps and grows to fit, so a long one is all visible.
  function fitDescription() {
    description.style.height = "auto";
    description.style.height = `${description.scrollHeight + 3}px`;
  }

  function close() { modal.style.display = "none"; }

  projectSelect.addEventListener("change", () => { if (kind === "sub") fillSubs(projectSelect.value); updateReceipt(); });
  category.addEventListener("change", () => { applyCategory(true); updateReceipt(); });
  description.addEventListener("input", () => { fitDescription(); updateReceipt(); });
  quantity.addEventListener("input", updateCost);
  rate.addEventListener("input", updateCost);
  $("expenseClose").addEventListener("click", close);
  $("expenseCancel").addEventListener("click", close);
  closeOnBackdropClick(modal, close);
  // One line of text that wraps: Enter saves rather than adding a line.
  description.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    saveBtn.click();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!editing || !(await confirmDialog("This can't be undone.", { title: "Delete this expense?", confirmText: "Delete", danger: true }))) return;
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
      const unit = info(category.value)?.unit || "";
      if (!desc) return showToast("Add a description.");
      let money;
      if (unit) {
        const q = Number(quantity.value);
        const r = Number(rate.value);
        if (!(q > 0) || !(r > 0)) return showToast(`Enter the ${plural(unit)} and rate.`);
        money = { quantity: q, rate: r, unit, amount: Math.round(q * r * 100) / 100 };
      } else {
        const total = Number(amount.value);
        if (!(total > 0)) return showToast("Enter the amount.");
        money = { quantity: null, rate: null, unit: null, amount: Math.round(total * 100) / 100 };
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
        : info(data.category)?.receipt ? "Expense added. Remember to email the receipt." : "Expense added.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  return { open };
}
