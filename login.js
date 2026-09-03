import { People } from "./db.js";
import { setSessionPersonId, startTestSession } from "./session.js";

let people = [];
let selectedPersonId = null;

const personCardsEl = document.getElementById("personCards");
const personCardsEmpty = document.getElementById("personCardsEmpty");
const loginAction = document.getElementById("loginAction");
const loginName = document.getElementById("loginName");
const loginPasswordField = document.getElementById("loginPasswordField");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");

People.listen((data) => {
  people = data;
  render();
});

function render() {
  if (people.length === 0) {
    personCardsEl.innerHTML = "";
    personCardsEmpty.style.display = "block";
    return;
  }
  personCardsEmpty.style.display = "none";
  personCardsEl.innerHTML = people.map((p) => `
    <div class="project-card ${p.id === selectedPersonId ? "active" : ""}" data-person-card="${p.id}">
      <div class="name">${p.name}</div>
    </div>
  `).join("");
}

personCardsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".project-card");
  if (!card) return;
  selectedPersonId = card.dataset.personCard;
  const person = people.find((p) => p.id === selectedPersonId);
  loginName.textContent = person ? person.name : "";
  loginAction.style.display = "flex";
  loginPasswordField.style.display = person && person.password ? "block" : "none";
  loginPassword.value = "";
  loginError.style.display = "none";
  render();
});

function checkPassword() {
  const person = people.find((p) => p.id === selectedPersonId);
  if (!person || !person.password) return true;
  if (loginPassword.value === person.password) return true;
  loginError.style.display = "block";
  return false;
}

document.getElementById("loginBtn").addEventListener("click", () => {
  if (!selectedPersonId) return;
  if (!checkPassword()) return;
  setSessionPersonId(selectedPersonId);
  window.location.href = "dashboard.html";
});

document.getElementById("testLoginBtn").addEventListener("click", () => {
  if (!selectedPersonId) return;
  if (!checkPassword()) return;
  startTestSession(selectedPersonId);
  window.location.href = "dashboard.html";
});

loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("loginBtn").click();
});
