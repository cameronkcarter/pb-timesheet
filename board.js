// Message Board on the Dashboard: short posts to everyone or to one person,
// optionally about a project. No replies — just a thumbs-up — and each
// person dismisses posts for themselves. The author sees "Seen by N of M"
// (a thumbs-up or a dismissal counts as seen).
//
// It stays small: new posts (up to two, then "N more"), or one line when
// there's nothing new. Dismissed posts and anything older than 30 days are
// under "Earlier".
import { Messages } from "./db.js";
import { esc, showToast, confirmDialog, projectColor, projectShortName, sortProjects } from "./util.js";

const NEW_DAYS = 30;
const SHOW_NEW = 2;
const EARLIER_MAX = 20;
const MAX_LENGTH = 1000;
// Outline thumbs-up (Tabler icons, MIT); filled when you've given one.
const THUMB_SVG = `<svg class="mb-thumb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3" /></svg>`;

export function createMessageBoard({ el, getData, sessionPersonId }) {
  let messages = [];
  let unavailable = false;  // couldn't read posts (rules not deployed yet)
  let composing = null;     // null, or { id (when editing), text, toPersonId, projectId }
  let showAllNew = false;
  let showEarlier = false;

  Messages.listen(sessionPersonId, (list) => {
    messages = list;
    unavailable = false;
    render();
  }, (err) => {
    console.warn("Message Board:", err.code || err);
    unavailable = true;
    render();
  });

  const me = () => getData().people.find((p) => p.id === sessionPersonId);
  const personName = (id) => getData().people.find((p) => p.id === id)?.name || "Someone";
  const firstName = (id) => personName(id).split(/\s+/)[0];
  const initials = (name) => String(name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  function ago(iso) {
    const then = new Date(iso);
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 1) return "Yesterday";
    return then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: then.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  // Who a post is for: one person, or everyone active except its author.
  function audience(m) {
    if (m.toPersonId) return [m.toPersonId];
    return getData().people.filter((p) => !p.inactive && p.id !== m.authorPersonId).map((p) => p.id);
  }

  function seenBy(m) {
    const seen = new Set([...(m.dismissedBy || []), ...(m.thumbsBy || [])]);
    return audience(m).filter((id) => seen.has(id));
  }

  function isNew(m) {
    const recent = Date.now() - new Date(m.postedAt) < NEW_DAYS * 86400000;
    return recent && !(m.dismissedBy || []).includes(sessionPersonId);
  }

  function postHtml(m, { canDismiss }) {
    const { projects } = getData();
    const project = m.projectId && projects.find((p) => p.id === m.projectId);
    const mine = m.authorPersonId === sessionPersonId;
    const thumbs = m.thumbsBy || [];
    const iThumbed = thumbs.includes(sessionPersonId);
    const to = m.toPersonId ? (m.toPersonId === sessionPersonId ? "to you" : `to ${esc(firstName(m.toPersonId))}`) : "";
    let seen = "";
    if (mine) {
      const who = seenBy(m);
      const all = audience(m);
      const left = all.filter((id) => !who.includes(id)).map(personName);
      seen = m.toPersonId
        ? `<span class="mb-seen">${who.length ? "Seen" : "Not seen yet"}</span>`
        : `<span class="mb-seen" title="${left.length ? `Not yet: ${esc(left.join(", "))}` : "Everyone's seen it"}">Seen by ${who.length} of ${all.length}</span>`;
    }
    return `<div class="mb-post ${m.toPersonId ? "mb-direct" : ""}" data-id="${m.id}">
      <div class="mb-avatar" aria-hidden="true">${esc(initials(personName(m.authorPersonId)))}</div>
      <div class="mb-body">
        <div class="mb-meta"><b>${esc(personName(m.authorPersonId))}</b>${to ? ` <span class="mb-to">${to}</span>` : ""} · ${ago(m.postedAt)}${m.editedAt ? " · edited" : ""}
          ${project ? `<span class="mb-project" style="--c:${projectColor(project.id)};" title="${esc(project.name)}">${esc(projectShortName(project))}</span>` : ""}</div>
        <div class="mb-text">${esc(m.text)}</div>
        <div class="mb-foot">
          <button type="button" class="mb-thumb ${iThumbed ? "on" : ""}" data-action="thumb" title="${thumbs.length ? esc(thumbs.map(personName).join(", ")) : "Thumbs up"}" aria-pressed="${iThumbed}" aria-label="Thumbs up">${THUMB_SVG}${thumbs.length ? `<span>${thumbs.length}</span>` : ""}</button>
          ${seen}
          ${mine ? '<button type="button" class="link-btn" data-action="edit">Edit</button>' : ""}
          ${mine || me()?.isAdmin ? '<button type="button" class="link-btn mb-delete" data-action="delete">Delete</button>' : ""}
        </div>
      </div>
      ${canDismiss ? '<button type="button" class="mb-dismiss" data-action="dismiss" title="Hide it for you; it moves to Earlier">Dismiss</button>' : ""}
    </div>`;
  }

  function composerHtml() {
    const { people, projects } = getData();
    const others = people.filter((p) => !p.inactive && p.id !== sessionPersonId).sort((a, b) => a.name.localeCompare(b.name));
    const c = composing;
    return `<div class="mb-compose">
      <textarea class="mb-input" rows="2" maxlength="${MAX_LENGTH}" placeholder="Write a note for the team">${esc(c.text)}</textarea>
      <div class="mb-compose-row">
        <label>To <select class="mb-to-select">
          <option value="">Everyone</option>
          ${others.map((p) => `<option value="${p.id}" ${p.id === c.toPersonId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select></label>
        <label>Project <select class="mb-project-select">
          <option value="">None</option>
          ${sortProjects(projects).map((p) => `<option value="${p.id}" ${p.id === c.projectId ? "selected" : ""}>${esc(projectShortName(p))}</option>`).join("")}
        </select></label>
        <span class="mb-compose-actions">
          <button type="button" class="link-btn" data-action="cancel">Cancel</button>
          <button type="button" class="small" data-action="post">${c.id ? "Save" : "Post"}</button>
        </span>
      </div>
    </div>`;
  }

  function render() {
    // Don't redraw under someone typing a post.
    if (composing && el.contains(document.activeElement) && document.activeElement.matches("textarea, select")) return;
    if (!getData().people.length) return;
    if (unavailable) {
      // Only admins need to know; everyone else just doesn't see it yet.
      el.hidden = !me()?.isAdmin;
      el.innerHTML = `<div class="mb-head"><h3>Message Board</h3></div>
        <div class="empty">Message Board needs the updated security rules (firestore.rules) published in Firebase.</div>`;
      return;
    }
    el.hidden = false;
    const sorted = [...messages].sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
    const fresh = sorted.filter(isNew);
    const earlier = sorted.filter((m) => !isNew(m)).slice(0, EARLIER_MAX);
    const shown = showAllNew ? fresh : fresh.slice(0, SHOW_NEW);
    const quiet = !fresh.length && !composing && !showEarlier;

    el.classList.toggle("mb-quiet", quiet);
    el.innerHTML = `<div class="mb-head">
        <h3>Message Board</h3>
        <span class="mb-count">${fresh.length ? `${fresh.length} new` : "Nothing new"}</span>
        ${earlier.length ? `<button type="button" class="link-btn mb-earlier-btn" data-action="earlier" aria-expanded="${showEarlier}">Earlier (${earlier.length}) <span class="chev ${showEarlier ? "up" : ""}" aria-hidden="true">&#9662;</span></button>` : ""}
        ${composing ? "" : '<button type="button" class="small mb-new" data-action="compose">+ Post</button>'}
      </div>
      ${composing ? composerHtml() : ""}
      ${shown.map((m) => postHtml(m, { canDismiss: true })).join("")}
      ${fresh.length > shown.length ? `<button type="button" class="link-btn mb-more" data-action="more">${fresh.length - shown.length} more</button>` : ""}
      ${showEarlier ? `<div class="mb-earlier">${earlier.map((m) => postHtml(m, { canDismiss: false })).join("")}</div>` : ""}`;

    const input = el.querySelector(".mb-input");
    if (input) fit(input);
  }

  function fit(t) {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  }

  function readComposer() {
    composing.text = el.querySelector(".mb-input").value;
    composing.toPersonId = el.querySelector(".mb-to-select").value || null;
    composing.projectId = el.querySelector(".mb-project-select").value || null;
  }

  async function post() {
    readComposer();
    const text = composing.text.trim();
    if (!text) return showToast("Write something first.");
    const { id, toPersonId, projectId } = composing;
    try {
      if (id) {
        await Messages.update(id, { text, toPersonId, projectId, editedAt: new Date().toISOString() });
      } else {
        await Messages.add({ authorPersonId: sessionPersonId, text, toPersonId, projectId, postedAt: new Date().toISOString() });
      }
      composing = null;
      render();
      showToast(id ? "Post updated." : toPersonId ? `Sent to ${firstName(toPersonId)}.` : "Posted.");
    } catch (err) {
      showToast("Error: " + err.message);
    }
  }

  // Add or remove yourself from one of a post's lists.
  const toggled = (list, on) => {
    const rest = (list || []).filter((x) => x !== sessionPersonId);
    return on ? [...rest, sessionPersonId] : rest;
  };

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action } = btn.dataset;
    const m = messages.find((x) => x.id === btn.closest(".mb-post")?.dataset.id);
    if (action === "compose") {
      composing = { id: null, text: "", toPersonId: null, projectId: null };
      render();
      el.querySelector(".mb-input")?.focus();
      return;
    }
    if (action === "cancel") { composing = null; render(); return; }
    if (action === "post") return post();
    if (action === "earlier") { showEarlier = !showEarlier; render(); return; }
    if (action === "more") { showAllNew = true; render(); return; }
    if (!m) return;
    try {
      if (action === "thumb") {
        await Messages.update(m.id, { thumbsBy: toggled(m.thumbsBy, !(m.thumbsBy || []).includes(sessionPersonId)) });
      }
      if (action === "dismiss") {
        await Messages.update(m.id, { dismissedBy: toggled(m.dismissedBy, true) });
        showToast("Dismissed. It's under Earlier.", {
          action: "Undo",
          onAction: () => Messages.update(m.id, { dismissedBy: toggled(m.dismissedBy, false) }).catch((err) => showToast("Error: " + err.message)),
        });
      }
      if (action === "edit") {
        composing = { id: m.id, text: m.text, toPersonId: m.toPersonId || null, projectId: m.projectId || null };
        render();
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        el.querySelector(".mb-input")?.focus();
      }
      if (action === "delete") {
        if (!(await confirmDialog("This can't be undone.", { title: "Delete this post?", confirmText: "Delete", danger: true }))) return;
        await Messages.remove(m.id);
        showToast("Post deleted.");
      }
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  el.addEventListener("input", (e) => {
    if (!e.target.matches(".mb-input")) return;
    composing.text = e.target.value;
    fit(e.target);
  });
  el.addEventListener("keydown", (e) => {
    if (!e.target.matches(".mb-input")) return;
    if (e.key === "Escape") { composing = null; render(); }
    // Ctrl/Cmd+Enter posts; plain Enter is a new line.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post();
  });
  // Keep what's typed if the page redraws while choosing To / Project.
  el.addEventListener("change", (e) => { if (composing && e.target.closest(".mb-compose")) readComposer(); });

  return { render };
}
