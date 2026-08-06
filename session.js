const KEY = "pb_session_person_id";

export function getSessionPersonId() {
  return localStorage.getItem(KEY);
}

export function setSessionPersonId(id) {
  localStorage.setItem(KEY, id);
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

// Call at the top of any page that requires someone to be logged in.
// Redirects to the login page and returns null if no one is logged in.
export function requireSession() {
  const id = getSessionPersonId();
  if (!id) {
    window.location.href = "index.html";
    return null;
  }
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
