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

  test("an unanchored fixed-duration item grows the end when it overflows", () => {
    const span: layout.Span = { start: 480, end: 1320 };
    // A has no fixed edge; stretching its duration to 900 overruns the 840-wide
    // span, so the end grows to 480 + 900 rather than clamping the duration.
    const items = [li("A", { fixedDuration: 60 })];
    const r = resize.slideDuration(items, span, 0, 900);
    expect(r.value).toBe(900);
    expect(r.bounds.fixedDuration).toBe(900);
    expect(r.span).toEqual({ start: 480, end: 1380 });
  });
});

describe("resize.clampScheduleEnd", () => {
  test("grows freely outward, up to the absolute ceiling", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("R", { fixedDuration: 300 })];
    expect(resize.clampScheduleEnd(items, span, 2000)).toBe(2000);
    expect(resize.clampScheduleEnd(items, span, 5000)).toBe(layout.FRAME_END);
  });

  test("shrinking stops at a trailing rigid item's required width (no leeway)", () => {
    const span: layout.Span = { start: 480, end: 900 };
    // R is rigid 300 and trails the list: the end can't drop below 480 + 300.
    const items = [li("R", { fixedDuration: 300 })];
    expect(resize.clampScheduleEnd(items, span, 500)).toBe(780);
  });

  test("shrinking stops at a fixed end anchor", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("A", { end: 840 })];
    expect(resize.clampScheduleEnd(items, span, 500)).toBe(840);
  });

  test("shrinking respects a trailing item with a fixed start + duration (no fixed end)", () => {
    const span: layout.Span = { start: 480, end: 900 };
    // R is anchored at 700 and rigid for 180m: its derived end is 880, with no
    // fixed-end wall, so the schedule end must stop there rather than slide in.
    const items = [li("R", { start: 700, fixedDuration: 180 })];
    expect(resize.clampScheduleEnd(items, span, 500)).toBe(880);
  });
});

describe("resize.clampScheduleStart", () => {
  test("moving later stops at a fixed start anchor", () => {
    const span: layout.Span = { start: 480, end: 900 };
    const items = [li("A", { start: 540 })];
    expect(resize.clampScheduleStart(items, span, 700)).toBe(540);
  });

  test("never exceeds the minute-of-day maximum", () => {
    const span: layout.Span = { start: 1200, end: 2880 };
    const items: layout.LayoutItem[] = [];
    expect(resize.clampScheduleStart(items, span, 2000)).toBe(layout.MAX_SCHEDULE_START);
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

  test("a typed start that drives a rigid item past the absolute end is rejected", () => {
    // R is rigid 200m; pinning its start to 2800 implies an end of 3000, beyond
    // the 2880 ceiling, so the span can't grow to fit and the move is rejected.
    const items = [li("R", { fixedDuration: 200 })];
    const r = resize.reinsertByValue(items, span, 0, "start", 2800);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blockerId).toBeNull();
  });
});
