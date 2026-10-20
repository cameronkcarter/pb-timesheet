// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE CONFIG BELOW.
// See README.md for step-by-step instructions on getting these values from
// the Firebase console (Project settings > General > Your apps > SDK setup).
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAKvBJvQfbjV_kuXBKBCm1QvxBhjP6NCNM",
  authDomain: "place-builders-timesheet.firebaseapp.com",
  projectId: "place-builders-timesheet",
  storageBucket: "place-builders-timesheet.firebasestorage.app",
  messagingSenderId: "998541766431",
  appId: "1:998541766431:web:edf9ffe47143c4b6a78a2a",
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, clearIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

export const app = initializeApp(firebaseConfig);
// Data is cached in the browser, so opening another page (or coming back
// within ~30 minutes) only reads records that changed since, instead of every
// record again. That keeps daily reads far under the free plan's limit. The
// cache is wiped on sign-out (see signOutUser) so nothing stays on a shared
// computer.
function makeDb() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn("Offline cache unavailable, using memory only:", err);
    return getFirestore(app);
  }
}
export const db = makeDb();
export const auth = getAuth(app);

// Everyone signs in with Google (see login.js); security rules then check
// their email against the staff list (see firestore.rules).

// Resolves with the signed-in user, or null, once Firebase knows which.
export const authChecked = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
});

// Resolves once someone is signed in. db.js awaits this before touching
// Firestore; pages without a signed-in user are sent to the login page.
export const authReady = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user) { unsub(); resolve(user); }
  });
});

export function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

// clearCache: false on the login page, which keeps using the database after.
export async function signOutUser({ clearCache = true } = {}) {
  await signOut(auth).catch(() => {});
  if (!clearCache) return;
  // Clear this browser's cached copy of the data.
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    console.warn("Couldn't clear the offline cache:", err);
  }
}
