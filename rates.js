// Two rates apply to every hour logged:
//   Pay rate  — what the person earns. Locked onto each time entry when it's
//               logged (entry.rate), falling back to the person's current rate
//               for old entries logged before that existed.
//   Bill rate — what the client is charged, and what project budgets are spent
//               at. Set per project (project.billRate). Projects with no bill
//               rate bill each person at their own pay rate (e.g. Cache
//               County). Locked onto each entry when it's invoiced
//               (entry.billRate), so changing a project's rate later never
//               rewrites past invoices.
//
// Internal projects (project.internal, e.g. Proposals & Pursuits) are neither
// billed nor paid: both rates are $0 and only hours are tracked.
//
// Assignments are hours (assignment.hours). Older assignments stored a dollar
// amount (capValue) instead; assignedHours() converts those on read.

// Firm-wide standard billing rate, pre-filled on new projects in Admin.
export const DEFAULT_BILL_RATE = 150;

function findProject(projectId, projects) {
  return projects.find((p) => p.id === projectId);
}

function personRate(personId, people) {
  const person = people.find((p) => p.id === personId);
  return person ? Number(person.rate || 0) : 0;
}

export function isInternal(project) {
  return !!(project && project.internal);
}

export function payRateOf(entry, { projects, people }) {
  if (isInternal(findProject(entry.projectId, projects))) return 0;
  return entry.rate != null ? Number(entry.rate) : personRate(entry.personId, people);
}

export function billRateOf(entry, { projects, people }) {
  const project = findProject(entry.projectId, projects);
  if (isInternal(project)) return 0;
  // Invoiced hours keep the rate they were billed at. Hours invoiced before
  // bill rates existed were billed at the person's pay rate.
  if (entry.invoiced) return entry.billRate != null ? Number(entry.billRate) : payRateOf(entry, { projects, people });
  if (project && project.billRate) return Number(project.billRate);
  return payRateOf(entry, { projects, people });
}

// What an hour of this person's time costs the project's budget.
export function assignmentRate(project, person) {
  if (isInternal(project)) return 0;
  if (project && project.billRate) return Number(project.billRate);
  return person ? Number(person.rate || 0) : 0;
}

export function assignedHours(assignment, { projects, people }) {
  if (assignment.hours != null) return Number(assignment.hours);
  // Legacy dollar assignment: convert at the rate it was entered against.
  const project = findProject(assignment.projectId, projects);
  const rate = project && project.billRate ? Number(project.billRate) : personRate(assignment.personId, people);
  return rate > 0 ? Number(assignment.capValue || 0) / rate : 0;
}

export function billedAmount(entries, ctx) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * billRateOf(e, ctx), 0);
}

export function paidAmount(entries, ctx) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * payRateOf(e, ctx), 0);
}
