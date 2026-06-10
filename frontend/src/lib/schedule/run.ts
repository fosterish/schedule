import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

import type { LayoutFrame, LayoutItem, Span } from "./layout";

// Play/skip/stop, branching on the schedule's hard `span`: an action pins an
// item's start (Play), its end (Stop), or both edges of the current/next pair
// (Skip), and any item driven to zero duration is deleted. Pure: returns the
// bounds patches and deletes; the caller builds ops.

export type RunAction = "play" | "stop" | "skip";

export interface RunTarget {
  enabled: boolean;
  target: ScheduleItemId | null;
}

export interface RunFlags {
  play: RunTarget;
  stop: RunTarget;
  skip: RunTarget;
}

export interface RunPlan {
  patches: { id: ScheduleItemId; bounds: ItemBounds }[];
  deletes: ScheduleItemId[];
}

export type RunError = { kind: "disabled"; reason: string };

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
  const f = compute(items, frames, nowMinute, span);
  // Stop sets the target's end to now; if its start already equals now that is a
  // zero-duration delete, so disable instead.
  if (f.stop.enabled && f.stop.target != null) {
    const t = items.find((it) => it.id === f.stop.target);
    if (t && t.bounds.start === nowMinute) {
      f.stop = { enabled: false, target: null };
    }
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
  const w = items.map(toWork);
  const assigned = items.map((it) => frameOf(frames, it.id));

  const result = run(action, w, assigned, span, nowMinute);
  if (!result.ok) return result;
  return ok(plan(items, w));
}

function run(
  action: RunAction,
  w: Work[],
  assigned: { start: number; end: number }[],
  span: { start: number; end: number },
  now: number,
): Result<void, RunError> {
  if (now < span.start) {
    if (action !== "play") return err(disabled("only Play is enabled before the schedule start"));
    setStart(w, 0, now);
    normalize(w);
    return ok(undefined);
  }
  if (now >= span.end) return afterEnd(action, w, now);
  const containing = currentIdx(w, assigned, now);
  if (containing >= 0) return within(action, w, containing, now);
  return gap(action, w, assigned, now);
}

function afterEnd(action: RunAction, w: Work[], now: number): Result<void, RunError> {
  const last = w.length - 1;
  const lastFixedEnd = w[last]!.end != null;
  if (action === "play") {
    if (lastFixedEnd) return err(disabled("Play disabled after the schedule end (last item has a fixed end)"));
    setStart(w, walkBack(w, last), now);
    normalize(w);
    return ok(undefined);
  }
  if (action === "stop") {
    if (lastFixedEnd) setEnd(w, last, now);
    else setEnd(w, walkBack(w, last), now);
    normalize(w);
    return ok(undefined);
  }
  if (lastFixedEnd) return err(disabled("Skip disabled after the schedule end"));
  const first = walkBack(w, last);
  if (first === last) return err(disabled("Skip disabled (only one item in the final block)"));
  setEnd(w, first, now);
  normalize(w);
  playLiveBlock(w, lastLiveBlockFirst(w), now);
  return ok(undefined);
}

function within(action: RunAction, w: Work[], idx: number, now: number): Result<void, RunError> {
  const fullyFixed = w[idx]!.start != null && w[idx]!.end != null;
  const first = fullyFixed ? idx : walkBack(w, idx);
  if (action === "play") {
    setStart(w, first, now);
    normalize(w);
    return ok(undefined);
  }
  if (action === "stop") {
    setEnd(w, first, now);
    normalize(w);
    return ok(undefined);
  }
  // skip: stop the current (block), play the next live block.
  setEnd(w, first, now);
  normalize(w);
  const nextPos = nextLivePos(w, first);
  if (nextPos < 0) return err(disabled("no next item to play"));
  playLiveBlock(w, blockFirstAmongLive(w, nextPos), now);
  return ok(undefined);
}

function gap(
  action: RunAction,
  w: Work[],
  assigned: { start: number; end: number }[],
  now: number,
): Result<void, RunError> {
  let prevFixedEnd = -1;
  for (let i = 0; i < w.length; i++) {
    if (assigned[i]!.end <= now && w[i]!.end != null) prevFixedEnd = i;
  }
  let next = -1;
  for (let i = 0; i < w.length; i++) {
    if (assigned[i]!.start >= now) {
      next = i;
      break;
    }
  }
  if (action === "play") {
    if (next < 0) return err(disabled("no next item to play"));
    setStart(w, next, now);
    normalize(w);
    return ok(undefined);
  }
  if (action === "stop") {
    if (prevFixedEnd < 0) return err(disabled("no previous fixed-end item to extend"));
    setEnd(w, prevFixedEnd, now);
    normalize(w);
    return ok(undefined);
  }
  if (prevFixedEnd < 0) return err(disabled("Skip disabled in the leading gap"));
  if (next < 0) return err(disabled("Skip disabled at the end of the schedule"));
  setEnd(w, prevFixedEnd, now);
  setStart(w, next, now);
  normalize(w);
  return ok(undefined);
}

// --- enablement ---

function compute(items: LayoutItem[], frames: LayoutFrame[], now: number, span: Span): RunFlags {
  const f: RunFlags = {
    play: off(),
    stop: off(),
    skip: off(),
  };
  if (items.length === 0) return f;
  const w = items.map(toWork);
  const assigned = items.map((it) => frameOf(frames, it.id));
  const idAt = (i: number) => (i >= 0 && i < w.length ? w[i]!.id : null);

  if (now < span.start) {
    f.play = { enabled: true, target: idAt(0) };
    return f;
  }
  if (now >= span.end) {
    const last = w.length - 1;
    if (w[last]!.end != null) {
      f.stop = { enabled: true, target: idAt(last) };
    } else {
      const first = walkBack(w, last);
      f.play = { enabled: true, target: idAt(first) };
      f.stop = { enabled: true, target: idAt(first) };
      if (countFinalBlock(w) > 1) f.skip = { enabled: true, target: idAt(first + 1) };
    }
    return f;
  }
  const containing = currentIdx(w, assigned, now);
  if (containing >= 0) {
    const fullyFixed = w[containing]!.start != null && w[containing]!.end != null;
    const first = fullyFixed ? containing : walkBack(w, containing);
    const nextFixedStart = containing + 1 < w.length && w[containing + 1]!.start != null;
    f.play = { enabled: true, target: idAt(first) };
    f.stop = { enabled: true, target: idAt(first) };
    if (first + 1 < w.length && !nextFixedStart) {
      f.skip = { enabled: true, target: idAt(first + 1) };
    }
    return f;
  }
  // gap
  let prev = -1;
  for (let i = 0; i < w.length; i++) {
    if (assigned[i]!.end <= now) prev = i;
    else break;
  }
  const prevFixedEnd = prev >= 0 && w[prev]!.end != null;
  let next = -1;
  for (let i = 0; i < w.length; i++) {
    if (assigned[i]!.start >= now) {
      next = i;
      break;
    }
  }
  f.play = { enabled: next >= 0, target: next >= 0 ? idAt(next) : null };
  f.stop = { enabled: prevFixedEnd, target: prevFixedEnd ? idAt(prev) : null };
  const skipOk = next >= 0 && prevFixedEnd && w[next]!.start == null;
  f.skip = { enabled: skipOk, target: skipOk ? idAt(next) : null };
  return f;
}

// --- shared helpers ---

// First item of the dynamic block containing idx; a fixed end terminates the
// previous block (checked before a fixed start).
function walkBack(w: Work[], idx: number): number {
  const s = w[idx]!;
  if (s.start != null) return idx;
  let i = idx;
  while (i > 0) {
    i -= 1;
    if (w[i]!.end != null) return i + 1;
    if (w[i]!.start != null) return i;
  }
  return 0;
}

// Item containing now; treats now == prev.end as "no current item" so the gap
// branch handles the post-stop pseudo-gap.
function currentIdx(w: Work[], assigned: { start: number; end: number }[], now: number): number {
  const raw = assigned.findIndex((a) => now >= a.start && now < a.end);
  if (raw < 0) return -1;
  if (raw > 0 && w[raw - 1]!.end === now && w[raw]!.start == null) return -1;
  return raw;
}

function countFinalBlock(w: Work[]): number {
  if (w.length === 0) return 0;
  let count = 1;
  let i = w.length;
  while (i > 1) {
    i -= 1;
    if (w[i - 1]!.end != null) return count;
    if (w[i]!.start != null) return count;
    count += 1;
  }
  return count;
}

function nextLivePos(w: Work[], after: number): number {
  for (let i = after + 1; i < w.length; i++) if (!w[i]!.deleted) return i;
  return -1;
}

// Block-first (among live items) of the live item at position `pos` in `w`.
function blockFirstAmongLive(w: Work[], pos: number): number {
  const live = w.filter((x) => !x.deleted);
  const id = w[pos]!.id;
  const li = live.findIndex((x) => x.id === id);
  if (li < 0) return pos;
  const bf = walkBackLive(live, li);
  return w.findIndex((x) => x.id === live[bf]!.id);
}

function lastLiveBlockFirst(w: Work[]): number {
  const live = w.filter((x) => !x.deleted);
  if (live.length === 0) return -1;
  const bf = walkBackLive(live, live.length - 1);
  return w.findIndex((x) => x.id === live[bf]!.id);
}

function walkBackLive(live: Work[], idx: number): number {
  const s = live[idx]!;
  if (s.start != null) return idx;
  let i = idx;
  while (i > 0) {
    i -= 1;
    if (live[i]!.end != null) return i + 1;
    if (live[i]!.start != null) return i;
  }
  return 0;
}

function playLiveBlock(w: Work[], pos: number, now: number): void {
  if (pos < 0) return;
  setStart(w, pos, now);
  normalize(w);
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

function plan(items: LayoutItem[], w: Work[]): RunPlan {
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

function frameOf(frames: LayoutFrame[], id: ScheduleItemId): { start: number; end: number } {
  const f = frames.find((fr) => fr.id === id);
  return f ? { start: f.start, end: f.end } : { start: 0, end: 0 };
}

function off(): RunTarget {
  return { enabled: false, target: null };
}

function disabled(reason: string): RunError {
  return { kind: "disabled", reason };
}
