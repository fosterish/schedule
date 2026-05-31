import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyFilter } from "../src/components/fuzzy.js";

// Item shape mirrors the projects list, but the helper is generic — getText selects the column.
const items = [
  { id: 1, name: "Garden" },
  { id: 2, name: "Game dev" },
  { id: 3, name: "Grocery" },
  { id: 4, name: "Daily writing" },
  { id: 5, name: "Doc edit" },
];
const getName = (it) => it.name;
const names = (rs) => rs.map((x) => x.name);

test("empty query returns the input unchanged (same reference)", () => {
  const out = fuzzyFilter(items, "", getName);
  assert.equal(out, items);
});

test("whitespace-only query is treated as empty", () => {
  const out = fuzzyFilter(items, "   \t  ", getName);
  assert.equal(out, items);
});

test("non-matching items are excluded", () => {
  const out = fuzzyFilter(items, "zzz", getName);
  assert.deepEqual(out, []);
});

test("subsequence match with no adjacency still surfaces", () => {
  // "dw" matches "Daily writing" as a scatter — no fixture item contains "dw" contiguously.
  const out = fuzzyFilter(items, "dw", getName);
  assert.deepEqual(names(out), ["Daily writing"]);
});

test("case-insensitive on both sides", () => {
  const out = fuzzyFilter(items, "GARDEN", getName);
  assert.deepEqual(names(out), ["Garden"]);
});

test("stable order on ties", () => {
  // Identical score and first-match index → ties must fall back on original order (stable sort).
  const local = [
    { name: "alpha" },
    { name: "alphabet" },
    { name: "alpha go" },
  ];
  const out = fuzzyFilter(local, "alpha", getName);
  assert.deepEqual(names(out), ["alpha", "alphabet", "alpha go"]);
});

test("contiguous run beats scattered match on score", () => {
  // Construct a pair where the only differentiator is contiguity:
  //   "abc" vs "aXbXc" for query "abc"
  const local = [{ name: "aXbXc" }, { name: "abc" }];
  const out = fuzzyFilter(local, "abc", getName);
  assert.equal(out[0].name, "abc");
  assert.equal(out[1].name, "aXbXc");
});

test("early prefix outranks late prefix on otherwise equal contiguous matches", () => {
  // Both contain "cat" contiguously; the earlier occurrence wins via
  // the first-match-index penalty.
  const local = [{ name: "old cat" }, { name: "cat" }];
  const out = fuzzyFilter(local, "cat", getName);
  assert.equal(out[0].name, "cat");
  assert.equal(out[1].name, "old cat");
});

test("getText returning null/undefined is treated as empty (no match)", () => {
  const local = [{ name: null }, { name: "alpha" }];
  const out = fuzzyFilter(local, "al", getName);
  assert.deepEqual(names(out), ["alpha"]);
});
