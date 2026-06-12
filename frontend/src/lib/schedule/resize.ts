import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

import * as layout from "./layout";

export type Edge = "start" | "end";

const DAY_MINUTES = 1440;

export interface SlideResult {
  bounds: ItemBounds;
  span: layout.Span;
  layout: layout.LayoutFrame[];
  value: number;
}

// Slide one fixed edge of items[index] toward `desired`, clamped so no item drops
// below its min/fixed duration and no fixed neighbour is crossed. A rigid item
// (fixed edge + fixedDuration) translates whole; both-ends resizes the edge. The
// span grows outward (never inward) when the edge presses past the schedule
// boundary. Returns the achieved bounds, grown span, and laid-out preview.
export function slideEdge(
  items: layout.LayoutItem[],
  span: layout.Span,
  index: number,
  edge: Edge,
  desired: number,
): SlideResult {
  const b = items[index]!.bounds;
  const current = (edge === "start" ? b.start : b.end) ?? (edge === "start" ? span.start : span.end);
  return slideParam(items, span, index, current, clampMinute(desired), (v) => setEdge(b, edge, v));
}

// Slide a fixed-duration item's length: the anchored edge holds, the derived edge
// moves. Same wall/growth rules as an edge slide.
export function slideDuration(
  items: layout.LayoutItem[],
  span: layout.Span,
  index: number,
  desired: number,
): SlideResult {
  const b = items[index]!.bounds;
  const current = b.fixedDuration ?? Math.max(layout.MIN_DURATION, b.durationTarget);
  const target = clampInt(desired, layout.MIN_DURATION, DAY_MINUTES);
  return slideParam(items, span, index, current, target, (v) => ({ ...b, fixedDuration: v }));
}

export interface ReinsertPlan {
  afterId: ScheduleItemId | null;
  bounds: ItemBounds;
  span: layout.Span;
  layout: layout.LayoutFrame[];
}

export interface ReinsertConflict {
  error: layout.LayoutError;
  blockerId: ScheduleItemId | null;
}

// Set an item's edge to an exact value by relocating it: the order slot is chosen
// from the other items' midpoints (the item's current frame is left in place while
// they are read), then it is spliced in with the edge pinned and the span grown to
// fit. Infeasible placements (overlap a fixed neighbour, no room) are rejected with
// the blocking item's id so the caller can name it.
export function reinsertByValue(
  items: layout.LayoutItem[],
  span: layout.Span,
  index: number,
  edge: Edge,
  value: number,
): Result<ReinsertPlan, ReinsertConflict> {
  const v = clampMinute(value);
  const movedId = items[index]!.id;
  const newBounds = setEdge(items[index]!.bounds, edge, v);
  const frames = layout.compute(items, span);
  const target = slotByValue(items, frames, index, v);

  const order = items.map((it) => it);
  order.splice(index, 1);
  order.splice(target, 0, { id: movedId, bounds: newBounds });

  const sp = spanFor(order, target, span, newBounds);
  const laid = layout.compute(order, sp);
  const verdict = layout.validate(order, laid, sp);
  const afterId = target === 0 ? null : order[target - 1]!.id;
  if (!verdict.ok) {
    return err({ error: verdict.error, blockerId: culprit(order, movedId, verdict.error) });
  }
  return ok({ afterId, bounds: newBounds, span: sp, layout: laid });
}

// Clamp a dragged/stepped schedule start to the DB window (start in [0,1439],
// end-start <= 1440) and outside every fixed item anchor. End is symmetric.
export function clampScheduleStart(items: layout.LayoutItem[], span: layout.Span, desired: number): number {
  const anchors = anchorMinutes(items);
  const hi = Math.min(1439, span.end - 1, anchors.length > 0 ? Math.min(...anchors) : Infinity);
  return clampInt(desired, Math.max(0, span.end - DAY_MINUTES), hi);
}

export function clampScheduleEnd(items: layout.LayoutItem[], span: layout.Span, desired: number): number {
  const anchors = anchorMinutes(items);
  const lo = Math.max(span.start + 1, anchors.length > 0 ? Math.max(...anchors) : -Infinity);
  return clampInt(desired, lo, span.start + DAY_MINUTES);
}

function anchorMinutes(items: layout.LayoutItem[]): number[] {
  const xs: number[] = [];
  for (const it of items) {
    if (it.bounds.start != null) xs.push(it.bounds.start);
    if (it.bounds.end != null) xs.push(it.bounds.end);
  }
  return xs;
}

// --- internals ---

function setEdge(b: ItemBounds, edge: Edge, v: number): ItemBounds {
  const next = edge === "start" ? { ...b, start: v } : { ...b, end: v };
  // Triply pinned: moving an edge resizes the item, so keep the fixed duration
  // consistent with the new span rather than over-constraining it.
  if (next.start != null && next.end != null && next.fixedDuration != null) {
    next.fixedDuration = next.end - next.start;
  }
  return next;
}

function slideParam(
  items: layout.LayoutItem[],
  span: layout.Span,
  index: number,
  current: number,
  desired: number,
  mutate: (v: number) => ItemBounds,
): SlideResult {
  const feasible = (v: number): boolean => {
    const cand = mutate(v);
    const order = withCandidate(items, index, cand);
    const sp = spanFor(items, index, span, cand);
    return layout.validate(order, layout.compute(order, sp), sp).ok;
  };
  const value = furthestFeasible(Math.round(current), Math.round(desired), feasible);
  const bounds = mutate(value);
  const order = withCandidate(items, index, bounds);
  const sp = spanFor(items, index, span, bounds);
  return { bounds, span: sp, layout: layout.compute(order, sp), value };
}

function withCandidate(items: layout.LayoutItem[], index: number, bounds: ItemBounds): layout.LayoutItem[] {
  return items.map((it, k) => (k === index ? { id: it.id, bounds } : it));
}

// Furthest integer in [current, desired] (either direction) that stays feasible,
// assuming feasibility is monotonic from the feasible `current` toward `desired`.
function furthestFeasible(current: number, desired: number, feasible: (v: number) => boolean): number {
  if (current === desired || !feasible(current)) return current;
  if (feasible(desired)) return desired;
  let lo = current;
  let hi = desired;
  while (Math.abs(hi - lo) > 1) {
    const mid = Math.round((lo + hi) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Minimal outward-only growth so the candidate's fixed edges fit. The start grows
// only when no fixed edge precedes the item (the run reaches the schedule start),
// by the preceding run's reserved width; the end is symmetric. Clamped to the DB
// window against the unchanged opposite bound. A fixed-neighbour wall isn't grown
// past here; validate rejects those instead.
function spanFor(
  items: layout.LayoutItem[],
  index: number,
  span: layout.Span,
  cand: ItemBounds,
): layout.Span {
  const r = layout.resolve(cand);
  let start = span.start;
  let end = span.end;
  if (r.start != null && reachesStart(items, index)) {
    start = Math.min(start, r.start - runNeed(items, 0, index));
  }
  if (r.end != null && reachesEnd(items, index)) {
    end = Math.max(end, r.end + runNeed(items, index + 1, items.length));
  }
  start = clampInt(start, Math.max(0, span.end - DAY_MINUTES), span.start);
  end = clampInt(end, span.end, span.start + DAY_MINUTES);
  // Also grow the end when a (fixed-duration) item's reserved width overflows the
  // trailing run, not just when a fixed edge presses past the boundary.
  const order = withCandidate(items, index, cand);
  end = clampInt(layout.minEndToFit(order, { start, end }), span.end, start + DAY_MINUTES);
  return { start, end };
}

function reachesStart(items: layout.LayoutItem[], index: number): boolean {
  for (let k = 0; k < index; k++) if (anchored(items[k]!.bounds)) return false;
  return true;
}

function reachesEnd(items: layout.LayoutItem[], index: number): boolean {
  for (let k = index + 1; k < items.length; k++) if (anchored(items[k]!.bounds)) return false;
  return true;
}

function anchored(b: ItemBounds): boolean {
  return b.start != null || b.end != null;
}

// Reserved width of items [from, to): a rigid item its fixed length, else the min.
function runNeed(items: layout.LayoutItem[], from: number, to: number): number {
  let need = 0;
  for (let k = from; k < to; k++) need += layout.resolve(items[k]!.bounds).rigid ?? layout.MIN_DURATION;
  return need;
}

// Slot (0..n-1 after the moved item is removed) for placing it before the first
// other item whose midpoint exceeds `value`.
function slotByValue(
  items: layout.LayoutItem[],
  frames: layout.LayoutFrame[],
  index: number,
  value: number,
): number {
  const frameById = new Map(frames.map((f) => [f.id, f]));
  let slot = 0;
  for (let k = 0; k < items.length; k++) {
    if (k === index) continue;
    const f = frameById.get(items[k]!.id);
    if (f && value < (f.start + f.end) / 2) break;
    slot++;
  }
  return slot;
}

// The first culprit index that isn't the moved item (the neighbour it overlaps),
// falling back to the first reported index.
function culprit(order: layout.LayoutItem[], movedId: ScheduleItemId, error: layout.LayoutError): ScheduleItemId | null {
  for (const i of error.indices) {
    const id = order[i]?.id;
    if (id != null && id !== movedId) return id;
  }
  const first = error.indices[0];
  return first != null ? order[first]?.id ?? null : null;
}

function clampMinute(v: number): number {
  return clampInt(v, layout.FRAME_START, layout.FRAME_END);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(v < lo ? lo : v > hi ? hi : v);
}
