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
const item = (s: string, bounds: ItemBounds): LayoutItem => ({ id: id(s), bounds });

function planFor(action: RunAction, items: LayoutItem[], now: number) {
  const r = apply(action, items, compute(items, SPAN), now, SPAN);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.reason}`);
  return r.value;
}

// Three elastic items split the 8am-10pm span into 480..760, 760..1040, 1040..1320.
const threeDynamic = () => [item("a", dyn()), item("b", dyn()), item("c", dyn())];

describe("run.flags", () => {
  it("offers only Play before the schedule start", () => {
    const f = flags(threeDynamic(), compute(threeDynamic(), SPAN), 400, SPAN);
    expect(f.play).toEqual({ enabled: true, target: id("a") });
    expect(f.stop.enabled).toBe(false);
    expect(f.skip.enabled).toBe(false);
  });

  it("targets the dynamic block's first item within it, skip the next", () => {
    const items = threeDynamic();
    const f = flags(items, compute(items, SPAN), 500, SPAN);
    expect(f.play.target).toBe(id("a"));
    expect(f.stop.target).toBe(id("a"));
    expect(f.skip).toEqual({ enabled: true, target: id("b") });
  });

  it("disables Stop when it would zero-duration delete the target", () => {
    const items = [item("a", fixed(480, 540)), item("b", dyn())];
    // now == a.start, so stopping a (set end=480) collapses it.
    const f = flags(items, compute(items, SPAN), 480, SPAN);
    expect(f.stop.enabled).toBe(false);
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

  it("Skip stops the current block and starts the next", () => {
    const p = planFor("skip", threeDynamic(), 500);
    const byId = new Map(p.patches.map((x) => [x.id, x.bounds]));
    expect(byId.get(id("a"))?.end).toBe(500);
    expect(byId.get(id("b"))?.start).toBe(500);
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
});
