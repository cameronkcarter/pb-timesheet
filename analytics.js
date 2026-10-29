// Analytics (on Admin): where everyone's hours went, for one project or all
// of them, over the last 3 or 12 months or all time.
//   - Totals: hours, share billable to clients, and (one billable project) budget used
//   - Hours by month, stacked: billable · no charge (paid, not billed) · internal
//   - Hours by person, same split, with each person's billable share — on all
//     projects that's the usual consulting "utilization" number.
// Counts every hour logged except declined ones (pending hours included).
// Colors were checked for color-blind separation and contrast on white.
import { esc, fmtHrs, formatCurrency, sortProjects } from "./util.js";
import { isInternal, isBillable, billedAmount } from "./rates.js";

const KINDS = [
  { key: "billed", label: "Billable", color: "#7b3d86" },
  { key: "unbilled", label: "No charge", color: "#c26f1a" },
  { key: "internal", label: "Internal", color: "#1f7fa8" },
];

const monthKeyOf = (iso) => iso.slice(0, 7);
const monthLabel = (key, withYear) => new Date(key + "-01T00:00:00")
  .toLocaleDateString("en-US", withYear ? { month: "short", year: "2-digit" } : { month: "short" });

export function createAnalytics({ getData }) {
  const projectSelect = document.getElementById("analyticsProject");
  const rangeToggle = document.getElementById("analyticsRange");
  const body = document.getElementById("analyticsBody");
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  document.body.appendChild(tip);
  let range = "12"; // months back: "3", "12" or "all"

  function kindOf(e, projects) {
    if (isInternal(projects.find((p) => p.id === e.projectId))) return "internal";
    return isBillable(e) ? "billed" : "unbilled";
  }

  const emptySplit = () => ({ billed: 0, unbilled: 0, internal: 0 });
  const total = (s) => s.billed + s.unbilled + s.internal;
  // Share of hours billed, leaving out internal ones on a single project.
  const billedShare = (s) => (total(s) > 0 ? Math.round((s.billed / total(s)) * 100) : 0);

  function renderProjectOptions() {
    const { projects } = getData();
    const current = projectSelect.value;
    projectSelect.innerHTML = '<option value="">All projects</option>' +
      sortProjects(projects).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    projectSelect.value = projects.some((p) => p.id === current) ? current : "";
  }

  function months() {
    const { timeEntries } = getData();
    const now = new Date();
    const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let start;
    if (range === "all") {
      start = timeEntries.reduce((m, e) => (e.date && e.date.slice(0, 7) < m ? e.date.slice(0, 7) : m), end);
    } else {
      const d = new Date(now.getFullYear(), now.getMonth() - (Number(range) - 1), 1);
      start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    const list = [];
    let [y, m] = start.split("-").map(Number);
    while (`${y}-${String(m).padStart(2, "0")}` <= end) {
      list.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return list;
  }

  function legendHtml(kinds) {
    return `<div class="chart-legend">${kinds.map((k) =>
      `<span><i style="background:${k.color};"></i>${k.label}</span>`).join("")}</div>`;
  }

  // Stacked segments for one split; tooltip lists each part.
  function segmentsHtml(split, scale, kinds, vertical) {
    return kinds.filter((k) => split[k.key] > 0).map((k) => {
      const size = `${(split[k.key] / scale) * 100}%`;
      return `<div class="seg" style="background:${k.color}; ${vertical ? "height" : "width"}:${size};"></div>`;
    }).join("");
  }

  const tipText = (title, split, kinds) =>
    `<strong>${esc(title)}</strong>${kinds.map((k) => `<span><i style="background:${k.color};"></i>${k.label} <b>${fmtHrs(split[k.key])}</b></span>`).join("")}<span class="tip-total">Total <b>${fmtHrs(total(split))} hrs</b></span>`;

  function render() {
    const { projects, people, timeEntries } = getData();
    renderProjectOptions();
    const projectId = projectSelect.value;
    const project = projects.find((p) => p.id === projectId);
    const monthList = months();
    const first = monthList[0];
    const entries = timeEntries.filter((e) => !e.declined && e.date && monthKeyOf(e.date) >= first
      && (!projectId || e.projectId === projectId));
    // Only the kinds that can appear here (e.g. no "Internal" on a billable project).
    const kinds = KINDS.filter((k) => !project || (isInternal(project) ? k.key === "internal" : k.key !== "internal"));

    if (!entries.length) {
      body.innerHTML = '<div class="empty">No hours logged in this period.</div>';
      return;
    }

    const all = emptySplit();
    const byMonth = new Map(monthList.map((k) => [k, emptySplit()]));
    const byPerson = new Map();
    entries.forEach((e) => {
      const kind = kindOf(e, projects);
      const h = Number(e.hours || 0);
      all[kind] += h;
      byMonth.get(monthKeyOf(e.date))[kind] += h;
      if (!byPerson.has(e.personId)) byPerson.set(e.personId, emptySplit());
      byPerson.get(e.personId)[kind] += h;
    });

    // Headline numbers.
    const stats = [`<div class="a-stat"><div class="a-value">${fmtHrs(total(all))}</div><div class="a-label">hours</div></div>`];
    if (!project || !isInternal(project)) {
      stats.push(`<div class="a-stat"><div class="a-value">${billedShare(all)}%</div><div class="a-label">billable to clients</div></div>`);
    }
    if (project && !isInternal(project)) {
      const { tasks } = getData();
      const budget = tasks.filter((t) => t.projectId === project.id).reduce((s, t) => s + Number(t.budget || 0), 0);
      const spent = billedAmount(timeEntries.filter((e) => e.projectId === project.id), { projects, people });
      if (budget > 0) {
        stats.push(`<div class="a-stat"><div class="a-value">${Math.round((spent / budget) * 100)}%</div><div class="a-label">of budget used · ${formatCurrency(spent)} of ${formatCurrency(budget)}</div></div>`);
      }
    }

    // Hours by month (vertical stacked bars).
    const monthMax = Math.max(1, ...[...byMonth.values()].map(total));
    const crossesYear = monthList[0].slice(0, 4) !== monthList[monthList.length - 1].slice(0, 4);
    const labelEvery = monthList.length > 18 ? 3 : monthList.length > 12 ? 2 : 1;
    const monthBars = monthList.map((k, i) => {
      const s = byMonth.get(k);
      const label = i % labelEvery === 0 ? monthLabel(k, crossesYear && (i === 0 || k.endsWith("-01"))) : "";
      return `<div class="m-col" data-tip="${esc(tipText(monthLabel(k, true), s, kinds))}">
        <div class="m-stack">${segmentsHtml(s, monthMax, kinds, true)}</div>
        <span class="m-label">${label}</span>
      </div>`;
    }).join("");

    // Hours by person (horizontal stacked bars), most hours first.
    const rows = [...byPerson].map(([pid, s]) => ({ name: people.find((p) => p.id === pid)?.name || "—", s }))
      .sort((a, b) => total(b.s) - total(a.s));
    const personMax = Math.max(1, ...rows.map((r) => total(r.s)));
    const showShare = !project || !isInternal(project);
    const personBars = rows.map((r) => `<div class="p-row" data-tip="${esc(tipText(r.name, r.s, kinds))}">
        <span class="p-name">${esc(r.name)}</span>
        <div class="p-track">${segmentsHtml(r.s, personMax, kinds, false)}</div>
        <span class="p-value">${fmtHrs(total(r.s))}${showShare ? ` <span class="appr-muted">· ${billedShare(r.s)}%</span>` : ""}</span>
      </div>`).join("");

    body.innerHTML = `<div class="a-stats">${stats.join("")}</div>
      ${kinds.length > 1 ? legendHtml(kinds) : ""}
      <div class="a-charts">
        <div class="a-chart">
          <div class="a-title">Hours by month</div>
          <div class="m-chart">
            <div class="m-axis"><span>${fmtHrs(monthMax)}</span><span>0</span></div>
            <div class="m-cols">${monthBars}</div>
          </div>
        </div>
        <div class="a-chart">
          <div class="a-title">Hours by person${showShare ? ' <span class="appr-muted">· share billable</span>' : ""}</div>
          <div class="p-chart">${personBars}</div>
        </div>
      </div>`;
  }

  // One tooltip for every bar: follows the pointer.
  body.addEventListener("pointermove", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 14 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  body.addEventListener("pointerleave", () => { tip.hidden = true; });

  projectSelect.addEventListener("change", render);
  rangeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    range = btn.dataset.value;
    rangeToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    render();
  });

  return { render };
}
