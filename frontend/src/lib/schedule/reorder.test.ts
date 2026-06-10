import { describe, expect, test } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import * as layout from "@lib/schedule/layout";
import * as reorder from "@lib/schedule/reorder";

function bounds(b: Partial<ItemBounds> = {}): ItemBounds {
  return {
    start: b.start ?? null,
    end: b.end ?? null,
    fixedDuration: b.fixedDuration ?? null,
    durationTarget: b.durationTarget ?? 60,
  };
}

function li(id: string, b: Partial<ItemBounds> = {}): layout.LayoutItem {
  return { id, bounds: bounds(b) };
}

// Laid-out edges aligned with `items`, as Timeline passes them to detect.
const framesOf = (items: layout.LayoutItem[], span: layout.Span) => layout.compute(items, span);

// A,B,C,D over the 480..900 span: A pins the start, D the end, B/C elastic,
// laying out at 480..585, 585..690, 690..795, 795..900.
const FOUR_SPAN: layout.Span = { start: 480, end: 900 };
function fourItems(): layout.LayoutItem[] {
  return [li("A", { start: 480 }), li("B"), li("C"), li("D", { end: 900 })];
}

describe("reorder.detect geometry", () => {
  test("no crossing yields no move", () => {
    const items = fourItems();
    // B's bottom edge (690) nudged to 700, short of C's midpoint (742.5).
    const r = reorder.detect(items, framesOf(items, FOUR_SPAN), "B", "down", 700, FOUR_SPAN);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("missing item yields no move", () => {
    const items = fourItems();
    const r = reorder.detect(items, framesOf(items, FOUR_SPAN), "Z", "down", 9999, FOUR_SPAN);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("a leading edge past a free midpoint reorders past that row", () => {
    const items = fourItems();
    // B's bottom edge crosses C's midpoint (742.5) but not D's (847.5).
    const r = reorder.detect(items, framesOf(items, FOUR_SPAN), "B", "down", 800, FOUR_SPAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBe("C");
  });

  test("reordering to the tail emits the last item's afterId", () => {
    const items = fourItems();
    const r = reorder.detect(items, framesOf(items, FOUR_SPAN), "B", "down", 999, FOUR_SPAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBe("D");
  });
});

const FIXED_SPAN: layout.Span = { start: 480, end: 1000 };
// A 480..600, F 600..780 (immovable), C 780..1000; A and C are free so moving
// them past F carries no conflicting anchor.
function fixedItems(): layout.LayoutItem[] {
  return [li("A"), li("F", { start: 600, end: 780 }), li("C")];
}

describe("reorder.detect fixed items", () => {
  test("a fixed item cannot be dragged", () => {
    const items = fixedItems();
    const r = reorder.detect(items, framesOf(items, FIXED_SPAN), "F", "down", 9999, FIXED_SPAN);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("clearing a fixed midpoint but not its far edge does not reorder", () => {
    const items = fixedItems();
    // A's bottom edge to 700: past F's midpoint (690) but short of F's end (780).
    const r = reorder.detect(items, framesOf(items, FIXED_SPAN), "A", "down", 700, FIXED_SPAN);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("crossing a fixed item's far edge lands the drag on its opposite side", () => {
    const items = fixedItems();
    // A's bottom edge to 800, past F's end (780): A jumps after the immovable F.
    const r = reorder.detect(items, framesOf(items, FIXED_SPAN), "A", "down", 800, FIXED_SPAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBe("F");
  });

  test("dragging up past a fixed item uses its matching start edge", () => {
    const items = fixedItems();
    // C's top edge to 550, past F's start (600): C jumps before the immovable F.
    const r = reorder.detect(items, framesOf(items, FIXED_SPAN), "C", "up", 550, FIXED_SPAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBe("A");
  });
});

describe("reorder.detect eligibility", () => {
  const span: layout.Span = { start: 480, end: 900 };
  test("an item with a single pinned edge cannot be dragged", () => {
    const items = [li("P", { start: 540 }), li("B")];
    const r = reorder.detect(items, framesOf(items, span), "P", "down", 9999, span);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("a fixed-duration-only item can be dragged", () => {
    const items = [li("A"), li("B", { fixedDuration: 60 })];
    // B's top edge to 500, past A's midpoint, so B reorders before A.
    const r = reorder.detect(items, framesOf(items, span), "B", "up", 500, span);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBeNull();
  });
});

describe("reorder.detect head/tail bounds", () => {
  test("no shift when the gap before a fixed-start head already fits", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("H", { start: 600 }), li("B")];
    const r = reorder.detect(items, framesOf(items, span), "B", "up", 550, span);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBeNull();
    expect(r.value!.span).toEqual({ start: 480, end: 900 });
  });

  test("a fixed-duration head shifts the start earlier by the shortfall", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("H", { start: 540 }), li("B", { fixedDuration: 120 })];
    // Gap before H is 60, B needs 120: start grows earlier by the 60 shortfall.
    const r = reorder.detect(items, framesOf(items, span), "B", "up", 500, span);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBeNull();
    expect(r.value!.span).toEqual({ start: 420, end: 900 });
  });

  test("appending past a fixed-end tail grows the end later", () => {
    const span: layout.Span = { start: 480, end: 840 };
    const items = [li("B", { fixedDuration: 120 }), li("T", { end: 780 })];
    // Trailing gap after T is 60, B needs 120: end grows later by 60.
    const r = reorder.detect(items, framesOf(items, span), "B", "down", 800, span);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value!.afterId).toBe("T");
    expect(r.value!.span).toEqual({ start: 480, end: 900 });
  });
});

describe("reorder.detect conflicts", () => {
  test("a move blocked by the day-window clamp stays infeasible", () => {
    const span: layout.Span = { start: 30, end: 900 };
    const items = [li("H", { start: 90 }), li("B", { fixedDuration: 120 })];
    // B needs 120 before H's start 90, but the start can only reach 0 (60 short).
    const r = reorder.detect(items, framesOf(items, span), "B", "up", 50, span);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error.kind).toBe("belowMin");
    expect(r.error.span.start).toBe(0);
  });

  test("a too-small interior gap is not relievable by bounds", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("F1", { start: 480, end: 600 }), li("F2", { start: 660, end: 900 }), li("B", { fixedDuration: 120 })];
    // The 60-min gap between F1 and F2 can't hold B's fixed 120; bounds don't help.
    const r = reorder.detect(items, framesOf(items, span), "B", "up", 620, span);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error.kind).toBe("belowMin");
    expect(r.error.span).toEqual({ start: 480, end: 900 });
  });
});
