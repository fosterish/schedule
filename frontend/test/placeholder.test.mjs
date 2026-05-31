import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchoredPlaceholderStartPatch,
  PLACEHOLDER_DURATION_DEFAULT,
} from "../src/components/placeholder.js";
import { solveInsertion } from "../src/components/insert_solver.js";

test("anchoredPlaceholderStartPatch: preserves span when start moves past old end", () => {
  const draft = {
    start_min: 100,
    end_min: 160,
    duration_target: PLACEHOLDER_DURATION_DEFAULT,
  };
  const patch = anchoredPlaceholderStartPatch(draft, 210);
  assert.equal(patch.start_min, 210);
  assert.equal(patch.end_min, 270);
  assert.equal(patch.end_min - patch.start_min, 60);
});

test("anchoredPlaceholderStartPatch: preserves user-edited duration", () => {
  const draft = { start_min: 500, end_min: 590, duration_target: 60 };
  const patch = anchoredPlaceholderStartPatch(draft, 600);
  assert.equal(patch.end_min - patch.start_min, 90);
});

test("solveInsertion: moved anchored start past fixed neighbour fits cleanly", () => {
  // Gaps [100..130] and [200..400] around fixed [130..200]; anchor at 100 overlaps it, then start moves to 210.
  const sched = { start_min: 0, end_min: 400 };
  const items = [
    {
      id: 1,
      position: 1,
      start_min: 130,
      end_min: 200,
      duration_target: 70,
      assigned_start: 130,
      assigned_end: 200,
    },
  ];
  const tightDraft = {
    _placeholder: true,
    start_min: 100,
    end_min: 160,
    duration_target: 60,
    color: "green",
    use_inline: true,
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
  };
  const overlap = solveInsertion({
    items,
    schedule: sched,
    draft: tightDraft,
    cursorMin: 100,
    allowRepositioning: false,
  });
  assert.equal(overlap.conflict, "overlap_fixed");

  const moved = {
    ...tightDraft,
    ...anchoredPlaceholderStartPatch(tightDraft, 210),
  };
  assert.equal(moved.end_min - moved.start_min, 60);

  const result = solveInsertion({
    items,
    schedule: sched,
    draft: moved,
    cursorMin: 100,
    allowRepositioning: false,
  });
  assert.equal(result.conflict, null);
});
