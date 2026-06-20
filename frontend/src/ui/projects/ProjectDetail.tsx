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
  // Freeze whether this is the just-created project, then clear the one-shot flag.
  const [focusTitle] = useState(() => uistate.focusProjectId.value === id);
  useEffect(() => {
    uistate.lastProjectsRoute.value = path;
    const pending = uistate.focusTaskId.peek();
    if (pending != null) {
      uistate.selectTask(pending);
      uistate.focusTaskId.value = null;
    } else {
      uistate.selectTask(null);
    }
  }, [path]);
  useEffect(() => {
    if (uistate.focusProjectId.value === id) uistate.focusProjectId.value = null;
  }, [id]);

  if (!id) return null;
  const project = effectiveProjects.value.find((p) => p.id === id) ?? null;
  const notFound = project == null;

  const hasCompleted =
    project != null && effectiveTasks.value.some((t) => t.projectId === project.id && t.completedAt != null);
  const archived = project?.archivedAt != null;

  function addTask(): void {
    if (!project) return;
    const tid = projectOps.createTask(project.id);
    if (tid != null) uistate.selectTask(tid, "title");
  }

  return (
    <div class={s.screen} style={`--project-color:${paletteColor(project?.color ?? "blue")}`}>
      <header class={s.header}>
        {project && (
          <ColorSwatch
            value={project.color}
            onPick={(c) => projectOps.patchProject(project.id, { color: c })}
            class={s.swatch!}
          />
        )}
        <div class={s.titleRow}>
          {project ? (
            <AutoField
              value={project.name}
              onCommit={(name) => projectOps.patchProject(project.id, { name })}
              placeholder="Untitled project"
              ariaLabel="Project name"
              class={archived ? `${s.title} ${s.titleArchived}` : s.title!}
              autoFocus={focusTitle}
              wrap
              fitContent={archived}
            />
          ) : (
            <AutoField value="Not Found" onCommit={() => {}} ariaLabel="Project name" class={s.title!} disabled wrap />
          )}
          {archived && <span class={s.archivedTag}>(Archived)</span>}
        </div>
        <HistoryControls context="project" disabled={notFound} />
        <NewButton label="New task" onClick={addTask} disabled={notFound} />
        <TrashButton
          onClick={() => {
            if (!project) return;
            projectOps.deleteProject(project.id);
            route("/projects");
          }}
          label="Delete project"
          disabled={notFound}
        />
      </header>
      <div class={s.toolbar}>
        <button type="button" class={s.back} onClick={() => route("/projects")}>
          <ChevronLeftIcon />
          <span>Projects</span>
        </button>
        <FilterField value={filter} onInput={setFilter} ariaLabel="Filter tasks" class={s.filter!} disabled={notFound} />
        <button
          type="button"
          class={s.clearCompleted}
          title="Delete all completed"
          aria-label="Delete all completed"
          disabled={notFound || !hasCompleted}
          onClick={() => project && projectOps.deleteCompletedTasks(project.id)}
        >
          <BroomIcon />
        </button>
        <button
          type="button"
          class={archived ? `${s.clearCompleted} ${s.archiveOn}` : s.clearCompleted!}
          title={archived ? "Unarchive project" : "Archive project"}
          aria-label={archived ? "Unarchive project" : "Archive project"}
          aria-pressed={archived}
          disabled={notFound}
          onClick={() => project && projectOps.toggleProjectArchived(project.id)}
        >
          <ArchiveIcon />
        </button>
      </div>
      <div class={s.stats}>
        <div class={s.statRow}>
          <span class={s.statLabel}>Value</span>
          <PipPicker
            value={project?.value ?? 0}
            count={8}
            color="lime"
            readonly={notFound}
            onPick={(v) => project && projectOps.patchProject(project.id, { value: v })}
          />
        </div>
        <div class={s.statRow}>
          <span class={s.statLabel}>Time</span>
          <PipPicker
            value={project?.time ?? 0}
            count={8}
            color="sky"
            readonly={notFound}
            onPick={(v) => project && projectOps.patchProject(project.id, { time: v })}
          />
        </div>
      </div>
      {project && <TaskList project={project} filter={filter} />}
      <button type="button" class={s.add} title="Add task" onClick={addTask} disabled={notFound}>
        <PlusIcon />
      </button>
    </div>
  );
}
