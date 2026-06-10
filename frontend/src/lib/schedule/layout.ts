import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

export const MIN_DURATION = 1;
// Two-day cursor range (today + overflow): minutes 0..2879.
export const FRAME_START = 0;
export const FRAME_END = 2879;
// Default bounds for a new schedule (8am–10pm).
export const DEFAULT_START = 8 * 60;
export const DEFAULT_END = 22 * 60;

export interface Span {
  start: number;
  end: number;
}

export interface LayoutItem {
  id: ScheduleItemId;
  bounds: ItemBounds;
}

export interface LayoutFrame {
  id: ScheduleItemId;
  start: number;
  end: number;
}

export type LayoutError =
  | { kind: "outOfBounds"; indices: number[] }
  | { kind: "anchorNonMonotonic"; indices: number[] }
  | { kind: "overConstrained"; indices: number[] }
  | { kind: "belowMin"; indices: number[] };

export type LayoutResult = Result<void, LayoutError>;

// Pure geometry over items in `position` order, tiling the schedule's hard span:
// the cursor starts at `span.start` and an unbounded trailing segment fills to
// `span.end`. Frames are clamped into [FRAME_START, FRAME_END]; an item entirely
// outside is omitted, so the caller diffs ids to learn what to delete.
export function compute(items: LayoutItem[], span: Span): LayoutFrame[] {
  const n = items.length;
  if (n === 0) return [];
  const r = items.map((it) => resolve(it.bounds));
  const startAbs = new Array<number>(n).fill(0);
  const endAbs = new Array<number>(n).fill(0);

  let cursor = span.start;
  let i = 0;
  while (i < n) {
    if (r[i]!.start != null) cursor = r[i]!.start!;
    const { last, right: fixedRight } = segmentBounds(r, i);
    const segStart = cursor;
    // An unbounded trailing segment fills to the schedule's hard end.
    const right = fixedRight ?? span.end;
    const count = last - i + 1;
    const shares = segmentShares(r, i, last, segStart, right);
    let c = segStart;
    for (let k = 0; k < count; k++) {
      const idx = i + k;
      startAbs[idx] = c;
      endAbs[idx] = c + shares[k]!;
      c = endAbs[idx]!;
    }
    // A fixed-end last item snaps exactly to the boundary.
    if (r[last]!.end != null) endAbs[last] = right;

    cursor = endAbs[last]!;
    i = last + 1;
  }

  const frames: LayoutFrame[] = [];
  for (let k = 0; k < n; k++) {
    const s = startAbs[k]!;
    const e = endAbs[k]!;
    if (e <= FRAME_START || s >= FRAME_END) continue;
    frames.push({
      id: items[k]!.id,
      start: clamp(s, FRAME_START, FRAME_END),
      end: clamp(e, FRAME_START, FRAME_END),
    });
  }
  return frames;
}

// ok, or the single highest-precedence error:
// outOfBounds > anchorNonMonotonic > overConstrained > belowMin.
export function validate(items: LayoutItem[], frames: LayoutFrame[], span: Span): LayoutResult {
  const outOfBounds: number[] = [];
  for (let k = 0; k < items.length; k++) {
    const b = items[k]!.bounds;
    const oob =
      (b.start != null && (b.start < span.start || b.start > span.end)) ||
      (b.end != null && (b.end < span.start || b.end > span.end));
    if (oob) outOfBounds.push(k);
  }
  if (outOfBounds.length > 0) {
    return err({ kind: "outOfBounds", indices: outOfBounds });
  }

  const nonMonotonic: number[] = [];
  let prevFixedEnd: number | null = null;
  for (let k = 0; k < items.length; k++) {
    const p = resolve(items[k]!.bounds);
    if (p.start != null && prevFixedEnd != null && p.start < prevFixedEnd) {
      nonMonotonic.push(k);
    }
    if (p.end != null) prevFixedEnd = p.end;
    else if (p.start != null) prevFixedEnd = p.start;
  }
  if (nonMonotonic.length > 0) {
    return err({ kind: "anchorNonMonotonic", indices: nonMonotonic });
  }

  const overConstrained: number[] = [];
  for (let k = 0; k < items.length; k++) {
    const b = items[k]!.bounds;
    if (b.start != null && b.end != null) {
      if (b.fixedDuration != null && b.end - b.start !== b.fixedDuration) {
        overConstrained.push(k);
      } else if (b.end <= b.start) {
        overConstrained.push(k);
      }
    }
  }
  if (overConstrained.length > 0) {
    return err({ kind: "overConstrained", indices: overConstrained });
  }

  const indexById = new Map(items.map((it, k) => [it.id, k]));
  const belowMin = new Set<number>();
  for (const f of frames) {
    if (f.end - f.start < MIN_DURATION) {
      const k = indexById.get(f.id);
      if (k !== undefined) belowMin.add(k);
    }
  }
  // A bounded segment that can't hold its rigid + minimum-elastic content tiles
  // past its fixed boundary: consecutive frames overlap. Both rows are squeezed.
  for (let i = 0; i + 1 < frames.length; i++) {
    if (frames[i]!.end > frames[i + 1]!.start) {
      for (const id of [frames[i]!.id, frames[i + 1]!.id]) {
        const k = indexById.get(id);
        if (k !== undefined) belowMin.add(k);
      }
    }
  }
  if (belowMin.size > 0) {
    return err({ kind: "belowMin", indices: [...belowMin].sort((a, b) => a - b) });
  }
  return ok(undefined);
}

export interface Resolved {
  start: number | null;
  end: number | null;
  rigid: number | null; // reserved length (fixedDuration), laid before elastic share
  target: number;
}

// Map the three-variable bounds to absolute anchors plus a rigid length.
// Two fixed inputs pin the item; fixedDuration alone makes it rigid; one fixed
// bound anchors that edge with an elastic duration; none is fully elastic.
export function resolve(b: ItemBounds): Resolved {
  const target = Math.max(MIN_DURATION, b.durationTarget);
  const { start: s, end: e, fixedDuration: fd } = b;
  if (s != null && e != null) return { start: s, end: e, rigid: null, target };
  if (s != null && fd != null) return { start: s, end: s + fd, rigid: fd, target };
  if (e != null && fd != null) return { start: e - fd, end: e, rigid: fd, target };
  if (fd != null) return { start: null, end: null, rigid: fd, target };
  if (s != null) return { start: s, end: null, rigid: null, target };
  if (e != null) return { start: null, end: e, rigid: null, target };
  return { start: null, end: null, rigid: null, target };
}

// Durations for items [i..last]: reserve rigid lengths, then share the slack
// up to `right` by target (largest remainder, MIN_DURATION floor).
function segmentShares(
  r: Resolved[],
  i: number,
  last: number,
  segStart: number,
  right: number,
): number[] {
  const count = last - i + 1;
  let rigidTotal = 0;
  const elasticIdx: number[] = [];
  for (let k = 0; k < count; k++) {
    const ri = r[i + k]!;
    if (ri.rigid != null) rigidTotal += ri.rigid;
    else elasticIdx.push(k);
  }
  const elasticShares = distribute(
    right - segStart - rigidTotal,
    elasticIdx.map((k) => r[i + k]!.target),
  );
  const out = new Array<number>(count).fill(MIN_DURATION);
  for (let k = 0; k < count; k++) {
    const ri = r[i + k]!;
    if (ri.rigid != null) out[k] = ri.rigid;
  }
  elasticIdx.forEach((k, e) => (out[k] = elasticShares[e]!));
  return out;
}

// Split `available` across weights, each at least MIN_DURATION, distributing
// leftover minutes by largest fractional remainder (reclaiming if over).
function distribute(available: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const shares: number[] = [];
  const remainders: number[] = [];
  let sum = 0;
  for (const w of weights) {
    const raw = (available * w) / total;
    const floor = Math.max(Math.floor(raw), MIN_DURATION);
    shares.push(floor);
    remainders.push(raw - Math.floor(raw));
    sum += floor;
  }
  let diff = available - sum;
  if (diff > 0) {
    const order = remainders
      .map((_, k) => k)
      .sort((a, b) => remainders[b]! - remainders[a]!);
    let k = 0;
    while (diff > 0 && order.length > 0) {
      const idx = order[k % order.length]!;
      shares[idx]!++;
      diff--;
      k++;
    }
  } else if (diff < 0) {
    let k = 0;
    let guard = 0;
    while (diff < 0 && guard < 100_000) {
      const idx = k % n;
      if (shares[idx]! > MIN_DURATION) {
        shares[idx]!--;
        diff++;
      }
      k++;
      guard++;
      if (k > n * 4 && shares.every((s) => s === MIN_DURATION)) break;
    }
  }
  return shares;
}

// Segment [i..last] and its fixed right boundary (a fixed end, the next fixed
// start, or null when the segment trails the list).
export function segmentBounds(
  r: Resolved[],
  i: number,
): { last: number; right: number | null } {
  const n = r.length;
  let j = i;
  while (j < n) {
    if (r[j]!.end != null) break;
    if (j + 1 < n && r[j + 1]!.start != null) break;
    j++;
  }
  const last = Math.min(j, n - 1);
  let right: number | null = null;
  if (j < n && r[j]!.end != null) right = r[j]!.end!;
  else if (j + 1 < n && r[j + 1]!.start != null) right = r[j + 1]!.start!;
  return { last, right };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
