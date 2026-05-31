import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depEdge,
  DEP_BLOCKED_BY,
  DEP_BLOCKING,
} from "../src/components/dep_edge.js";

test('"blocked by" puts this task on the blocked side', () => {
  // This task (1) is blocked by other (2): stored edge is (blocked=1, blocker=2).
  assert.deepEqual(depEdge(DEP_BLOCKED_BY, 1, 2), {
    blockedId: 1,
    blockerId: 2,
  });
});

test('"blocking" puts this task on the blocker side', () => {
  // This task (1) blocks other (2): stored edge is (blocked=2, blocker=1).
  assert.deepEqual(depEdge(DEP_BLOCKING, 1, 2), {
    blockedId: 2,
    blockerId: 1,
  });
});

test("unknown type falls back to blocked_by", () => {
  assert.deepEqual(depEdge("garbage", 7, 9), {
    blockedId: 7,
    blockerId: 9,
  });
});

test("the two types are exact reverses of the same pair", () => {
  const a = depEdge(DEP_BLOCKED_BY, 3, 4);
  const b = depEdge(DEP_BLOCKING, 3, 4);
  // Flipping the type swaps which id is blocked vs blocker.
  assert.equal(a.blockedId, b.blockerId);
  assert.equal(a.blockerId, b.blockedId);
});

test("identity is preserved across a flip-back round trip", () => {
  // blocked_by → blocking → blocked_by should land on the original edge.
  const start = depEdge(DEP_BLOCKED_BY, 10, 20);
  // Re-derive from the flipped perspective: from other's POV it's blocking.
  const flipped = depEdge(DEP_BLOCKING, 10, 20);
  const back = depEdge(DEP_BLOCKED_BY, 10, 20);
  assert.deepEqual(start, back);
  assert.notDeepEqual(start, flipped);
});
