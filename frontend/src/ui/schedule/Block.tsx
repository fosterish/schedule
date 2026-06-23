import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import type { Project } from "@bindings/Project";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { Task } from "@bindings/Task";
import type { ScheduleViewItem } from "@lib/schedule/resolve";
import { fmtClock, fmtDurationHuman } from "@lib/timefmt";
import * as settings from "@state/settings";
import * as scheduleOps from "@state/mutations/schedule";
import * as uistate from "@state/uistate";
import { projectIndex } from "@state/views";
import { paletteColor } from "@ui/palette";
import { AutoField } from "@ui/components/AutoField";
import { Combobox } from "@ui/components/Combobox";
import { Select } from "@ui/components/Select";
import { Stepper } from "@ui/components/Stepper";
import { DotsIcon, GoToIcon } from "@ui/components/icons";
import { TrashButton } from "@ui/components/TrashButton";

import { ItemEditor } from "./ItemEditor";
import s from "./Block.module.css";

type Focus = "title" | "description" | null;

interface Props {
  item: ScheduleViewItem;
  raw: ScheduleItem | undefined;
  top: number;
  height: number;
  // Times for the label: a live drag/resize preview when active, else the item's
  // resolved start/end. Kept separate so the tag tracks the edge before commit.
  tagStart: number;
  tagEnd: number;
  selected: boolean;
  dragging: boolean;
  onSelect: (focus: Focus) => void;
  // Complete (or reopen) the resolved task and, when the cursor sits inside, split.
  onToggleTask: () => void;
  onPointerDown?: (e: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onResizeStart?: (edge: "start" | "end", e: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
}

// One timeline item. Collapsed, it shows static title/description text so a press
// anywhere drags to reorder. Selecting swaps in the editable fields (or project
// pickers), the bottom-anchored editor controls, and the corner trash. Gradient
// bands encode which of start/duration/end are pinned.
export function Block({
  item,
  raw,
  top,
  height,
  tagStart,
  tagEnd,
  selected,
  dragging,
  onSelect,
  onToggleTask,
  onPointerDown,
  onResizeStart,
}: Props): JSX.Element {
  const focus = uistate.focusOnSelect.value;
  const blockRef = useRef<HTMLDivElement | null>(null);
  const [contentH, setContentH] = useState(0);

  // Report the selected item's natural content height so the timeline can hold
  // a zoom floor tall enough to fit it (head + editor grow with the description).
  useLayoutEffect(() => {
    if (!selected) {
      setContentH(0);
      return;
    }
    const el = blockRef.current;
    if (!el) return;
    const measure = (): void => {
      const headEl = el.children[0] as HTMLElement | undefined;
      const bodyEl = el.children[1] as HTMLElement | undefined;
      const total = (headEl?.offsetHeight ?? 0) + (bodyEl?.offsetHeight ?? 0);
      uistate.selectedContentHeight.value = total;
      setContentH(total);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (el.children[0]) ro.observe(el.children[0]);
    if (el.children[1]) ro.observe(el.children[1]);
    return () => {
      ro.disconnect();
      uistate.selectedContentHeight.value = 0;
    };
  }, [selected]);

  // Only let content overflow the block (e.g. the color popover) once it is tall
  // enough to contain it; while the morph grows the block, keep it clipped so the
  // editor controls don't spill past the short item.
  const expanded = selected && contentH > 0 && height >= contentH - 0.5;
  const cls = [s.block, selected ? s.selected : "", expanded ? s.expanded : "", dragging ? s.dragging : "", ...bandClasses(raw)]
    .filter(Boolean)
    .join(" ");
  const headCls = [s.head, selected ? "" : `${s.headCollapsed} ${s.faded}`].filter(Boolean).join(" ");

  return (
    <div
      ref={blockRef}
      class={cls}
      style={`top:${top}px;height:${height}px;--block-color:${paletteColor(item.color)}`}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        if (!selected) onSelect(null);
      }}
    >
      <div class={headCls}>{head(item, raw, selected, focus, onSelect, onToggleTask)}</div>

      {selected && raw && (
        <ItemEditor raw={raw} frameStart={item.start} frameEnd={item.end} />
      )}

      <div class={s.timeTag}>
        {`${fmtClock(tagStart, settings.hour12.value)} \u2013 ${fmtClock(tagEnd, settings.hour12.value)} (${fmtDurationHuman(tagEnd - tagStart)})`}
      </div>

      {!selected && !dragging && onResizeStart && raw?.bounds.start != null && (
        <div
          class={`${s.handle} ${s.handleTop}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart("start", e);
          }}
        >
          <DotsIcon class={s.handleDots} />
        </div>
      )}
      {!selected && !dragging && onResizeStart && raw?.bounds.end != null && (
        <div
          class={`${s.handle} ${s.handleBottom}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart("end", e);
          }}
        >
          <DotsIcon class={s.handleDots} />
        </div>
      )}
    </div>
  );
}

// Editable title + description for a selected inline item; autoFocus lands on
// whichever field the collapsed click targeted.
function InlineHead({ raw, focus, onDelete }: { raw: ScheduleItem; focus: Focus; onDelete: () => void }): JSX.Element {
  return (
    <>
      <div class={s.headRow}>
        <AutoField
          value={raw.inlineLabel ?? ""}
          onCommit={(v) => scheduleOps.patchItem(raw.id, { inlineLabel: v || null })}
          placeholder="Untitled"
          autoFocus={focus === "title"}
          ariaLabel="Item title"
          class={s.title!}
          wrap
        />
        <TrashButton onClick={onDelete} label="Delete item" class={s.headTrash!} />
      </div>
      <div class={s.descWrap!}>
        <AutoField
          value={raw.inlineDescription ?? ""}
          onCommit={(v) => scheduleOps.patchItem(raw.id, { inlineDescription: v || null })}
          placeholder={"Add description\u2026"}
          multiline
          autoFocus={focus === "description"}
          ariaLabel="Item description"
          class={s.desc!}
        />
      </div>
    </>
  );
}

function head(
  item: ScheduleViewItem,
  raw: ScheduleItem | undefined,
  selected: boolean,
  focus: Focus,
  onSelect: (focus: Focus) => void,
  onToggleTask: () => void,
): JSX.Element {
  if (selected && raw) {
    const onDelete = (): void => scheduleOps.deleteItem(raw.id);
    return raw.useInline ? (
      <InlineHead raw={raw} focus={focus} onDelete={onDelete} />
    ) : (
      <ProjectHead item={item} raw={raw} onDelete={onDelete} />
    );
  }
  return <CollapsedHead item={item} onSelect={onSelect} onToggleTask={onToggleTask} />;
}

// Static text for a collapsed item; clicking selects and focuses the field it hit
// (the field hint is ignored by project items).
function CollapsedHead({
  item,
  onSelect,
  onToggleTask,
}: {
  item: ScheduleViewItem;
  onSelect: (focus: Focus) => void;
  onToggleTask: () => void;
}): JSX.Element {
  const desc = description(item);
  const isTask = item.payload.kind === "task";
  const completed = item.payload.kind === "task" && item.payload.completed;
  const titleCls = completed ? `${s.titleStatic} ${s.titleCompleted}` : s.titleStatic!;
  const { title, subtitle } = headText(item);
  return (
    <>
      <div class={s.headRow}>
        <div class={titleCls} onClick={pickFocus(() => onSelect("title"))}>
          {title}
          {subtitle != null && (
            <span class={s.subtitleStatic}>
              {isTask && (
                <input
                  type="checkbox"
                  class={s.taskCheck}
                  checked={completed}
                  title={completed ? "Mark task incomplete" : "Mark task complete"}
                  aria-label={completed ? "Mark task incomplete" : "Mark task complete"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onToggleTask();
                  }}
                />
              )}
              {subtitle}
            </span>
          )}
        </div>
      </div>
      {desc != null && desc.trim() !== "" && (
        <div class={`${s.descStatic} ${s.descCollapsed}`} onClick={pickFocus(() => onSelect("description"))}>
          {desc}
        </div>
      )}
    </>
  );
}

// Project/task pickers for a project-backed item. Each row pairs a mode dropdown
// (by rank / by name) with a value control: a clamped rank stepper or a
// searchable picker. A null id is the rank mode; switching to by-name seeds the
// id from the currently resolved row so the choice carries over. A ranked project
// resolves at runtime, so the task mode is locked to rank (its rank stays editable).
function ProjectHead({
  item,
  raw,
  onDelete,
}: {
  item: ScheduleViewItem;
  raw: ScheduleItem;
  onDelete: () => void;
}): JSX.Element {
  const { route } = useLocation();
  const projects = projectIndex.value.rankedProjects();
  const projectByRank = raw.projectId == null;

  const resolvedProjectId =
    item.payload.kind === "task" || item.payload.kind === "noTask" ? item.payload.projectId : null;
  const resolvedTaskId = item.payload.kind === "task" ? item.payload.taskId : null;

  const selectedProject = projects.find((p) => p.id === raw.projectId) ?? null;
  const projectId = raw.projectId ?? resolvedProjectId;
  const tasks = projectId != null ? projectIndex.value.projectTasks(projectId) : [];
  const selectedTask = tasks.find((t) => t.id === raw.taskId) ?? null;
  const taskByRank = projectByRank || raw.taskId == null;

  // Names resolved from the payload so the rank-mode parentheticals show what the
  // current rank actually points at; the swatch always uses the item's color.
  const resolvedProjectName =
    item.payload.kind === "task" || item.payload.kind === "noTask" ? item.payload.projectName : null;
  const resolvedTaskName = item.payload.kind === "task" ? item.payload.taskName : null;
  const swatch = paletteColor(item.color);

  // Both buttons only render once their target resolves, so the ids are set here.
  const goToProject = (e: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    route(`/projects/${projectId}`);
  };
  const goToTask = (e: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    uistate.focusTaskId.value = resolvedTaskId;
    route(`/projects/${projectId}`);
  };

  const setProjectMode = (mode: SelMode): void => {
    const projectId = mode === "name" ? (raw.projectId ?? resolvedProjectId ?? projects[0]?.id ?? null) : null;
    scheduleOps.patchItem(raw.id, { projectId, taskId: null });
  };
  const setTaskMode = (mode: SelMode): void => {
    const taskId = mode === "name" ? (raw.taskId ?? resolvedTaskId ?? tasks[0]?.id ?? null) : null;
    scheduleOps.patchItem(raw.id, { taskId });
  };

  return (
    <div class={s.selectWrap}>
      <div class={s.selectGrid}>
        <Select<SelMode>
          options={[
            { value: "rank", label: "Project by priority" },
            { value: "name", label: "Project by name" },
          ]}
          value={projectByRank ? "rank" : "name"}
          onChange={setProjectMode}
          ariaLabel="Project selection mode"
          class={`${s.modeSelect} ${s.areaPmode}`}
        />
        <div class={`${s.valueCell} ${s.areaPval}`}>
          {projectByRank ? (
            <RankField
              value={raw.projectRank}
              max={projects.length}
              ariaLabel="Project rank"
              class={s.rankCell!}
              onChange={(n) => scheduleOps.patchItem(raw.id, { projectRank: n })}
            />
          ) : (
            <Combobox<Project>
              items={projects}
              value={selectedProject}
              getKey={(p) => p.id}
              getLabel={(p) => p.name || "Untitled project"}
              getColor={(p) => paletteColor(p.color)}
              placeholder="Project"
              class={s.comboFill!}
              onSelect={(p) => scheduleOps.patchItem(raw.id, { projectId: p ? p.id : null, taskId: null })}
            />
          )}
          {projectByRank && resolvedProjectName != null && (
            <Resolved color={swatch} name={resolvedProjectName} />
          )}
          {projectId != null && (
            <button
              type="button"
              class={s.goBtn}
              title="Go to project"
              aria-label="Go to project"
              onClick={goToProject}
            >
              <GoToIcon />
            </button>
          )}
        </div>
        <TrashButton onClick={onDelete} label="Delete item" class={`${s.headTrash} ${s.areaTrash}`} />

        <Select<SelMode>
          options={[
            { value: "rank", label: "Task by rank" },
            { value: "name", label: "Task by name" },
          ]}
          value={taskByRank ? "rank" : "name"}
          onChange={setTaskMode}
          disabled={projectByRank}
          ariaLabel="Task selection mode"
          class={`${s.modeSelect} ${s.areaTmode}`}
        />
        <div class={`${s.valueCell} ${s.areaTval}`}>
          {taskByRank ? (
            <RankField
              value={raw.taskRank}
              max={tasks.length}
              ariaLabel="Task rank"
              class={s.rankCell!}
              onChange={(n) => scheduleOps.patchItem(raw.id, { taskRank: n })}
            />
          ) : (
            <Combobox<Task>
              items={tasks}
              value={selectedTask}
              getKey={(t) => t.id}
              getLabel={(t) => t.name || "Untitled task"}
              placeholder="Task"
              class={s.comboFill!}
              onSelect={(t) => scheduleOps.patchItem(raw.id, { taskId: t ? t.id : null })}
            />
          )}
          {taskByRank && resolvedTaskName != null && <Resolved name={resolvedTaskName} />}
          {resolvedTaskId != null && (
            <button
              type="button"
              class={s.goBtn}
              title="Go to task"
              aria-label="Go to task"
              onClick={goToTask}
            >
              <GoToIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// The "(swatch name)" hint shown after a rank picker, naming the row the current
// rank resolves to.
function Resolved({ color, name }: { color?: string; name: string }): JSX.Element {
  return (
    <span class={s.resolved}>
      ({color != null && <span class={s.resolvedSwatch} style={{ background: color }} />}
      <span class={s.resolvedName}>{name || "Untitled"}</span>)
    </span>
  );
}

type SelMode = "rank" | "name";

// Integer rank field (1..max) with a spinner, mirroring the time-anchor steppers.
// Self-syncs on commit so an out-of-range entry snaps back to the clamped value
// even when the clamp lands on the rank already stored.
function RankField({
  value,
  max,
  disabled = false,
  ariaLabel,
  class: cls,
  onChange,
}: {
  value: number;
  max: number;
  disabled?: boolean;
  ariaLabel: string;
  class?: string;
  onChange: (n: number) => void;
}): JSX.Element {
  const hi = Math.max(1, max);
  const clamp = (n: number): number => Math.min(hi, Math.max(1, Math.round(n)));
  const [local, setLocal] = useState(String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setLocal(String(value));
  }, [value]);

  const commit = (): void => {
    editing.current = false;
    const n = Number.parseInt(local, 10);
    const next = Number.isNaN(n) ? value : clamp(n);
    setLocal(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <span class={cls ? `${s.rankField} ${cls}` : s.rankField}>
      <input
        type="text"
        inputMode="numeric"
        class={s.rankInput}
        value={local}
        aria-label={ariaLabel}
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onInput={(e) => {
          editing.current = true;
          setLocal(e.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            editing.current = false;
            setLocal(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      {!disabled && (
        <span class={s.rankStepper}>
          <Stepper onStep={(d) => onChange(clamp(value + d))} label={ariaLabel} />
        </span>
      )}
    </span>
  );
}

// Select on the field's own click so the block handler doesn't then clear focus.
function pickFocus(fn: () => void) {
  return (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    fn();
  };
}

// Gradient encodes which bounds are pinned: free = dark, pinned side = light.
// Two+ pins read fully light; a lone duration peaks light in the middle.
function bandClasses(raw: ScheduleItem | undefined): string[] {
  if (!raw) return [];
  const start = raw.bounds.start != null;
  const end = raw.bounds.end != null;
  const dur = raw.bounds.fixedDuration != null;
  const count = (start ? 1 : 0) + (end ? 1 : 0) + (dur ? 1 : 0);
  if (count >= 2) return [s.bandLight!];
  if (count === 0) return [s.bandDark!];
  if (dur) return [s.bandDurationOnly!];
  if (start) return [s.bandStartOnly!];
  return [s.bandEndOnly!];
}

// Primary title plus an optional subtitle (the task line for project-backed
// items), shown on separate lines rather than joined with a colon.
function headText(item: ScheduleViewItem): { title: string; subtitle: string | null } {
  const p = item.payload;
  switch (p.kind) {
    case "inline":
      return { title: p.label || "Untitled", subtitle: null };
    case "task":
      return { title: p.projectName || "Untitled project", subtitle: p.taskName || "Untitled task" };
    case "noTask":
      return {
        title: p.projectName || "Untitled project",
        subtitle: p.projectHasTasks ? "(no task at rank)" : null,
      };
    case "noProject":
      return { title: "Unresolved", subtitle: null };
  }
}

function description(item: ScheduleViewItem): string | null {
  const p = item.payload;
  if (p.kind === "inline") return p.description;
  if (p.kind === "task") return p.taskDescription;
  return null;
}
