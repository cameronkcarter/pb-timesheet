const KEY = "pb_session_person_id";
const TEST_ACTIVE_KEY = "pb_test_active";
const TEST_PERSON_KEY = "pb_test_person_id";

function clearTestSandboxData() {
  Object.keys(sessionStorage).forEach((k) => {
    if (k.startsWith("pb_test_data_") || k.startsWith("pb_test_seeded_")) {
      sessionStorage.removeItem(k);
    }
  });
}

export function isTestMode() {
  return sessionStorage.getItem(TEST_ACTIVE_KEY) === "true";
}

// Starts a fresh test session for the given person. Test data lives only in
// sessionStorage (this tab only) and is wiped every time a new test session
// starts, so nothing carries over between tries.
export function startTestSession(personId) {
  clearTestSandboxData();
  sessionStorage.setItem(TEST_ACTIVE_KEY, "true");
  sessionStorage.setItem(TEST_PERSON_KEY, personId);
}

export function getSessionPersonId() {
  if (isTestMode()) return sessionStorage.getItem(TEST_PERSON_KEY);
  return localStorage.getItem(KEY);
}

export function setSessionPersonId(id) {
  // A real login must always fully exit test mode, even if a previous test
  // session in this tab was left active without logging out first.
  sessionStorage.removeItem(TEST_ACTIVE_KEY);
  sessionStorage.removeItem(TEST_PERSON_KEY);
  clearTestSandboxData();
  localStorage.setItem(KEY, id);
}

export function clearSession() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(TEST_ACTIVE_KEY);
  sessionStorage.removeItem(TEST_PERSON_KEY);
  clearTestSandboxData();
}

function renderTestModeBanner() {
  if (!isTestMode() || document.getElementById("testModeBanner")) return;
  const banner = document.createElement("div");
  banner.id = "testModeBanner";
  banner.textContent = "TEST MODE — nothing you do here is saved. Log out to exit.";
  banner.style.cssText =
    "background:#d98936;color:#fff;text-align:center;padding:8px;font-size:13px;font-weight:600;letter-spacing:0.2px;";
  document.body.insertBefore(banner, document.body.firstChild);
}

// Call at the top of any page that requires someone to be logged in.
// Redirects to the login page and returns null if no one is logged in.
export function requireSession() {
  const id = getSessionPersonId();
  if (!id) {
    window.location.href = "index.html";
    return null;
  }
  renderTestModeBanner();
  return id;
}

// Call once a person record has loaded, on pages restricted to admins
// (Admin, Invoicing). Redirects away and returns false if they aren't one.
export function enforceAdmin(person) {
  if (!person || !person.isAdmin) {
    window.location.href = "dashboard.html";
    return false;
  }
  return true;
}

// Call once a person record has loaded, on pages with nav links to the
// admin-only pages (Dashboard, Timesheet). Those links start hidden in the
// HTML; this reveals them only if the logged-in person is an admin.
export function applyAdminNavVisibility(person) {
  if (!person || !person.isAdmin) return;
  const adminLink = document.getElementById("navAdminLink");
  const invoiceLink = document.getElementById("navInvoiceLink");
  if (adminLink) adminLink.style.display = "";
  if (invoiceLink) invoiceLink.style.display = "";
}
