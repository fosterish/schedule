import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import { effectiveProjects, effectiveTasks } from "@state/pending";
import * as projectOps from "@state/mutations/project";
import * as uistate from "@state/uistate";
import { paletteColor } from "@ui/palette";
import { AutoField } from "@ui/components/AutoField";
import { ColorSwatch } from "@ui/components/ColorSwatch";
import { FilterField } from "@ui/components/FilterField";
import { HistoryControls } from "@ui/components/HistoryControls";
import { NewButton } from "@ui/components/NewButton";
import { PipPicker } from "@ui/components/PipPicker";
import { TrashButton } from "@ui/components/TrashButton";
import { ArchiveIcon, BroomIcon, ChevronLeftIcon, PlusIcon } from "@ui/components/icons";

import { TaskList } from "./TaskList";
import s from "./ProjectDetail.module.css";

export function ProjectDetail({ id }: { id?: string }): JSX.Element | null {
  const { path, route } = useLocation();
  const [filter, setFilter] = useState("");
  useEffect(() => {
    uistate.lastProjectsRoute.value = path;
    uistate.selectTask(null);
  }, [path]);

  if (!id) return null;
  const project = effectiveProjects.value.find((p) => p.id === id);
  if (!project) return <div class={s.centered}>Project not found.</div>;

  const hasCompleted = effectiveTasks.value.some((t) => t.projectId === project.id && t.completedAt != null);
  const archived = project.archivedAt != null;

  function addTask(): void {
    if (!project) return;
    const tid = projectOps.createTask(project.id);
    if (tid != null) uistate.selectTask(tid, "title");
  }

  return (
    <div class={s.screen} style={`--project-color:${paletteColor(project.color)}`}>
      <header class={s.header}>
        <ColorSwatch
          value={project.color}
          onPick={(c) => projectOps.patchProject(project.id, { color: c })}
          class={s.swatch!}
        />
        <div class={s.titleRow}>
          <AutoField
            value={project.name}
            onCommit={(name) => projectOps.patchProject(project.id, { name })}
            placeholder="Untitled project"
            ariaLabel="Project name"
            class={archived ? `${s.title} ${s.titleArchived}` : s.title!}
            wrap
            fitContent={archived}
          />
          {archived && <span class={s.archivedTag}>(Archived)</span>}
        </div>
        <HistoryControls context="project" />
        <NewButton label="New task" onClick={addTask} />
        <TrashButton
          onClick={() => {
            projectOps.deleteProject(project.id);
            route("/projects");
          }}
          label="Delete project"
        />
      </header>
      <div class={s.toolbar}>
        <button type="button" class={s.back} onClick={() => route("/projects")}>
          <ChevronLeftIcon />
          <span>Projects</span>
        </button>
        <FilterField value={filter} onInput={setFilter} ariaLabel="Filter tasks" class={s.filter!} />
        <button
          type="button"
          class={s.clearCompleted}
          title="Delete all completed"
          aria-label="Delete all completed"
          disabled={!hasCompleted}
          onClick={() => projectOps.deleteCompletedTasks(project.id)}
        >
          <BroomIcon />
        </button>
        <button
          type="button"
          class={archived ? `${s.clearCompleted} ${s.archiveOn}` : s.clearCompleted!}
          title={archived ? "Unarchive project" : "Archive project"}
          aria-label={archived ? "Unarchive project" : "Archive project"}
          aria-pressed={archived}
          onClick={() => projectOps.toggleProjectArchived(project.id)}
        >
          <ArchiveIcon />
        </button>
      </div>
      <div class={s.stats}>
        <div class={s.statRow}>
          <span class={s.statLabel}>Value</span>
          <PipPicker value={project.value} count={8} color="lime" onPick={(v) => projectOps.patchProject(project.id, { value: v })} />
        </div>
        <div class={s.statRow}>
          <span class={s.statLabel}>Time</span>
          <PipPicker value={project.time} count={8} color="sky" onPick={(v) => projectOps.patchProject(project.id, { time: v })} />
        </div>
      </div>
      <TaskList project={project} filter={filter} />
      <button type="button" class={s.add} title="Add task" onClick={addTask}>
        <PlusIcon />
      </button>
    </div>
  );
}
