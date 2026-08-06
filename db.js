import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

function listenCollection(name, callback, orderByField) {
  const ref = collection(db, name);
  const q = orderByField ? query(ref, orderBy(orderByField)) : ref;
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

function add(name, data) {
  return addDoc(collection(db, name), { ...data, createdAt: serverTimestamp() });
}

function update(name, id, data) {
  return updateDoc(doc(db, name, id), data);
}

function remove(name, id) {
  return deleteDoc(doc(db, name, id));
}

async function markInvoiced(ids, invoiceId) {
  const batch = writeBatch(db);
  const invoicedDate = new Date().toISOString();
  ids.forEach((id) => {
    batch.update(doc(db, "timeEntries", id), { invoiced: true, invoicedDate, invoiceId });
  });
  await batch.commit();
}

async function markPaid(ids) {
  const batch = writeBatch(db);
  const paidDate = new Date().toISOString();
  ids.forEach((id) => {
    batch.update(doc(db, "timeEntries", id), { paid: true, paidDate });
  });
  await batch.commit();
}

export const People = {
  listen: (cb) => listenCollection("people", cb, "name"),
  add: (data) => add("people", data),
  update: (id, data) => update("people", id, data),
  remove: (id) => remove("people", id),
};

export const Projects = {
  listen: (cb) => listenCollection("projects", cb, "name"),
  add: (data) => add("projects", data),
  update: (id, data) => update("projects", id, data),
  remove: (id) => remove("projects", id),
};

// Tasks documents look like: { projectId, name, budget }
export const Tasks = {
  listen: (cb) => listenCollection("tasks", cb, "name"),
  add: (data) => add("tasks", data),
  update: (id, data) => update("tasks", id, data),
  remove: (id) => remove("tasks", id),
};

// Assignment documents look like: { personId, taskId, projectId, maxHours }
export const Assignments = {
  listen: (cb) => listenCollection("assignments", cb),
  add: (data) => add("assignments", data),
  update: (id, data) => update("assignments", id, data),
  remove: (id) => remove("assignments", id),
};

// TimeEntry documents look like:
// { personId, taskId, projectId, date, hours, invoiced, invoicedDate, invoiceId, paid, paidDate }
export const TimeEntries = {
  listen: (cb) => listenCollection("timeEntries", cb, "date"),
  add: (data) => add("timeEntries", {
    invoiced: false, invoicedDate: null, invoiceId: null, paid: false, paidDate: null, ...data,
  }),
  update: (id, data) => update("timeEntries", id, data),
  remove: (id) => remove("timeEntries", id),
  markInvoiced,
  markPaid,
};

// DueDate documents look like: { projectId, personIds: [], title, dueDate }
export const DueDates = {
  listen: (cb) => listenCollection("dueDates", cb, "dueDate"),
  add: (data) => add("dueDates", data),
  update: (id, data) => update("dueDates", id, data),
  remove: (id) => remove("dueDates", id),
};

// Invoice documents look like:
// { projectId, projectName, invoiceNumber, date, dueDate, periodLabel,
//   taskRows, laborRows, feeTotal, billedTotal, currentTotal, remainingTotal,
//   pctTotal, total, paid, paidDate }
export const Invoices = {
  listen: (cb) => listenCollection("invoices", cb, "date"),
  add: (data) => add("invoices", { paid: false, paidDate: null, ...data }),
  update: (id, data) => update("invoices", id, data),
  remove: (id) => remove("invoices", id),
};
