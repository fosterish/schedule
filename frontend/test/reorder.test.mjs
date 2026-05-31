// Pure reorder math: each (grabbed_edge, target_edge) combination plus the both-bounds-fixed reject rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../src/components/layout.js";
import { computeReorderPreview } from "../src/components/reorder.js";

function mk(id, start_min, end_min, duration_target = 60) {
  return {
    id,
    position: id,
    start_min,
    end_min,
    duration_target,
    use_inline: true,
    inline_label: `item ${id}`,
    inline_description: null,
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
  };
}

function layoutOf(schedule, items) {
  const lo = computeLayout(schedule, items);
  return lo.items;
}

// =============================================================================
// Trigger semantics: leading edge of ghost crosses midpoint of a different item
// =============================================================================

test("no reorder when leading edge has not crossed any midpoint", () => {
  const schedule = { start_min: 480, end_min: 720 }; // 8:00–12:00
  const items = [mk(1, null, null), mk(2, null, null)];
  const laid = layoutOf(schedule, items);
  // Item 2 midpoint = 660; ghost bottom (leading) = 630 < 660, so no crossing.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 510,
    ghostBottomMin: 630,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, false);
  assert.equal(r.newAfterId, null);
});

test("reorder triggers when leading edge crosses target midpoint", () => {
  const schedule = { start_min: 480, end_min: 720 };
  const items = [mk(1, null, null), mk(2, null, null)];
  const laid = layoutOf(schedule, items);
  // Leading edge (ghost bottom) past item 2 midpoint = 660.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 555,
    ghostBottomMin: 675,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  assert.equal(r.newAfterId, 2);
  assert.deepEqual(
    r.reorderedRawItems.map((it) => it.id),
    [2, 1]
  );
});

test("farthest crossed midpoint becomes the target", () => {
  const schedule = { start_min: 480, end_min: 840 }; // 6 hours
  const items = [mk(1, null, null), mk(2, null, null), mk(3, null, null)];
  const laid = layoutOf(schedule, items);
  // Midpoints 540/660/780; ghost bottom 800 passes both 660 and 780.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 680,
    ghostBottomMin: 800,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  assert.equal(r.newAfterId, 3);
  assert.deepEqual(
    r.reorderedRawItems.map((it) => it.id),
    [2, 3, 1]
  );
});

// =============================================================================
// Dynamic grabbed, dynamic target edge — pure positional reorder, no anchor
// changes (fully dynamic grabbed)
// =============================================================================

test("fully dynamic grabbed past dynamic target: position-only reorder", () => {
  const schedule = { start_min: 480, end_min: 720 };
  const items = [mk(1, null, null), mk(2, null, null)];
  const laid = layoutOf(schedule, items);
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 555,
    ghostBottomMin: 675,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.anchorUpdates, []);
  // After reorder both items still occupy the full window (split in two).
  assert.equal(r.layout.items[0].assigned_start, 480);
  assert.equal(r.layout.items[1].assigned_end, 720);
});

// =============================================================================
// Dynamic grabbed (trailing fixed), dynamic target edge:
// grabbed.trailing_edge = target_edge (current minute).
// =============================================================================

test("trailing-fixed dynamic grabbed past dynamic target: anchor at target edge", () => {
  // Drag A down past B: trailing edge is A's fixed start, target edge dynamic → A.start_min = B.end (760).
  const schedule = { start_min: 480, end_min: 900 };
  const items = [mk(1, 480, null), mk(2, null, null), mk(3, null, 900)];
  const laid = layoutOf(schedule, items);
  // Midpoint of B = 690. Ghost bottom past 690.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 580,
    ghostBottomMin: 700,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  assert.equal(r.allowed, true, `expected allowed; got reason=${r.reason}`);
  const a = r.reorderedRawItems.find((it) => it.id === 1);
  assert.equal(a.start_min, 760, "A.start_min at target edge");
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 1 && u.start_min === 760),
    `expected start_min=760 update, got ${JSON.stringify(r.anchorUpdates)}`
  );
});

// =============================================================================
// Dynamic grabbed (leading fixed), fixed target edge — uses min(dur, gap)
// =============================================================================

test("leading-fixed dynamic grabbed past fixed target edge: leading = target_edge + min(dur, gap)", () => {
  // Drag G down past fixed T: leading edge = end_min = T.end + min(grabbed_dur, gap=660).
  const schedule = { start_min: 480, end_min: 1320 };
  const G = mk(1, null, 540, 60);
  const T = mk(2, 600, 660);
  const tail = mk(3, null, null);
  const items = [G, T, tail];
  const laid = layoutOf(schedule, items);
  // T midpoint 630, tail midpoint 990; ghost bottom 650 crosses T only.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 530,
    ghostBottomMin: 650,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true, "reorder triggered");
  // Leading edge end_min = target_edge + min(grabbed_dur, gap); grabbed_dur is G's pre-drag size.
  const g = r.reorderedRawItems.find((it) => it.id === 1);
  const grabbedDur = laid[0].assigned_end - laid[0].assigned_start;
  const expectedEnd = 660 + Math.min(grabbedDur, 660);
  assert.equal(
    g.end_min,
    expectedEnd,
    `G.end_min should be ${expectedEnd}, got ${g.end_min}`
  );
});

// =============================================================================
// Fixed grabbed past fixed target edge — target shifts opposite of travel
// =============================================================================

test("fixed-grabbed past fully fixed target shifts target opposite of travel", () => {
  // Drag B up past A: A shifts down by B.duration → A=[540,600], B=[480,540].
  const schedule = { start_min: 480, end_min: 720 };
  const A = mk(1, 480, 540);
  const B = mk(2, 600, 660);
  const items = [A, B];
  const laid = layoutOf(schedule, items);
  // Drag B up; ghost top 500 < A midpoint 510. B fully fixed so height stays 60 → bottom 560.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 2,
    ghostTopMin: 500,
    ghostBottomMin: 560,
    dirSign: -1,
  });
  assert.equal(r.hasReorder, true);
  const b = r.reorderedRawItems.find((it) => it.id === 2);
  const a = r.reorderedRawItems.find((it) => it.id === 1);
  assert.equal(b.start_min, 480, "B.start_min");
  assert.equal(b.end_min, 540, "B.end_min");
  assert.equal(a.start_min, 540, "A.start_min shifted down by B.duration");
  assert.equal(a.end_min, 600, "A.end_min shifted down by B.duration");
  assert.ok(r.anchorUpdates.some((u) => u.id === 1 && u.start_min === 540));
  assert.ok(r.anchorUpdates.some((u) => u.id === 2 && u.start_min === 480));
});

test("fixed-grabbed past fully fixed target drops into gap on other side when there's room", () => {
  // Gap past B (720-660=60) equals grabbed_dur → "drop on other side" branch: A→[660,720], B undisturbed.
  const schedule = { start_min: 480, end_min: 720 };
  const A = mk(1, 480, 540);
  const B = mk(2, 600, 660);
  const items = [A, B];
  const laid = layoutOf(schedule, items);
  // Drag A DOWN. Ghost bottom past B midpoint = 630.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 590,
    ghostBottomMin: 650,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  const a = r.reorderedRawItems.find((it) => it.id === 1);
  const b = r.reorderedRawItems.find((it) => it.id === 2);
  assert.equal(b.start_min, 600, "B.start_min unchanged");
  assert.equal(b.end_min, 660, "B.end_min unchanged");
  assert.equal(a.start_min, 660, "A.start_min adjacent to B.end");
  assert.equal(a.end_min, 720, "A.end_min = A.start + duration");
  assert.ok(
    !r.anchorUpdates.some((u) => u.id === 2),
    `expected no anchor update for B, got ${JSON.stringify(r.anchorUpdates)}`
  );
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 1 && u.start_min === 660 && u.end_min === 720),
    `expected A anchor update with start=660 end=720, got ${JSON.stringify(r.anchorUpdates)}`
  );
});

test("fixed-grabbed past fully fixed target falls back to shifting target when there's no room on the other side (dragging down)", () => {
  // No free minutes past B (schedule ends 660) → fallback shifts B up to [540,600], A→[600,660].
  const schedule = { start_min: 480, end_min: 660 };
  const A = mk(1, 480, 540);
  const B = mk(2, 600, 660);
  const items = [A, B];
  const laid = layoutOf(schedule, items);
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 590,
    ghostBottomMin: 650,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  const a = r.reorderedRawItems.find((it) => it.id === 1);
  const b = r.reorderedRawItems.find((it) => it.id === 2);
  assert.equal(b.start_min, 540, "B.start_min shifted up");
  assert.equal(b.end_min, 600, "B.end_min shifted up");
  assert.equal(a.start_min, 600, "A.start_min at new B.end");
  assert.equal(a.end_min, 660, "A.end_min = start + duration");
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 2 && u.start_min === 540 && u.end_min === 600),
    `expected B shift update, got ${JSON.stringify(r.anchorUpdates)}`
  );
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 1 && u.start_min === 600 && u.end_min === 660),
    `expected A anchor update, got ${JSON.stringify(r.anchorUpdates)}`
  );
});

test("fixed-grabbed past fully fixed target falls back to shifting target when gap is partial", () => {
  // Only 40 min past B (< grabbed_dur 60) → fallback still engages: B up to [540,600], A→[600,660].
  const schedule = { start_min: 480, end_min: 700 };
  const A = mk(1, 480, 540);
  const B = mk(2, 600, 660);
  const items = [A, B];
  const laid = layoutOf(schedule, items);
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 1,
    ghostTopMin: 590,
    ghostBottomMin: 650,
    dirSign: +1,
  });
  assert.equal(r.hasReorder, true);
  const a = r.reorderedRawItems.find((it) => it.id === 1);
  const b = r.reorderedRawItems.find((it) => it.id === 2);
  assert.equal(b.start_min, 540, "B.start_min shifted up");
  assert.equal(b.end_min, 600, "B.end_min shifted up");
  assert.equal(a.start_min, 600, "A.start_min at new B.end");
  assert.equal(a.end_min, 660, "A.end_min = start + duration");
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 2 && u.start_min === 540 && u.end_min === 600),
    `expected B shift update, got ${JSON.stringify(r.anchorUpdates)}`
  );
  assert.ok(
    r.anchorUpdates.some((u) => u.id === 1 && u.start_min === 600 && u.end_min === 660),
    `expected A anchor update, got ${JSON.stringify(r.anchorUpdates)}`
  );
});

// =============================================================================
// Fixed grabbed past dynamic target edge — leading edge at current target_edge
// =============================================================================

test("fixed-grabbed past dynamic target edge: leading edge at current target_edge", () => {
  // Drag fixed G up past dynamic T: leading edge lands at T's start (480) → G=[480,540], T reflows.
  const schedule = { start_min: 480, end_min: 720 };
  const T = mk(1, null, null);
  const G = mk(2, 600, 660);
  const items = [T, G];
  const laid = layoutOf(schedule, items);
  // T midpoint 540; drag G up so ghost top (500) crosses it.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 2,
    ghostTopMin: 500,
    ghostBottomMin: 560,
    dirSign: -1,
  });
  assert.equal(r.hasReorder, true);
  const g = r.reorderedRawItems.find((it) => it.id === 2);
  assert.equal(g.start_min, 480, "G.start_min at T's pre-drag top");
  assert.equal(g.end_min, 540, "G.end_min = G.start + G.duration");
});

// =============================================================================
// Two fixed edges with zero usable room → reject (dynamic grabbed)
// =============================================================================

test("dynamic grabbed rejected when slot has both fixed bounds and no room", () => {
  // A [480,540], B [540,600] back-to-back; C dynamic can't fit between them — both bounds fixed, gap 0 → reject.
  const schedule = { start_min: 480, end_min: 720 };
  const A = mk(1, 480, 540);
  const B = mk(2, 540, 600);
  const C = mk(3, null, null);
  const items = [A, B, C];
  const laid = layoutOf(schedule, items);
  // B midpoint 570; drag C up so ghost top (520) crosses it.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 3,
    ghostTopMin: 520,
    ghostBottomMin: 640,
    dirSign: -1,
  });
  assert.equal(r.allowed, false, "rejected (two fixed edges, no room)");
  assert.equal(r.hasReorder, false, "no preview commit");
});

// =============================================================================
// Two fixed edges WITH room → allowed (dynamic grabbed slots in)
// =============================================================================

test("dynamic grabbed allowed between two fixed edges with room", () => {
  // A [480,540], B [660,720] with a big gap; drag C up past B → C lands between them.
  const schedule = { start_min: 480, end_min: 800 };
  const A = mk(1, 480, 540);
  const B = mk(2, 660, 720);
  const C = mk(3, null, null);
  const items = [A, B, C];
  const laid = layoutOf(schedule, items);
  // B midpoint 690; drag C up so ghost top (650) crosses it.
  const r = computeReorderPreview({
    schedule,
    items,
    laidOut: laid,
    draggedId: 3,
    ghostTopMin: 650,
    ghostBottomMin: 730,
    dirSign: -1,
  });
  assert.equal(r.allowed, true, `allowed when there's room (reason=${r.reason})`);
  assert.equal(r.hasReorder, true);
  // C is fully dynamic — no anchor updates. Layout reflows around fixed edges.
  assert.deepEqual(r.anchorUpdates, []);
  assert.deepEqual(
    r.reorderedRawItems.map((it) => it.id),
    [1, 3, 2]
  );
});
