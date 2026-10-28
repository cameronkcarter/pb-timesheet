// Subtasks (dated to-dos assigned to people, e.g. "Draft memo — due Oct 20")
// and timeline events share one record type (DueDates) and one editor, used
// on the Projects page and the Dashboard. The editor's markup is created here
// so both pages get the same pop-up.
import { DueDates, Assignments } from "./db.js";
import { showToast, closeOnBackdropClick, esc, confirmDialog } from "./util.js";

// A subtask has people; an event (shown on the timeline) doesn't.
export function isSubtask(d) {
  return !!(d.personIds && d.personIds.length > 0);
}

export async function setItemCompleted(id, completed) {
  try {
    await DueDates.update(id, { completed, completedDate: completed ? new Date().toISOString() : null });
    if (completed) showToast("Marked complete.", { action: "Undo", onAction: () => setItemCompleted(id, false) });
    else showToast("Reopened.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

export async function deleteItem(d) {
  if (!d || !(await confirmDialog("This can't be undone.", { title: `Delete "${d.title}"?`, confirmText: "Delete", danger: true }))) return false;
  try {
    await DueDates.remove(d.id);
    showToast("Deleted.");
    return true;
  } catch (err) {
    showToast("Error: " + err.message);
    return false;
  }
}

const MARKUP = `
<div id="itemModal" class="modal-overlay" style="display:none;">
  <div class="modal sheet-modal sheet-small item-sheet" role="dialog" aria-labelledby="itemHeading">
    <div class="item-head">
      <h2 id="itemHeading">New subtask</h2>
      <button type="button" id="itemClose" class="icon-btn" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <label for="itemTitle" class="item-label" id="itemTitleLabel">Subtask</label>
      <input type="text" id="itemTitle" class="item-name" placeholder="e.g. Draft plan review memo" autocomplete="off" />

      <div class="item-label">Details</div>
      <div class="row-group">
        <label class="row-item" for="itemProject">
          <span class="row-label">Project</span>
          <select id="itemProject"></select>
        </label>
        <label class="row-item" for="itemTask">
          <span class="row-label">Task</span>
          <select id="itemTask"></select>
        </label>
        <label class="row-item" for="itemDate">
          <span class="row-label" id="itemDateLabel">Due date</span>
          <input type="date" id="itemDate" />
        </label>
      </div>

      <div id="itemPeopleField">
        <div class="item-label">Assigned to</div>
        <div id="itemPeople" class="person-chips"></div>
      </div>
    </div>
    <div class="sheet-foot">
      <button type="button" id="itemDelete" class="link-btn item-delete" style="display:none;">Delete</button>
      <button type="button" id="itemCancel" class="secondary">Cancel</button>
      <button type="button" id="itemSave">Save</button>
    </div>
  </div>
</div>`;

// getData()        -> { people, tasks, projects, assignments } (current lists)
// projectChoices() -> projects offered in the Project dropdown
// canManage(d)     -> may this person edit/delete record d
export function createItemEditor({ getData, sessionPersonId, projectChoices, canManage }) {
  document.body.insertAdjacentHTML("beforeend", MARKUP);
  const $ = (id) => document.getElementById(id);
  const modal = $("itemModal");
  const heading = $("itemHeading");
  const titleLabel = $("itemTitleLabel");
  const saveBtn = $("itemSave");
  const titleInput = $("itemTitle");
  const projectSelect = $("itemProject");
  const taskSelect = $("itemTask");
  const dateInput = $("itemDate");
  const dateLabel = $("itemDateLabel");
  const peopleField = $("itemPeopleField");
  const peoplePills = $("itemPeople");
  const deleteBtn = $("itemDelete");

  let editing = null; // record being edited, or null when adding
  let mode = "subtask"; // "subtask" | "event"

  // Subtasks always belong to a task. Staff can only pick tasks they're
  // assigned to; admins, the project's PM and anyone on an internal project
  // (no assignments there) can pick any open task. Events can be on the
  // whole project.
  function taskChoices(projectId, keepTaskId) {
    const { tasks, people, projects, assignments = [] } = getData();
    const me = people.find((p) => p.id === sessionPersonId);
    const project = projects.find((p) => p.id === projectId);
    const anyTask = mode === "event" || !!(me && me.isAdmin) || !!(project && (project.internal || project.pmPersonId === sessionPersonId));
    return tasks.filter((t) => t.projectId === projectId && (t.id === keepTaskId || (!t.closed && (anyTask
      || assignments.some((a) => a.taskId === t.id && a.personId === sessionPersonId)))))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function fillTasks(projectId, selectedTaskId) {
    const projectTasks = taskChoices(projectId, selectedTaskId);
    const first = mode === "event"
      ? `<option value="">No specific task</option>`
      : `<option value="" disabled ${selectedTaskId ? "" : "selected"}>${projectTasks.length ? "Choose a task" : "No tasks you're assigned to"}</option>`;
    taskSelect.innerHTML = first +
      projectTasks.map((t) => `<option value="${t.id}" ${t.id === selectedTaskId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  }

  function fillPeople(selectedIds) {
    const { people } = getData();
    // Active people, plus anyone already on this subtask.
    const choices = people.filter((p) => !p.inactive || (selectedIds || []).includes(p.id));
    const initials = (name) => String(name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    peoplePills.innerHTML = [...choices].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<label class="person-chip">
      <input type="checkbox" class="itemPerson" value="${p.id}" ${(selectedIds || []).includes(p.id) ? "checked" : ""} />
      <span class="person-chip-avatar">${esc(initials(p.name))}</span>
      <span>${esc(p.name)}</span>
    </label>`).join("");
  }

  function close() {
    modal.style.display = "none";
  }

  // open(record) to edit; open(null, { mode, projectId, taskId, personId }) to add.
  function open(record, preset = {}) {
    editing = record || null;
    mode = record ? (isSubtask(record) ? "subtask" : "event") : (preset.mode || "subtask");
    const noun = mode === "event" ? "event" : "subtask";
    heading.textContent = `${record ? "Edit" : "New"} ${noun}`;
    titleLabel.textContent = mode === "event" ? "Event" : "Subtask";
    titleInput.placeholder = mode === "event" ? "e.g. Community Workshop" : "e.g. Draft plan review memo";
    dateLabel.textContent = mode === "event" ? "Date" : "Due date";
    saveBtn.textContent = record ? "Save changes" : `Add ${noun}`;
    peopleField.style.display = mode === "subtask" ? "block" : "none";

    const choices = projectChoices();
    const projectId = record ? record.projectId : (preset.projectId || (choices[0] && choices[0].id) || "");
    projectSelect.innerHTML = choices.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    projectSelect.value = projectId;
    fillTasks(projectId, record ? record.taskId : (preset.taskId || ""));

    titleInput.value = record ? record.title : "";
    dateInput.value = record ? record.dueDate : "";
    fillPeople(record ? record.personIds : (preset.personId ? [preset.personId] : (mode === "subtask" ? [sessionPersonId] : [])));
    deleteBtn.style.display = record && canManage(record) ? "inline-block" : "none";

    modal.style.display = "flex";
    titleInput.focus();
  }

  projectSelect.addEventListener("change", () => fillTasks(projectSelect.value, ""));
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });
  $("itemCancel").addEventListener("click", close);
  $("itemClose").addEventListener("click", close);
  closeOnBackdropClick(modal, close);

  deleteBtn.addEventListener("click", async () => {
    if (await deleteItem(editing)) close();
  });

  saveBtn.addEventListener("click", async () => {
    const projectId = projectSelect.value;
    const taskId = taskSelect.value || null;
    const title = titleInput.value.trim();
    const dueDate = dateInput.value;
    const personIds = mode === "subtask"
      ? [...peoplePills.querySelectorAll(".itemPerson:checked")].map((cb) => cb.value)
      : [];
    if (!title) { titleInput.focus(); return showToast("Give it a name."); }
    if (!projectId) return showToast("Select a project.");
    if (mode === "subtask" && !taskId) return showToast("Choose a task.");
    if (!dueDate) return showToast(mode === "event" ? "Pick a date." : "Pick a due date.");
    if (mode === "subtask" && personIds.length === 0) return showToast("Assign it to at least one person.");
    try {
      if (editing) {
        await DueDates.update(editing.id, { projectId, taskId, title, dueDate, personIds });
        showToast("Saved.");
      } else {
        await DueDates.add({ projectId, taskId, title, dueDate, personIds, createdByPersonId: sessionPersonId });
        showToast("Added.");
      }
      close();
      await addToTask(projectId, taskId, personIds);
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  // Giving someone a subtask on a task they aren't on yet adds them to that
  // task with 0 assigned hours (admins only; staff can't change assignments).
  async function addToTask(projectId, taskId, personIds) {
    const { people, projects, assignments } = getData();
    const me = people.find((p) => p.id === sessionPersonId);
    const project = projects.find((p) => p.id === projectId);
    if (!taskId || !assignments || !me || !me.isAdmin || !project || project.internal) return;
    const missing = personIds.filter((pid) => !assignments.some((a) => a.taskId === taskId && a.personId === pid));
    try {
      await Promise.all(missing.map((personId) => Assignments.add({ projectId, taskId, personId, hours: 0 })));
    } catch (err) {
      console.warn("Couldn't add to task:", err);
    }
  }

  return { open };
}
