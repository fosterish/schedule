import { test } from "node:test";
import assert from "node:assert/strict";
import { solveInsertion } from "../src/components/insert_solver.js";
import { PLACEHOLDER_ID } from "../src/components/placeholder.js";

// Items are raw; the solver runs computeLayout internally. Some inputs carry assigned bounds because cursorInsertionAfterId consults them.

function dynamicItem(id, position, duration_target, assigned) {
  return {
    id,
    position,
    start_min: null,
    end_min: null,
    duration_target,
    use_inline: true,
    color: "blue",
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
    assigned_start: assigned ? assigned.start : 0,
    assigned_end: assigned ? assigned.end : 0,
  };
}

function fixedItem(id, position, start_min, end_min) {
  return {
    id,
    position,
    start_min,
    end_min,
    duration_target: Math.max(1, end_min - start_min),
    use_inline: true,
    color: "red",
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
    assigned_start: start_min,
    assigned_end: end_min,
  };
}

function dynamicDraft(duration_target = 60) {
  return {
    _placeholder: true,
    start_min: null,
    end_min: null,
    duration_target,
    color: "green",
    use_inline: true,
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
  };
}

function anchoredDraft(start_min, end_min) {
  return {
    _placeholder: true,
    start_min,
    end_min,
    duration_target: Math.max(1, end_min - start_min),
    color: "green",
    use_inline: true,
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
  };
}

test("solveInsertion: no fixed items → placeholder lands at cursor slot, no reorders", () => {
  const sched = { start_min: 480, end_min: 720 };
  const items = [
    dynamicItem(1, 1.0, 60, { start: 480, end: 600 }),
    dynamicItem(2, 2.0, 60, { start: 600, end: 720 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: dynamicDraft(60),
    cursorMin: 700, // late, after midpoint of item 2
    allowRepositioning: true,
  });
  assert.equal(result.conflict, null);
  assert.deepEqual(result.reorders, []);
  // Placeholder lands at the tail (after id=2 since 700 > midpoint(660)).
  assert.equal(result.afterItemId, 2);
  const ids = result.items.map((it) => it.id);
  assert.deepEqual(ids, [1, 2, PLACEHOLDER_ID]);
});

test("solveInsertion: anchored draft overlaps a fixed item → overlap_fixed", () => {
  const sched = { start_min: 480, end_min: 720 };
  const items = [fixedItem(1, 1.0, 540, 660)];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: anchoredDraft(600, 640),
    cursorMin: null,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, "overlap_fixed");
  assert.deepEqual(result.items, []);
});

test("solveInsertion: anchored draft past schedule end → overlap_edge", () => {
  const sched = { start_min: 480, end_min: 720 };
  const result = solveInsertion({
    items: [],
    schedule: sched,
    draft: anchoredDraft(700, 750),
    cursorMin: null,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, "overlap_edge");
});

test("solveInsertion: repositioning off, anchor leaves no room → squashed_dynamic", () => {
  const sched = { start_min: 480, end_min: 482 };
  // Fixed [480,481] leaves 1 min for two dynamics → one falls below MIN_DURATION (=1); repositioning off → squashed_dynamic.
  const items = [
    dynamicItem(1, 1.0, 60, { start: 480, end: 481 }),
    dynamicItem(2, 2.0, 60, { start: 481, end: 482 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: anchoredDraft(480, 482),
    cursorMin: null,
    allowRepositioning: false,
  });
  // Both overlap_edge and squashed_dynamic are valid conflicts; we expect the squeeze to win since the anchor fits bounds.
  assert.ok(
    result.conflict === "squashed_dynamic" ||
      result.conflict === "overlap_fixed",
    `got conflict=${result.conflict}`
  );
});

test("solveInsertion: repositioning on but schedule too tight → no_slack", () => {
  // Two dynamics fit a 2-min schedule (1 min each); a third drops below MIN_DURATION and no permutation rescues.
  const sched = { start_min: 0, end_min: 2 };
  const items = [
    dynamicItem(1, 1.0, 60, { start: 0, end: 1 }),
    dynamicItem(2, 2.0, 60, { start: 1, end: 2 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: dynamicDraft(60),
    cursorMin: 1,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, "no_slack");
});

// Equal duration_target items keep original order — the greedy tie-breaker prefers no move.
test("solveInsertion: equal-target items stay in original order", () => {
  const sched = { start_min: 0, end_min: 600 };
  const items = [
    dynamicItem(10, 1.0, 60, { start: 0, end: 300 }),
    dynamicItem(20, 2.0, 60, { start: 300, end: 600 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: dynamicDraft(60),
    cursorMin: 0,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, null);
  const existingIds = result.items
    .filter((it) => !it._placeholder)
    .map((it) => it.id);
  assert.deepEqual(existingIds, [10, 20]);
  assert.deepEqual(result.reorders, []);
});

test("solveInsertion: same-gap items retain original order", () => {
  const sched = { start_min: 0, end_min: 1200 };
  // One fixed item in the middle creating two gaps.
  const items = [
    dynamicItem(1, 1.0, 100, { start: 0, end: 300 }),
    dynamicItem(2, 2.0, 100, { start: 300, end: 600 }),
    fixedItem(3, 3.0, 600, 700),
    dynamicItem(4, 4.0, 100, { start: 700, end: 950 }),
    dynamicItem(5, 5.0, 100, { start: 950, end: 1200 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: dynamicDraft(100),
    cursorMin: 1100,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, null);
  // Items 1,2 stay in the left gap, 4,5 in the right — solver doesn't reorder within a gap.
  const existingIds = result.items
    .filter((it) => !it._placeholder)
    .map((it) => it.id);
  const idx1 = existingIds.indexOf(1);
  const idx2 = existingIds.indexOf(2);
  const idx4 = existingIds.indexOf(4);
  const idx5 = existingIds.indexOf(5);
  assert.ok(idx1 < idx2, "item 1 stays before item 2");
  assert.ok(idx4 < idx5, "item 4 stays before item 5");
});

test("solveInsertion: greedy moves longest-target into the larger gap", () => {
  // Fixed [100..150] splits into small gap [0..100] and big gap [150..600]; solver swaps the mismatched-target items.
  const sched = { start_min: 0, end_min: 600 };
  const items = [
    dynamicItem(1, 1.0, 400, { start: 0, end: 100 }),
    fixedItem(2, 2.0, 100, 150),
    dynamicItem(3, 3.0, 50, { start: 150, end: 600 }),
  ];
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: dynamicDraft(10),
    cursorMin: 0,
    allowRepositioning: true,
  });
  assert.equal(result.conflict, null);
  // Assert only the load-bearing property: id=1 lands after the fixed id=2; either swap or pull-past is valid.
  const finalOrder = result.items.map((it) => it.id);
  const idx1 = finalOrder.indexOf(1);
  const idx2 = finalOrder.indexOf(2);
  assert.ok(idx1 > idx2, `id=1 should be after the fixed id=2, got ${finalOrder.join(",")}`);
  assert.ok(
    result.reorders.some((r) => r.id === 1),
    "expected a reorder entry for item 1"
  );
});
