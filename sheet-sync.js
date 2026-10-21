// Keeps the Google Sheet up to date: sends every invoice, its billed lines,
// task budgets and paid/void status. The Apps Script skips rows it already
// has, so syncing is safe to run any time. Used by Invoices (automatically,
// after generating, marking paid or voiding) and by Admin (status + Sync).
import { Invoices } from "./db.js";
import { showToast } from "./util.js";
import { isTestMode } from "./session.js";
import { sheetSyncEnabled, buildSheetPayload, postToSheet, SHEET_WEBHOOK_URL, SHEET_URL } from "./sheets.js";

// getData() -> { invoices, timeEntries, tasks, people, projects }
// onChange() is called when the sync starts or finishes (to redraw status).
export function createSheetSync({ getData, onChange = () => {} }) {
  let syncing = false;
  let queued = false;
  let error = null;

  // Calls that arrive mid-sync are queued into one follow-up run so nothing
  // is missed.
  async function sync({ manual = false } = {}) {
    if (!sheetSyncEnabled()) return;
    if (syncing) { queued = true; return; }
    syncing = true;
    error = null;
    onChange();
    try {
      const { invoices, timeEntries, tasks, people, projects } = getData();
      const payload = buildSheetPayload({ invoices, timeEntries, tasks, people, projects });
      const result = await postToSheet(payload);
      // Only flag invoices whose state still matches what was sent, in case
      // one changed while the request was in flight.
      const sent = new Map(payload.invoices.map((i) => [i.invoiceId, i.paidDate]));
      const toFlag = getData().invoices.filter((i) => !i.sheetSynced && sent.has(i.id) &&
        sent.get(i.id) === (i.void ? "VOID" : i.paid && i.paidDate ? i.paidDate.slice(0, 10) : ""));
      await Promise.all(toFlag.map((i) => Invoices.update(i.id, { sheetSynced: true })));
      if (manual) showToast(`Sheet synced: ${result.invoicesAdded} new invoices, ${result.linesAdded} new lines.`);
    } catch (err) {
      error = err.message;
      showToast("Couldn't update the Google Sheet (nothing else was affected). Try Sync in Admin.");
    } finally {
      syncing = false;
      onChange();
      if (queued) {
        queued = false;
        sync();
      }
    }
  }

  // What to show: { configured, url, testMode, syncing, error, unsynced, total }
  function status() {
    const invoices = getData().invoices;
    return {
      configured: !!SHEET_WEBHOOK_URL,
      url: SHEET_URL,
      testMode: isTestMode(),
      syncing,
      error,
      unsynced: invoices.filter((i) => !i.sheetSynced).length,
      total: invoices.length,
    };
  }

  return { sync, status };
}
