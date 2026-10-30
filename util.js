// Escape text for safe use inside HTML (names, notes, etc.).
export function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatCurrency(n) {
  return (n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Local date, not UTC — otherwise after ~6pm Mountain "today" becomes tomorrow.
export function todayISO() {
  return toISODate(new Date());
}

// Project colors: the one an admin picked in Edit project (project.color),
// or else a stable one from the project id (same color on every page).
// db.js passes every projects update to setProjectColors, so pages keep
// calling projectColor(id).
const PROJECT_COLORS = [
  "#2f6db5", "#2e8b57", "#c0632a", "#8e44ad", "#b8860b",
  "#c0392b", "#16808a", "#6d4c41", "#d14d8a", "#4a5d23",
];
// Swatches offered in Edit project: the defaults plus a few brand tones.
export const PROJECT_COLOR_CHOICES = [...PROJECT_COLORS, "#6e3073", "#4a5fa8", "#2a8a8a", "#6f6874"];

const chosenColors = new Map();
export function setProjectColors(projects) {
  chosenColors.clear();
  projects.forEach((p) => { if (p.color) chosenColors.set(p.id, p.color); });
}

// Short name for chips: the one set in Edit project, or the name's first
// words up to about 16 characters.
export function projectShortName(project) {
  if (!project) return "";
  if (project.shortName) return project.shortName;
  const words = String(project.name || "").split(/\s+/);
  let out = words[0] || "";
  for (const w of words.slice(1)) {
    if ((out + " " + w).length > 16) break;
    out += " " + w;
  }
  return out;
}

export function projectColor(projectId) {
  if (chosenColors.has(projectId)) return chosenColors.get(projectId);
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

// Compact M/D/YY format matching the invoice template (e.g. "8/1/26").
export function formatShortMDY(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`;
}

let toastTimer;
// A subtask's buttons at the right of its row: Edit, then ✓ to mark it
// complete (↺ to reopen a completed one), then × to delete.
export function subtaskActionsHtml(d, { canComplete = true, canManage = false } = {}) {
  const btn = (action, title, symbol, cls = "") => `<button type="button" class="icon-btn sub-act ${cls}" data-action="${action}" data-id="${d.id}" title="${title}" aria-label="${title}">${symbol}</button>`;
  return [
    canManage && !d.completed ? `<button type="button" class="link-btn" data-action="edit-duedate" data-id="${d.id}">Edit</button>` : "",
    canComplete ? (d.completed ? btn("reopen-duedate", "Reopen", "&#8634;") : btn("complete-duedate", "Mark complete", "&#10003;", "sub-act-done")) : "",
    canManage ? btn("delete-duedate", "Delete", "&times;") : "",
  ].join("");
}

// showToast("Marked complete.", { action: "Undo", onAction }) adds a button
// and stays up longer so there's time to use it.
export function showToast(message, { action, onAction } = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action;
    btn.addEventListener("click", () => {
      el.classList.remove("show");
      onAction();
    });
    el.append(btn);
  }
  el.classList.toggle("has-action", !!action);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), action ? 6000 : 2500);
}

// Project order everywhere: client projects newest first (most recently
// added at the top), then internal projects (e.g. Proposals & Pursuits).
function createdMillis(p) {
  const c = p && p.createdAt;
  if (!c) return 0;
  if (typeof c.toMillis === "function") return c.toMillis();
  if (typeof c.seconds === "number") return c.seconds * 1000;
  const t = Date.parse(c);
  return isNaN(t) ? 0 : t;
}

export function sortProjects(list) {
  return [...list].sort((a, b) =>
    (!!a.internal - !!b.internal) || (createdMillis(b) - createdMillis(a)) || String(a.name).localeCompare(String(b.name)));
}

export function fmtHrs(n) {
  return (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// A person's hours as a bar as long as the larger of assigned and logged:
// dark for logged, light for what's left, red for hours logged past what was
// assigned, with a label under it. Bars drawn with the same scale (the longest
// in a list, see hoursScale) compare by length.
export function hoursBarHtml(assigned, logged, scale) {
  const done = Math.min(logged, assigned);
  const left = Math.max(0, assigned - logged);
  const over = Math.max(0, logged - assigned);
  const total = done + left + over;
  const pct = (n) => `${total ? (n / total) * 100 : 0}%`;
  const label = total === 0 ? `<span class="hb-none">No hours assigned</span>`
    : `<b>${fmtHrs(logged)} hrs logged</b> · ${over ? `<span class="hb-over-txt">${fmtHrs(over)} over</span>` : `${fmtHrs(left)} left`}`;
  return `<div class="hb-bar" style="width:${(total / scale) * 100}%;">
      <span class="hb-logged" style="width:${pct(done)};"></span><span class="hb-left" style="width:${pct(left)};"></span><span class="hb-over" style="width:${pct(over)};"></span>
    </div><div class="hb-label">${label}</div>`;
}

// The scale for a list of { assigned, logged }: its longest bar.
export const hoursScale = (rows) => Math.max(1, ...rows.map((r) => Math.max(r.assigned, r.logged)));

// "Tue, Oct 14" for a time entry's date.
export const entryDate = (iso) => new Date(iso + "T00:00:00")
  .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// "Oct 14", "Oct 14 – 16" or "Sep 30 – Oct 2" for a set of entries.
export function dateRange(entries) {
  const dates = entries.map((e) => e.date).sort();
  const fmt = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);
  const a = dates[0];
  const b = dates[dates.length - 1];
  if (a === b) return fmt(a, { month: "short", day: "numeric" });
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { day: "numeric" })}`
    : `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { month: "short", day: "numeric" })}`;
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
// Three layers: invoiced (darkest), logged/spent, and assigned-but-not-yet-
// logged (lightest), each as a share of the budget.
export function budgetBarHtml(spent, committed, budget, large = false, invoiced = 0) {
  const pct = (v) => (budget > 0 ? Math.min(100, (v / budget) * 100) : (v > 0 ? 100 : 0));
  const spentOver = spent - budget > 0.005;
  const committedOver = committed - budget > 0.005;
  const title = `Invoiced ${formatCurrency(invoiced)} · Logged ${formatCurrency(spent)} · Logged + assigned ${formatCurrency(committed)} · Budget ${formatCurrency(budget)}`;
  return `<div class="progress-bar budget-progress ${large ? "large" : ""}" title="${title}">
    <div class="fill assigned ${committedOver ? "over" : ""}" style="width:${pct(committed)}%"></div>
    <div class="fill spent ${spentOver ? "over" : ""}" style="width:${pct(spent)}%"></div>
    ${invoiced > 0.005 ? `<div class="fill invoiced" style="width:${pct(invoiced)}%"></div>` : ""}
  </div>`;
}

// One assignment / subtask (a dated to-do for a person, e.g. "Draft memo —
// due Oct 20"), shown under the task it belongs to. Open items get a
// "Mark complete" button; completed ones show a check and "Reopen".
export function dueItemHtml(d, { canComplete = false, canEdit = false, canDelete = false, who = "" } = {}) {
  const today = todayISO();
  const overdue = !d.completed && d.dueDate < today;
  const soon = !d.completed && !overdue && daysBetween(today, d.dueDate) <= 3;
  const short = (iso) => {
    const dt = new Date(iso + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric",
      ...(dt.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  };
  const days = daysBetween(today, d.dueDate);
  const rel = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 ? `in ${days} days`
    : days === -1 ? "1 day overdue" : `${-days} days overdue`;
  const when = d.completed
    ? `Done${d.completedDate ? " " + short(String(d.completedDate).slice(0, 10)) : ""}`
    : `${short(d.dueDate)} &middot; ${rel}`;
  const action = !canComplete ? ""
    : d.completed
      ? `<button type="button" class="small secondary due-btn" data-action="reopen-duedate" data-id="${d.id}">Reopen</button>`
      : `<button type="button" class="small due-btn due-complete" data-action="complete-duedate" data-id="${d.id}">Mark complete</button>`;
  return `<div class="due-item ${d.completed ? "done" : ""} ${overdue ? "overdue" : ""} ${soon ? "soon" : ""}">
    <span class="due-mark" aria-hidden="true">${d.completed ? "&#10003;" : ""}</span>
    <span class="due-title" title="${esc(d.title)}">${esc(d.title)}${who ? ` <span class="due-who">${esc(who)}</span>` : ""}</span>
    <span class="due-when">${when}</span>
    ${canEdit && !d.completed ? `<button type="button" class="link-btn due-edit" data-action="edit-duedate" data-id="${d.id}">Edit</button>` : ""}
    ${action}
    ${canDelete ? `<button type="button" class="icon-btn due-delete" data-action="delete-duedate" data-id="${d.id}" title="Delete" aria-label="Delete">&times;</button>` : ""}
  </div>`;
}

// Branded stand-ins for the browser's alert() and confirm(): a small card
// centered over the page. Paragraphs in the message are split on blank
// lines. Both resolve once answered — confirmDialog to true (OK) or false
// (Cancel, Escape, or a click outside).
//   if (!(await confirmDialog("Delete this?", { confirmText: "Delete", danger: true }))) return;
export function showDialog({ title = "", message = "", confirmText = "OK", cancelText = null, danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    const text = String(message || "").trim();
    const paragraphs = text ? text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "";
    overlay.innerHTML = `<div class="dialog-card" role="alertdialog" aria-modal="true" ${title ? 'aria-labelledby="dialogTitle"' : ""} aria-describedby="dialogBody">
      ${title ? `<h2 id="dialogTitle">${esc(title)}</h2>` : ""}
      <div id="dialogBody" class="dialog-body">${paragraphs}</div>
      <div class="dialog-actions">
        ${cancelText ? `<button type="button" class="secondary" data-answer="no">${esc(cancelText)}</button>` : ""}
        <button type="button" class="${danger ? "danger" : ""}" data-answer="yes">${esc(confirmText)}</button>
      </div>
    </div>`;
    const lastFocus = document.activeElement;
    const done = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    overlay.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-answer]");
      if (btn) done(btn.dataset.answer === "yes");
      else if (e.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-answer="yes"]').focus();
  });
}

export const alertDialog = (message, title = "") => showDialog({ title, message });

export const confirmDialog = (message, { title = "", confirmText = "OK", danger = false } = {}) =>
  showDialog({ title, message, confirmText, cancelText: "Cancel", danger });
