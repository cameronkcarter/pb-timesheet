// The Approvals tab: hours and expenses waiting on a project manager or
// admin (see approvals.js). Others are sent to the Dashboard.
import { People, Projects, Tasks, Assignments, TimeEntries, Expenses } from "./db.js";
import { formatCurrency, fmtHrs } from "./util.js";
import { requireSession, wireLogout, applyAdminNavVisibility, renderNavUserName } from "./session.js";
import { createApprovals, canApprove } from "./approvals.js";

const sessionPersonId = requireSession();

let people = [];
let projects = [];
let tasks = [];
let assignments = [];
let timeEntries = [];
let expenses = [];
let peopleLoaded = false;
let projectsLoaded = false;
let navDone = false;

wireLogout("logoutLink");

const summary = document.getElementById("approvalSummary");
const approvals = createApprovals({
  getData: () => ({ people, projects, tasks, assignments, timeEntries, expenses }),
  sessionPersonId,
  onChange: (s) => {
    summary.textContent = s.count
      ? `${[
        s.hours ? `${fmtHrs(s.hours)} hrs` : "",
        s.expenses ? `${formatCurrency(s.expenses)} expenses` : "",
      ].filter(Boolean).join(" · ")} waiting from ${s.people} ${s.people === 1 ? "person" : "people"}.`
      : "Nothing waiting.";
  },
});

function render() {
  if (!peopleLoaded || !projectsLoaded) return;
  const me = people.find((p) => p.id === sessionPersonId);
  if (!canApprove(me, projects)) {
    window.location.href = "dashboard.html";
    return;
  }
  applyAdminNavVisibility(me, projects);
  if (!navDone) {
    navDone = true;
    renderNavUserName(me);
  }
  approvals.render();
}

if (sessionPersonId) {
  People.listen((d) => { people = d; peopleLoaded = true; render(); });
  Projects.listen((d) => { projects = d; projectsLoaded = true; render(); });
  Tasks.listen((d) => { tasks = d; render(); });
  Assignments.listen((d) => { assignments = d; render(); });
  TimeEntries.listen((d) => { timeEntries = d; render(); });
  Expenses.listen((d) => { expenses = d; render(); });
}
