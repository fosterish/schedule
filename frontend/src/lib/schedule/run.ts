import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

import { FRAME_END, FRAME_START, MAX_SCHEDULE_START, MIN_DURATION, feasible, minEndToFit } from "./layout";
import type { LayoutFrame, LayoutItem, Span } from "./layout";

// Play/stop for the live schedule. Play advances to the item that should run at
// `now` — the current dynamic block's open first item, the next item when that
// first is anchored, or the item after a static/anchored one — pinning its start
// and stopping whatever it interrupts. Stop pins the current item's end to now.
// Pure: returns the bounds patches and deletes; the caller builds ops.

export type RunAction = "play" | "stop";

export interface RunTarget {
  enabled: boolean;
  target: ScheduleItemId | null;
}

export interface RunFlags {
  play: RunTarget;
  stop: RunTarget;
}

export interface RunPlan {
  patches: { id: ScheduleItemId; bounds: ItemBounds }[];
  deletes: ScheduleItemId[];
  // Hard span grown outward to admit the pinned edges.
  span: Span;
}

export type RunError = { kind: "disabled"; reason: string };

// The two edges an action pins to `now`: `stop` (an end) and `start` (a start);
// `target` is the item the action is "about" (for toolbar buttons and badges).
interface Intent {
  target: number;
  stop: number | null;
  start: number | null;
}

interface Work {
  id: ScheduleItemId;
  start: number | null;
  end: number | null;
  fixedDuration: number | null;
  durationTarget: number;
  deleted: boolean;
}

// Enablement + the item each action would modify, for toolbar buttons and the
// media badges pinned at the target's midpoint.
export function flags(items: LayoutItem[], frames: LayoutFrame[], nowMinute: number, span: Span): RunFlags {
  const f: RunFlags = { play: off(), stop: off() };
  if (items.length === 0) return f;
  const assigned = items.map((it) => frameOf(frames, it.id));

  const pi = playIntent(items, assigned, nowMinute);
  if (pi) f.play = { enabled: true, target: items[pi.target]!.id };

  const si = stopIntent(items, assigned, nowMinute);
  if (si) {
    // Stop pins the target's end to now; at its start that zeroes the duration,
    // so disable instead.
    const fr = frames.find((x) => x.id === items[si.target]!.id);
    if (!(fr && fr.start === nowMinute)) f.stop = { enabled: true, target: items[si.target]!.id };
  }

  // Offer an action only when `apply` yields a legal schedule, not one
  // overlapping an internal fixed wall.
  for (const action of ["play", "stop"] as const) {
    if (f[action].enabled && !apply(action, items, frames, nowMinute, span).ok) f[action] = off();
  }
  return f;
}

export function apply(
  action: RunAction,
  items: LayoutItem[],
  frames: LayoutFrame[],
  nowMinute: number,
  span: Span,
): Result<RunPlan, RunError> {
  if (items.length === 0) return err(disabled("no items to act on"));
  const assigned = items.map((it) => frameOf(frames, it.id));
  const intent = action === "play" ? playIntent(items, assigned, nowMinute) : stopIntent(items, assigned, nowMinute);
  if (!intent) return err(disabled("action is disabled here"));
  // Play's stop-then-play must not collapse the item it interrupts below its
  // minimum duration; explicit Stop is free to delete a zero-length target.
  if (action === "play" && intent.stop != null && nowMinute - assigned[intent.stop]!.start < MIN_DURATION) {
    return err(disabled("stopping the current item would breach its minimum duration"));
  }

  const w = items.map(toWork);
  if (intent.stop != null) setEnd(w, intent.stop, nowMinute);
  if (intent.start != null) setStart(w, intent.start, nowMinute);
  normalize(w);

  const { patches, deletes } = plan(items, w);
  const next = nextItems(items, patches, deletes);
  const grown = settle(span, patches, next);
  // Growth admits edges pinned past the boundary, not an internal fixed wall a
  // run overruns. Reject those.
  if (!feasible(next, grown)) return err(disabled("would overlap a fixed item"));
  return ok({ patches, deletes, span: grown });
}

// Play targets the item that should run at `now`: the open first item of the
// current dynamic block, the item after it when that first is anchored or the
// current item is static, or the upcoming item when now sits in a gap/before.
function playIntent(items: LayoutItem[], assigned: Frame[], now: number): Intent | null {
  const n = items.length;
  const cur = currentIdx(assigned, now);
  if (cur < 0) {
    const next = nextIdx(assigned, now);
    if (next >= 0) return { target: next, stop: null, start: next };
    // Past the end: treat the trailing item as the current one.
  }
  const anchor = cur >= 0 ? cur : n - 1;
  if (isStatic(items[anchor]!.bounds)) {
    const t = anchor + 1;
    return t < n ? { target: t, stop: anchor, start: t } : null;
  }
  const first = blockFirst(items, anchor);
  if (items[first]!.bounds.start == null) return { target: first, stop: null, start: first };
  const t = first + 1;
  return t < n ? { target: t, stop: first, start: t } : null;
}

// Stop ends the current static item or the current dynamic block's first item;
// in a gap it extends the preceding fixed-end item to now.
function stopIntent(items: LayoutItem[], assigned: Frame[], now: number): Intent | null {
  const cur = currentIdx(assigned, now);
  if (cur >= 0) {
    const anchor = isStatic(items[cur]!.bounds) ? cur : blockFirst(items, cur);
    return { target: anchor, stop: anchor, start: null };
  }
  const prev = prevFixedEndIdx(items, assigned, now);
  return prev >= 0 ? { target: prev, stop: prev, start: null } : null;
}

// Post-action items: survivors carry their patched bounds.
function nextItems(
  items: LayoutItem[],
  patches: { id: ScheduleItemId; bounds: ItemBounds }[],
  deletes: ScheduleItemId[],
): LayoutItem[] {
  const patched = new Map(patches.map((p) => [p.id, p.bounds]));
  const dropped = new Set(deletes);
  return items
    .filter((it) => !dropped.has(it.id))
    .map((it) => ({ id: it.id, bounds: patched.get(it.id) ?? it.bounds }));
}

// Grow the span outward (never inward) to admit pinned edges, then to keep the
// trailing run's minimum widths.
function settle(span: Span, patches: { bounds: ItemBounds }[], next: LayoutItem[]): Span {
  let start = span.start;
  let end = span.end;
  for (const p of patches) {
    if (p.bounds.start != null) start = Math.min(start, p.bounds.start);
    if (p.bounds.end != null) end = Math.max(end, p.bounds.end);
  }
  start = clamp(start, FRAME_START, MAX_SCHEDULE_START);
  end = clamp(end, start + 1, FRAME_END);
  end = clamp(minEndToFit(next, { start, end }), end, FRAME_END);
  return { start, end };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- shared helpers ---

type Frame = { start: number; end: number };

// An item is static when at least two of its start/duration/end are fixed; one
// or none leaves it part of a dynamic block.
function isStatic(b: ItemBounds): boolean {
  let c = 0;
  if (b.start != null) c++;
  if (b.end != null) c++;
  if (b.fixedDuration != null) c++;
  return c >= 2;
}

// First item of the dynamic block containing `i`: walk left until a fixed start
// begins the block, or the previous item (static or fixed-end) closes its own.
function blockFirst(items: LayoutItem[], i: number): number {
  let j = i;
  while (j > 0) {
    if (items[j]!.bounds.start != null) break;
    const prev = items[j - 1]!.bounds;
    if (isStatic(prev) || prev.end != null) break;
    j -= 1;
  }
  return j;
}

function currentIdx(assigned: Frame[], now: number): number {
  return assigned.findIndex((a) => now >= a.start && now < a.end);
}

function nextIdx(assigned: Frame[], now: number): number {
  for (let i = 0; i < assigned.length; i++) {
    if (assigned[i]!.start >= now) return i;
  }
  return -1;
}

function prevFixedEndIdx(items: LayoutItem[], assigned: Frame[], now: number): number {
  let idx = -1;
  for (let i = 0; i < items.length; i++) {
    if (assigned[i]!.end <= now && items[i]!.bounds.end != null) idx = i;
  }
  return idx;
}

// Pin start; if that would over-constrain a fixed-duration item (both edges now
// set), the explicit pin wins and the duration goes elastic.
function setStart(w: Work[], i: number, v: number): void {
  const it = w[i]!;
  it.start = v;
  if (it.end != null && it.fixedDuration != null) it.fixedDuration = null;
}

function setEnd(w: Work[], i: number, v: number): void {
  const it = w[i]!;
  it.end = v;
  if (it.start != null && it.fixedDuration != null) it.fixedDuration = null;
}

function normalize(w: Work[]): void {
  for (const it of w) {
    if (it.start != null && it.end != null && it.start === it.end) it.deleted = true;
  }
}

function plan(
  items: LayoutItem[],
  w: Work[],
): { patches: { id: ScheduleItemId; bounds: ItemBounds }[]; deletes: ScheduleItemId[] } {
  const patches: { id: ScheduleItemId; bounds: ItemBounds }[] = [];
  const deletes: ScheduleItemId[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = w[i]!;
    if (it.deleted) {
      deletes.push(it.id);
      continue;
    }
    const before = items[i]!.bounds;
    if (before.start !== it.start || before.end !== it.end || before.fixedDuration !== it.fixedDuration) {
      patches.push({
        id: it.id,
        bounds: { start: it.start, end: it.end, fixedDuration: it.fixedDuration, durationTarget: it.durationTarget },
      });
    }
  }
  return { patches, deletes };
}

function toWork(it: LayoutItem): Work {
  return {
    id: it.id,
    start: it.bounds.start,
    end: it.bounds.end,
    fixedDuration: it.bounds.fixedDuration,
    durationTarget: it.bounds.durationTarget,
    deleted: false,
  };
}

function frameOf(frames: LayoutFrame[], id: ScheduleItemId): Frame {
  const f = frames.find((fr) => fr.id === id);
  return f ? { start: f.start, end: f.end } : { start: 0, end: 0 };
}

function off(): RunTarget {
  return { enabled: false, target: null };
}

function disabled(reason: string): RunError {
  return { kind: "disabled", reason };
}
