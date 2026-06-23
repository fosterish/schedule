import { describe, expect, it } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";

import { compute } from "./layout";
import type { LayoutItem, Span } from "./layout";
import { splitAt, targetAt } from "./split";

const SPAN: Span = { start: 480, end: 1320 };

const id = (s: string) => s as ScheduleItemId;
const item = (s: string, bounds: ItemBounds): LayoutItem => ({ id: id(s), bounds });
const dyn = (durationTarget = 60): ItemBounds => ({ start: null, end: null, fixedDuration: null, durationTarget });
const fixed = (start: number, end: number): ItemBounds => ({ start, end, fixedDuration: null, durationTarget: end - start });

function planFor(items: LayoutItem[], cursor: number) {
  const r = splitAt(items, compute(items, SPAN), cursor);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.reason}`);
  return r.value;
}

describe("split.targetAt", () => {
  it("returns the item strictly containing the cursor", () => {
    const items = [item("a", dyn()), item("b", dyn()), item("c", dyn())];
    expect(targetAt(compute(items, SPAN), 900)).toBe(id("b"));
  });

  it("is null on a boundary between two items", () => {
    const items = [item("a", dyn()), item("b", dyn()), item("c", dyn())];
    // a/b share minute 760.
    expect(targetAt(compute(items, SPAN), 760)).toBeNull();
  });

  it("is null in a gap and on the schedule edges", () => {
    const items = [item("a", fixed(600, 720))];
    const frames = compute(items, SPAN);
    expect(targetAt(frames, 500)).toBeNull(); // leading gap
    expect(targetAt(frames, 480)).toBeNull(); // schedule start
  });
});

describe("split.splitAt", () => {
  it("divides an elastic item's target weight and keeps both elastic", () => {
    const items = [item("a", dyn()), item("b", dyn(60)), item("c", dyn())];
    const plan = planFor(items, 900); // midpoint of b [760,1040]
    expect(plan.id).toBe(id("b"));
    expect(plan.bounds).toEqual({ start: null, end: null, fixedDuration: null, durationTarget: 30 });
    expect(plan.newBounds).toEqual({ start: null, end: null, fixedDuration: null, durationTarget: 30 });
  });

  it("splits a static item into two abutting static items", () => {
    const items = [item("a", fixed(480, 720))];
    const plan = planFor(items, 600);
    expect(plan.bounds.start).toBe(480);
    expect(plan.bounds.end).toBe(600);
    expect(plan.bounds.fixedDuration).toBeNull();
    expect(plan.newBounds.start).toBe(600);
    expect(plan.newBounds.end).toBe(720);
    expect(plan.newBounds.fixedDuration).toBeNull();
  });

  it("keeps the fixed start on the first half and leaves the second completely free", () => {
    const items = [item("a", { start: 480, end: null, fixedDuration: null, durationTarget: 60 })];
    const plan = planFor(items, 900);
    expect(plan.bounds).toEqual({ start: 480, end: null, fixedDuration: null, durationTarget: 30 });
    expect(plan.newBounds).toEqual({ start: null, end: null, fixedDuration: null, durationTarget: 30 });
  });

  it("leaves the first half completely free and keeps the fixed end on the second", () => {
    const items = [item("a", { start: null, end: 1320, fixedDuration: null, durationTarget: 60 })];
    const plan = planFor(items, 900); // a fills [480,1320], midpoint 900
    expect(plan.bounds).toEqual({ start: null, end: null, fixedDuration: null, durationTarget: 30 });
    expect(plan.newBounds).toEqual({ start: null, end: 1320, fixedDuration: null, durationTarget: 30 });
  });

  it("combines a fixed end with a fixed duration across both halves", () => {
    const items = [item("a", { start: null, end: 1320, fixedDuration: 120, durationTarget: 60 })];
    const plan = planFor(items, 1260); // a is rigid [1200,1320], cut at the midpoint
    expect(plan.bounds).toEqual({ start: null, end: null, fixedDuration: 60, durationTarget: 60 });
    expect(plan.newBounds).toEqual({ start: null, end: 1320, fixedDuration: 60, durationTarget: 60 });
  });

  it("divides a fixed duration by the cut", () => {
    const items = [item("a", { start: null, end: null, fixedDuration: 120, durationTarget: 60 })];
    const plan = planFor(items, 540); // a is rigid [480,600], cut at the midpoint
    expect(plan.bounds.fixedDuration).toBe(60);
    expect(plan.newBounds.fixedDuration).toBe(60);
  });

  it("is disabled when the cursor isn't strictly inside an item", () => {
    const items = [item("a", dyn()), item("b", dyn())]; // a [480,900], b [900,1320]
    expect(splitAt(items, compute(items, SPAN), 700).ok).toBe(true); // inside a
    expect(splitAt(items, compute(items, SPAN), 900).ok).toBe(false); // a/b boundary
    expect(splitAt(items, compute(items, SPAN), 480).ok).toBe(false); // schedule start
  });
});
