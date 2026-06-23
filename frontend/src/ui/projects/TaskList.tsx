import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { Project } from "@bindings/Project";
import type { Task } from "@bindings/Task";
import type { TaskId } from "@bindings/TaskId";
import * as proj from "@lib/project";
import { effectiveDependencies, effectiveTasks } from "@state/pending";
import * as projectOps from "@state/mutations/project";
import * as uistate from "@state/uistate";
import { AutoField } from "@ui/components/AutoField";
import { TrashButton } from "@ui/components/TrashButton";
import { GripIcon } from "@ui/components/icons";

import { DependencyEditor } from "./DependencyEditor";
import s from "./TaskList.module.css";

interface DragState {
  id: TaskId;
  startY: number;
  y: number;
  order: TaskId[];
  mids: number[];
  height: number;
  target: proj.reorder.TaskReorder | null;
  conflicts: Set<TaskId>;
  moved: boolean;
}

// Per-row translateY for a live drag preview: shift the untouched rows to open a
// gap at the target slot while the grabbed row floats with the pointer.
function previewOffsets(d: DragState): Map<TaskId, number> {
  const out = new Map<TaskId, number>([[d.id, d.y - d.startY]]);
  if (!d.target) return out;
  const rest = d.order.filter((id) => id !== d.id);
  const insertAt = d.target.afterId == null ? 0 : rest.indexOf(d.target.afterId) + 1;
  const preview = [...rest];
  preview.splice(insertAt, 0, d.id);
  // Shift by the center-to-center pitch (row height + list gap), not the bare
  // row height, so the preview matches where the committed reorder lands.
  const pitch = d.mids.length >= 2 ? d.mids[1]! - d.mids[0]! : d.height;
  for (const id of d.order) {
    if (id === d.id) continue;
    out.set(id, (preview.indexOf(id) - d.order.indexOf(id)) * pitch);
  }
  return out;
}

export function TaskList({ project, filter = "" }: { project: Project; filter?: string }): JSX.Element {
  const all = effectiveTasks.value
    .filter((t) => t.projectId === project.id)
    .sort((a, b) => (a.listOrder < b.listOrder ? -1 : a.listOrder > b.listOrder ? 1 : 0));
  const deps = effectiveDependencies.value.filter(
    (d) => all.some((t) => t.id === d.blockedId) || all.some((t) => t.id === d.blockerId),
  );
  const q = filter.trim().toLowerCase();
  const filtering = q !== "";
  const visible = filtering ? all.filter((t) => (t.name || "Untitled task").toLowerCase().includes(q)) : all;
  const [incomplete, completed] = proj.tasks.partitionByCompletion(visible);
  const edges = proj.graph.edgesFromDeps(deps);

  const doneIds = new Set(all.filter((t) => t.completedAt != null).map((t) => t.id));
  const blockedCounts = new Map<TaskId, number>();
  for (const d of deps) {
    if (!doneIds.has(d.blockerId)) blockedCounts.set(d.blockedId, (blockedCounts.get(d.blockedId) ?? 0) + 1);
  }

  const rowRefs = useRef(new Map<TaskId, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const selectedId = uistate.selectedTask.value;

  // Reveal the selected task (e.g. arriving via "Go to task"); "nearest" leaves
  // an already-visible row in place so plain clicks don't jump the list.
  useEffect(() => {
    if (selectedId == null) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function gripDown(id: TaskId) {
    return (e: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      // Reordering another task drops the current selection; capture geometry on
      // the next frame so it reflects the now-collapsed (deselected) layout.
      uistate.selectTask(null);
      const order = incomplete.map((t) => t.id);
      const startY = e.clientY;
      setDrag({ id, startY, y: startY, order, mids: [], height: 0, target: null, conflicts: new Set(), moved: false });
      requestAnimationFrame(() => {
        const mids = order.map((tid) => {
          const r = rowRefs.current.get(tid)?.getBoundingClientRect();
          return r ? r.top + r.height / 2 : 0;
        });
        const height = rowRefs.current.get(id)?.getBoundingClientRect().height ?? 0;
        setDrag((d) => (d && d.id === id ? { ...d, mids, height } : d));
      });
    };
  }

  function gripMove(e: JSX.TargetedPointerEvent<HTMLButtonElement>): void {
    if (!drag || drag.mids.length === 0) return;
    const y = e.clientY;
    const dir = y >= drag.startY ? "down" : "up";
    // The leading edge of the dragged row (bottom when moving down, top when up)
    // is what crosses other rows' midpoints, independent of the grab offset.
    const draggedMid = drag.mids[drag.order.indexOf(drag.id)] ?? drag.startY;
    const center = draggedMid + (y - drag.startY);
    const leadingEdge = dir === "down" ? center + drag.height / 2 : center - drag.height / 2;
    const res = proj.reorder.detect(drag.order, drag.mids, drag.id, dir, leadingEdge, edges);
    if (res.ok) {
      setDrag({ ...drag, y, moved: true, target: res.value, conflicts: new Set() });
    } else {
      setDrag({ ...drag, y, moved: true, conflicts: new Set(res.error.conflictIds) });
    }
  }

  function gripUp(): void {
    if (!drag) return;
    const d = drag;
    // On-screen tops of every row the preview moved (the floating grabbed row
    // plus the rows shifted to open its gap), captured while their transforms
    // still apply.
    const before = new Map<TaskId, number>();
    if (d.moved) {
      for (const id of previewOffsets(d).keys()) {
        const top = rowRefs.current.get(id)?.getBoundingClientRect().top;
        if (top != null) before.set(id, top);
      }
    }
    setDrag(null);
    if (d.moved && d.target && d.conflicts.size === 0) {
      projectOps.reorderTask(project.id, d.id, d.target.afterId);
    }
    if (before.size === 0) return;
    // FLIP: the preview already sat every row at its final spot, so clearing
    // their transforms must not re-animate them. Pin each row back to its drop
    // position (transition off) then release; only true deltas animate, i.e.
    // the grabbed row sliding from the pointer into its slot.
    requestAnimationFrame(() => {
      const settled: HTMLElement[] = [];
      for (const [id, top] of before) {
        const el = rowRefs.current.get(id);
        if (!el) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${top - el.getBoundingClientRect().top}px)`;
        settled.push(el);
      }
      requestAnimationFrame(() => {
        for (const el of settled) {
          el.style.transition = "";
          el.style.transform = "";
        }
      });
    });
  }

  const offsets = drag ? previewOffsets(drag) : null;

  const renderRow = (t: Task, draggable: boolean): JSX.Element => {
    const selected = selectedId === t.id;
    const dragging = drag?.id === t.id && drag.moved;
    const offset = offsets?.get(t.id);
    const blockedBy = blockedCounts.get(t.id) ?? 0;
    return (
      <div
        key={t.id}
        ref={(el) => {
          if (el) rowRefs.current.set(t.id, el);
          else rowRefs.current.delete(t.id);
        }}
        class={[s.row, selected ? s.selected : "", dragging ? s.dragging : "", drag?.conflicts.has(t.id) ? s.conflict : ""]
          .filter(Boolean)
          .join(" ")}
        style={offset ? `transform:translateY(${offset}px)` : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (!selected) uistate.selectTask(t.id, null);
        }}
      >
        <div class={s.rowHead}>
          <input
            type="checkbox"
            class={s.check}
            checked={t.completedAt != null}
            onClick={(e) => e.stopPropagation()}
            onChange={() => projectOps.toggleTaskComplete(t.id)}
          />
          {selected ? (
            <AutoField
              value={t.name}
              onCommit={(v) => projectOps.patchTask(t.id, { name: v })}
              placeholder="Untitled task"
              autoFocus={uistate.focusOnSelect.value === "title"}
              ariaLabel="Task name"
              class={s.name!}
            />
          ) : (
            <span
              class={t.completedAt != null ? `${s.name} ${s.done}` : s.name}
              onClick={(e) => {
                e.stopPropagation();
                uistate.selectTask(t.id, "title");
              }}
            >
              {t.name || "Untitled task"}
            </span>
          )}
          {!selected && blockedBy > 0 && <span class={s.blocked}>blocked by {blockedBy}</span>}
          {selected && <TrashButton onClick={() => projectOps.deleteTask(t.id)} label="Delete task" />}
          {draggable && (
            <button
              type="button"
              class={s.grip}
              title="Drag to reorder"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={gripDown(t.id)}
              onPointerMove={gripMove}
              onPointerUp={gripUp}
            >
              <GripIcon />
            </button>
          )}
        </div>
        {selected && (
          <div class={s.detail}>
            <AutoField
              value={t.description ?? ""}
              onCommit={(v) => projectOps.patchTask(t.id, { description: v || null })}
              placeholder={"Add description\u2026"}
              multiline
              autoFocus={uistate.focusOnSelect.value === "description"}
              ariaLabel="Task description"
            />
            <DependencyEditor task={t} tasks={all} deps={deps} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div class={s.list} data-selection-surface onClick={() => uistate.selectTask(null)}>
      {incomplete.map((t) => renderRow(t, !filtering))}
      {completed.length > 0 && <div class={s.divider}>Completed</div>}
      {completed.map((t) => renderRow(t, false))}
      {filtering && incomplete.length === 0 && completed.length === 0 && <p class={s.empty}>No matches.</p>}
    </div>
  );
}
