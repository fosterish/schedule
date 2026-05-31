// Pins `classifyLayout`'s own API contract; integration paths are covered by insert_solver and reorder tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLayout, computeLayout } from "../src/components/layout.js";

test("feasible layout: feasible=true, reason=null, no fatal indices", () => {
  const sched = { start_min: 480, end_min: 720 };
  const items = [
    { id: 1, position: 1, start_min: null, end_min: null, duration_target: 60 },
    { id: 2, position: 2, start_min: null, end_min: null, duration_target: 60 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, true);
  assert.equal(c.reason, null);
  assert.deepEqual(c.fatalIndices, []);
});

test("below_min: schedule too tight for the items it carries", () => {
  // Segment-level BelowMinDuration: proportional-floor fallback may avoid per-item flags, but the segment signal surfaces.
  const sched = { start_min: 0, end_min: 2 };
  const items = [
    { id: 1, position: 1, start_min: null, end_min: null, duration_target: 60 },
    { id: 2, position: 2, start_min: null, end_min: null, duration_target: 60 },
    { id: 3, position: 3, start_min: null, end_min: null, duration_target: 60 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, false);
  assert.equal(c.reason, "below_min");
});

test("fatalIndices collects per-item below_min flags", () => {
  // An interval shorter than MIN_DURATION (=1) trips `flags.below_min`, which `fatalIndices` surfaces directly.
  const sched = { start_min: 480, end_min: 720 };
  const items = [
    // start == end → 0-min span, flagged below_min.
    { id: 1, position: 1, start_min: 500, end_min: 500, duration_target: 1 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, false);
  assert.deepEqual(c.fatalIndices, [0]);
});

test("out_of_bounds: a fixed anchor falls outside the schedule window", () => {
  const sched = { start_min: 480, end_min: 720 };
  const items = [
    { id: 1, position: 1, start_min: 100, end_min: 200, duration_target: 100 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, false);
  assert.equal(c.reason, "out_of_bounds");
  assert.deepEqual(c.fatalIndices, [0]);
});

test("anchor_conflict: two fixed items in inverted order", () => {
  const sched = { start_min: 0, end_min: 1000 };
  const items = [
    // Earlier position anchored LATER than the next item's anchor.
    { id: 1, position: 1, start_min: 600, end_min: 700, duration_target: 100 },
    { id: 2, position: 2, start_min: 300, end_min: 400, duration_target: 100 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, false);
  assert.equal(c.reason, "anchor_conflict");
});

test("precedence: out_of_bounds wins over below_min when both trip", () => {
  // 1-min window with a fixed item poking outside it AND a dynamic companion flagged below_min.
  const sched = { start_min: 480, end_min: 481 };
  const items = [
    { id: 1, position: 1, start_min: 100, end_min: 200, duration_target: 100 },
    { id: 2, position: 2, start_min: null, end_min: null, duration_target: 60 },
  ];
  const layout = computeLayout(sched, items);
  const c = classifyLayout(layout);
  assert.equal(c.feasible, false);
  assert.equal(
    c.reason,
    "out_of_bounds",
    "out_of_bounds outranks below_min when both signals trip"
  );
});

test("classifier tolerates missing fields gracefully", () => {
  // Defensive: a hand-rolled layout with no errors/items must classify feasible (guards call sites synthesising fake layouts).
  const c = classifyLayout({ items: [], errors: [] });
  assert.equal(c.feasible, true);
  assert.equal(c.reason, null);
  assert.deepEqual(c.fatalIndices, []);
});
