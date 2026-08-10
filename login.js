import { People } from "./db.js";
import { setSessionPersonId, startTestSession } from "./session.js";

let people = [];
let selectedPersonId = null;

const personCardsEl = document.getElementById("personCards");
const personCardsEmpty = document.getElementById("personCardsEmpty");
const loginAction = document.getElementById("loginAction");
const loginName = document.getElementById("loginName");

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
  loginAction.style.display = "block";
  render();
});

document.getElementById("loginBtn").addEventListener("click", () => {
  if (!selectedPersonId) return;
  setSessionPersonId(selectedPersonId);
  window.location.href = "dashboard.html";
});

document.getElementById("testLoginBtn").addEventListener("click", () => {
  if (!selectedPersonId) return;
  startTestSession(selectedPersonId);
  window.location.href = "dashboard.html";
});
