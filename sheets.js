// Sends invoice data to the Google Sheet "paper trail" (see apps-script/Code.gs
// for the script that receives it and the one-time setup steps).
import { isTestMode } from "./session.js";
import { formatMonthLabel } from "./util.js";
import { billRateOf, payRateOf } from "./rates.js";

// ---------------------------------------------------------------------------
// PASTE THESE IN after deploying apps-script/Code.gs as a web app.
// Leave SHEET_WEBHOOK_URL blank to turn sheet syncing off entirely.
// ---------------------------------------------------------------------------
export const SHEET_WEBHOOK_URL = "https://script.google.com/a/macros/place.builders/s/AKfycbwitanq9JckIvfjPCrJLACojbJUVAOhtoTgRpMOAnlPSR1O0RTc4914yleUuuegY5iIRA/exec";
export const SHEET_SECRET = "80629abbed674cbab587d4cd5aa1d3fd";
export const SHEET_URL = "https://docs.google.com/spreadsheets/d/1AtB8-91u3jB6pijWLjtyZ0JyGEZpg3VZzhkRUh5rOeM/edit";

// Test Mode never touches the sheet, same as it never touches Firestore.
export function sheetSyncEnabled() {
  return !!SHEET_WEBHOOK_URL && !isTestMode();
}

// Rolls time entries up into one line per task x person x rate, dropping the
// individual work dates (the sheet only cares about invoiced totals).
// rate/amount are what the client was billed; payRate/payAmount are what the
// person earns.
function linesFromEntries(entries, { tasks, people, projects }) {
  const groups = {};
  entries.forEach((e) => {
    const rate = billRateOf(e, { projects, people });
    const payRate = payRateOf(e, { projects, people });
    const key = `${e.taskId}|${e.personId}|${rate}|${payRate}`;
    if (!groups[key]) groups[key] = { taskId: e.taskId, personId: e.personId, rate, payRate, hours: 0 };
    groups[key].hours += Number(e.hours || 0);
  });
  return Object.values(groups).map((g) => {
    const task = tasks.find((t) => t.id === g.taskId);
    const person = people.find((p) => p.id === g.personId);
    return {
      taskId: g.taskId,
      taskName: task ? task.name : "(deleted task)",
      personId: g.personId,
      personName: person ? person.name : "(removed person)",
      hours: Math.round(g.hours * 100) / 100,
      rate: g.rate,
      amount: Math.round(g.hours * g.rate * 100) / 100,
      payRate: g.payRate,
      payAmount: Math.round(g.hours * g.payRate * 100) / 100,
    };
  });
}

// Builds the full sync payload. The Apps Script skips anything it already
// has, so it's always safe to send everything.
export function buildSheetPayload({ invoices, timeEntries, tasks, people, projects }) {
  const sheetInvoices = [...invoices]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((inv) => {
      const project = projects.find((p) => p.id === inv.projectId);
      const linked = timeEntries.filter((e) => e.invoiceId === inv.id);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: inv.date,
        periodLabel: inv.periodLabel || "",
        projectId: inv.projectId,
        projectName: project ? project.name : inv.projectName,
        total: inv.total,
        paidDate: inv.paid && inv.paidDate ? inv.paidDate.slice(0, 10) : "",
        lines: linesFromEntries(linked, { tasks, people, projects }).map((l) => ({
          // Pay rate is only added to the key when it differs from the bill
          // rate, so lines synced before bill rates existed keep their keys.
          ...l, lineKey: `${inv.id}|${l.taskId}|${l.personId}|${l.rate}${l.payRate !== l.rate ? `|pay${l.payRate}` : ""}`,
        })),
      };
    });

  // Entries marked invoiced without belonging to any invoice record (e.g.
  // hours transferred from another contract). The site counts these as
  // already billed, so the sheet does too, flagged with a note.
  const extraLines = timeEntries
    .filter((e) => e.invoiced && !e.invoiceId)
    .map((e) => {
      const project = projects.find((p) => p.id === e.projectId);
      const [line] = linesFromEntries([e], { tasks, people, projects });
      return {
        ...line,
        lineKey: `entry|${e.id}`,
        invoiceDate: (e.invoicedDate || e.date).slice(0, 10),
        invoiceNumber: "",
        periodLabel: formatMonthLabel(new Date(e.date + "T00:00:00")),
        projectId: e.projectId,
        projectName: project ? project.name : "(deleted project)",
        note: `No invoice record${e.note ? ": " + e.note : ""}`,
      };
    });

  return { invoices: sheetInvoices, extraLines, budgets: buildBudgets({ tasks, projects }) };
}

export function buildBudgets({ tasks, projects }) {
  return tasks
    .map((t) => {
      const project = projects.find((p) => p.id === t.projectId);
      // Internal projects (not billed) have no budget to track in the sheet.
      if (!project || project.internal) return null;
      return {
        projectId: project.id, projectName: project.name,
        taskId: t.id, taskName: t.name, budget: Number(t.budget || 0),
      };
    })
    .filter(Boolean);
}

export async function postToSheet(payload) {
  // text/plain keeps this a "simple" CORS request, which Apps Script web apps
  // accept without a preflight.
  const res = await fetch(SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: SHEET_SECRET, ...payload }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Sheet sync failed");
  return data;
}
