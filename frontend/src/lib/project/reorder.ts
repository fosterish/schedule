import type { TaskId } from "@bindings/TaskId";
import { type Result, ok, err } from "@lib/result";

import { type Edge, getDragViolations } from "./graph";

export type DragDir = "up" | "down";

export interface TaskReorder {
  id: TaskId;
  afterId: TaskId | null;
}

export interface TaskConflict {
  afterId: TaskId | null;
  conflictIds: TaskId[];
}

// Drag geometry + dep validation. ok(null): no net move; ok(TaskReorder):
// valid move; err(TaskConflict): the dep DAG rejects this slot (caller freezes
// at the last valid one and highlights conflictIds). Emits afterId only; the
// order key is minted at commit.
export function detect(
  order: TaskId[],
  mids: number[],
  dragged: TaskId,
  dir: DragDir,
  leadingEdge: number,
  edges: Edge[],
): Result<TaskReorder | null, TaskConflict> {
  const draggedIdx = order.indexOf(dragged);
  if (draggedIdx < 0) return ok(null);
  const target = targetIndex(mids, draggedIdx, leadingEdge, dir);
  if (target === draggedIdx) return ok(null);

  const next = [...order];
  next.splice(draggedIdx, 1);
  next.splice(target, 0, dragged);
  const afterId = target === 0 ? null : (next[target - 1] ?? null);

  const conflictIds = getDragViolations(next, dragged, edges);
  if (conflictIds.length > 0) return err({ afterId, conflictIds });
  return ok({ id: dragged, afterId });
}

// Minimal moves to turn `current` into `target`; one TaskReorder per row whose
// position changed. Used to normalize a dep-invalid load via sortByDeps.
export function transform(current: TaskId[], target: TaskId[]): TaskReorder[] {
  const out: TaskReorder[] = [];
  const cur = [...current];
  for (let i = 0; i < target.length; i++) {
    const id = target[i];
    if (id === undefined || cur[i] === id) continue;
    const from = cur.indexOf(id);
    if (from < 0) continue;
    cur.splice(from, 1);
    cur.splice(i, 0, id);
    out.push({ id, afterId: i === 0 ? null : (target[i - 1] ?? null) });
  }
  return out;
}

// Farthest row whose midpoint the leading edge crossed; stops at the first
// uncrossed midpoint (midpoints are monotonic).
function targetIndex(
  mids: number[],
  draggedIdx: number,
  leadingEdge: number,
  dir: DragDir,
): number {
  let target = draggedIdx;
  if (dir === "down") {
    for (let i = draggedIdx + 1; i < mids.length; i++) {
      const m = mids[i];
      if (m !== undefined && leadingEdge > m) target = i;
      else break;
    }
  } else {
    for (let i = draggedIdx - 1; i >= 0; i--) {
      const m = mids[i];
      if (m !== undefined && leadingEdge < m) target = i;
      else break;
    }
  }
  return target;
}
