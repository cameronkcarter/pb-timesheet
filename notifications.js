// Notifications: a bell in the top bar, beside your name, listing what
// someone else changed about your hours and expenses (approved, declined,
// edited, moved back to pending, invoiced, reimbursed) and tasks you were
// added to.
//
// Each is a document written by whoever made the change (an admin or the
// project's manager; see firestore.rules):
// { personId (to), byPersonId, projectId, text, link, at (ISO), read }
// The bell counts the unread ones; opening it marks them read. Read ones
// older than 60 days are cleared out when you load a page. You aren't
// notified about your own changes, except in Test Mode, so it can be tried
// alone.
import { Notifications } from "./db.js";
import { isTestMode } from "./session.js";
import { esc, fmtHrs, formatCurrency, dateRange, projectShortName } from "./util.js";

const KEEP_DAYS = 60;
const SHOW_MAX = 40;

// Sends one notification. Never throws: a notification that can't be sent
// shouldn't undo the change it's about. Returns its id (for Undo), or null.
export async function notify({ to, by, projectId = null, text, link = null }) {
  if (!to || (to === by && !isTestMode())) return null;
  try {
    const ref = await Notifications.add({
      personId: to, byPersonId: by, projectId, text, link, at: new Date().toISOString(), read: false,
    });
    return ref?.id || null;
  } catch (err) {
    console.warn("Couldn't send a notification.", err);
    return null;
  }
}

// Takes back notifications (e.g. after Undo).
export function unnotify(ids) {
  return Promise.all([].concat(ids).filter(Boolean).map((id) => Notifications.remove(id).catch(() => {})));
}

// One notification per person and project for a set of hours and expenses
// (expenses tagged isExpense, like on Approvals):
// "Dana Lee approved your 7.5 hrs on Ogden Downtown (Oct 2 – 9)". `after`
// is added to the end; `what` replaces "your 7.5 hrs". Returns the ids.
export function notifyEntries(entries, { by, data, verb, after = "", what = null }) {
  const { people = [], projects = [] } = data;
  const name = people.find((p) => p.id === by)?.name || "Someone";
  const groups = new Map();
  entries.forEach((e) => {
    if (!e || (e.isExpense && e.kind === "sub")) return;
    const to = e.isExpense ? e.personId || e.createdByPersonId : e.personId;
    const key = `${to}|${e.projectId}`;
    if (!groups.has(key)) groups.set(key, { to, projectId: e.projectId, list: [] });
    groups.get(key).list.push(e);
  });
  return Promise.all([...groups.values()].map(({ to, projectId, list }) => {
    const project = projects.find((p) => p.id === projectId);
    const hours = list.filter((e) => !e.isExpense);
    const exps = list.filter((e) => e.isExpense);
    const amounts = [
      hours.length ? `${fmtHrs(hours.reduce((s, e) => s + Number(e.hours || 0), 0))} hrs` : "",
      exps.length ? `${formatCurrency(exps.reduce((s, e) => s + Number(e.amount || 0), 0))} ${exps.length === 1 ? "expense" : "in expenses"}` : "",
    ].filter(Boolean).join(" and ");
    const latest = hours.map((e) => e.date).sort().pop();
    return notify({
      to, by, projectId,
      text: `${name} ${verb} ${what || `your ${amounts}`} on ${project ? projectShortName(project) : "a project"} (${dateRange(list)})${after}`,
      link: latest ? `timesheet.html?day=${latest}` : "dashboard.html",
    });
  }));
}

// ---------- The bell ----------
const BELL = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16l-2-2zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// "Just now", "5m", "3h", "Yesterday", "Oct 12".
function ago(iso) {
  const then = new Date(iso);
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return "Yesterday";
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Adds the bell just left of your name in the top bar (once per page).
export function mountBell(person) {
  const nameEl = document.getElementById("navUserName");
  if (!person || !nameEl || document.getElementById("notifBell")) return;
  const wrap = document.createElement("div");
  wrap.className = "notif";
  wrap.innerHTML = `<button type="button" id="notifBell" class="notif-bell" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
      ${BELL}<span class="notif-count" hidden></span>
    </button>
    <div class="notif-panel" role="dialog" aria-label="Notifications" hidden></div>`;
  nameEl.before(wrap);
  const bell = wrap.querySelector(".notif-bell");
  const count = wrap.querySelector(".notif-count");
  const panel = wrap.querySelector(".notif-panel");

  let list = [];
  let fresh = new Set(); // unread when the panel opened; stay highlighted while it's open
  let pruned = false;

  function renderCount() {
    const unread = list.filter((n) => !n.read).length;
    count.hidden = !unread;
    count.textContent = unread > 9 ? "9+" : unread;
    bell.setAttribute("aria-label", unread ? `Notifications (${unread} new)` : "Notifications");
  }

  function renderPanel() {
    const shown = list.slice(0, SHOW_MAX);
    panel.innerHTML = `<div class="notif-head">Notifications</div>
      ${shown.length
        ? `<div class="notif-list">${shown.map((n) => `<a class="notif-item ${fresh.has(n.id) ? "unread" : ""}" href="${esc(n.link || "#")}">
            <span class="notif-text">${esc(n.text)}</span>
            <span class="notif-time">${esc(ago(n.at))}</span>
          </a>`).join("")}</div>`
        : `<div class="notif-empty">Nothing yet. You'll see here when your hours or expenses are approved, declined or changed.</div>`}`;
  }

  function open() {
    fresh = new Set(list.filter((n) => !n.read).map((n) => n.id));
    renderPanel();
    panel.hidden = false;
    bell.setAttribute("aria-expanded", "true");
    fresh.forEach((id) => Notifications.update(id, { read: true }).catch(() => {}));
  }
  function close() {
    panel.hidden = true;
    bell.setAttribute("aria-expanded", "false");
    fresh = new Set();
  }

  bell.addEventListener("click", () => (panel.hidden ? open() : close()));
  document.addEventListener("click", (e) => { if (!panel.hidden && !wrap.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { close(); bell.focus(); } });

  Notifications.listen(person.id, (docs) => {
    list = docs.sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!pruned) {
      pruned = true;
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
      list.filter((n) => n.read && n.at < cutoff).forEach((n) => Notifications.remove(n.id).catch(() => {}));
    }
    renderCount();
    if (!panel.hidden) renderPanel();
  }, () => wrap.remove()); // can't be read (e.g. rules not deployed yet): no bell
}
