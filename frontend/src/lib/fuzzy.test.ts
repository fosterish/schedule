import { describe, expect, it } from "vitest";

import { fuzzyFilter } from "./fuzzy";

const names = (s: string[]) => s.map((name) => ({ name }));
const text = (x: { name: string }) => x.name;

describe("fuzzyFilter", () => {
  it("returns items unchanged for an empty query", () => {
    const items = names(["beta", "alpha"]);
    expect(fuzzyFilter(items, "  ", text)).toBe(items);
  });

  it("keeps only subsequence matches", () => {
    const out = fuzzyFilter(names(["alpha", "beta", "gamma"]), "aa", text);
    expect(out.map(text)).toEqual(["alpha", "gamma"]);
  });

  it("ranks adjacency and earliness higher", () => {
    const out = fuzzyFilter(names(["abxc", "abc", "xxabc"]), "abc", text);
    expect(out.map(text)).toEqual(["abc", "xxabc", "abxc"]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyFilter(names(["Hello"]), "hl", text).map(text)).toEqual(["Hello"]);
  });
});
