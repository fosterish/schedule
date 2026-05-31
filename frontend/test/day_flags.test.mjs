import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunningFlags } from "../src/components/day_flags.js";

// Mirrors the backend's mk_item; the flags helper only reads start/end_min and assigned_start/end.
function mkItem({ id, start_min, end_min, assigned_start, assigned_end }) {
  return {
    id,
    position: id,
    start_min: start_min == null ? null : start_min,
    end_min: end_min == null ? null : end_min,
    assigned_start,
    assigned_end,
  };
}

const sched = { start_min: 480, end_min: 720 };

test("no schedule → all disabled", () => {
  const flags = computeRunningFlags(null, [], 600);
  assert.equal(flags.play_enabled, false);
  assert.equal(flags.skip_enabled, false);
  assert.equal(flags.stop_enabled, false);
});

test("empty schedule with now before end → only play", () => {
  const flags = computeRunningFlags(sched, [], 600);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.skip_enabled, false);
  assert.equal(flags.stop_enabled, false);
});

test("before schedule start → only play", () => {
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 400);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.skip_enabled, false);
  assert.equal(flags.stop_enabled, false);
});

test("inside fully-dynamic item: play + stop, skip when next exists", () => {
  // Single item: skip disabled (no item after walk_back's result).
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 600);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);

  const items2 = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags2 = computeRunningFlags(sched, items2, 540);
  assert.equal(flags2.skip_enabled, true);
});

test("skip enabled mid-trailing-dynamic-block (3-item case)", () => {
  // A fixed, B fixed-start/dynamic-end, C dynamic, now inside C. walk_back idx=2→1, idx+1<len → skip enabled.
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 540, assigned_start: 480, assigned_end: 540 }),
    mkItem({ id: 2, start_min: 540, end_min: null, assigned_start: 540, assigned_end: 630 }),
    mkItem({ id: 3, start_min: null, end_min: null, assigned_start: 630, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 660);
  assert.equal(flags.skip_enabled, true);
});

test("post-stop pseudo-gap: not 'inside' the next item", () => {
  // prev.end_min == now AND next.start_min == null → gap branch fires.
  // Gap: prev_fixed_end exists, next_item_exists → all three enabled.
  const items = [
    mkItem({ id: 1, start_min: 540, end_min: 600, assigned_start: 540, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 600);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, true);
});

test("inside fully-fixed item: skip disabled when next item has fixed start", () => {
  // Skip would override both adjacent fixed anchors at `now`; stop/play stay enabled for deliberate overrides.
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 600, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: 600, end_min: 720, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 540);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);
});

test("inside fully-fixed item: skip enabled when next item has dynamic start", () => {
  // Fully-fixed item followed by dynamic-start item: skipping just sets the dynamic item's start to `now`.
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 600, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 540);
  assert.equal(flags.skip_enabled, true);
});

test("inside dynamic item: skip disabled when next item has fixed start", () => {
  // "Respect future fixed items" rule: skip disabled when the next item's start is anchored.
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: 600, end_min: 720, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 540);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);
});

test("inside dynamic item: skip disabled when fixed-start sentinel sits ahead", () => {
  // Rule only inspects the immediate successor; a fixed-start item further ahead doesn't trip it — skip stays enabled.
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 540 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 540, assigned_end: 600 }),
    mkItem({ id: 3, start_min: 600, end_min: 720, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 500);
  assert.equal(flags.skip_enabled, true);
});

test("gap branch: skip disabled when next item has fixed start", () => {
  // Skip would override the prev item's fixed end and next item's fixed start — disable.
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 540, assigned_start: 480, assigned_end: 540 }),
    mkItem({ id: 2, start_min: 600, end_min: 720, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 570);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);
});

test("after schedule end with fixed-end last item: stop only", () => {
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 720, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 800);
  assert.equal(flags.play_enabled, false);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);
});

test("after schedule end with dynamic-end last item: play+stop, skip iff block has >1", () => {
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 800);
  assert.equal(flags.play_enabled, true);
  assert.equal(flags.stop_enabled, true);
  assert.equal(flags.skip_enabled, false);

  const items2 = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags2 = computeRunningFlags(sched, items2, 800);
  assert.equal(flags2.skip_enabled, true);
});

// --- target item resolution (drives the timeline media-target badges) ---

test("targets null when disabled / no schedule / empty", () => {
  const none = computeRunningFlags(null, [], 600);
  assert.equal(none.play_target, null);
  assert.equal(none.skip_target, null);
  assert.equal(none.stop_target, null);

  const empty = computeRunningFlags(sched, [], 600);
  assert.equal(empty.play_target, null); // play_enabled but no item to target
  assert.equal(empty.stop_target, null);
});

test("before start: play targets first item", () => {
  const items = [
    mkItem({ id: 7, start_min: null, end_min: null, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 400);
  assert.equal(flags.play_target, 7);
  assert.equal(flags.stop_target, null);
  assert.equal(flags.skip_target, null);
});

test("inside dynamic block: play+stop target block-first, skip targets next", () => {
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 540);
  assert.equal(flags.play_target, 1);
  assert.equal(flags.stop_target, 1);
  assert.equal(flags.skip_target, 2);
});

test("inside fully-fixed item: play+stop target it, skip targets next", () => {
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 600, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 540);
  assert.equal(flags.play_target, 1);
  assert.equal(flags.stop_target, 1);
  assert.equal(flags.skip_target, 2);
});

test("gap branch: play+skip target next item, stop targets prev fixed-end item", () => {
  const items = [
    mkItem({ id: 1, start_min: 540, end_min: 600, assigned_start: 540, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 600);
  assert.equal(flags.play_target, 2);
  assert.equal(flags.stop_target, 1);
  assert.equal(flags.skip_target, 2);
});

test("3-item trailing block: skip targets the item after the block-first", () => {
  // A fixed, B fixed-start/dynamic-end, C dynamic; now inside C.
  const items = [
    mkItem({ id: 1, start_min: 480, end_min: 540, assigned_start: 480, assigned_end: 540 }),
    mkItem({ id: 2, start_min: 540, end_min: null, assigned_start: 540, assigned_end: 630 }),
    mkItem({ id: 3, start_min: null, end_min: null, assigned_start: 630, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 660);
  assert.equal(flags.play_target, 2);
  assert.equal(flags.stop_target, 2);
  assert.equal(flags.skip_target, 3);
});

test("after end, dynamic last block of 2: play+stop target first, skip targets next", () => {
  const items = [
    mkItem({ id: 1, start_min: null, end_min: null, assigned_start: 480, assigned_end: 600 }),
    mkItem({ id: 2, start_min: null, end_min: null, assigned_start: 600, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 800);
  assert.equal(flags.play_target, 1);
  assert.equal(flags.stop_target, 1);
  assert.equal(flags.skip_target, 2);
});

test("after end, fixed-end last item: stop targets last item", () => {
  const items = [
    mkItem({ id: 9, start_min: 480, end_min: 720, assigned_start: 480, assigned_end: 720 }),
  ];
  const flags = computeRunningFlags(sched, items, 800);
  assert.equal(flags.stop_target, 9);
  assert.equal(flags.play_target, null);
  assert.equal(flags.skip_target, null);
});
