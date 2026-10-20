import { db, authReady } from "./firebase-config.js";
import {
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { isTestMode } from "./session.js";
import {
  listenTest,
  addTest,
  updateTest,
  removeTest,
  markInvoicedTest,
  markPaidTest,
  approveTest,
} from "./sandbox.js";

function listenCollection(name, callback, orderByField) {
  if (isTestMode()) return listenTest(name, callback, orderByField);
  let unsub = null;
  let cancelled = false;
  authReady.then(() => {
    if (cancelled) return;
    const ref = collection(db, name);
    const q = orderByField ? query(ref, orderBy(orderByField)) : ref;
    unsub = onSnapshot(q, (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  });
  return () => {
    cancelled = true;
    if (unsub) unsub();
  };
}

async function add(name, data) {
  if (isTestMode()) return addTest(name, { ...data, createdAt: new Date().toISOString() });
  await authReady;
  return addDoc(collection(db, name), { ...data, createdAt: serverTimestamp() });
}

async function update(name, id, data) {
  if (isTestMode()) return updateTest(name, id, data);
  await authReady;
  return updateDoc(doc(db, name, id), data);
}

async function remove(name, id) {
  if (isTestMode()) return removeTest(name, id);
  await authReady;
  return deleteDoc(doc(db, name, id));
}

// billRates: { entryId: rate } — locks in the rate each hour was billed at.
async function markInvoiced(ids, invoiceId, billRates = {}) {
  if (isTestMode()) return markInvoicedTest(ids, invoiceId, billRates);
  await authReady;
  const batch = writeBatch(db);
  const invoicedDate = new Date().toISOString();
  ids.forEach((id) => {
    batch.update(doc(db, "timeEntries", id), { invoiced: true, invoicedDate, invoiceId, billRate: billRates[id] ?? null });
  });
  await batch.commit();
}

async function markPaid(ids) {
  if (isTestMode()) return markPaidTest(ids);
  await authReady;
  const batch = writeBatch(db);
  const paidDate = new Date().toISOString();
  ids.forEach((id) => {
    batch.update(doc(db, "timeEntries", id), { paid: true, paidDate });
  });
  await batch.commit();
}

async function approve(ids) {
  if (isTestMode()) return approveTest(ids);
  await authReady;
  const batch = writeBatch(db);
  const approvedDate = new Date().toISOString();
  ids.forEach((id) => {
    batch.update(doc(db, "timeEntries", id), { approved: true, approvedDate });
  });
  await batch.commit();
}

// People documents look like:
// { name, email (Google sign-in), rate (pay $/hr), billRate ($/hr charged to clients), isAdmin,
//   inactive (deactivated: can't sign in, hidden from pickers, kept on
//   past records) }
export const People = {
  listen: (cb) => listenCollection("people", cb, "name"),
  add: (data) => add("people", data),
  update: (id, data) => update("people", id, data),
  remove: (id) => remove("people", id),
};

// Staff documents are the Google sign-in list, one per active person with an
// email: id = lowercase email, { personId, isAdmin }. Admin keeps them in
// sync with People (see admin.js); security rules use them to decide who can
// read and write what (see firestore.rules).
export const Staff = {
  listen: (cb) => listenCollection("staff", cb),
  async set(email, data) {
    if (isTestMode()) return;
    await authReady;
    return setDoc(doc(db, "staff", email), data);
  },
  async remove(email) {
    if (isTestMode()) return;
    await authReady;
    return deleteDoc(doc(db, "staff", email));
  },
};

export const normEmail = (e) => String(e || "").trim().toLowerCase();

// Project documents look like:
// { name, client, projectNumber, billToName, billToCompany, billToAddress1,
//   billToAddress2, pmPersonId (project manager: approves its hours),
//   internal (not billed or paid, e.g. Proposals & Pursuits) }
export const Projects = {
  listen: (cb) => listenCollection("projects", cb, "name"),
  add: (data) => add("projects", data),
  update: (id, data) => update("projects", id, data),
  remove: (id) => remove("projects", id),
};

// Task documents look like: { projectId, name, budget ($), startDate, endDate }
export const Tasks = {
  listen: (cb) => listenCollection("tasks", cb, "name"),
  add: (data) => add("tasks", data),
  update: (id, data) => update("tasks", id, data),
  remove: (id) => remove("tasks", id),
};

// Assignment documents look like: { personId, taskId, projectId, hours }
export const Assignments = {
  listen: (cb) => listenCollection("assignments", cb),
  add: (data) => add("assignments", data),
  update: (id, data) => update("assignments", id, data),
  remove: (id) => remove("assignments", id),
};

// TimeEntry documents look like:
// { personId, taskId, projectId, date, hours, note, rate (pay, locked when
//   logged), billRate (locked when invoiced), approved, approvedDate,
//   invoiced, invoicedDate, invoiceId, paid, paidDate }
export const TimeEntries = {
  listen: (cb) => listenCollection("timeEntries", cb, "date"),
  add: (data) => add("timeEntries", {
    note: null,
    approved: false, approvedDate: null,
    invoiced: false, invoicedDate: null, invoiceId: null, paid: false, paidDate: null, ...data,
  }),
  update: (id, data) => update("timeEntries", id, data),
  remove: (id) => remove("timeEntries", id),
  markInvoiced,
  markPaid,
  approve,
};

// Expense documents: project expenses (kind "project": category, description,
// quantity x rate, paid by personId for reimbursement) and subconsultant
// invoices (kind "sub": subId, description, amount). Approved like hours, then
// invoiced; project expenses someone paid for are later marked reimbursed.
// { projectId, kind, personId, subId, category, description, date, quantity,
//   rate, amount, approved, approvedDate, declined, declineReason, invoiced,
//   invoiceId, invoicedDate, reimbursed, reimbursedDate, createdByPersonId,
//   subPaid, subPaidDate (subconsultant invoices: we've paid the sub) }
export const Expenses = {
  listen: (cb) => listenCollection("expenses", cb, "date"),
  add: (data) => add("expenses", {
    personId: null, subId: null, category: null, quantity: null, rate: null,
    approved: false, approvedDate: null, declined: false, declineReason: null,
    invoiced: false, invoiceId: null, invoicedDate: null, reimbursed: false, reimbursedDate: null,
    ...data,
  }),
  update: (id, data) => update("expenses", id, data),
  remove: (id) => remove("expenses", id),
  approve: (ids) => {
    const approvedDate = new Date().toISOString();
    return Promise.all(ids.map((id) => update("expenses", id, { approved: true, approvedDate })));
  },
  markInvoiced: (ids, invoiceId) => {
    const invoicedDate = new Date().toISOString();
    return Promise.all(ids.map((id) => update("expenses", id, { invoiced: true, invoicedDate, invoiceId })));
  },
};

// DueDate documents are subtasks (personIds non-empty) or timeline events:
// { projectId, taskId, personIds: [], title, dueDate, createdByPersonId,
//   completed, completedDate }
export const DueDates = {
  listen: (cb) => listenCollection("dueDates", cb, "dueDate"),
  add: (data) => add("dueDates", { taskId: null, completed: false, completedDate: null, ...data }),
  update: (id, data) => update("dueDates", id, data),
  remove: (id) => remove("dueDates", id),
};

// Invoice documents look like:
// { projectId, projectName, invoiceNumber, date, dueDate, periodLabel,
//   periodStart, periodEnd, taskRows, laborRows, feeTotal, billedTotal,
//   currentTotal, remainingTotal, pctTotal, total, paid, paidDate,
//   sheetSynced (logged in the Google Sheet) }
export const Invoices = {
  listen: (cb) => listenCollection("invoices", cb, "date"),
  add: (data) => add("invoices", { paid: false, paidDate: null, ...data }),
  update: (id, data) => update("invoices", id, data),
  remove: (id) => remove("invoices", id),
};
