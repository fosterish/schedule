import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cursorInsertionAfterId,
  explicitCursorMin,
} from "../src/components/cursor_insert.js";

// Three contiguous items laid out 480..720, no gaps.
const items = [
  { id: 11, assigned_start: 480, assigned_end: 560 },
  { id: 22, assigned_start: 560, assigned_end: 640 },
  { id: 33, assigned_start: 640, assigned_end: 720 },
];

test("null cursor → undefined (tail / append)", () => {
  assert.equal(cursorInsertionAfterId(null, items), undefined);
});

test("empty items → undefined", () => {
  assert.equal(cursorInsertionAfterId(600, []), undefined);
});

test("cursor before first item → head (null)", () => {
  assert.equal(cursorInsertionAfterId(400, items), null);
});

test("cursor at the first item's start is treated as head", () => {
  assert.equal(cursorInsertionAfterId(480, items), null);
});

test("cursor inside first item, closer to start → head (null)", () => {
  assert.equal(cursorInsertionAfterId(500, items), null);
});

test("cursor inside an item, closer to end → after that item", () => {
  assert.equal(cursorInsertionAfterId(620, items), 22);
});

test("cursor inside middle item, closer to start → after previous item", () => {
  assert.equal(cursorInsertionAfterId(570, items), 11);
});

test("cursor at exact midpoint → after this item (tie → 'after')", () => {
  assert.equal(cursorInsertionAfterId(600, items), 22);
});

test("cursor past last item → after the last item (tail)", () => {
  assert.equal(cursorInsertionAfterId(800, items), 33);
});

test("cursor in a gap between items → after the preceding item", () => {
  const gapItems = [
    { id: 11, assigned_start: 480, assigned_end: 540 },
    { id: 22, assigned_start: 600, assigned_end: 660 },
  ];
  assert.equal(cursorInsertionAfterId(570, gapItems), 11);
});

// explicitCursorMin distinguishes a deliberate cursor from today's live default; the latter collapses to null for end-of-schedule fallback.
test("explicitCursorMin: null cursor → null", () => {
  assert.equal(explicitCursorMin(null, 600), null);
});

test("explicitCursorMin: cursor equal to nowMin → null (live default)", () => {
  assert.equal(explicitCursorMin(600, 600), null);
});

test("explicitCursorMin: cursor distinct from nowMin → passes through", () => {
  assert.equal(explicitCursorMin(700, 600), 700);
});

test("explicitCursorMin: non-null cursor with null nowMin → passes through", () => {
  // Defensive: a transient null nowMin shouldn't suppress an otherwise-explicit cursor.
  assert.equal(explicitCursorMin(600, null), 600);
});
