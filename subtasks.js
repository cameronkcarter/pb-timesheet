// Subtasks (dated to-dos assigned to people, e.g. "Draft memo — due Oct 20")
// and timeline events share one record type (DueDates) and one editor, used
// on the Projects page and the Dashboard. The editor's markup is created here
// so both pages get the same pop-up.
import { DueDates } from "./db.js";
import { showToast, closeOnBackdropClick, esc } from "./util.js";

// A subtask has people; an event (shown on the timeline) doesn't.
export function isSubtask(d) {
  return !!(d.personIds && d.personIds.length > 0);
}

export async function setItemCompleted(id, completed) {
  try {
    await DueDates.update(id, { completed, completedDate: completed ? new Date().toISOString() : null });
    showToast(completed ? "Marked complete." : "Reopened.");
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

export async function deleteItem(d) {
  if (!d || !confirm(`Delete "${d.title}"? This can't be undone.`)) return false;
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
  <div class="modal sheet-modal sheet-small" role="dialog" aria-labelledby="itemTitle">
    <div class="sheet-head">
      <div class="sheet-kicker" id="itemKicker">New subtask</div>
      <input type="text" id="itemTitle" class="title-input" placeholder="What needs doing?" />
      <button type="button" id="itemClose" class="icon-btn sheet-close" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <div class="field-grid">
        <div class="field">
          <label for="itemProject">Project</label>
          <select id="itemProject"></select>
        </div>
        <div class="field">
          <label for="itemTask">Task</label>
          <select id="itemTask"></select>
        </div>
        <div class="field">
          <label for="itemDate" id="itemDateLabel">Due date</label>
          <input type="date" id="itemDate" />
        </div>
      </div>
      <div class="field" id="itemPeopleField">
        <label>Assigned to</label>
        <div id="itemPeople" class="dd-people-pills"></div>
      </div>
    </div>
    <div class="sheet-foot">
      <button type="button" id="itemDelete" class="danger" style="margin-right:auto; display:none;">Delete</button>
      <button type="button" id="itemCancel" class="secondary">Cancel</button>
      <button type="button" id="itemSave">Save</button>
    </div>
  </div>
</div>`;

// getData()        -> { people, tasks, projects } (current lists)
// projectChoices() -> projects offered in the Project dropdown
// canManage(d)     -> may this person edit/delete record d
export function createItemEditor({ getData, sessionPersonId, projectChoices, canManage }) {
  document.body.insertAdjacentHTML("beforeend", MARKUP);
  const $ = (id) => document.getElementById(id);
  const modal = $("itemModal");
  const kicker = $("itemKicker");
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

  function fillTasks(projectId, selectedTaskId) {
    const { tasks } = getData();
    const projectTasks = tasks.filter((t) => t.projectId === projectId).sort((a, b) => a.name.localeCompare(b.name));
    taskSelect.innerHTML = `<option value="">${mode === "event" ? "No specific task" : "Whole project"}</option>` +
      projectTasks.map((t) => `<option value="${t.id}" ${t.id === selectedTaskId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  }

  function fillPeople(selectedIds) {
    const { people } = getData();
    // Active people, plus anyone already on this subtask.
    const choices = people.filter((p) => !p.inactive || (selectedIds || []).includes(p.id));
    peoplePills.innerHTML = [...choices].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<label>
      <input type="checkbox" class="itemPerson" value="${p.id}" ${(selectedIds || []).includes(p.id) ? "checked" : ""} />
      ${esc(p.name)}
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
    kicker.textContent = `${record ? "Edit" : "New"} ${noun}`;
    titleInput.placeholder = mode === "event" ? "Event name, e.g. Community Workshop" : "What needs doing?";
    dateLabel.textContent = mode === "event" ? "Date" : "Due date";
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
  $("itemCancel").addEventListener("click", close);
  $("itemClose").addEventListener("click", close);
  closeOnBackdropClick(modal, close);

  deleteBtn.addEventListener("click", async () => {
    if (await deleteItem(editing)) close();
  });

  $("itemSave").addEventListener("click", async () => {
    const projectId = projectSelect.value;
    const taskId = taskSelect.value || null;
    const title = titleInput.value.trim();
    const dueDate = dateInput.value;
    const personIds = mode === "subtask"
      ? [...peoplePills.querySelectorAll(".itemPerson:checked")].map((cb) => cb.value)
      : [];
    if (!title) { titleInput.focus(); return showToast("Give it a name."); }
    if (!projectId) return showToast("Select a project.");
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
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  return { open };
}
