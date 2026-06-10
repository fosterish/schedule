import { describe, expect, test } from "vitest";

import type { ItemBounds } from "@bindings/ItemBounds";
import * as layout from "@lib/schedule/layout";
import * as resize from "@lib/schedule/resize";

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

describe("resize.slideEdge walls", () => {
  test("a both-ends edge stops at the next fixed item's edge", () => {
    const span: layout.Span = { start: 480, end: 900 };
    // M 480..600, N 720..900; the 600..720 gap is the only slack.
    const items = [li("M", { start: 480, end: 600 }), li("N", { start: 720, end: 900 })];
    const r = resize.slideEdge(items, span, 0, "end", 800);
    expect(r.value).toBe(720);
    expect(r.bounds.end).toBe(720);
    expect(r.span).toEqual(span);
  });

  test("an edge cannot shrink its own item below the minimum", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("M", { start: 480, end: 600 }), li("N", { start: 720, end: 900 })];
    const r = resize.slideEdge(items, span, 0, "end", 400);
    expect(r.value).toBe(481);
  });

  test("a rigid item translates whole and stops at a fixed neighbour", () => {
    const span: layout.Span = { start: 480, end: 900 };
    // A ends at 580 (wall); R is rigid 600..720 (start + 120 duration).
    const items = [li("A", { end: 580 }), li("R", { start: 600, fixedDuration: 120 })];
    const r = resize.slideEdge(items, span, 1, "start", 500);
    expect(r.value).toBe(580);
    expect(r.bounds.start).toBe(580);
    expect(r.bounds.fixedDuration).toBe(120);
  });
});

describe("resize.slideEdge schedule growth", () => {
  test("a head's fixed start grows the schedule earlier", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("H", { start: 480 }), li("B")];
    const r = resize.slideEdge(items, span, 0, "start", 420);
    expect(r.value).toBe(420);
    expect(r.span).toEqual({ start: 420, end: 900 });
  });

  test("growth is clamped to the day floor", () => {
    const span: layout.Span = { start: 0, end: 1440 };
    const items = [li("H", { start: 0 }), li("B")];
    const r = resize.slideEdge(items, span, 0, "start", -60);
    expect(r.value).toBe(0);
    expect(r.span).toEqual({ start: 0, end: 1440 });
  });
});

describe("resize.reinsertByValue", () => {
  // A pins the start, D the end; B and C are elastic. Frames tile at
  // 480..585, 585..690, 690..795, 795..900 (mids 532.5, 637.5, 742.5, 847.5).
  const span: layout.Span = { start: 480, end: 900 };
  const four = (): layout.LayoutItem[] => [li("A", { start: 480 }), li("B"), li("C"), li("D", { end: 900 })];

  test("a typed start relocates the item past the nearer midpoints", () => {
    const r = resize.reinsertByValue(four(), span, 1, "start", 820);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.afterId).toBe("C");
    expect(r.value.bounds.start).toBe(820);
  });

  test("a value that lands before a later fixed start is rejected with the blocker", () => {
    const span2: layout.Span = { start: 480, end: 900 };
    // A elastic, F fixed 600..720, M elastic. Setting M's start to 650 lands it
    // before F by midpoint, but its anchor sits past F's start: non-monotonic.
    const items = [li("A"), li("F", { start: 600, end: 720 }), li("M")];
    const r = resize.reinsertByValue(items, span2, 2, "start", 650);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blockerId).toBe("F");
  });
});
