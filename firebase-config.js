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
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
