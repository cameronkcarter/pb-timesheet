// Picking a project (Projects and Setup tabs): a search box over every
// project, your projects as chips, and "All projects" listing the rest.
// The page shows the picked project's details under it.
//   root     — element to fill (inside the page's project card)
//   getData  — () => ({ projects, mine, selectedId, groups })
//              groups (optional): [{ label, list, cls }] — chips in labeled
//              sections instead of one "mine" row (Timesheet: Projects, Pursuits)
//   onPick   — (projectId) => void
//   action   — optional HTML for a button beside the search (e.g. + New Project)
//   label    — heading over the chips (default "Your Projects")
import { esc, projectColor, markClass, projectShortName } from "./util.js";

const SEARCH_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

export function createProjectPicker({ root, getData, onPick, action = "", label = "Your Projects" }) {
  root.classList.add("project-picker");
  root.innerHTML = `
    <div class="picker-top">
      <label class="project-search">${SEARCH_ICON}
        <input type="search" placeholder="Find a project by name, client or number" aria-label="Find a project" autocomplete="off" />
      </label>
      ${action}
    </div>
    <div class="picker-results" hidden></div>
    <div class="chip-label">${label}</div>
    <div class="project-chips"></div>
    <div class="other-projects" hidden></div>`;
  const search = root.querySelector(".project-search input");
  const results = root.querySelector(".picker-results");
  const chips = root.querySelector(".project-chips");
  const others = root.querySelector(".other-projects");
  let othersOpen = false;

  const dot = (p) => `<i aria-hidden="true" class="${markClass(p.id)}" style="--c:${projectColor(p.id)};"></i>`;

  function matches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return getData().projects
      .filter((p) => [p.name, p.client, p.shortName, p.projectNumber].some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  function renderResults() {
    const list = matches(search.value);
    results.hidden = !search.value.trim();
    results.innerHTML = list.length
      ? list.map((p, i) => `<button type="button" class="picker-result ${i === 0 ? "first" : ""}" data-project-card="${p.id}">
          ${dot(p)}<span class="picker-result-name">${esc(p.name)}</span>
          <span class="picker-result-meta">${esc([p.client, p.projectNumber].filter(Boolean).join(" · "))}</span></button>`).join("")
      : '<div class="picker-none">No projects match.</div>';
  }

  function render() {
    const { projects, mine, selectedId, groups } = getData();
    const mineIds = new Set(mine.map((p) => p.id));
    const rest = projects.filter((p) => !mineIds.has(p.id)).sort((x, y) => x.name.localeCompare(y.name));
    const selected = projects.find((p) => p.id === selectedId);
    const chip = (p) => `<button type="button" class="project-chip ${markClass(p.id)} ${p.id === selectedId ? "on" : ""}" data-project-card="${p.id}"
      style="--c:${projectColor(p.id)};" title="${esc(p.name)}"><i aria-hidden="true"></i>${esc(projectShortName(p))}</button>`;
    root.classList.toggle("grouped", !!groups);
    if (groups) {
      chips.innerHTML = groups.filter((g) => g.list.length).map((g) => `<div class="chip-group ${g.cls || ""}">
        <div class="chip-label">${esc(g.label)}</div><div class="chip-group-row">${g.list.map(chip).join("")}</div></div>`).join("");
      others.hidden = true;
      return;
    }
    chips.innerHTML = [...mine, ...(selected && !mineIds.has(selected.id) ? [selected] : [])].map(chip).join("")
      + (rest.length ? `<button type="button" class="project-chip project-chip-more" data-action="all-projects" aria-expanded="${othersOpen}">
          All projects (${projects.length}) <span class="chev ${othersOpen ? "up" : ""}" aria-hidden="true">&#9662;</span></button>` : "");
    others.hidden = !othersOpen;
    others.innerHTML = [...projects].sort((x, y) => x.name.localeCompare(y.name))
      .map((p) => `<button type="button" class="other-project ${markClass(p.id)} ${p.id === selectedId ? "on" : ""}" data-project-card="${p.id}"
        style="--c:${projectColor(p.id)};"><i aria-hidden="true"></i>${esc(p.name)}</button>`).join("");
  }

  function pick(id) {
    othersOpen = false;
    search.value = "";
    renderResults();
    onPick(id);
    render();
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="all-projects"]')) {
      othersOpen = !othersOpen;
      render();
      return;
    }
    const btn = e.target.closest("[data-project-card]");
    if (btn) pick(btn.dataset.projectCard);
  });
  search.addEventListener("input", renderResults);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = matches(search.value)[0];
      if (first) pick(first.id);
    }
    if (e.key === "Escape") { search.value = ""; renderResults(); }
  });

  return { render };
}
