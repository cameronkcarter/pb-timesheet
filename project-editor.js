// Edit Tasks & Budgets (admins, on the Projects tab): a project's tasks with
// budgets and dates, its expenses budget and subconsultants. Markup lives in
// projects.html (#projectModal). A project's details are in Setup, which also
// adds and removes projects (removeProject below).
import { Projects, Tasks, Assignments, TimeEntries, DueDates, Expenses } from "./db.js";
import { formatCurrency, showToast, closeOnBackdropClick, esc, alertDialog, confirmDialog } from "./util.js";
import { sheetSyncEnabled, buildBudgets, postToSheet } from "./sheets.js";

// Keep the Google Sheet's Task Budgets tab current. Best-effort: if it
// fails, the next invoice sync rewrites budgets anyway.
export function syncBudgetsToSheet({ tasks, projects }) {
  if (!sheetSyncEnabled()) return;
  postToSheet({ budgets: buildBudgets({ tasks, projects }) })
    .catch((err) => console.warn("Sheet budget sync failed:", err));
}

// Removes a project and everything that belongs to it (tasks, assignments,
// subtasks and events, logged hours, expenses). Refuses if anything was ever
// invoiced, since that history is part of the invoice paper trail.
export async function removeProject(projectId, { projects, tasks, assignments, dueDates, timeEntries, invoices, expenses }) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return false;
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const projectAssignments = assignments.filter((a) => a.projectId === projectId);
  const projectDueDates = dueDates.filter((d) => d.projectId === projectId);
  const projectEntries = timeEntries.filter((e) => e.projectId === projectId);
  const projectExpenses = expenses.filter((e) => e.projectId === projectId);

  if (projectEntries.some((e) => e.invoiced) || projectExpenses.some((e) => e.invoiced) ||
    invoices.some((i) => i.projectId === projectId)) {
    await alertDialog("Removing it would break the invoice history.", `"${project.name}" has been invoiced`);
    return false;
  }

  const counts = [
    [projectTasks.length, "task"], [projectAssignments.length, "assignment"],
    [projectDueDates.length, "subtask/event"], [projectEntries.length, "logged time entry"],
    [projectExpenses.length, "expense"],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);
  const detail = counts.length ? `This also permanently deletes its ${counts.join(", ")}.\n\n` : "";
  if (!(await confirmDialog(`${detail}This can't be undone.`, { title: `Remove "${project.name}"?`, confirmText: "Remove Project", danger: true }))) return false;

  try {
    for (const e of projectEntries) await TimeEntries.remove(e.id);
    for (const e of projectExpenses) await Expenses.remove(e.id);
    for (const d of projectDueDates) await DueDates.remove(d.id);
    for (const a of projectAssignments) await Assignments.remove(a.id);
    for (const t of projectTasks) await Tasks.remove(t.id);
    await Projects.remove(projectId);
    showToast(`"${project.name}" removed.`);
    syncBudgetsToSheet({ tasks: tasks.filter((t) => t.projectId !== projectId), projects: projects.filter((p) => p.id !== projectId) });
    return true;
  } catch (err) {
    showToast("Error: " + err.message);
    return false;
  }
}

export function createProjectEditor({ getData, onSaved }) {
  const $ = (id) => document.getElementById(id);
  const projectModal = $("projectModal");
  const modalTaskRows = $("modalTaskRows");
  const modalTaskHead = $("modalTaskHead");
  const modalTaskTotal = $("modalTaskTotal");
  const expenseFields = $("modalExpenseFields");
  const expenseBudget = $("modalExpenseBudget");
  const subRows = $("modalSubRows");
  const subTotal = $("modalSubTotal");

  let editing = null; // the project
  let pendingTaskDeletions = new Set();
  const internal = () => !!editing?.internal;

  // Numbered tasks ("Task 1: …"): on by default for client projects, off for
  // internal ones (e.g. RFPs), until it's set by hand. The "Task N:" prefix
  // is a label in front of each name, numbered in row order, and is added to
  // the name when saved.
  const numberTasksBox = $("modalNumberTasks");
  const stripTaskNumber = (name) => name.replace(/^Task\s*\d+\s*[:.\-–]?\s*/i, "");
  function setNumbered(on) {
    numberTasksBox.checked = on;
    modalTaskRows.classList.toggle("numbered", on);
    renumberTasks();
  }
  function renumberTasks() {
    modalTaskRows.querySelectorAll(".task-num").forEach((el, i) => { el.textContent = `Task ${i + 1}:`; });
  }
  numberTasksBox.addEventListener("change", () => setNumbered(numberTasksBox.checked));

  function updateTaskTotal() {
    const rows = [...modalTaskRows.querySelectorAll(".modal-task-row")];
    if (internal()) {
      modalTaskTotal.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"}` : "";
      return;
    }
    const total = rows.reduce((s, r) => s + (Number(r.querySelector(".modalTaskBudget").value) || 0), 0);
    modalTaskTotal.textContent = `${formatCurrency(total)} total budget`;
  }

  function taskRowHtml(taskId, name, budget, startDate, endDate) {
    return `<div class="modal-task-row task-edit-grid" data-task-id="${taskId || ""}">
      <div class="task-name-cell"><span class="task-num"></span><input type="text" class="modalTaskName" placeholder="Task name" value="${esc(stripTaskNumber(name || ""))}" /></div>
      <div class="money-input col-budget"><span>$</span><input type="number" class="modalTaskBudget" placeholder="0" min="0" step="0.01" value="${budget || ""}" /></div>
      <input type="date" class="modalTaskStart" value="${startDate || ""}" title="Start (optional)" />
      <input type="date" class="modalTaskEnd" value="${endDate || ""}" title="End (optional)" />
      <button type="button" class="icon-btn removeTaskRow" title="Remove task" aria-label="Remove task">&times;</button>
    </div>`;
  }

  function subRowHtml(sub = {}) {
    return `<div class="sub-row" data-sub-id="${sub.id || ""}">
      <input type="text" class="subName" placeholder="Subconsultant name" value="${esc(sub.name || "")}" />
      <div class="money-input"><span>$</span><input type="number" class="subBudget" placeholder="Budget" min="0" step="0.01" value="${sub.budget || ""}" /></div>
      <button type="button" class="icon-btn removeSubRow" title="Remove subconsultant" aria-label="Remove">&times;</button>
    </div>`;
  }

  function updateSubTotal() {
    const total = [...subRows.querySelectorAll(".subBudget")].reduce((t, i) => t + (Number(i.value) || 0), 0);
    subTotal.textContent = total ? `${formatCurrency(total)} total` : "";
  }

  function open(project) {
    const { tasks } = getData();
    editing = project;
    pendingTaskDeletions = new Set();
    $("projectModalName").textContent = project.name;
    const projectTasks = tasks.filter((t) => t.projectId === project.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    modalTaskRows.innerHTML = projectTasks.length
      ? projectTasks.map((t) => taskRowHtml(t.id, t.name, t.budget, t.startDate, t.endDate)).join("")
      : taskRowHtml();
    modalTaskRows.classList.toggle("internal", internal());
    modalTaskHead.classList.toggle("internal", internal());
    expenseFields.style.display = internal() ? "none" : "";
    expenseBudget.value = project.expenseBudget || "";
    subRows.innerHTML = (project.subconsultants || []).map(subRowHtml).join("");
    updateSubTotal();
    setNumbered(project.numberTasks !== undefined ? project.numberTasks : !internal());
    updateTaskTotal();
    projectModal.style.display = "flex";
  }

  function close() {
    projectModal.style.display = "none";
  }

  $("modalAddSubRow").addEventListener("click", () => {
    subRows.insertAdjacentHTML("beforeend", subRowHtml());
    subRows.lastElementChild.querySelector(".subName").focus();
  });
  subRows.addEventListener("input", (e) => { if (e.target.classList.contains("subBudget")) updateSubTotal(); });
  subRows.addEventListener("click", (e) => {
    const btn = e.target.closest(".removeSubRow");
    if (!btn) return;
    const row = btn.closest(".sub-row");
    const id = row.dataset.subId;
    // Recorded invoices from a subconsultant are part of the invoice history.
    if (id && (getData().expenses || []).some((x) => x.subId === id)) {
      alertDialog("This subconsultant already has invoices recorded.", "Can't remove");
      return;
    }
    row.remove();
    updateSubTotal();
  });

  $("modalAddTaskRow").addEventListener("click", () => {
    modalTaskRows.insertAdjacentHTML("beforeend", taskRowHtml());
    renumberTasks();
    modalTaskRows.lastElementChild.querySelector(".modalTaskName").focus();
    updateTaskTotal();
  });
  modalTaskRows.addEventListener("input", (e) => {
    if (e.target.classList.contains("modalTaskBudget")) updateTaskTotal();
  });
  modalTaskRows.addEventListener("click", async (e) => {
    const btn = e.target.closest(".removeTaskRow");
    if (!btn) return;
    const { assignments, dueDates, timeEntries } = getData();
    const row = btn.closest(".modal-task-row");
    const taskId = row.dataset.taskId;
    if (taskId) {
      // Hours logged on a task are part of the timesheet/invoice history.
      if (timeEntries.some((e) => e.taskId === taskId)) {
        alertDialog("It has hours logged; removing it would break the timesheet and invoice history.", "Can't remove this task");
        return;
      }
      const linked = assignments.filter((a) => a.taskId === taskId).length + dueDates.filter((d) => d.taskId === taskId).length;
      if (linked && !(await confirmDialog(`Its ${linked} assignment${linked === 1 ? "" : "s"} and subtask${linked === 1 ? "" : "s"} will be removed too when you save.`, { title: "Remove this task?", confirmText: "Remove", danger: true }))) return;
      pendingTaskDeletions.add(taskId);
    }
    row.remove();
    renumberTasks();
    updateTaskTotal();
  });
  $("modalCancelProject").addEventListener("click", close);
  $("modalCloseProject").addEventListener("click", close);
  closeOnBackdropClick(projectModal, close);

  $("modalSaveProject").addEventListener("click", async () => {
    const { assignments, dueDates } = getData();
    const projectId = editing.id;
    try {
      await Projects.update(projectId, {
        numberTasks: numberTasksBox.checked,
        expenseBudget: internal() ? 0 : Number(expenseBudget.value) || 0,
        subconsultants: internal() ? [] : [...subRows.querySelectorAll(".sub-row")]
          .map((row) => ({
            id: row.dataset.subId || `sub_${Math.random().toString(36).slice(2, 10)}`,
            name: row.querySelector(".subName").value.trim(),
            budget: Number(row.querySelector(".subBudget").value) || 0,
          }))
          .filter((sub) => sub.name),
      });

      const numbered = numberTasksBox.checked;
      for (const [i, row] of [...modalTaskRows.querySelectorAll(".modal-task-row")].entries()) {
        const taskId = row.dataset.taskId;
        const bareName = stripTaskNumber(row.querySelector(".modalTaskName").value.trim());
        const taskName = bareName && numbered ? `Task ${i + 1}: ${bareName}` : bareName;
        const taskBudget = internal() ? 0 : Number(row.querySelector(".modalTaskBudget").value) || 0;
        const startDate = row.querySelector(".modalTaskStart").value || null;
        const endDate = row.querySelector(".modalTaskEnd").value || null;
        if (!taskName) continue;
        if (taskId) {
          await Tasks.update(taskId, { name: taskName, budget: taskBudget, startDate, endDate });
        } else {
          await Tasks.add({ projectId, name: taskName, budget: taskBudget, startDate, endDate });
        }
      }

      for (const taskId of pendingTaskDeletions) {
        for (const a of assignments.filter((x) => x.taskId === taskId)) await Assignments.remove(a.id);
        for (const d of dueDates.filter((x) => x.taskId === taskId)) await DueDates.remove(d.id);
        await Tasks.remove(taskId);
      }

      close();
      showToast("Tasks & budgets saved.");
      onSaved(projectId);
      syncBudgetsToSheet(getData());
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  return { open };
}
