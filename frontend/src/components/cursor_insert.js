// Pure cursor helpers, kept separate from TimeCursor so Node tests can import without resolving mithril.

// Returns cursorMin only when the user explicitly placed it (non-null and not equal to live nowMin), else null.
export function explicitCursorMin(cursorMin, nowMin) {
  if (cursorMin == null) return null;
  if (cursorMin === nowMin) return null;
  return cursorMin;
}

// Compute insertion target: undefined=append, null=head, numeric id=after that item; inside an item picks the nearer edge.
export function cursorInsertionAfterId(cursorMin, items) {
  if (cursorMin == null) return undefined;
  if (!items || items.length === 0) return undefined;
  if (cursorMin <= items[0].assigned_start) {
    // Equality (cursor exactly at first start) also collapses to head insert.
    return null;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (cursorMin >= it.assigned_start && cursorMin < it.assigned_end) {
      const mid = (it.assigned_start + it.assigned_end) / 2;
      if (cursorMin < mid) {
        return i === 0 ? null : items[i - 1].id;
      }
      return it.id;
    }
    if (
      cursorMin >= it.assigned_end &&
      (i + 1 >= items.length || cursorMin < items[i + 1].assigned_start)
    ) {
      return it.id;
    }
  }
  return undefined;
}
