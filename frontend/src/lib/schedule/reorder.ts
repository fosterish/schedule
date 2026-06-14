import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import type { DragDir } from "@lib/project/reorder";
import { type Result, ok, err } from "@lib/result";

import * as layout from "./layout";

export type { DragDir };

// A pinned edge (start or end) makes an item immovable; reorders flow around it
// without shifting it. A bare fixed duration still drags.
export function isAnchored(b: ItemBounds): boolean {
  return b.start != null || b.end != null;
}

export interface ScheduleReorder {
  afterId: ScheduleItemId | null;
  layout: layout.LayoutFrame[];
  span: layout.Span;
}

export interface ScheduleConflict {
  afterId: ScheduleItemId | null;
  error: layout.LayoutError;
  layout: layout.LayoutFrame[];
  span: layout.Span;
}

// Drag geometry, then a layout verdict over the new order. Moving an item before
// the head or after the tail grows the schedule span outward (never shrinking) by
// the minimum needed to keep every item's min/fixed duration; the grown span
// rides along so the caller can persist it. ok(null): no move; ok: feasible; err:
// infeasible, keeping the greyed layout + culprit. An anchored item can't drag.
export function detect(
  items: layout.LayoutItem[],
  frames: readonly { start: number; end: number }[],
  dragged: ScheduleItemId,
  dir: DragDir,
  leadingEdge: number,
  span: layout.Span,
): Result<ScheduleReorder | null, ScheduleConflict> {
  const fromIdx = items.findIndex((it) => it.id === dragged);
  if (fromIdx < 0 || isAnchored(items[fromIdx]!.bounds)) return ok(null);
  const target = targetIndex(items, frames, fromIdx, leadingEdge, dir);
  if (target === fromIdx) return ok(null);

  const order = [...items];
  const [moved] = order.splice(fromIdx, 1);
  order.splice(target, 0, moved!);

  const adj = adjustSpan(order, span, target);
  const laid = layout.compute(order, adj);
  const verdict = layout.validate(order, laid, adj);
  const afterId = target === 0 ? null : order[target - 1]!.id;

  if (!verdict.ok) {
    return err({ afterId, error: verdict.error, layout: laid, span: adj });
  }
  return ok({ afterId, layout: laid, span: adj });
}

// Farthest row the grabbed item's leading edge crossed. The trigger is the other
// row's matching-side edge when that edge is pinned (so the drag must clear the
// whole immovable side), else its midpoint. Thresholds stay monotonic with
// position, so the first uncrossed row stops the scan.
function targetIndex(
  items: layout.LayoutItem[],
  frames: readonly { start: number; end: number }[],
  fromIdx: number,
  leadingEdge: number,
  dir: DragDir,
): number {
  let target = fromIdx;
  const step = dir === "down" ? 1 : -1;
  for (let i = fromIdx + step; i >= 0 && i < items.length; i += step) {
    const f = frames[i];
    if (!f) break;
    const b = items[i]!.bounds;
    const mid = (f.start + f.end) / 2;
    const crossed =
      dir === "down" ? leadingEdge > (b.end != null ? f.end : mid) : leadingEdge < (b.start != null ? f.start : mid);
    if (crossed) target = i;
    else break;
  }
  return target;
}

// Span grown outward (never inward) for a move onto the head/tail: shift the
// touched edge by the leading/trailing segment's shortfall, clamped to the day
// frame [FRAME_START, FRAME_END]. When the clamp can't cover the shortfall the
// layout stays infeasible and validate rejects the move.
function adjustSpan(order: layout.LayoutItem[], span: layout.Span, target: number): layout.Span {
  const n = order.length;
  const r = order.map((it) => layout.resolve(it.bounds));
  if (target === 0) {
    const { last, right } = layout.segmentBounds(r, 0);
    const boundary = right ?? span.end;
    const deficit = runNeed(r, 0, last) - (boundary - span.start);
    if (deficit <= 0) return span;
    const start = Math.max(layout.FRAME_START, span.start - deficit);
    return { start, end: span.end };
  }
  if (target === n - 1) {
    const tail = trailingSegment(r, span);
    const deficit = runNeed(r, tail.from, n - 1) - (span.end - tail.left);
    if (deficit <= 0) return span;
    const end = Math.min(layout.FRAME_END, span.end + deficit);
    return { start: span.start, end };
  }
  return span;
}

// Minimum width a run [i..last] reserves: a rigid item its fixed length, an
// elastic one MIN_DURATION.
function runNeed(r: layout.Resolved[], i: number, last: number): number {
  let need = 0;
  for (let k = i; k <= last; k++) need += r[k]!.rigid ?? layout.MIN_DURATION;
  return need;
}

// The final segment and the hard left edge it tiles from (a fixed boundary, else
// the span start).
function trailingSegment(r: layout.Resolved[], span: layout.Span): { from: number; left: number } {
  const n = r.length;
  let i = 0;
  let cursor = span.start;
  let from = 0;
  let left = span.start;
  while (i < n) {
    const segLeft = r[i]!.start != null ? r[i]!.start! : cursor;
    const { last, right } = layout.segmentBounds(r, i);
    from = i;
    left = segLeft;
    cursor = right ?? span.end;
    i = last + 1;
  }
  return { from, left };
}
