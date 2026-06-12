import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

import * as layout from "./layout";

// A successful insert plan. `afterId` (null = head) and the new item's `bounds`
// feed op assembly at commit (mint id + position key there). With hard schedule
// bounds the draft stays fully elastic and simply reflows with its neighbours.
export interface ScheduleInsert {
  afterId: ScheduleItemId | null;
  bounds: ItemBounds;
  span: layout.Span;
  layout: layout.LayoutFrame[];
}

export interface InsertConflict {
  afterId: ScheduleItemId | null;
  error: layout.LayoutError;
  layout: layout.LayoutFrame[];
}

// Stand-in id for the not-yet-minted row while we lay out the candidate order;
// stripped from the result (the caller mints the real id).
const DRAFT_ID = "\u0000insert" as ScheduleItemId;

// Place a new fully-elastic item, then lay it out within the schedule's hard
// span. With an explicit `cursor` the slot follows it (the midpoint-nearest slot
// in a dynamic block or gap, or the start of the next opening when the cursor
// sits inside a static block). Without one the draft drops at the end of the
// future block or gap that strains the least, measured against `now`. Returns the
// feasible plan, or the greyed layout + culprit when the insert over-constrains
// the day.
export function insertAt(
  items: layout.LayoutItem[],
  draft: ItemBounds,
  span: layout.Span,
  cursor: number | null,
  now: number | null,
): Result<ScheduleInsert, InsertConflict> {
  const frames = layout.compute(items, span);
  const regs = regions(items, span);
  const idx =
    cursor != null
      ? explicitIndex(items, frames, regs, cursor)
      : leastStrainIndex(items, span, draft, regs, now);

  const order = [...items];
  order.splice(idx, 0, { id: DRAFT_ID, bounds: { ...draft } });

  // Grow the end so the draft fits when the schedule has no trailing slack left.
  const sp: layout.Span = { start: span.start, end: layout.minEndToFit(order, span) };
  const laid = layout.compute(order, sp);
  const verdict = layout.validate(order, laid, sp);
  const afterId = idx === 0 ? null : items[idx - 1]!.id;
  if (!verdict.ok) {
    return err({ afterId, error: verdict.error, layout: stripDraft(laid) });
  }
  return ok({ afterId, bounds: { ...draft }, span: sp, layout: stripDraft(laid) });
}

type RegionKind = "dynamic" | "static" | "gap";

// A stretch of the span: a dynamic block (contiguous elastic items, optionally
// bookended by a fixed-start/fixed-end item), a static block (one item pinned at
// both edges), or an empty gap between them. `insertBegin`/`insertEnd` are the
// order indices that land a draft at the block's start/end (past a fixed-start
// bookend, or before a fixed-end bookend).
interface Region {
  kind: RegionKind;
  start: number;
  end: number;
  insertBegin: number;
  insertEnd: number;
}

// Walk the items as `layout.compute` tiles them, emitting each segment plus the
// gaps the fixed anchors open between them.
function regions(items: layout.LayoutItem[], span: layout.Span): Region[] {
  const r = items.map((it) => layout.resolve(it.bounds));
  const n = items.length;
  const out: Region[] = [];
  let cursor = span.start;
  let i = 0;
  while (i < n) {
    const fixedStart = r[i]!.start != null;
    const segStart = fixedStart ? r[i]!.start! : cursor;
    if (segStart > cursor) {
      out.push({ kind: "gap", start: cursor, end: segStart, insertBegin: i, insertEnd: i });
    }
    const { last, right } = layout.segmentBounds(r, i);
    const segEnd = right ?? span.end;
    // A pinned-both item always tiles alone (its fixed edges break the segment).
    const isStatic = last === i && r[i]!.start != null && r[i]!.end != null;
    const fixedEnd = items[last]!.bounds.end != null;
    out.push({
      kind: isStatic ? "static" : "dynamic",
      start: segStart,
      end: segEnd,
      insertBegin: fixedStart && !isStatic ? i + 1 : i,
      insertEnd: fixedEnd ? last : last + 1,
    });
    cursor = segEnd;
    i = last + 1;
  }
  if (cursor < span.end) {
    out.push({ kind: "gap", start: cursor, end: span.end, insertBegin: n, insertEnd: n });
  }
  return out;
}

// Cursor-driven slot. A cursor inside a static block can't split it, so the draft
// jumps to the next non-static opening's start; otherwise it follows the midpoint
// rule within the dynamic block or gap it lands in.
function explicitIndex(
  items: layout.LayoutItem[],
  frames: layout.LayoutFrame[],
  regs: Region[],
  cursor: number,
): number {
  const at = regs.findIndex((reg) => cursor < reg.end);
  const region = at >= 0 ? regs[at]! : regs[regs.length - 1];
  if (region && region.kind === "static") {
    for (let k = at + 1; k < regs.length; k++) {
      if (regs[k]!.kind !== "static") return regs[k]!.insertBegin;
    }
    return items.length;
  }
  return midpointIndex(items, frames, cursor);
}

// Insertion index (0..n) from a cursor minute: head when at/above the first
// frame, before/after a containing item by its midpoint, after the item bordering
// a gap, else the tail.
function midpointIndex(
  items: layout.LayoutItem[],
  frames: layout.LayoutFrame[],
  cursor: number,
): number {
  const n = items.length;
  if (frames.length === 0) return n;
  if (cursor <= frames[0]!.start) return 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (cursor >= f.start && cursor < f.end) {
      const before = cursor < (f.start + f.end) / 2;
      const at = items.findIndex((it) => it.id === f.id);
      return before ? at : at + 1;
    }
    const next = frames[i + 1];
    if (cursor >= f.end && (!next || cursor < next.start)) {
      return items.findIndex((it) => it.id === f.id) + 1;
    }
  }
  return n;
}

// End-of-region slot whose insertion strains the schedule least: simulate the
// draft at the end of each future dynamic block or gap, scoring the minutes items
// fall below their targets. Ties keep the earliest region; an empty future falls
// back to the tail.
function leastStrainIndex(
  items: layout.LayoutItem[],
  span: layout.Span,
  draft: ItemBounds,
  regs: Region[],
  now: number | null,
): number {
  const threshold = now ?? -Infinity;
  let bestIdx = items.length;
  let bestStrain = Infinity;
  let found = false;
  for (const reg of regs) {
    if (reg.kind === "static" || reg.end <= threshold) continue;
    const idx = reg.insertEnd;
    const order = [...items];
    order.splice(idx, 0, { id: DRAFT_ID, bounds: { ...draft } });
    const laid = layout.compute(order, span);
    const strain = layout.validate(order, laid, span).ok ? totalShortfall(order, laid) : Infinity;
    if (!found || strain < bestStrain) {
      found = true;
      bestStrain = strain;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

// Total minutes every laid-out item falls short of its duration target.
function totalShortfall(order: layout.LayoutItem[], frames: layout.LayoutFrame[]): number {
  const byId = new Map(frames.map((f) => [f.id, f] as const));
  let total = 0;
  for (const it of order) {
    const f = byId.get(it.id);
    if (!f) continue;
    const dur = f.end - f.start;
    const target = layout.resolve(it.bounds).target;
    if (dur < target) total += target - dur;
  }
  return total;
}

function stripDraft(frames: layout.LayoutFrame[]): layout.LayoutFrame[] {
  return frames.filter((f) => f.id !== DRAFT_ID);
}
