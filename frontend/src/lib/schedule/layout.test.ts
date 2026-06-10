import { describe, expect, test } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import {
  compute,
  validate,
  FRAME_END,
  type LayoutItem,
  type Span,
} from "@lib/schedule/layout";

// 8am–10pm, the default hard bounds.
const SPAN: Span = { start: 480, end: 1320 };

function item(id: string, b: Partial<ItemBounds>): LayoutItem {
  return {
    id,
    bounds: {
      start: b.start ?? null,
      end: b.end ?? null,
      fixedDuration: b.fixedDuration ?? null,
      durationTarget: b.durationTarget ?? 60,
    },
  };
}

describe("compute", () => {
  test("empty", () => {
    expect(compute([], SPAN)).toEqual([]);
  });

  test("lone elastic item fills the whole span", () => {
    expect(compute([item("a", { durationTarget: 30 })], SPAN)).toEqual([
      { id: "a", start: 480, end: 1320 },
    ]);
  });

  test("elastic items with no fixed edges share the span", () => {
    const frames = compute([item("a", { durationTarget: 1 }), item("b", { durationTarget: 1 })], SPAN);
    expect(frames).toEqual([
      { id: "a", start: 480, end: 900 },
      { id: "b", start: 900, end: 1320 },
    ]);
  });

  test("missing first start: leading elastic begins at span.start", () => {
    const frames = compute([item("a", { durationTarget: 60 }), item("b", { end: 600, durationTarget: 60 })], SPAN);
    expect(frames).toEqual([
      { id: "a", start: 480, end: 540 },
      { id: "b", start: 540, end: 600 },
    ]);
  });

  test("missing last end: trailing elastic fills to span.end", () => {
    const frames = compute([item("a", { start: 1200, durationTarget: 60 }), item("b", { durationTarget: 60 })], SPAN);
    expect(frames).toEqual([
      { id: "a", start: 1200, end: 1260 },
      { id: "b", start: 1260, end: 1320 },
    ]);
  });

  test("pinned item keeps its anchors", () => {
    expect(compute([item("a", { start: 500, end: 560 })], SPAN)).toEqual([
      { id: "a", start: 500, end: 560 },
    ]);
  });

  test("two elastic share a bounded segment proportionally", () => {
    const frames = compute([item("a", { start: 480, durationTarget: 1 }), item("b", { end: 600, durationTarget: 3 })], SPAN);
    expect(frames).toEqual([
      { id: "a", start: 480, end: 510 },
      { id: "b", start: 510, end: 600 },
    ]);
  });

  test("rigid item reserves its length before the elastic share", () => {
    const frames = compute(
      [
        item("a", { start: 480, durationTarget: 1 }),
        item("r", { fixedDuration: 30 }),
        item("b", { end: 600, durationTarget: 1 }),
      ],
      SPAN,
    );
    expect(frames).toEqual([
      { id: "a", start: 480, end: 525 },
      { id: "r", start: 525, end: 555 },
      { id: "b", start: 555, end: 600 },
    ]);
  });

  test("largest-remainder split is contiguous and fills the segment", () => {
    const frames = compute(
      [
        item("a", { start: 480, durationTarget: 1 }),
        item("m", { durationTarget: 1 }),
        item("z", { end: 580, durationTarget: 1 }),
      ],
      SPAN,
    );
    expect(frames[0]!.start).toBe(480);
    expect(frames.at(-1)!.end).toBe(580);
    for (let k = 1; k < frames.length; k++) {
      expect(frames[k]!.start).toBe(frames[k - 1]!.end);
    }
    const total = frames.reduce((s, f) => s + (f.end - f.start), 0);
    expect(total).toBe(100);
  });

  test("item entirely past the frame is omitted", () => {
    expect(compute([item("a", { start: 3000, end: 3060 })], SPAN)).toEqual([]);
  });

  test("item overlapping the frame edge is clamped", () => {
    expect(compute([item("a", { start: 2800, end: 3000 })], SPAN)).toEqual([
      { id: "a", start: 2800, end: FRAME_END },
    ]);
  });
});

describe("validate", () => {
  test("feasible layout is ok", () => {
    const items = [item("a", { start: 480, durationTarget: 1 }), item("b", { end: 600, durationTarget: 1 })];
    expect(validate(items, compute(items, SPAN), SPAN)).toEqual({ ok: true, value: undefined });
  });

  test("anchor before the span start is out of bounds", () => {
    const items = [item("a", { start: 100, end: 160 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "outOfBounds", indices: [0] });
  });

  test("anchor past the span end is out of bounds", () => {
    const items = [item("a", { start: 1200, end: 1400 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "outOfBounds", indices: [0] });
  });

  test("out-of-bounds outranks an over-constrained item", () => {
    const items = [item("a", { start: 0, end: 50, fixedDuration: 30 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("outOfBounds");
  });

  test("non-monotonic fixed anchors", () => {
    const items = [item("a", { start: 500, end: 600 }), item("b", { start: 550, end: 700 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "anchorNonMonotonic", indices: [1] });
  });

  test("contradictory fixed inputs are over-constrained", () => {
    const items = [item("a", { start: 500, end: 550, fixedDuration: 30 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "overConstrained", indices: [0] });
  });

  test("inverted pinned span is over-constrained", () => {
    const items = [item("a", { start: 550, end: 540 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("overConstrained");
  });

  test("squeezed segment falls below the minimum", () => {
    const items = [item("a", { start: 480, durationTarget: 1 }), item("b", { end: 481, durationTarget: 1 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("belowMin");
  });

  test("anchor precedence beats below-min", () => {
    const items = [item("a", { start: 480, end: 600 }), item("b", { start: 550, end: 551 })];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("anchorNonMonotonic");
  });

  test("a rigid item overflowing a too-small bounded gap is below-min", () => {
    // F1 ends at 600, F2 starts at 660: the 60-min gap can't hold r's fixed 120,
    // so r tiles past F2's start and the frames overlap.
    const items = [
      item("f1", { start: 480, end: 600 }),
      item("r", { fixedDuration: 120 }),
      item("f2", { start: 660, end: 900 }),
    ];
    const r = validate(items, compute(items, SPAN), SPAN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("belowMin");
      expect(r.error.indices).toContain(1);
    }
  });
});
