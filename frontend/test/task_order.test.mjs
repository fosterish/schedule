import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edgesFromDepsMap,
  partitionByCompletion,
  topoOrder,
  isOrderValid,
  dropConflictIds,
  reorderTargetIndex,
  reorderOps,
  wouldCreateCycle,
  hasCycle,
} from "../src/components/task_order.js";

// ---------- edgesFromDepsMap ----------

test("edgesFromDepsMap maps blocker→blocked and coerces keys to numbers", () => {
  // task 2 is blocked by 1; task 3 is blocked by 1 and 2.
  const edges = edgesFromDepsMap({ 2: [1], 3: [1, 2] });
  assert.deepEqual(edges, [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 3 },
  ]);
});

test("edgesFromDepsMap drops edges touching excluded (completed) ids", () => {
  // 1 blocks 2; 2 blocks 3. Exclude 2 (completed) → both edges vanish.
  const edges = edgesFromDepsMap({ 2: [1], 3: [2] }, (id) => id !== 2);
  assert.deepEqual(edges, []);
  // Excluding nothing keeps both.
  assert.equal(edgesFromDepsMap({ 2: [1], 3: [2] }).length, 2);
});

// ---------- partitionByCompletion ----------

test("partitionByCompletion sinks completed and preserves relative order", () => {
  const tasks = [
    { id: 1 },
    { id: 2, completed_at: "t" },
    { id: 3 },
    { id: 4, completed_at: "t" },
  ];
  const { incomplete, completed } = partitionByCompletion(tasks);
  assert.deepEqual(incomplete.map((t) => t.id), [1, 3]);
  assert.deepEqual(completed.map((t) => t.id), [2, 4]);
});

// ---------- topoOrder ----------

test("topoOrder leaves an already-valid order unchanged", () => {
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }];
  assert.deepEqual(topoOrder([1, 2, 3], edges), [1, 2, 3]);
});

test("topoOrder fixes a reversed chain", () => {
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }];
  // 3 before 2 before 1 → must become 1,2,3.
  assert.deepEqual(topoOrder([3, 2, 1], edges), [1, 2, 3]);
});

test("topoOrder handles a diamond (1→2, 1→3, 2→4, 3→4)", () => {
  const edges = [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 4 },
  ];
  const out = topoOrder([4, 3, 2, 1], edges);
  // 1 first, 4 last; 2 and 3 between in stable (earliest-available) order.
  assert.equal(out[0], 1);
  assert.equal(out[3], 4);
  assert.ok(out.indexOf(2) < out.indexOf(4));
  assert.ok(out.indexOf(3) < out.indexOf(4));
});

test("topoOrder drops the dependent below its blocker, keeping others stable", () => {
  // 5 blocks 1: earliest-available emits 2,3,4,5 then 1 — the dependent sinks below its blocker, others stable.
  const edges = [{ from: 5, to: 1 }];
  assert.deepEqual(topoOrder([1, 2, 3, 4, 5], edges), [2, 3, 4, 5, 1]);
});

// ---------- isOrderValid ----------

test("isOrderValid detects forward vs backward edges", () => {
  const edges = [{ from: 1, to: 2 }];
  assert.equal(isOrderValid([1, 2], edges), true);
  assert.equal(isOrderValid([2, 1], edges), false);
});

// ---------- dropConflictIds ----------

test("dropConflictIds flags a blocker sitting below the dragged dependent", () => {
  // 1 blocks 2. Order [2,1] → dragging 2 sits above its blocker 1.
  const edges = [{ from: 1, to: 2 }];
  assert.deepEqual(dropConflictIds([2, 1], 2, edges), [1]);
});

test("dropConflictIds flags a dependent sitting above the dragged blocker", () => {
  // 1 blocks 2. Order [2,1] → dragging 1 (blocker) sits below dependent 2.
  const edges = [{ from: 1, to: 2 }];
  assert.deepEqual(dropConflictIds([2, 1], 1, edges), [2]);
});

test("dropConflictIds returns empty for a valid placement", () => {
  const edges = [{ from: 1, to: 2 }];
  assert.deepEqual(dropConflictIds([1, 2], 2, edges), []);
});

// ---------- reorderTargetIndex ----------

test("reorderTargetIndex moves down past crossed midpoints", () => {
  const mids = [10, 30, 50, 70];
  // Dragging row 0 down, leading edge at 55 → crosses mids[1]=30, mids[2]=50.
  assert.equal(reorderTargetIndex(mids, 0, 55, 1), 2);
});

test("reorderTargetIndex moves up past crossed midpoints", () => {
  const mids = [10, 30, 50, 70];
  // Dragging row 3 up, leading edge at 25 → crosses mids[2]=50, mids[1]=30.
  assert.equal(reorderTargetIndex(mids, 3, 25, -1), 1);
});

test("reorderTargetIndex stays put when no midpoint crossed", () => {
  const mids = [10, 30, 50, 70];
  assert.equal(reorderTargetIndex(mids, 1, 35, 1), 1);
  assert.equal(reorderTargetIndex(mids, 1, 0, 0), 1);
});

// ---------- reorderOps ----------

test("reorderOps yields no ops for an unchanged order", () => {
  assert.deepEqual(reorderOps([1, 2, 3], [1, 2, 3]), []);
});

test("reorderOps moves a single displaced task after its predecessor", () => {
  // Move 3 to the front: [1,2,3] → [3,1,2].
  assert.deepEqual(reorderOps([1, 2, 3], [3, 1, 2]), [
    { id: 3, afterId: null },
  ]);
});

test("reorderOps places a moved task after the correct neighbor", () => {
  // [1,2,3,4] → [1,3,2,4]: 3 should follow 1.
  assert.deepEqual(reorderOps([1, 2, 3, 4], [1, 3, 2, 4]), [
    { id: 3, afterId: 1 },
  ]);
});

// ---------- wouldCreateCycle ----------

test("wouldCreateCycle catches a direct 2-cycle", () => {
  const edges = [{ from: 1, to: 2 }];
  // Adding 2→1 closes a loop.
  assert.equal(wouldCreateCycle(edges, { from: 2, to: 1 }), true);
});

test("wouldCreateCycle catches a transitive cycle", () => {
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }];
  // Adding 3→1 closes 1→2→3→1.
  assert.equal(wouldCreateCycle(edges, { from: 3, to: 1 }), true);
});

test("wouldCreateCycle allows a non-cycle edge", () => {
  const edges = [{ from: 1, to: 2 }];
  assert.equal(wouldCreateCycle(edges, { from: 2, to: 3 }), false);
});

test("wouldCreateCycle rejects a self-edge", () => {
  assert.equal(wouldCreateCycle([], { from: 1, to: 1 }), true);
});

// ---------- hasCycle ----------

test("hasCycle is false for a DAG and true for a loop", () => {
  assert.equal(hasCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }]), false);
  assert.equal(
    hasCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]),
    true
  );
});
