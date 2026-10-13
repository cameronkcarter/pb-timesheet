// Two rates apply to every hour logged, both set per person in Admin:
//   Pay rate  (person.rate)     — what the person earns. Locked onto each
//               time entry when it's logged (entry.rate), falling back to the
//               person's current rate for old entries logged before that.
//   Bill rate (person.billRate) — what the client is charged for that
//               person's hours, and what project budgets are spent at. Locked
//               onto each entry when it's invoiced (entry.billRate), so rate
//               changes later never rewrite past invoices. Falls back to the
//               pay rate if a person has no bill rate set.
//
// Projects choose how they bill:
//   default                  — each person's bill rate
//   project.billAtPayRate    — each person's pay rate (older contracts with no
//                              overhead, e.g. Cache County)
//   project.internal         — not billed or paid at all (e.g. Proposals &
//                              Pursuits); only hours are tracked
//
// Assignments are hours (assignment.hours). Older assignments stored a dollar
// amount (capValue) instead; assignedHours() converts those on read.

// Firm's standard bill rate, pre-filled when adding a person in Admin.
export const DEFAULT_BILL_RATE = 150;

function findProject(projectId, projects) {
  return projects.find((p) => p.id === projectId);
}

function findPerson(personId, people) {
  return people.find((p) => p.id === personId);
}

export function isInternal(project) {
  return !!(project && project.internal);
}

export function personPayRate(person) {
  return person ? Number(person.rate || 0) : 0;
}

export function personBillRate(person) {
  if (!person) return 0;
  return person.billRate != null && person.billRate !== "" ? Number(person.billRate) : Number(person.rate || 0);
}

export function payRateOf(entry, { projects, people }) {
  if (isInternal(findProject(entry.projectId, projects))) return 0;
  return entry.rate != null ? Number(entry.rate) : personPayRate(findPerson(entry.personId, people));
}

export function billRateOf(entry, { projects, people }) {
  const project = findProject(entry.projectId, projects);
  if (isInternal(project)) return 0;
  // Invoiced hours keep the rate they were billed at. Hours invoiced before
  // bill rates existed were billed at the person's pay rate.
  if (entry.invoiced) return entry.billRate != null ? Number(entry.billRate) : payRateOf(entry, { projects, people });
  if (project && project.billAtPayRate) return payRateOf(entry, { projects, people });
  return personBillRate(findPerson(entry.personId, people));
}

// What an hour of this person's time costs the project's budget.
export function assignmentRate(project, person) {
  if (isInternal(project)) return 0;
  if (project && project.billAtPayRate) return personPayRate(person);
  return personBillRate(person);
}

export function assignedHours(assignment, { projects, people }) {
  if (assignment.hours != null) return Number(assignment.hours);
  // Legacy dollar assignment: convert at the rate it was entered against
  // (a project-wide rate, if the project had one then, else the pay rate).
  const project = findProject(assignment.projectId, projects);
  const rate = project && project.billRate
    ? Number(project.billRate)
    : personPayRate(findPerson(assignment.personId, people));
  return rate > 0 ? Number(assignment.capValue || 0) / rate : 0;
}

export function billedAmount(entries, ctx) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * billRateOf(e, ctx), 0);
}

export function paidAmount(entries, ctx) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * payRateOf(e, ctx), 0);
}

// How much of a task's budget is used up and spoken for:
//   spent      — hours logged so far, at their bill rates
//   committed  — spent, plus each person's assigned hours not yet logged (at
//                their rate). Logging past an assignment just adds to spent,
//                so a task can never look over budget and have budget left.
//   unassigned — budget not yet spent or handed out (negative = over)
// hoursOverride ({ assignmentId: hours }) lets callers preview unsaved edits.
export function taskBudgetUse(task, { projects, people, assignments, timeEntries }, hoursOverride = {}) {
  const project = findProject(task.projectId, projects);
  const ctx = { projects, people };
  const entries = timeEntries.filter((e) => e.taskId === task.id);
  const spent = billedAmount(entries, ctx);
  let outstanding = 0;
  assignments.filter((a) => a.taskId === task.id).forEach((a) => {
    const hours = a.id in hoursOverride ? hoursOverride[a.id] : assignedHours(a, ctx);
    const logged = entries.filter((e) => e.personId === a.personId).reduce((s, e) => s + Number(e.hours || 0), 0);
    outstanding += Math.max(0, hours - logged) * assignmentRate(project, findPerson(a.personId, people));
  });
  const budget = Number(task.budget || 0);
  return { budget, spent, committed: spent + outstanding, unassigned: budget - spent - outstanding };
}
