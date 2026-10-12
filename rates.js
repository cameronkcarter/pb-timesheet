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

// Firm-wide standard billing rate, pre-filled on new projects in Admin.
export const DEFAULT_BILL_RATE = 150;

function personRate(personId, people) {
  const person = people.find((p) => p.id === personId);
  return person ? Number(person.rate || 0) : 0;
}

export function payRateOf(entry, people) {
  return entry.rate != null ? Number(entry.rate) : personRate(entry.personId, people);
}

export function billRateOf(entry, { projects, people }) {
  // Invoiced hours keep the rate they were billed at. Hours invoiced before
  // bill rates existed were billed at the person's pay rate.
  if (entry.invoiced) return entry.billRate != null ? Number(entry.billRate) : payRateOf(entry, people);
  const project = projects.find((p) => p.id === entry.projectId);
  if (project && project.billRate) return Number(project.billRate);
  return payRateOf(entry, people);
}

// Rate used to turn a person's dollar assignment on a project into hours,
// and to price their not-yet-logged hours against the budget.
export function assignmentRate(project, person) {
  if (project && project.billRate) return Number(project.billRate);
  return person ? Number(person.rate || 0) : 0;
}

export function billedAmount(entries, ctx) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * billRateOf(e, ctx), 0);
}

export function paidAmount(entries, people) {
  return entries.reduce((s, e) => s + Number(e.hours || 0) * payRateOf(e, people), 0);
}
