import { authChecked, signInWithGoogle, signOutUser } from "./firebase-config.js";
import { setSessionPersonId, staffEntryFor, clearSession } from "./session.js";
import { esc } from "./util.js";

// Login: sign in with Google. Your email must be on the staff list (set in
// Admin > People). Test Mode is switched on from the nav once you're in.

const loading = document.getElementById("loginLoading");
const main = document.getElementById("loginMain");
const googleBtn = document.getElementById("googleBtn");
const errorEl = document.getElementById("loginError");

function showError(html) {
  errorEl.innerHTML = html;
  errorEl.style.display = html ? "block" : "none";
}

function enter(entry) {
  setSessionPersonId(entry.personId);
  window.location.href = "dashboard.html";
}

async function signIn() {
  showError("");
  googleBtn.disabled = true;
  try {
    const { user } = await signInWithGoogle();
    const entry = await staffEntryFor(user);
    if (!entry) {
      await signOutUser();
      showError(`<strong>${esc(user.email)}</strong> isn't on the staff list. Ask an admin to add it, or try another account.`);
      return;
    }
    enter(entry);
  } catch (err) {
    if (err && (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request")) return;
    showError("Couldn't sign in. Try again.");
    console.error(err);
  } finally {
    googleBtn.disabled = false;
  }
}

googleBtn.addEventListener("click", signIn);

// Already signed in on this device? Go straight in.
authChecked.then(async (user) => {
  const entry = user ? await staffEntryFor(user).catch(() => null) : null;
  if (entry) return enter(entry);
  if (user) await signOutUser();
  clearSession();
  loading.style.display = "none";
  main.style.display = "";
});
