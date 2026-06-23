import { describe, expect, it } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";

import { compute } from "./layout";
import type { LayoutItem, Span } from "./layout";
import { apply, flags, type RunAction } from "./run";

// Default hard bounds (8am-10pm).
const SPAN: Span = { start: 480, end: 1320 };

const id = (s: string) => s as ScheduleItemId;
const dyn = (durationTarget = 60): ItemBounds => ({
  start: null,
  end: null,
  fixedDuration: null,
  durationTarget,
});
const fixed = (start: number, end: number): ItemBounds => ({
  start,
  end,
  fixedDuration: null,
  durationTarget: end - start,
});
const fixedStart = (start: number): ItemBounds => ({ start, end: null, fixedDuration: null, durationTarget: 60 });
const rigid = (fixedDuration: number): ItemBounds => ({ start: null, end: null, fixedDuration, durationTarget: fixedDuration });
const item = (s: string, bounds: ItemBounds): LayoutItem => ({ id: id(s), bounds });

function planFor(action: RunAction, items: LayoutItem[], now: number) {
  const r = apply(action, items, compute(items, SPAN), now, SPAN);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.reason}`);
  return r.value;
}

// Three elastic items split the 8am-10pm span into 480..760, 760..1040, 1040..1320.
const threeDynamic = () => [item("a", dyn()), item("b", dyn()), item("c", dyn())];

describe("run.flags", () => {
  it("offers only Play before the schedule start, targeting the first item", () => {
    const f = flags(threeDynamic(), compute(threeDynamic(), SPAN), 400, SPAN);
    expect(f.play).toEqual({ enabled: true, target: id("a") });
    expect(f.stop.enabled).toBe(false);
  });

  it("targets the dynamic block's open first item for both Play and Stop", () => {
    const items = threeDynamic();
    const f = flags(items, compute(items, SPAN), 500, SPAN);
    expect(f.play.target).toBe(id("a"));
    expect(f.stop.target).toBe(id("a"));
  });

  it("Play targets the second item when the block's first has a fixed start", () => {
    const items = [item("a", fixedStart(480)), item("b", dyn()), item("c", dyn())];
    const f = flags(items, compute(items, SPAN), 500, SPAN);
    expect(f.play.target).toBe(id("b"));
    // Stop still targets the block's first (anchored) item.
    expect(f.stop.target).toBe(id("a"));
  });

  it("Play targets the item after the current static item", () => {
    const items = [item("a", fixed(480, 600)), item("b", dyn())];
    const f = flags(items, compute(items, SPAN), 540, SPAN);
    expect(f.play.target).toBe(id("b"));
    expect(f.stop.target).toBe(id("a"));
  });

  it("disables Play when an anchored block/static item has no following item", () => {
    const items = [item("a", fixed(480, 540)), item("b", fixedStart(700))];
    // now is inside b, whose block is just itself (fixed start, nothing after).
    const f = flags(items, compute(items, SPAN), 800, SPAN);
    expect(f.play.enabled).toBe(false);
    expect(f.stop.target).toBe(id("b"));
  });

  it("disables Play when its stop-then-play would breach the stop target's minimum duration", () => {
    const items = [item("a", fixed(480, 600)), item("b", dyn())];
    // now == a.start: stopping a to start b would collapse a below its minimum.
    expect(flags(items, compute(items, SPAN), 480, SPAN).play.enabled).toBe(false);
    // A minute in, a has room to run; Play targets b again.
    const g = flags(items, compute(items, SPAN), 481, SPAN);
    expect(g.play).toEqual({ enabled: true, target: id("b") });
  });

  it("disables both actions when the schedule has no items", () => {
    const f = flags([], compute([], SPAN), 500, SPAN);
    expect(f.play.enabled).toBe(false);
    expect(f.stop.enabled).toBe(false);
  });

  it("disables Stop when it would zero-duration delete the target", () => {
    const items = [item("a", fixed(480, 540)), item("b", dyn())];
    // now == a.start, so stopping a (set end=480) collapses it.
    const f = flags(items, compute(items, SPAN), 480, SPAN);
    expect(f.stop.enabled).toBe(false);
  });

  it("disables Stop at the beginning of a dynamic block", () => {
    const items = threeDynamic();
    // now == the block's start; stopping its first item would zero its duration.
    const f = flags(items, compute(items, SPAN), 480, SPAN);
    expect(f.stop.enabled).toBe(false);
    // A minute later it targets the block's first item and is enabled.
    const g = flags(items, compute(items, SPAN), 481, SPAN);
    expect(g.stop).toEqual({ enabled: true, target: id("a") });
  });

  it("disables Play when a fixed-duration item would overrun the next fixed start", () => {
    // a is rigid 60 min, b is pinned to 540: a only fits before b when it starts <= 480.
    const items = [item("a", rigid(60)), item("b", fixedStart(540))];
    // Playing at 500 pins a to [500, 560], overlapping b at 540 -> disabled.
    expect(flags(items, compute(items, SPAN), 500, SPAN).play.enabled).toBe(false);
    // At the schedule start there is exactly room: a lays out [480, 540].
    expect(flags(items, compute(items, SPAN), 480, SPAN).play.enabled).toBe(true);
  });

  it("disables Play when dynamic items can't fit their minimums before the next fixed start", () => {
    // Three 1-min-minimum items must precede b's fixed start at 483.
    const items = [item("a", dyn()), item("b", dyn()), item("c", dyn()), item("d", fixedStart(483))];
    // Playing at 481 leaves only 2 minutes for three items -> overlap -> disabled.
    expect(flags(items, compute(items, SPAN), 481, SPAN).play.enabled).toBe(false);
  });
});

describe("run.apply", () => {
  it("Play before start pins the first item's start", () => {
    const p = planFor("play", threeDynamic(), 400);
    expect(p.patches).toEqual([
      { id: id("a"), bounds: { start: 400, end: null, fixedDuration: null, durationTarget: 60 } },
    ]);
    expect(p.deletes).toEqual([]);
  });

  it("Play/Stop within a dynamic block act on its first item", () => {
    expect(planFor("play", threeDynamic(), 500).patches[0]?.bounds.start).toBe(500);
    expect(planFor("stop", threeDynamic(), 500).patches[0]?.bounds.end).toBe(500);
  });

  it("Play stops an anchored block's first item and starts the next", () => {
    const items = [item("a", fixedStart(480)), item("b", dyn()), item("c", dyn())];
    const p = planFor("play", items, 500);
    const byId = new Map(p.patches.map((x) => [x.id, x.bounds]));
    expect(byId.get(id("a"))?.end).toBe(500);
    expect(byId.get(id("b"))?.start).toBe(500);
  });

  it("Play stops the current static item and starts the one after", () => {
    const items = [item("a", fixed(480, 600)), item("b", dyn())];
    const p = planFor("play", items, 540);
    const byId = new Map(p.patches.map((x) => [x.id, x.bounds]));
    expect(byId.get(id("a"))?.end).toBe(540);
    expect(byId.get(id("b"))?.start).toBe(540);
  });

  it("Stop only Play before start is allowed", () => {
    const r = apply("stop", threeDynamic(), compute(threeDynamic(), SPAN), 400, SPAN);
    expect(r.ok).toBe(false);
  });

  it("Stop on a fixed item ending now deletes it (zero duration)", () => {
    const items = [item("a", fixed(480, 540)), item("b", dyn())];
    const p = planFor("stop", items, 480);
    expect(p.deletes).toContain(id("a"));
  });

  it("gap Stop extends the previous fixed-end item", () => {
    // a fixed 480..540, gap, c fixed 700..760. now=600 is in the gap.
    const items = [item("a", fixed(480, 540)), item("c", fixed(700, 760))];
    const p = planFor("stop", items, 600);
    expect(p.patches).toEqual([
      { id: id("a"), bounds: { start: 480, end: 600, fixedDuration: null, durationTarget: 60 } },
    ]);
  });

  it("grows the span outward to fit an item played past the schedule end", () => {
    const p = planFor("play", threeDynamic(), 1400);
    expect(p.patches[0]?.bounds.start).toBe(1400);
    // Three items need at least 1400 + 3 minutes; the span end grows to admit them.
    expect(p.span.end).toBeGreaterThanOrEqual(1403);
  });

  it("rejects a Play that would overlap a later fixed start", () => {
    const items = [item("a", rigid(60)), item("b", fixedStart(540))];
    expect(apply("play", items, compute(items, SPAN), 500, SPAN).ok).toBe(false);
  });
});
