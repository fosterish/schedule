import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import { type Result, ok, err } from "@lib/result";

import { MIN_DURATION, type LayoutFrame, type LayoutItem } from "./layout";

// Cut the item under the cursor in two abutting halves. The current item keeps
// its start; its end mirrors the start anchor's fixedness (fixed -> pinned at the
// cursor). The clone keeps the original end and mirrors the original end anchor's
// fixedness. Durations divide by the cursor's position: a fixed duration splits
// its length, an elastic one splits its target weight. Pure: returns the patched
// current bounds + the clone's bounds; the caller mints the id and order key.

export interface ScheduleSplit {
  id: ScheduleItemId;
  bounds: ItemBounds;
  newBounds: ItemBounds;
}

export type SplitError = { kind: "disabled"; reason: string };

// The item whose laid frame strictly contains `cursor` (never on an edge), or
// null in a gap, on a boundary between items, or on a schedule edge.
export function targetAt(frames: LayoutFrame[], cursor: number): ScheduleItemId | null {
  const at = Math.round(cursor);
  const frame = frames.find((f) => at > f.start && at < f.end);
  return frame ? frame.id : null;
}

export function splitAt(items: LayoutItem[], frames: LayoutFrame[], cursor: number): Result<ScheduleSplit, SplitError> {
  const at = Math.round(cursor);
  const frame = frames.find((f) => at > f.start && at < f.end);
  if (!frame) return err({ kind: "disabled", reason: "the cursor isn\u2019t inside an item" });
  const item = items.find((it) => it.id === frame.id);
  if (!item) return err({ kind: "disabled", reason: "no item to split" });

  const b = item.bounds;
  const frac = (at - frame.start) / (frame.end - frame.start);
  const cur: ItemBounds = {
    start: b.start,
    end: b.start != null ? at : null,
    fixedDuration: null,
    durationTarget: b.durationTarget,
  };
  const nw: ItemBounds = {
    start: b.end != null ? at : null,
    end: b.end,
    fixedDuration: null,
    durationTarget: b.durationTarget,
  };
  if (b.fixedDuration != null) {
    const [a, c] = cut(b.fixedDuration, frac);
    cur.fixedDuration = a;
    nw.fixedDuration = c;
  } else {
    const [a, c] = cut(b.durationTarget, frac);
    cur.durationTarget = a;
    nw.durationTarget = c;
  }
  // Two fixed anchors already pin the length, so the rigid duration is redundant.
  if (cur.start != null && cur.end != null) cur.fixedDuration = null;
  if (nw.start != null && nw.end != null) nw.fixedDuration = null;
  return ok({ id: frame.id, bounds: cur, newBounds: nw });
}

// Divide `total` at `frac`, each half at least MIN_DURATION; the parts sum to
// `total` whenever it can hold two minimum halves.
function cut(total: number, frac: number): [number, number] {
  if (total < 2 * MIN_DURATION) return [MIN_DURATION, MIN_DURATION];
  const a = clamp(Math.round(total * frac), MIN_DURATION, total - MIN_DURATION);
  return [a, total - a];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
