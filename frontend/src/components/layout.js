/** Layout algorithm; JS port that must stay in sync with backend/src/resolve.rs::compute_layout (golden corpus verifies parity). */

export const MIN_DURATION = 1;

export function computeLayout(schedule, items) {
  const errors = [];
  const out = items.map((it) => ({
    id: it.id,
    assigned_start: 0,
    assigned_end: 0,
    flags: { overflow: false, out_of_bounds: false, below_min: false },
  }));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let oob = false;
    if (it.start_min != null) {
      if (it.start_min < schedule.start_min || it.start_min > schedule.end_min)
        oob = true;
    }
    if (it.end_min != null) {
      if (it.end_min < schedule.start_min || it.end_min > schedule.end_min)
        oob = true;
    }
    if (oob) {
      errors.push("OutOfBounds");
      out[i].flags.out_of_bounds = true;
    }
  }
  if (!items.length) return { items: out, errors };

  let prevFixedEnd = null;
  for (const it of items) {
    if (it.start_min != null) {
      if (prevFixedEnd != null && it.start_min < prevFixedEnd) {
        errors.push("AnchorNonMonotonic");
      }
    }
    if (it.end_min != null) prevFixedEnd = it.end_min;
    else if (it.start_min != null) prevFixedEnd = it.start_min;
  }

  let cursor = schedule.start_min;
  let i = 0;
  const n = items.length;
  while (i < n) {
    if (items[i].start_min != null) cursor = items[i].start_min;
    // Find segment end j (same termination rules as the Rust port).
    let j = i;
    while (j < n) {
      if (items[j].end_min != null) break;
      if (j + 1 < n && items[j + 1].start_min != null) break;
      j++;
    }
    const rightBoundary =
      j < n && items[j].end_min != null
        ? items[j].end_min
        : j + 1 < n && items[j + 1].start_min != null
        ? items[j + 1].start_min
        : schedule.end_min;
    const segmentStart = cursor;
    const last = Math.min(j, n - 1);
    const seg = items.slice(i, last + 1);

    const totalWeight = seg.reduce(
      (s, it) => s + Math.max(1, it.duration_target),
      0
    );
    const available = rightBoundary - segmentStart;
    if (available < seg.length * MIN_DURATION) {
      errors.push("BelowMinDuration");
    }

    if (seg.length === 1 && seg[0].end_min != null) {
      const idx = i;
      out[idx].assigned_start = segmentStart;
      out[idx].assigned_end = rightBoundary;
      if (rightBoundary - segmentStart < MIN_DURATION) out[idx].flags.below_min = true;
    } else {
      const shares = [];
      const remainders = [];
      let sumAssigned = 0;
      for (const it of seg) {
        const w = Math.max(1, it.duration_target);
        const raw = (available * w) / totalWeight;
        const floor = Math.max(Math.floor(raw), MIN_DURATION);
        shares.push(floor);
        remainders.push(raw - Math.floor(raw));
        sumAssigned += floor;
      }
      let diff = available - sumAssigned;
      if (diff > 0) {
        const order = remainders.map((_, k) => k).sort((a, b) => remainders[b] - remainders[a]);
        let k = 0;
        while (diff > 0 && order.length > 0) {
          shares[order[k % order.length]] += 1;
          diff -= 1;
          k++;
        }
      } else if (diff < 0) {
        let k = 0;
        let guard = 0;
        while (diff < 0 && guard < 100000) {
          const idx2 = k % seg.length;
          if (shares[idx2] > MIN_DURATION) {
            shares[idx2] -= 1;
            diff += 1;
          }
          k++;
          guard++;
          if (k > seg.length * 4 && shares.every((s) => s === MIN_DURATION)) break;
        }
        if (diff < 0) errors.push("OverflowSegment");
      }
      let c = segmentStart;
      for (let k = 0; k < seg.length; k++) {
        const dur = shares[k];
        const idx = i + k;
        out[idx].assigned_start = c;
        out[idx].assigned_end = c + dur;
        if (c + dur - c < MIN_DURATION) out[idx].flags.below_min = true;
        c = c + dur;
      }
      // Snap the last item's end to the boundary when it has a fixed end.
      if (seg[seg.length - 1].end_min != null) {
        const idx = i + seg.length - 1;
        out[idx].assigned_end = rightBoundary;
        if (out[idx].assigned_end - out[idx].assigned_start < MIN_DURATION)
          out[idx].flags.below_min = true;
      }
    }
    cursor = out[i + seg.length - 1].assigned_end;
    i = i + seg.length;
  }
  return { items: out, errors };
}

/** Classify a layout: precedence out_of_bounds > anchor_conflict > below_min > overflow; fatalIndices lists the offending item indices. */
export function classifyLayout(layout) {
  const errors = (layout && layout.errors) || [];
  const items = (layout && layout.items) || [];
  const fatalIndices = [];
  let hasBelowMinFlag = false;
  let hasOutOfBoundsFlag = false;
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    const tooShort = li.assigned_end - li.assigned_start < MIN_DURATION;
    const belowMin = !!(li.flags && li.flags.below_min) || tooShort;
    const oob = !!(li.flags && li.flags.out_of_bounds);
    if (belowMin || oob) {
      fatalIndices.push(i);
      if (belowMin) hasBelowMinFlag = true;
      if (oob) hasOutOfBoundsFlag = true;
    }
  }
  const hasOob = errors.includes("OutOfBounds") || hasOutOfBoundsFlag;
  const hasAnchorConflict = errors.includes("AnchorNonMonotonic");
  const hasBelowMin = errors.includes("BelowMinDuration") || hasBelowMinFlag;
  const hasOverflow = errors.includes("OverflowSegment");
  let reason = null;
  if (hasOob) reason = "out_of_bounds";
  else if (hasAnchorConflict) reason = "anchor_conflict";
  else if (hasBelowMin) reason = "below_min";
  else if (hasOverflow) reason = "overflow";
  return { feasible: reason === null, reason, fatalIndices };
}
