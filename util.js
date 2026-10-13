export function formatCurrency(n) {
  return (n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function daysAgo(dateStr) {
  if (!dateStr) return "";
  const then = new Date(dateStr);
  const diffMs = Date.now() - then.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

// Local date, not UTC — otherwise after ~6pm Mountain "today" becomes tomorrow.
export function todayISO() {
  return toISODate(new Date());
}

// Stable color per project (same project = same color on every page).
const PROJECT_COLORS = [
  "#2f6db5", "#2e8b57", "#c0632a", "#8e44ad", "#b8860b",
  "#c0392b", "#16808a", "#6d4c41", "#d14d8a", "#4a5d23",
];
export function projectColor(projectId) {
  let hash = 0;
  for (const ch of String(projectId || "")) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

export function toISODate(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// Sunday-start week containing the given date.
export function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Whole days between two "YYYY-MM-DD" strings (can be negative).
export function daysBetween(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  return Math.round((end - start) / 86400000);
}

export function formatShortDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatWeekday(date) {
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

// Human-readable countdown/overdue label for a due date.
export function dueLabel(dateStr) {
  if (!dateStr) return "";
  const today = new Date(todayISO() + "T00:00:00");
  const due = new Date(dateStr + "T00:00:00");
  const days = Math.round((due - today) / 86400000);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 1) return `Due in ${days} days`;
  if (days === -1) return "1 day overdue";
  return `${-days} days overdue`;
}

export function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

export function lastDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function formatMonthLabel(date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function formatMonthShort(date) {
  return date.toLocaleDateString("en-US", { month: "long" });
}

// Compact M/D/YY format matching the invoice template (e.g. "8/1/26").
export function formatShortMDY(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`;
}

let toastTimer;
export function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// Hours bar for someone's assignment. Leads with hours REMAINING (the number
// people act on), with logged and assigned alongside. The whole bar is the
// assignment, filled in the project color as hours are logged. Logging past the assignment is allowed (more
// hours are often added later), so it shows in amber, not as an error.
export function hoursBarHtml(logged, assigned, color, large = false) {
  const pct = assigned > 0 ? Math.min(100, (logged / assigned) * 100) : (logged > 0 ? 100 : 0);
  const over = logged - assigned > 0.005;
  const headline = assigned <= 0 && logged <= 0
    ? "No hours assigned"
    : over ? `${fmtHrs(logged - assigned)} hrs over` : `${fmtHrs(assigned - logged)} hrs remaining`;
  return `<div class="hours-bar-wrap">
    <div class="progress-bar hours-progress ${large ? "large" : "task-bar"} ${over ? "over" : ""}" style="--c:${color};">
      <div class="fill logged" style="width:${pct}%"></div>
    </div>
    <div class="hours-captions">
      <span class="hours-left ${over ? "hours-over" : ""}">${headline}</span>
      <span>${fmtHrs(logged)} logged of ${fmtHrs(assigned)} assigned</span>
    </div>
  </div>`;
}

export function fmtHrs(n) {
  return (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Close a modal when its dark backdrop is clicked — but only if the click
// both started and ended on the backdrop. Otherwise dragging to select text
// in a field and releasing outside the dialog would close it.
export function closeOnBackdropClick(overlay, close) {
  let downOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener("click", (e) => {
    if (downOnBackdrop && e.target === overlay) close();
    downOnBackdrop = false;
  });
}

// Task budget bar: spent (solid) over committed — spent plus assigned hours
// not yet logged — (lighter), both as a share of the budget. The light part
// turns red if assignments push the task past its budget.
export function budgetBarHtml(spent, committed, budget, large = false) {
  const pct = (v) => (budget > 0 ? Math.min(100, (v / budget) * 100) : (v > 0 ? 100 : 0));
  const spentOver = spent - budget > 0.005;
  const committedOver = committed - budget > 0.005;
  const title = `Spent ${formatCurrency(spent)} · Spent + assigned ${formatCurrency(committed)} · Budget ${formatCurrency(budget)}`;
  return `<div class="progress-bar budget-progress ${large ? "large" : ""}" title="${title}">
    <div class="fill assigned ${committedOver ? "over" : ""}" style="width:${pct(committed)}%"></div>
    <div class="fill spent ${spentOver ? "over" : ""}" style="width:${pct(spent)}%"></div>
  </div>`;
}
