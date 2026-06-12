import { describe, expect, it } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";

import { insertAt } from "./insert";
import { type LayoutItem, type Span } from "./layout";

const SPAN: Span = { start: 480, end: 1320 };
const id = (s: string) => s as ScheduleItemId;
const bounds = (b: Partial<ItemBounds> = {}): ItemBounds => ({
  start: b.start ?? null,
  end: b.end ?? null,
  fixedDuration: b.fixedDuration ?? null,
  durationTarget: b.durationTarget ?? 60,
});
const dyn = (durationTarget = 60): ItemBounds => bounds({ durationTarget });
const item = (s: string, b: ItemBounds): LayoutItem => ({ id: id(s), bounds: b });

function expectOk<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("insertAt with an explicit cursor", () => {
  it("drops a fully-elastic item into an empty schedule", () => {
    const r = expectOk(insertAt([], dyn(), SPAN, 600, null));
    expect(r.afterId).toBeNull();
    expect(r.bounds.start).toBeNull();
    expect(r.bounds.end).toBeNull();
    expect(r.bounds.fixedDuration).toBeNull();
  });

  it("inserts in the middle without pinning anything", () => {
    const items = [item("a", dyn()), item("b", dyn())];
    // Two elastic items split 480..1320 into 480..900 and 900..1320; 901 lands
    // just inside b, before its midpoint.
    const r = expectOk(insertAt(items, dyn(), SPAN, 901, null));
    expect(r.afterId).toBe(id("a"));
    expect(r.bounds.start).toBeNull();
    expect(r.bounds.end).toBeNull();
  });

  it("inserts an elastic item at the head", () => {
    const items = [item("a", dyn()), item("b", dyn())];
    const r = expectOk(insertAt(items, dyn(60), SPAN, 0, null));
    expect(r.afterId).toBeNull();
  });

  it("redirects a cursor inside a static block to the next opening", () => {
    // A pinned 600..660 block can't be split; the gap after it takes the draft.
    const items = [item("a", bounds({ start: 600, end: 660 })), item("b", dyn())];
    const r = expectOk(insertAt(items, dyn(), SPAN, 630, null));
    expect(r.afterId).toBe(id("a"));
  });

  it("steps past a fixed-start bookend when redirecting out of a static block", () => {
    // Static 540..600 abuts a dynamic block opening at a fixed start of 600; the
    // draft lands after that bookend, not before it.
    const items = [item("a", bounds({ start: 540, end: 600 })), item("b", bounds({ start: 600 }))];
    const r = expectOk(insertAt(items, dyn(), SPAN, 570, null));
    expect(r.afterId).toBe(id("b"));
  });

  it("drops into the gap a cursor lands in", () => {
    const items = [item("a", bounds({ start: 540, end: 600 })), item("b", bounds({ start: 900, end: 960 }))];
    const r = expectOk(insertAt(items, dyn(), SPAN, 700, null));
    expect(r.afterId).toBe(id("a"));
  });

  it("reports a conflict when the insert leaves no room", () => {
    // a..b span a 2-min slot; squeezing a third item below the minimum.
    const items = [item("a", { ...dyn(1), start: 480 }), item("b", { ...dyn(1), end: 482 })];
    const r = insertAt(items, dyn(), SPAN, 481, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error.kind).toBe("belowMin");
  });

  it("grows the schedule end to admit a new item when the span is full", () => {
    // A rigid item fills 480..1320 exactly; the draft needs one trailing minute.
    const items = [item("a", bounds({ fixedDuration: 840 }))];
    const r = expectOk(insertAt(items, dyn(), SPAN, null, null));
    expect(r.afterId).toBe(id("a"));
    expect(r.span).toEqual({ start: 480, end: 1321 });
  });
});

describe("insertAt without a cursor (least strain)", () => {
  it("appends a fully-elastic item to a single elastic block", () => {
    const items = [item("a", dyn()), item("b", dyn())];
    const r = expectOk(insertAt(items, dyn(60), SPAN, null, null));
    expect(r.afterId).toBe(id("b"));
  });

  it("prefers a roomy gap over a cramped dynamic block", () => {
    // a fills its own 480..540 block; the 540..600 gap absorbs the draft with no
    // strain, whereas wedging it before a would halve both.
    const items = [item("a", bounds({ end: 540 })), item("b", bounds({ start: 600, end: 660 }))];
    const r = expectOk(insertAt(items, dyn(), SPAN, null, null));
    expect(r.afterId).toBe(id("a"));
  });

  it("only considers blocks at or after now", () => {
    const items = [
      item("a", bounds({ end: 600 })),
      item("mid", bounds({ start: 660, end: 720 })),
      item("c", bounds({ start: 780 })),
    ];
    // With no clock the earliest zero-strain slot is the leading block (head).
    expect(expectOk(insertAt(items, dyn(), SPAN, null, null)).afterId).toBeNull();
    // now=700 skips the past blocks; the next opening is the 720..780 gap.
    expect(expectOk(insertAt(items, dyn(), SPAN, null, 700)).afterId).toBe(id("mid"));
  });
});
