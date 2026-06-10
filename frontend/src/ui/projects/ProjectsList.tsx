import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import type { Project } from "@bindings/Project";
import { effectiveProjects, effectiveTasks } from "@state/pending";
import * as projectOps from "@state/mutations/project";
import * as uistate from "@state/uistate";
import { projectIndex } from "@state/views";
import { paletteColor, randomProjectColor } from "@ui/palette";
import { FilterField } from "@ui/components/FilterField";
import { HistoryControls } from "@ui/components/HistoryControls";
import { NewButton } from "@ui/components/NewButton";
import { PipPicker } from "@ui/components/PipPicker";
import { PlusIcon } from "@ui/components/icons";

import s from "./ProjectsList.module.css";

export function ProjectsList(): JSX.Element {
  const { path, route } = useLocation();
  const [filter, setFilter] = useState("");
  useEffect(() => {
    uistate.lastProjectsRoute.value = path;
  }, [path]);

  const idx = projectIndex.value;
  const ranked: Project[] = [];
  for (let rank = 1; ; rank++) {
    const pid = idx.pickByRank(rank);
    if (pid == null) break;
    const p = idx.project(pid);
    if (p) ranked.push(p);
  }

  const archivedAll = effectiveProjects.value
    .filter((p) => p.archivedAt != null)
    .sort((a, b) => b.archivedAt! - a.archivedAt!);

  const q = filter.trim().toLowerCase();
  const matches = (p: Project): boolean => q === "" || (p.name || "Untitled project").toLowerCase().includes(q);
  const shown = ranked.filter(matches);
  const archivedShown = archivedAll.filter(matches);

  const tasksByProject = new Map<string, { total: number; done: number }>();
  for (const t of effectiveTasks.value) {
    const c = tasksByProject.get(t.projectId) ?? { total: 0, done: 0 };
    c.total += 1;
    if (t.completedAt != null) c.done += 1;
    tasksByProject.set(t.projectId, c);
  }

  function create(): void {
    const id = projectOps.createProject(randomProjectColor());
    if (id != null) route(`/projects/${id}`);
  }

  function renderRow(p: Project, isArchived: boolean): JSX.Element {
    const c = tasksByProject.get(p.id) ?? { total: 0, done: 0 };
    return (
      <button
        key={p.id}
        type="button"
        class={isArchived ? `${s.row} ${s.archivedRow}` : s.row}
        style={`--project-color:${paletteColor(p.color)}`}
        onClick={() => route(`/projects/${p.id}`)}
      >
        <span class={s.dot} style={`background:${paletteColor(p.color)}`} />
        <span class={s.name}>{p.name || "Untitled project"}</span>
        {c.total > 0 && (
          <span class={s.count}>
            {c.done} / {c.total}
          </span>
        )}
        <span class={s.stats}>
          <PipPicker value={p.value} count={8} color="lime" readonly />
          <PipPicker value={p.time} count={8} color="sky" readonly />
        </span>
      </button>
    );
  }

  return (
    <div class={s.screen}>
      <header class={s.header}>
        <h1 class={s.heading}>Projects</h1>
        <HistoryControls context="project" />
        <NewButton label="New project" onClick={create} />
      </header>
      <div class={s.toolbar}>
        <FilterField value={filter} onInput={setFilter} ariaLabel="Filter projects" class={s.filter!} />
      </div>
      <div class={s.list}>
        {shown.map((p) => renderRow(p, false))}
        {archivedShown.length > 0 && <div class={s.divider}>Archived</div>}
        {archivedShown.map((p) => renderRow(p, true))}
        {shown.length === 0 && archivedShown.length === 0 && (
          <p class={s.empty}>{ranked.length === 0 && archivedAll.length === 0 ? "No projects yet." : "No matches."}</p>
        )}
      </div>
      <button type="button" class={s.add} title="New project" onClick={create}>
        <PlusIcon />
      </button>
    </div>
  );
}
