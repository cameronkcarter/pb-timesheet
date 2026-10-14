import { People } from "./db.js";
import { setSessionPersonId, startTestSession } from "./session.js";
import { esc } from "./util.js";

// Login: pick your name (last person to log in on this device is listed
// first), then type your password (if they have one) and log in. Test Mode is a
// small link under the selected person.

const LAST_PERSON_KEY = "pb_last_person_id"; // survives logging out, unlike the session

let people = [];
let selectedPersonId = null;

const personList = document.getElementById("personList");
const personListEmpty = document.getElementById("personListEmpty");
const personListLoading = document.getElementById("personListLoading");

function lastPersonId() {
  try { return localStorage.getItem(LAST_PERSON_KEY); } catch { return null; }
}

function rememberPerson(id) {
  try { localStorage.setItem(LAST_PERSON_KEY, id); } catch { /* not critical */ }
}

function initials(name) {
  return String(name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function avatarColor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 42%, 42%)`;
}

People.listen((data) => {
  people = data.filter((p) => !p.inactive); // deactivated people can't log in
  if (!selectedPersonId) {
    const last = lastPersonId();
    if (last && people.some((p) => p.id === last)) selectedPersonId = last;
  }
  render();
});

function sortedPeople() {
  const last = lastPersonId();
  return [...people].sort((a, b) => (b.id === last) - (a.id === last) || a.name.localeCompare(b.name));
}

function render() {
  personListLoading.style.display = "none";
  if (people.length === 0) {
    personList.innerHTML = "";
    personListEmpty.style.display = "block";
    return;
  }
  personListEmpty.style.display = "none";
  const last = lastPersonId();

  personList.innerHTML = sortedPeople().map((p) => {
    const selected = p.id === selectedPersonId;
    return `<div class="login-person ${selected ? "selected" : ""}" role="listitem">
      <button type="button" class="login-person-btn" data-person="${p.id}" aria-expanded="${selected}">
        <span class="login-avatar" style="background:${avatarColor(p.id)};">${esc(initials(p.name))}</span>
        <span class="login-person-name">${esc(p.name)}</span>
        ${p.id === last ? '<span class="login-last">Last signed in</span>' : ""}
        <span class="login-chevron" aria-hidden="true">&rsaquo;</span>
      </button>
      ${selected ? loginPanelHtml(p) : ""}
    </div>`;
  }).join("");

  const pw = personList.querySelector(".login-password");
  if (pw) pw.focus();
}

function loginPanelHtml(person) {
  return `<div class="login-panel">
    ${person.password ? `<input type="password" class="login-password" placeholder="Password" autocomplete="current-password" />
      <div class="login-error" style="display:none;">That password isn't right — try again.</div>` : ""}
    <button type="button" class="login-btn" data-action="login">Log in</button>
    <button type="button" class="login-test-link" data-action="test">Try Test Mode instead <span>(nothing is saved)</span></button>
  </div>`;
}

function passwordOk(person) {
  if (!person.password) return true;
  const input = personList.querySelector(".login-password");
  if (input && input.value === person.password) return true;
  const error = personList.querySelector(".login-error");
  if (error) error.style.display = "block";
  const panel = personList.querySelector(".login-panel");
  if (panel) {
    panel.classList.remove("shake");
    void panel.offsetWidth; // restart the animation
    panel.classList.add("shake");
  }
  if (input) { input.select(); input.focus(); }
  return false;
}

function go(testMode) {
  const person = people.find((p) => p.id === selectedPersonId);
  if (!person || !passwordOk(person)) return;
  rememberPerson(person.id);
  if (testMode) startTestSession(person.id); else setSessionPersonId(person.id);
  window.location.href = "dashboard.html";
}

personList.addEventListener("click", (e) => {
  const personBtn = e.target.closest(".login-person-btn");
  if (personBtn) {
    const id = personBtn.dataset.person;
    selectedPersonId = selectedPersonId === id ? null : id;
    render();
    return;
  }
  const action = e.target.closest("[data-action]");
  if (action) go(action.dataset.action === "test");
});

personList.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("login-password")) go(false);
});
