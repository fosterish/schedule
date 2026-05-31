// Pure reorder math for timeline drag: maps a pre-drag snapshot and ghost position to the resulting order, anchors, and patch.

import { computeLayout, classifyLayout, MIN_DURATION } from "./layout.js";

/** Compute the reorder preview for a drag gesture (dirSign: +1 down, -1 up, 0 none). */
export function computeReorderPreview(opts) {
  const { schedule, items, laidOut, draggedId, ghostTopMin, ghostBottomMin, dirSign } = opts;

  const draggedIdx = items.findIndex((it) => it.id === draggedId);
  if (draggedIdx < 0) {
    throw new Error("draggedId not in items");
  }
  const grabbed = items[draggedIdx];
  const grabbedSlot = laidOut[draggedIdx];
  const grabbedDur = Math.max(
    MIN_DURATION,
    grabbedSlot.assigned_end - grabbedSlot.assigned_start
  );
  const grabbedFixed = grabbed.start_min != null && grabbed.end_min != null;

  // No net movement → no reorder; caller keeps grabbed's original spot.
  if (dirSign === 0) {
    return noReorderResult({ schedule, items, laidOut, draggedIdx, grabbedSlot });
  }

  // Leading edge of grabbed: ghost bottom when dragging down, ghost top when dragging up.
  const ghostLeadingMin = dirSign > 0 ? ghostBottomMin : ghostTopMin;

  // Target = farthest item whose midpoint the leading edge crossed; stop at the first non-crossed midpoint (midpoints are monotonic).
  let targetIdx = null;
  if (dirSign > 0) {
    for (let i = draggedIdx + 1; i < items.length; i++) {
      const lo = laidOut[i];
      const mid = (lo.assigned_start + lo.assigned_end) / 2;
      if (ghostLeadingMin > mid) targetIdx = i;
      else break;
    }
  } else {
    for (let i = draggedIdx - 1; i >= 0; i--) {
      const lo = laidOut[i];
      const mid = (lo.assigned_start + lo.assigned_end) / 2;
      if (ghostLeadingMin < mid) targetIdx = i;
      else break;
    }
  }

  if (targetIdx == null) {
    return noReorderResult({ schedule, items, laidOut, draggedIdx, grabbedSlot });
  }

  // Where grabbed lands: after target when dragging down, before target when dragging up.
  const reorderedIdx = computeNewIndex(items.length, draggedIdx, targetIdx, dirSign);

  // Build the post-reorder sequence (slot analysis only) by moving grabbed to its new spot.
  const seq = items.slice();
  seq.splice(draggedIdx, 1);
  seq.splice(reorderedIdx, 0, grabbed);

  // Target sits next to grabbed in seq: reorderedIdx-1 when dragging down, reorderedIdx+1 when dragging up.
  const targetInSeqIdx = dirSign > 0 ? reorderedIdx - 1 : reorderedIdx + 1;
  const target = seq[targetInSeqIdx];

  const grabbedLeadingKey = dirSign > 0 ? "end_min" : "start_min";
  const grabbedTrailingKey = dirSign > 0 ? "start_min" : "end_min";
  const grabbedLeadingFixed = grabbed[grabbedLeadingKey] != null;
  const grabbedTrailingFixed = grabbed[grabbedTrailingKey] != null;

  // Target's edge adjacent to grabbed: bottom (end_min) when dragging down, top (start_min) when dragging up.
  const targetEdgeKey = dirSign > 0 ? "end_min" : "start_min";
  const targetEdgeFixed = target[targetEdgeKey] != null;
  // Use the laid-out minute of the target edge (the anchor if fixed, else the pre-drag layout value).
  const targetIdxInItems = items.findIndex((it) => it.id === target.id);
  const targetSlot = laidOut[targetIdxInItems];
  const targetEdgeMin =
    dirSign > 0 ? targetSlot.assigned_end : targetSlot.assigned_start;

  // Other bound = the next fixed constraint past grabbed in the travel direction, falling back to the schedule bound.
  const otherBound = computeOtherBound({
    seq,
    grabbedSeqIdx: reorderedIdx,
    laidOut,
    items,
    schedule,
    dirSign,
  });

  // Gap = minutes from target_edge to other_bound; open-ended bound means unbounded.
  const gapMinutes =
    otherBound == null
      ? Number.POSITIVE_INFINITY
      : dirSign > 0
        ? Math.max(0, otherBound.minute - targetEdgeMin)
        : Math.max(0, targetEdgeMin - otherBound.minute);

  // Reject only when both bounds are fixed and there's no usable room; doesn't apply to fully fixed grabbed.
  const bothBoundsFixed = targetEdgeFixed && (otherBound != null && otherBound.fixed);
  if (!grabbedFixed && bothBoundsFixed && gapMinutes < MIN_DURATION) {
    return rejectedResult({
      schedule,
      items,
      laidOut,
      draggedIdx,
      grabbedSlot,
      reason: "dynamic grabbed cannot fit between two fixed edges",
    });
  }

  const draft = items.map((it) => ({ ...it }));
  const draftGrabbed = draft[draftFindIndex(draft, grabbed.id)];
  const draftTarget = draft[draftFindIndex(draft, target.id)];

  // Track which anchors changed so the commit patches only those.
  const anchorChanges = new Map();

  if (grabbedFixed) {
    if (targetEdgeFixed) {
      // Fixed grabbed above a fixed edge: drop into the gap beside target; if it won't fit, shift target instead.
      if (gapMinutes >= grabbedDur) {
        if (dirSign > 0) {
          draftGrabbed.start_min = targetEdgeMin;
          draftGrabbed.end_min = targetEdgeMin + grabbedDur;
        } else {
          draftGrabbed.end_min = targetEdgeMin;
          draftGrabbed.start_min = targetEdgeMin - grabbedDur;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      } else {
        const shift = -dirSign * grabbedDur;
        const tNewStart =
          draftTarget.start_min != null ? draftTarget.start_min + shift : null;
        const tNewEnd =
          draftTarget.end_min != null ? draftTarget.end_min + shift : null;
        if (tNewStart != null) draftTarget.start_min = tNewStart;
        if (tNewEnd != null) draftTarget.end_min = tNewEnd;
        recordAnchorChange(anchorChanges, draftTarget, target);
        const newTargetEdge =
          dirSign > 0 ? draftTarget.end_min : draftTarget.start_min;
        if (dirSign > 0) {
          draftGrabbed.start_min = newTargetEdge;
          draftGrabbed.end_min = newTargetEdge + grabbedDur;
        } else {
          draftGrabbed.end_min = newTargetEdge;
          draftGrabbed.start_min = newTargetEdge - grabbedDur;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      }
    } else {
      // Fixed grabbed above a dynamic edge: leading edge at the target edge's current minute, trailing follows by duration.
      if (dirSign > 0) {
        draftGrabbed.end_min = targetEdgeMin;
        draftGrabbed.start_min = targetEdgeMin - grabbedDur;
      } else {
        draftGrabbed.start_min = targetEdgeMin;
        draftGrabbed.end_min = targetEdgeMin + grabbedDur;
      }
      recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
    }
  } else {
    if (targetEdgeFixed) {
      if (grabbedLeadingFixed) {
        // Dynamic grabbed, leading fixed, above a fixed edge: leading_edge = target_edge + min(grabbed_dur, gap).
        const step = Math.min(grabbedDur, gapMinutes);
        if (dirSign > 0) {
          draftGrabbed.end_min = targetEdgeMin + step;
        } else {
          draftGrabbed.start_min = targetEdgeMin - step;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      } else if (grabbedTrailingFixed) {
        // trailing_edge = target_edge.
        if (dirSign > 0) {
          draftGrabbed.start_min = targetEdgeMin;
        } else {
          draftGrabbed.end_min = targetEdgeMin;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      }
      // Fully dynamic grabbed: no anchors to set; the layout reflows.
    } else {
      if (grabbedLeadingFixed) {
        // leading_edge = target_edge (current minute).
        if (dirSign > 0) {
          draftGrabbed.end_min = targetEdgeMin;
        } else {
          draftGrabbed.start_min = targetEdgeMin;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      } else if (grabbedTrailingFixed) {
        // trailing_edge = target_edge (current minute).
        if (dirSign > 0) {
          draftGrabbed.start_min = targetEdgeMin;
        } else {
          draftGrabbed.end_min = targetEdgeMin;
        }
        recordAnchorChange(anchorChanges, draftGrabbed, grabbed);
      }
      // fully dynamic: no anchor changes.
    }
  }

  // Move grabbed to its new spot; the layout reflows the items in between.
  const reorderedDraft = draft.slice();
  const oldIdx = reorderedDraft.findIndex((it) => it.id === grabbed.id);
  const moved = reorderedDraft.splice(oldIdx, 1)[0];
  reorderedDraft.splice(reorderedIdx, 0, moved);

  // Auto-expand the schedule window for preview so the layout sees new anchors (mirrors backend patch_item).
  const sched = { ...schedule };
  for (const it of reorderedDraft) {
    if (it.start_min != null) {
      if (it.start_min < sched.start_min) sched.start_min = it.start_min;
      if (it.start_min > sched.end_min) sched.end_min = it.start_min;
    }
    if (it.end_min != null) {
      if (it.end_min > sched.end_min) sched.end_min = it.end_min;
      if (it.end_min < sched.start_min) sched.start_min = it.end_min;
    }
  }

  const layout = computeLayout(sched, reorderedDraft);

  // Reject an infeasible layout, except out-of-bounds for fixed grabbed (the backend auto-expands at commit).
  const classification = classifyLayout(layout);
  if (!classification.feasible && classification.reason !== "out_of_bounds") {
    return rejectedResult({
      schedule,
      items,
      laidOut,
      draggedIdx,
      grabbedSlot,
      reason: "reorder would leave an item below the minimum duration",
    });
  }

  // Build anchor_updates for only the ids whose anchors changed; the backend applies them atomically with the reorder.
  const anchorUpdates = [];
  for (const [id, change] of anchorChanges.entries()) {
    if (Object.keys(change).length === 0) continue;
    anchorUpdates.push({ id, ...change });
  }

  return {
    hasReorder: true,
    allowed: true,
    reason: null,
    reorderedRawItems: reorderedDraft,
    newDraggedIdx: reorderedIdx,
    newAfterId: reorderedIdx === 0 ? null : reorderedDraft[reorderedIdx - 1].id,
    anchorUpdates,
    scheduleEffective: sched,
    layout,
    grabbedDur,
    grabbedFixed,
  };
}

function noReorderResult({ schedule, items, laidOut, draggedIdx, grabbedSlot }) {
  const layoutItems = laidOut.map((lo) => ({ ...lo, flags: { ...lo.flags } }));
  return {
    hasReorder: false,
    allowed: true,
    reason: null,
    reorderedRawItems: items.slice(),
    newDraggedIdx: draggedIdx,
    newAfterId: draggedIdx === 0 ? null : items[draggedIdx - 1].id,
    anchorUpdates: [],
    scheduleEffective: { ...schedule },
    layout: { items: layoutItems, errors: [] },
    grabbedDur: Math.max(1, grabbedSlot.assigned_end - grabbedSlot.assigned_start),
    grabbedFixed:
      items[draggedIdx].start_min != null &&
      items[draggedIdx].end_min != null,
  };
}

function rejectedResult({
  schedule,
  items,
  laidOut,
  draggedIdx,
  grabbedSlot,
  reason,
}) {
  const layoutItems = laidOut.map((lo) => ({ ...lo, flags: { ...lo.flags } }));
  return {
    hasReorder: false,
    allowed: false,
    reason,
    reorderedRawItems: items.slice(),
    newDraggedIdx: draggedIdx,
    newAfterId: draggedIdx === 0 ? null : items[draggedIdx - 1].id,
    anchorUpdates: [],
    scheduleEffective: { ...schedule },
    layout: { items: layoutItems, errors: [] },
    grabbedDur: Math.max(1, grabbedSlot.assigned_end - grabbedSlot.assigned_start),
    grabbedFixed:
      items[draggedIdx].start_min != null &&
      items[draggedIdx].end_min != null,
  };
}

// Destination index of grabbed after reorder; both directions resolve to targetIdx (removal shifts indices accordingly).
function computeNewIndex(_len, draggedIdx, targetIdx, dirSign) {
  if (dirSign > 0) {
    return targetIdx; // because removal shifts target left by 1
  }
  return targetIdx; // up: insert before target (which kept its index)
}

function draftFindIndex(draft, id) {
  return draft.findIndex((it) => it.id === id);
}

function recordAnchorChange(map, drafted, original) {
  const change = map.get(drafted.id) || {};
  if (drafted.start_min !== original.start_min) {
    change.start_min = drafted.start_min;
  }
  if (drafted.end_min !== original.end_min) {
    change.end_min = drafted.end_min;
  }
  map.set(drafted.id, change);
}

// Other bound past grabbed; if the immediate neighbor's facing edge is dynamic, it stays DYNAMIC after walking further.
function computeOtherBound({ seq, grabbedSeqIdx, laidOut, items, schedule, dirSign }) {
  const nextIdx = dirSign > 0 ? grabbedSeqIdx + 1 : grabbedSeqIdx - 1;
  if (nextIdx < 0 || nextIdx >= seq.length) {
    // No item on the other side → schedule bound. Fixed by definition.
    return {
      minute: dirSign > 0 ? schedule.end_min : schedule.start_min,
      fixed: true,
    };
  }
  const facingKey = dirSign > 0 ? "start_min" : "end_min";
  const neighbor = seq[nextIdx];
  if (neighbor[facingKey] != null) {
    return { minute: neighbor[facingKey], fixed: true };
  }
  // Facing edge dynamic → slot open; still find the next fixed constraint beyond for gap math.
  let scan = nextIdx;
  while (scan >= 0 && scan < seq.length) {
    const it = seq[scan];
    const otherKey = dirSign > 0 ? "end_min" : "start_min";
    if (it[otherKey] != null) {
      return { minute: it[otherKey], fixed: false };
    }
    if (scan !== nextIdx && it[facingKey] != null) {
      return { minute: it[facingKey], fixed: false };
    }
    scan += dirSign > 0 ? 1 : -1;
  }
  return {
    minute: dirSign > 0 ? schedule.end_min : schedule.start_min,
    fixed: false,
  };
}
