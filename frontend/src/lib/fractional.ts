import { generateJitteredKeyBetween } from "fractional-indexing-jittered";

import type { OrderKey } from "@bindings/OrderKey";

// Lexicographic order key strictly between left and right (null = list end).
// Jittered so concurrent offline inserts into the same gap don't collide.
export function keyBetween(
  left: OrderKey | null,
  right: OrderKey | null,
): OrderKey {
  return generateJitteredKeyBetween(left, right);
}
