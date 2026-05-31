// Pure solver deciding where a new item goes; preserves intra-gap order and equal-target order, skips repositioning without anchors.

import { computeLayout, classifyLayout } from "./layout.js";
import { cursorInsertionAfterId } from "./cursor_insert.js";
import { PLACEHOLDER_ID } from "./placeholder.js";

// Conflict kinds: overlap_fixed, overlap_edge, squashed_dynamic, no_slack. end_before_start is owned by the popup, not raised here.

// Defensive cap on greedy iterations; convergence normally takes a handful of passes.
const MAX_GREEDY_ITERATIONS = 50;

export function solveInsertion({
  items,
  schedule,
  draft,
  cursorMin,
  allowRepositioning,
}) {
  if (!schedule || !draft) return emptyResult();
  const list = items || [];

  const hasStart = draft.start_min != null;
  const hasEnd = draft.end_min != null;
  const isAnchored = hasStart && hasEnd;
  const isPartial = !isAnchored && (hasStart || hasEnd);

  // Pre-check overlaps first so the solver never runs on a physically impossible draft.
  if (isAnchored) {
    if (
      draft.start_min < schedule.start_min ||
      draft.end_min > schedule.end_min
    ) {
      return conflictResult("overlap_edge");
    }
    if (anchoredOverlapsFixed(draft, list)) {
      return conflictResult("overlap_fixed");
    }
  } else if (isPartial) {
    const anchorMin = hasStart ? draft.start_min : draft.end_min;
    if (anchorMin < schedule.start_min || anchorMin > schedule.end_min) {
      return conflictResult("overlap_edge");
    }
    if (partialOverlapsFixed(draft, list)) {
      return conflictResult("overlap_fixed");
    }
  }

  // Pick the initial slot from the anchor minute (anchored/partial) or the time-cursor minute (fully dynamic).
  let initialAnchorMin;
  if (isAnchored) initialAnchorMin = draft.start_min;
  else if (isPartial) initialAnchorMin = hasStart ? draft.start_min : draft.end_min;
  else initialAnchorMin = cursorMin;
  const initialAfterId = cursorInsertionAfterId(initialAnchorMin, list);

  const draftRow = makeDraftRow(draft);
  const initialVirtual = spliceInto(list, initialAfterId, draftRow);

  // Repositioning only matters when the schedule has a hard anchor; otherwise reordering is a no-op.
  const scheduleHasAnchors = list.some(
    (it) => it.start_min != null || it.end_min != null
  );
  let bestVirtual = initialVirtual;
  if (allowRepositioning && scheduleHasAnchors) {
    bestVirtual = runGreedy(initialVirtual, schedule);
  }

  // Map an infeasible layout to no_slack (repositioning was on) or squashed_dynamic (off, so toggling may rescue).
  const layout = computeLayout(schedule, bestVirtual);
  const classification = classifyLayout(layout);
  if (!classification.feasible) {
    return conflictResult(
      allowRepositioning ? "no_slack" : "squashed_dynamic"
    );
  }

  const reorders = computeReorders(bestVirtual, list);
  const placeholderIdx = bestVirtual.findIndex(
    (it) => it && it._placeholder
  );
  const afterItemId = computeAfterItemId(bestVirtual, placeholderIdx);
  const draftLaid = layout.items[placeholderIdx];

  // Merge raw and laid-out fields so the timeline renderer can paint the items directly.
  const mergedItems = bestVirtual.map((raw, i) => ({
    ...raw,
    assigned_start: layout.items[i].assigned_start,
    assigned_end: layout.items[i].assigned_end,
    flags: layout.items[i].flags,
  }));

  return {
    items: mergedItems,
    reorders,
    conflict: null,
    draftAssignedStart: draftLaid ? draftLaid.assigned_start : null,
    draftAssignedEnd: draftLaid ? draftLaid.assigned_end : null,
    afterItemId,
  };
}

function anchoredOverlapsFixed(draft, list) {
  for (const it of list) {
    if (it.start_min != null && it.end_min != null) {
      // Fully fixed neighbour: classic [a, b) ∩ [c, d) overlap test.
      if (overlapsInterval(draft.start_min, draft.end_min, it.start_min, it.end_min)) {
        return true;
      }
    } else if (it.start_min != null) {
      // Partial neighbour pinned at start: conflict only if the draft strictly crosses the edge (touching is allowed).
      if (draft.start_min < it.start_min && draft.end_min > it.start_min) {
        return true;
      }
    } else if (it.end_min != null) {
      if (draft.start_min < it.end_min && draft.end_min > it.end_min) {
        return true;
      }
    }
  }
  return false;
}

function partialOverlapsFixed(draft, list) {
  for (const it of list) {
    if (it.start_min == null || it.end_min == null) continue;
    if (draft.start_min != null) {
      if (
        draft.start_min >= it.start_min &&
        draft.start_min < it.end_min
      ) {
        return true;
      }
    }
    if (draft.end_min != null) {
      if (draft.end_min > it.start_min && draft.end_min <= it.end_min) {
        return true;
      }
    }
  }
  return false;
}

function overlapsInterval(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

function makeDraftRow(draft) {
  return {
    id: PLACEHOLDER_ID,
    _placeholder: true,
    position: null,
    start_min: draft.start_min ?? null,
    end_min: draft.end_min ?? null,
    duration_target: draft.duration_target ?? 60,
    use_inline: draft.use_inline ?? true,
    inline_label: draft.inline_label ?? null,
    inline_description: draft.inline_description ?? null,
    color: draft.color,
    project_id: draft.project_id ?? null,
    project_rank: draft.project_rank ?? 1,
    task_id: draft.task_id ?? null,
    task_rank: draft.task_rank ?? 1,
  };
}

// afterId is triple-state: null → head, undefined → tail, numeric → after that id.
function spliceInto(base, afterId, row) {
  if (afterId === null) return [row, ...base];
  if (afterId === undefined) return [...base, row];
  const idx = base.findIndex((it) => it.id === afterId);
  if (idx < 0) return [...base, row];
  return [...base.slice(0, idx + 1), row, ...base.slice(idx + 1)];
}

// Greedy: accept the first strict improvement, ties keep order; deviation sums |duration-target| with heavy penalty for layout errors.
function runGreedy(initial, schedule) {
  let best = initial.slice();
  let bestDev = computeDeviation(best, schedule);
  let iter = 0;
  let improved = true;
  while (improved && iter++ < MAX_GREEDY_ITERATIONS) {
    improved = false;
    for (let i = 0; i < best.length; i++) {
      if (!isFullyDynamic(best[i])) continue;
      const it = best[i];
      const without = best.slice(0, i).concat(best.slice(i + 1));
      for (let j = 0; j <= without.length; j++) {
        if (j === i) continue;
        const trial = without
          .slice(0, j)
          .concat([it], without.slice(j));
        const dev = computeDeviation(trial, schedule);
        if (dev < bestDev - 1e-9) {
          best = trial;
          bestDev = dev;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best;
}

function isFullyDynamic(it) {
  return it && it.start_min == null && it.end_min == null;
}

function computeDeviation(virtualItems, schedule) {
  const layout = computeLayout(schedule, virtualItems);
  let dev = 0;
  // A layout error biases by a large constant so feasible always beats infeasible.
  const ERR_PENALTY = 1e9;
  if (layout.errors.length > 0) dev += ERR_PENALTY * layout.errors.length;
  for (let i = 0; i < virtualItems.length; i++) {
    const it = virtualItems[i];
    const li = layout.items[i];
    if (li.flags.below_min) dev += ERR_PENALTY;
    if (li.flags.out_of_bounds) dev += ERR_PENALTY;
    if (it.start_min != null && it.end_min != null) continue;
    const target = Math.max(1, it.duration_target ?? 60);
    const actual = li.assigned_end - li.assigned_start;
    dev += Math.abs(actual - target);
  }
  return dev;
}

function computeAfterItemId(virtualItems, placeholderIdx) {
  if (placeholderIdx < 0) return undefined;
  if (placeholderIdx === 0) return null; // head insert
  return virtualItems[placeholderIdx - 1].id;
}

// Emit {id, position} only for moved items; reusing the moved items' original positions keeps monotonicity automatic.
function computeReorders(virtualItems, originalItems) {
  const originalIndexById = new Map();
  originalItems.forEach((it, i) => originalIndexById.set(it.id, i));
  const finalOrderOfExisting = virtualItems.filter(
    (it) => !it._placeholder
  );
  const finalIndexById = new Map();
  finalOrderOfExisting.forEach((it, i) => finalIndexById.set(it.id, i));
  // Moved set: items whose index in the existing-only sequence changed.
  const movedIds = new Set();
  for (const it of finalOrderOfExisting) {
    const orig = originalIndexById.get(it.id);
    const fin = finalIndexById.get(it.id);
    if (orig !== fin) movedIds.add(it.id);
  }
  if (movedIds.size === 0) return [];
  // Assign the moved items' sorted original positions in final order, preserving the position set and monotonicity.
  const originalPosById = new Map();
  for (const it of originalItems) {
    originalPosById.set(it.id, it.position);
  }
  const movedPositions = Array.from(movedIds)
    .map((id) => originalPosById.get(id))
    .sort((a, b) => a - b);
  let i = 0;
  const reorders = [];
  for (const it of finalOrderOfExisting) {
    if (!movedIds.has(it.id)) continue;
    const newPos = movedPositions[i++];
    if (newPos !== originalPosById.get(it.id)) {
      reorders.push({ id: it.id, position: newPos });
    }
  }
  return reorders;
}

function emptyResult() {
  return {
    items: [],
    reorders: [],
    conflict: null,
    draftAssignedStart: null,
    draftAssignedEnd: null,
    afterItemId: undefined,
  };
}

function conflictResult(kind) {
  return {
    items: [],
    reorders: [],
    conflict: kind,
    draftAssignedStart: null,
    draftAssignedEnd: null,
    afterItemId: undefined,
  };
}
