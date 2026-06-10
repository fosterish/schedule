import { describe, expect, test } from "vitest";

import type { OrderKey } from "@bindings/OrderKey";
import { keyBetween } from "@lib/fractional";

describe("keyBetween", () => {
  test("first key, then appends and prepends keep ordering", () => {
    const a = keyBetween(null, null);
    const afterA = keyBetween(a, null);
    const beforeA = keyBetween(null, a);
    expect(beforeA < a).toBe(true);
    expect(a < afterA).toBe(true);
  });

  test("lands strictly between two neighbors", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });

  test("repeated splitting of the same gap stays ordered", () => {
    let left = keyBetween(null, null);
    const right = keyBetween(left, null);
    for (let i = 0; i < 50; i++) {
      const next = keyBetween(left, right);
      expect(left < next && next < right).toBe(true);
      left = next;
    }
  });

  test("a long append/prepend run preserves total order", () => {
    const keys: OrderKey[] = [];
    let k: OrderKey | null = null;
    for (let i = 0; i < 100; i++) {
      k = keyBetween(k, null);
      keys.push(k);
    }
    const sorted = [...keys].sort();
    expect(sorted).toEqual(keys);
  });

  test("jitter makes same-gap inserts collision-resistant", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(keyBetween(a, b));
    expect(seen.size).toBeGreaterThan(90);
    for (const k of seen) expect(a < k && k < b).toBe(true);
  });
});
