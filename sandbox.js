// In-memory/sessionStorage-backed mock of the Firestore collection API used
// by db.js when a test session is active. Each collection is lazily seeded
// once per tab from a real one-time read of Firestore, then all further
// reads/writes stay local to sessionStorage — nothing touches Firestore.
import { db, authReady } from "./firebase-config.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const listeners = {}; // collection name -> [{ cb, orderByField }]

function dataKey(name) {
  return `pb_test_data_${name}`;
}

function seededKey(name) {
  return `pb_test_seeded_${name}`;
}

function readData(name) {
  const raw = sessionStorage.getItem(dataKey(name));
  return raw ? JSON.parse(raw) : [];
}

function writeData(name, items) {
  sessionStorage.setItem(dataKey(name), JSON.stringify(items));
}

function sortItems(items, orderByField) {
  if (!orderByField) return items;
  return [...items].sort((a, b) => {
    const av = a[orderByField];
    const bv = b[orderByField];
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
}

function notifyAll(name) {
  (listeners[name] || []).forEach(({ cb, orderByField }) => {
    cb(sortItems(readData(name), orderByField));
  });
}

// Copies the real collection once per tab. Anything added in Test Mode before
// the copy finished is kept. If the real data can't be read (e.g. a new kind
// of record the live security rules don't cover yet), start from what's here.
async function seedIfNeeded(name) {
  if (sessionStorage.getItem(seededKey(name))) return;
  let real = [];
  try {
    await authReady;
    const snap = await getDocs(collection(db, name));
    real = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn(`Test Mode: couldn't copy "${name}", starting empty.`, err.code || err);
  }
  if (sessionStorage.getItem(seededKey(name))) return; // another listener finished first
  const added = readData(name).filter((i) => String(i.id).startsWith("test_"));
  writeData(name, [...real.filter((r) => !added.some((a) => a.id === r.id)), ...added]);
  sessionStorage.setItem(seededKey(name), "true");
}

export function listenTest(name, cb, orderByField) {
  if (!listeners[name]) listeners[name] = [];
  const entry = { cb, orderByField };
  listeners[name].push(entry);

  // Always deliver async, even when already seeded, matching Firestore's
  // onSnapshot contract that pages rely on (never fires synchronously).
  if (sessionStorage.getItem(seededKey(name))) {
    Promise.resolve().then(() => cb(sortItems(readData(name), orderByField)));
  } else {
    seedIfNeeded(name).then(() => notifyAll(name));
  }

  return () => {
    listeners[name] = listeners[name].filter((l) => l !== entry);
  };
}

export function addTest(name, data) {
  const items = readData(name);
  const id = "test_" + Math.random().toString(36).slice(2, 10);
  items.push({ id, ...data });
  writeData(name, items);
  notifyAll(name);
  return Promise.resolve({ id });
}

export function updateTest(name, id, data) {
  const items = readData(name);
  const idx = items.findIndex((i) => i.id === id);
  if (idx !== -1) items[idx] = { ...items[idx], ...data };
  writeData(name, items);
  notifyAll(name);
  return Promise.resolve();
}

export function removeTest(name, id) {
  writeData(name, readData(name).filter((i) => i.id !== id));
  notifyAll(name);
  return Promise.resolve();
}

export function markInvoicedTest(ids, invoiceId, billRates = {}) {
  const items = readData("timeEntries");
  const invoicedDate = new Date().toISOString();
  ids.forEach((id) => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx !== -1) items[idx] = { ...items[idx], invoiced: true, invoicedDate, invoiceId, billRate: billRates[id] ?? null };
  });
  writeData("timeEntries", items);
  notifyAll("timeEntries");
  return Promise.resolve();
}

export function markPaidTest(ids) {
  const items = readData("timeEntries");
  const paidDate = new Date().toISOString();
  ids.forEach((id) => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx !== -1) items[idx] = { ...items[idx], paid: true, paidDate };
  });
  writeData("timeEntries", items);
  notifyAll("timeEntries");
  return Promise.resolve();
}

export function approveTest(ids) {
  const items = readData("timeEntries");
  const approvedDate = new Date().toISOString();
  ids.forEach((id) => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx !== -1) items[idx] = { ...items[idx], approved: true, approvedDate };
  });
  writeData("timeEntries", items);
  notifyAll("timeEntries");
  return Promise.resolve();
}
