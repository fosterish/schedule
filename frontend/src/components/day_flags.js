// Client-side play/skip/stop enablement against a minute; mirrors apply_action in day.rs, which still enforces the rules server-side.

/** Returns play/skip/stop enabled flags plus the *_target item id each action would modify (null when disabled). */
export function computeRunningFlags(schedule, items, nowMin) {
  const flags = {
    play_enabled: false,
    skip_enabled: false,
    stop_enabled: false,
    play_target: null,
    skip_target: null,
    stop_target: null,
  };
  if (!schedule) return flags;
  // Index→id, guarding out-of-range so targets only point at real items.
  const idAt = (i) => (i >= 0 && i < items.length ? items[i].id : null);
  if (!items || items.length === 0) {
    flags.play_enabled = nowMin < schedule.end_min;
    return flags;
  }
  // Case 1: before schedule starts.
  if (nowMin < schedule.start_min) {
    flags.play_enabled = true;
    flags.play_target = idAt(0);
    return flags;
  }
  // Case 3: after schedule ends.
  if (nowMin >= schedule.end_min) {
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    const lastHasFixedEnd = last.end_min != null;
    if (lastHasFixedEnd) {
      flags.stop_enabled = true;
      flags.stop_target = idAt(lastIdx);
    } else {
      flags.play_enabled = true;
      flags.stop_enabled = true;
      // Both play and stop act on the first item of the trailing dynamic block (apply_action Case 3b).
      const first = dayItemWalkBack(items, lastIdx);
      flags.play_target = idAt(first);
      flags.stop_target = idAt(first);
      const n = countFinalDynamicBlock(items);
      if (n > 1) {
        flags.skip_enabled = true;
        // Skip's play half lands on the item right after `first`.
        flags.skip_target = idAt(first + 1);
      }
    }
    return flags;
  }
  // Case 2: within schedule. Treat a layout-flush against a just-stopped item as a gap (post-stop pseudo-gap).
  let containing = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (nowMin >= it.assigned_start && nowMin < it.assigned_end) {
      containing = i;
      break;
    }
  }
  if (
    containing > 0 &&
    items[containing - 1].end_min === nowMin &&
    items[containing].start_min == null
  ) {
    containing = -1;
  }
  if (containing >= 0) {
    const item = items[containing];
    const fullyFixed = item.start_min != null && item.end_min != null;
    // Disable skip when the next item has a fixed start, else skip would silently override its anchor.
    const nextHasFixedStart =
      containing + 1 < items.length &&
      items[containing + 1].start_min != null;
    if (fullyFixed) {
      flags.play_enabled = true;
      flags.stop_enabled = true;
      // Play/stop act on the containing item (apply_fixed_item_action).
      flags.play_target = idAt(containing);
      flags.stop_target = idAt(containing);
      if (containing + 1 < items.length && !nextHasFixedStart) {
        flags.skip_enabled = true;
        // Skip stops this item then plays the next one.
        flags.skip_target = idAt(containing + 1);
      }
    } else {
      flags.play_enabled = true;
      flags.stop_enabled = true;
      // Play/stop act on the first item of the dynamic block (apply_dynamic_block_action walks back to it).
      const first = dayItemWalkBack(items, containing);
      flags.play_target = idAt(first);
      flags.stop_target = idAt(first);
      if (first + 1 < items.length && !nextHasFixedStart) {
        flags.skip_enabled = true;
        // Skip stops the block's first item then plays the next one.
        flags.skip_target = idAt(first + 1);
      }
    }
    return flags;
  }
  // Gap branch. `>=` for next mirrors the layout-flush next item in the post-stop pseudo-gap (apply_gap_action in day.rs).
  let prevIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].assigned_end <= nowMin) {
      prevIdx = i;
    } else {
      break;
    }
  }
  const prevFixedEndExists = prevIdx >= 0 && items[prevIdx].end_min != null;
  let nextIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].assigned_start >= nowMin) {
      nextIdx = i;
      break;
    }
  }
  flags.play_enabled = nextIdx >= 0;
  flags.stop_enabled = prevFixedEndExists;
  // Same anchored-boundary guard: if prev end and next start are both fixed, skip would collapse the planned gap.
  flags.skip_enabled =
    flags.play_enabled &&
    flags.stop_enabled &&
    items[nextIdx].start_min == null;
  // Play (and skip's play half) start the next item; stop extends the
  // most recent fixed-end item before `now`.
  if (flags.play_enabled) flags.play_target = idAt(nextIdx);
  if (flags.stop_enabled) flags.stop_target = idAt(prevIdx);
  if (flags.skip_enabled) flags.skip_target = idAt(nextIdx);
  return flags;
}

// Mirror of day_item_walk_back: first item of the dynamic block containing startingIdx; fixed items terminate the walk.
function dayItemWalkBack(items, startingIdx) {
  const s = items[startingIdx];
  if (s.start_min != null && s.end_min != null) return startingIdx;
  if (s.start_min != null) return startingIdx;
  let i = startingIdx;
  while (i > 0) {
    i -= 1;
    if (items[i].end_min != null) return i + 1;
    if (items[i].start_min != null) return i;
  }
  return 0;
}

// Mirror of count_final_dynamic_block: walks back from the last item, stopping at a fixed boundary.
function countFinalDynamicBlock(items) {
  if (items.length === 0) return 0;
  let count = 1;
  let i = items.length;
  while (i > 1) {
    i -= 1;
    if (items[i - 1].end_min != null) return count;
    if (items[i].start_min != null) return count;
    count += 1;
  }
  return count;
}
