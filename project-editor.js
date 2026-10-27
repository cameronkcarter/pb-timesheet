// The project popup (admins, on the Projects tab): name, client, PM, billing,
// invoice-to details and tasks with budgets and dates. Also removes projects.
// Markup lives in projects.html (#projectModal).
import { Projects, Tasks, Assignments, TimeEntries, DueDates, Expenses } from "./db.js";
import { formatCurrency, showToast, closeOnBackdropClick, esc } from "./util.js";
import { sheetSyncEnabled, buildBudgets, postToSheet } from "./sheets.js";

// How a project bills: each person's bill rate, or not at all (internal).
const PROJECT_TYPES = {
  rates: "Billed at each person's bill rate.",
  internal: "Not billed or paid. Just tracks hours.",
};

export function createProjectEditor({ getData, onSaved }) {
  const $ = (id) => document.getElementById(id);
  const projectModal = $("projectModal");
  const projectModalTitle = $("projectModalTitle");
  const modalProjectName = $("modalProjectName");
  const modalProjectClient = $("modalProjectClient");
  const modalBillToName = $("modalBillToName");
  const modalBillToCompany = $("modalBillToCompany");
  const modalBillToAddress1 = $("modalBillToAddress1");
  const modalBillToAddress2 = $("modalBillToAddress2");
  const modalProjectNumber = $("modalProjectNumber");
  const modalProjectType = $("modalProjectType");
  const modalProjectPm = $("modalProjectPm");
  const modalTypeHint = $("modalTypeHint");
  const modalBillingFields = $("modalBillingFields");
  const modalTaskRows = $("modalTaskRows");
  const modalTaskHead = $("modalTaskHead");
  const modalTaskTotal = $("modalTaskTotal");
  const removeBtn = $("modalRemoveProject");
  const expenseFields = $("modalExpenseFields");
  const expenseBudget = $("modalExpenseBudget");
  const subRows = $("modalSubRows");
  const subTotal = $("modalSubTotal");

  let editingId = null;
  let modalType = "rates";
  let pendingTaskDeletions = new Set();

  // Keep the Google Sheet's Task Budgets tab current. Best-effort: if it
  // fails, the next invoice sync rewrites budgets anyway.
  function syncBudgetsToSheet() {
    if (!sheetSyncEnabled()) return;
    const { tasks, projects } = getData();
    postToSheet({ budgets: buildBudgets({ tasks, projects }) })
      .catch((err) => console.warn("Sheet budget sync failed:", err));
  }

  function setModalType(type) {
    modalType = type;
    modalProjectType.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.value === type;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on);
    });
    modalTypeHint.textContent = PROJECT_TYPES[type];
    const internal = type === "internal";
    modalBillingFields.style.display = internal ? "none" : "block";
    expenseFields.style.display = internal ? "none" : "block";
    modalTaskRows.classList.toggle("internal", internal);
    modalTaskHead.classList.toggle("internal", internal);
    updateTaskTotal();
  }

  function updateTaskTotal() {
    const rows = [...modalTaskRows.querySelectorAll(".modal-task-row")];
    if (modalType === "internal") {
      modalTaskTotal.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"}` : "";
      return;
    }
    const total = rows.reduce((s, r) => s + (Number(r.querySelector(".modalTaskBudget").value) || 0), 0);
    modalTaskTotal.textContent = `${formatCurrency(total)} total budget`;
  }

  function taskRowHtml(taskId, name, budget, startDate, endDate) {
    return `<div class="modal-task-row task-edit-grid" data-task-id="${taskId || ""}">
      <input type="text" class="modalTaskName" placeholder="Task name" value="${esc(name || "")}" />
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
    const { people, tasks } = getData();
    editingId = project ? project.id : null;
    pendingTaskDeletions = new Set();
    projectModalTitle.textContent = project ? "Edit project" : "New project";
    modalProjectName.value = project ? project.name : "";
    modalProjectClient.value = project ? project.client || "" : "";
    modalBillToName.value = project ? project.billToName || "" : "";
    modalBillToCompany.value = project ? project.billToCompany || "" : "";
    modalBillToAddress1.value = project ? project.billToAddress1 || "" : "";
    modalBillToAddress2.value = project ? project.billToAddress2 || "" : "";
    modalProjectNumber.value = project ? project.projectNumber || "" : "";
    const pmChoices = people.filter((p) => !p.inactive || (project && p.id === project.pmPersonId))
      .sort((x, y) => x.name.localeCompare(y.name));
    modalProjectPm.innerHTML = '<option value="">None</option>' + pmChoices
      .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    modalProjectPm.value = project ? project.pmPersonId || "" : "";

    const projectTasks = project
      ? tasks.filter((t) => t.projectId === project.id).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    modalTaskRows.innerHTML = projectTasks.length > 0
      ? projectTasks.map((t) => taskRowHtml(t.id, t.name, t.budget, t.startDate, t.endDate)).join("")
      : taskRowHtml();
    expenseBudget.value = project && project.expenseBudget ? project.expenseBudget : "";
    subRows.innerHTML = (project?.subconsultants || []).map(subRowHtml).join("");
    updateSubTotal();
    setModalType(project && project.internal ? "internal" : "rates");
    removeBtn.style.display = project ? "" : "none";
    $("modalMergeProject").style.display = project ? "" : "none";
    showMerge(false);

    projectModal.style.display = "flex";
    modalProjectName.focus();
  }

  function close() {
    projectModal.style.display = "none";
  }

  // Removes a project and everything that belongs to it (tasks, assignments,
  // subtasks and events, logged hours, expenses). Refuses if anything was ever
  // invoiced, since that history is part of the invoice paper trail.
  async function remove(projectId) {
    const { projects, tasks, assignments, dueDates, timeEntries, invoices, expenses = [] } = getData();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return false;
    const projectTasks = tasks.filter((t) => t.projectId === projectId);
    const projectAssignments = assignments.filter((a) => a.projectId === projectId);
    const projectDueDates = dueDates.filter((d) => d.projectId === projectId);
    const projectEntries = timeEntries.filter((e) => e.projectId === projectId);
    const projectExpenses = expenses.filter((e) => e.projectId === projectId);

    if (projectEntries.some((e) => e.invoiced) || projectExpenses.some((e) => e.invoiced) ||
      invoices.some((i) => i.projectId === projectId)) {
      alert(`"${project.name}" has invoiced hours, so it can't be removed — that would break the invoice history.`);
      return false;
    }

    const counts = [
      [projectTasks.length, "task"], [projectAssignments.length, "assignment"],
      [projectDueDates.length, "subtask/event"], [projectEntries.length, "logged time entry"],
      [projectExpenses.length, "expense"],
    ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);
    const detail = counts.length ? `\n\nThis also permanently deletes its ${counts.join(", ")}.` : "";
    if (!confirm(`Permanently remove "${project.name}"?${detail}\n\nThis can't be undone.`)) return false;

    try {
      for (const e of projectEntries) await TimeEntries.remove(e.id);
      for (const e of projectExpenses) await Expenses.remove(e.id);
      for (const d of projectDueDates) await DueDates.remove(d.id);
      for (const a of projectAssignments) await Assignments.remove(a.id);
      for (const t of projectTasks) await Tasks.remove(t.id);
      await Projects.remove(projectId);
      showToast(`"${project.name}" removed.`);
      syncBudgetsToSheet();
      return true;
    } catch (err) {
      showToast("Error: " + err.message);
      return false;
    }
  }

  // ---------- Merge into another project ----------
  // For duplicates (e.g. someone made "RFPs" when "Proposals & Pursuits"
  // already existed): moves this project's tasks, hours, assignments,
  // subtasks, expenses and subconsultants into the chosen project, then
  // removes this one. Tasks with the same name are combined; if one person
  // has hours on both on the same day, those become one entry (hours added,
  // notes joined). Only between projects of the same kind (both internal or
  // both billed), and not once anything here has been invoiced.
  const projectFoot = $("projectFoot");
  const mergeFoot = $("mergeFoot");
  const mergeTarget = $("mergeTarget");

  function showMerge(on) {
    projectFoot.hidden = on;
    mergeFoot.hidden = !on;
  }

  $("modalMergeProject").addEventListener("click", () => {
    const { projects, timeEntries, expenses = [], invoices } = getData();
    const project = projects.find((p) => p.id === editingId);
    if (!project) return;
    if (timeEntries.some((e) => e.projectId === project.id && e.invoiced)
      || expenses.some((e) => e.projectId === project.id && e.invoiced)
      || invoices.some((i) => i.projectId === project.id)) {
      return alert(`"${project.name}" has been invoiced, so it can't be merged — that would break the invoice history.`);
    }
    const choices = projects.filter((p) => p.id !== project.id && !!p.internal === !!project.internal)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!choices.length) {
      return alert(`There's no other ${project.internal ? "internal" : "billed"} project to merge into.`);
    }
    mergeTarget.innerHTML = choices.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    showMerge(true);
  });

  $("mergeCancel").addEventListener("click", () => showMerge(false));

  $("mergeConfirm").addEventListener("click", async () => {
    const { projects, tasks, assignments, dueDates, timeEntries, expenses = [] } = getData();
    const source = projects.find((p) => p.id === editingId);
    const target = projects.find((p) => p.id === mergeTarget.value);
    if (!source || !target) return;
    const hours = timeEntries.filter((e) => e.projectId === source.id).reduce((s, e) => s + Number(e.hours || 0), 0);
    if (!confirm(`Move everything in "${source.name}" (${Math.round(hours * 100) / 100} hrs logged) into "${target.name}", then remove "${source.name}"?\n\nTasks with the same name are combined. This can't be undone.`)) return;

    const btn = $("mergeConfirm");
    btn.disabled = true;
    btn.textContent = "Merging…";
    try {
      const norm = (s) => String(s || "").trim().toLowerCase();
      const targetTasks = tasks.filter((t) => t.projectId === target.id);
      // Entries already on the target, kept current as entries combine into them.
      const onTarget = timeEntries.filter((e) => e.projectId === target.id).map((e) => ({ ...e }));

      for (const task of tasks.filter((t) => t.projectId === source.id)) {
        const same = targetTasks.find((t) => norm(t.name) === norm(task.name));
        const taskId = same ? same.id : task.id;

        for (const e of timeEntries.filter((x) => x.taskId === task.id)) {
          const twin = same && onTarget.find((x) => x.taskId === taskId && x.personId === e.personId && x.date === e.date);
          if (twin) {
            twin.hours = Number(twin.hours || 0) + Number(e.hours || 0);
            twin.note = [twin.note, e.note].filter(Boolean).join("; ");
            twin.approved = !!twin.approved && !!e.approved;
            await TimeEntries.update(twin.id, { hours: twin.hours, note: twin.note, approved: twin.approved, approvedDate: twin.approved ? twin.approvedDate || null : null });
            await TimeEntries.remove(e.id);
          } else {
            await TimeEntries.update(e.id, { projectId: target.id, taskId });
            onTarget.push({ ...e, projectId: target.id, taskId });
          }
        }
        for (const a of assignments.filter((x) => x.taskId === task.id)) {
          const twin = same && assignments.find((x) => x.taskId === taskId && x.personId === a.personId);
          if (twin) {
            await Assignments.update(twin.id, { hours: Number(twin.hours || 0) + Number(a.hours || 0) });
            await Assignments.remove(a.id);
          } else {
            await Assignments.update(a.id, { projectId: target.id, taskId });
          }
        }
        for (const d of dueDates.filter((x) => x.taskId === task.id)) {
          await DueDates.update(d.id, { projectId: target.id, taskId });
        }
        if (same) {
          // Budgets add up; a closed duplicate doesn't close the kept task.
          if (Number(task.budget || 0)) await Tasks.update(same.id, { budget: Number(same.budget || 0) + Number(task.budget || 0) });
          await Tasks.remove(task.id);
        } else {
          await Tasks.update(task.id, { projectId: target.id });
        }
      }

      // Anything left on the project that isn't tied to one of its tasks.
      for (const e of timeEntries.filter((x) => x.projectId === source.id && !tasks.some((t) => t.id === x.taskId && t.projectId === source.id))) {
        await TimeEntries.update(e.id, { projectId: target.id });
      }
      for (const d of dueDates.filter((x) => x.projectId === source.id && !x.taskId)) {
        await DueDates.update(d.id, { projectId: target.id });
      }
      for (const x of expenses.filter((e) => e.projectId === source.id)) {
        await Expenses.update(x.id, { projectId: target.id });
      }
      const subs = source.subconsultants || [];
      const targetUpdate = {};
      if (subs.length) targetUpdate.subconsultants = [...(target.subconsultants || []), ...subs];
      if (Number(source.expenseBudget || 0)) targetUpdate.expenseBudget = Number(target.expenseBudget || 0) + Number(source.expenseBudget || 0);
      if (Object.keys(targetUpdate).length) await Projects.update(target.id, targetUpdate);

      await Projects.remove(source.id);
      showToast(`Merged into "${target.name}".`);
      showMerge(false);
      close();
      onSaved(target.id);
      syncBudgetsToSheet();
    } catch (err) {
      showToast("Error: " + err.message + " (merge stopped partway; run it again to finish)");
    } finally {
      btn.disabled = false;
      btn.textContent = "Merge";
    }
  });

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
      alert("This subconsultant already has invoices recorded, so it can't be removed.");
      return;
    }
    row.remove();
    updateSubTotal();
  });

  modalProjectType.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (btn) setModalType(btn.dataset.value);
  });
  $("modalAddTaskRow").addEventListener("click", () => {
    modalTaskRows.insertAdjacentHTML("beforeend", taskRowHtml());
    modalTaskRows.lastElementChild.querySelector(".modalTaskName").focus();
    updateTaskTotal();
  });
  modalTaskRows.addEventListener("input", (e) => {
    if (e.target.classList.contains("modalTaskBudget")) updateTaskTotal();
  });
  modalTaskRows.addEventListener("click", (e) => {
    const btn = e.target.closest(".removeTaskRow");
    if (!btn) return;
    const { assignments, dueDates, timeEntries } = getData();
    const row = btn.closest(".modal-task-row");
    const taskId = row.dataset.taskId;
    if (taskId) {
      // Hours logged on a task are part of the timesheet/invoice history.
      if (timeEntries.some((e) => e.taskId === taskId)) {
        alert("This task already has hours logged, so it can't be removed — that would break the timesheet and invoice history.");
        return;
      }
      const linked = assignments.filter((a) => a.taskId === taskId).length + dueDates.filter((d) => d.taskId === taskId).length;
      if (linked && !confirm(`Remove this task? Its ${linked} assignment${linked === 1 ? "" : "s"} and subtask${linked === 1 ? "" : "s"} will be removed too when you save.`)) return;
      pendingTaskDeletions.add(taskId);
    }
    row.remove();
    updateTaskTotal();
  });
  $("modalCancelProject").addEventListener("click", close);
  $("modalCloseProject").addEventListener("click", close);
  closeOnBackdropClick(projectModal, close);
  removeBtn.addEventListener("click", async () => {
    if (editingId && await remove(editingId)) {
      close();
      onSaved(null);
    }
  });

  $("modalSaveProject").addEventListener("click", async () => {
    const { tasks, assignments, dueDates } = getData();
    const name = modalProjectName.value.trim();
    const internal = modalType === "internal";
    if (!name) {
      modalProjectName.focus();
      return showToast("Give the project a name.");
    }
    const projectData = {
      name,
      client: modalProjectClient.value.trim(),
      billToName: modalBillToName.value.trim(),
      billToCompany: modalBillToCompany.value.trim(),
      billToAddress1: modalBillToAddress1.value.trim(),
      billToAddress2: modalBillToAddress2.value.trim(),
      projectNumber: modalProjectNumber.value.trim(),
      internal,
      billAtPayRate: false,
      pmPersonId: modalProjectPm.value || null,
      expenseBudget: internal ? 0 : Number(expenseBudget.value) || 0,
      subconsultants: internal ? [] : [...subRows.querySelectorAll(".sub-row")]
        .map((row) => ({
          id: row.dataset.subId || `sub_${Math.random().toString(36).slice(2, 10)}`,
          name: row.querySelector(".subName").value.trim(),
          budget: Number(row.querySelector(".subBudget").value) || 0,
        }))
        .filter((sub) => sub.name),
    };
    try {
      let projectId = editingId;
      if (projectId) {
        await Projects.update(projectId, projectData);
      } else {
        const ref = await Projects.add(projectData);
        projectId = ref.id;
      }

      for (const row of modalTaskRows.querySelectorAll(".modal-task-row")) {
        const taskId = row.dataset.taskId;
        const taskName = row.querySelector(".modalTaskName").value.trim();
        const taskBudget = internal ? 0 : Number(row.querySelector(".modalTaskBudget").value) || 0;
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
      showToast(editingId ? "Project updated." : "Project added.");
      onSaved(projectId);
      syncBudgetsToSheet();
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  return { open };
}
