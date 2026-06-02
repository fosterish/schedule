// Pure task ordering and cycle detection. Edge {from, to} means "from blocks to" (blocker → blocked).

// Build blocker→blocked edges from a deps map; coerce keys to numbers. includeId filters nodes (ordering ignores completed tasks).
export function edgesFromDepsMap(depsMap, includeId) {
  const ok = typeof includeId === "function" ? includeId : () => true;
  const edges = [];
  for (const blockedKey of Object.keys(depsMap || {})) {
    const blockedId = Number(blockedKey);
    if (!ok(blockedId)) continue;
    for (const blockerId of depsMap[blockedKey] || []) {
      if (!ok(blockerId)) continue;
      edges.push({ from: blockerId, to: blockedId });
    }
  }
  return edges;
}

// Split tasks into incomplete-then-completed (completed = completed_at truthy), preserving relative order within each group.
export function partitionByCompletion(tasks) {
  const incomplete = [];
  const completed = [];
  for (const t of tasks || []) {
    (t.completed_at ? completed : incomplete).push(t);
  }
  return { incomplete, completed };
}

// Stable topological order: among unblocked nodes, pick the earliest in orderedIds, preserving the user's order where allowed.
export function topoOrder(orderedIds, edges) {
  const ids = orderedIds.slice();
  const present = new Set(ids);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const { from, to } of edges) {
    if (!present.has(from) || !present.has(to)) continue;
    adj.get(from).push(to);
    indeg.set(to, indeg.get(to) + 1);
  }
  const used = new Set();
  const result = [];
  while (result.length < ids.length) {
    let pick = null;
    for (const id of ids) {
      if (!used.has(id) && indeg.get(id) === 0) {
        pick = id;
        break;
      }
    }
    if (pick == null) break; // cycle — bail to the defensive append below
    used.add(pick);
    result.push(pick);
    for (const to of adj.get(pick)) indeg.set(to, indeg.get(to) - 1);
  }
  if (result.length < ids.length) {
    for (const id of ids) if (!used.has(id)) result.push(id);
  }
  return result;
}

// True iff every edge points forward (blocker before blocked); edges with ids outside the order are ignored.
export function isOrderValid(orderedIds, edges) {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  for (const { from, to } of edges) {
    if (!pos.has(from) || !pos.has(to)) continue;
    if (pos.get(from) >= pos.get(to)) return false;
  }
  return true;
}

// Ids of dependency rows conflicting with draggedId at its current position; used to dull-red those rows during a drag.
export function dropConflictIds(orderedIds, draggedId, edges) {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  if (!pos.has(draggedId)) return [];
  const di = pos.get(draggedId);
  const out = new Set();
  for (const { from, to } of edges) {
    if (!pos.has(from) || !pos.has(to)) continue;
    if (from === draggedId && pos.get(to) < di) out.add(to);
    if (to === draggedId && pos.get(from) > di) out.add(from);
  }
  return [...out];
}

// Drag target index: the farthest row whose midpoint the leading edge crossed (dirSign +1 down, -1 up, 0 none).
export function reorderTargetIndex(mids, draggedIdx, leadingEdge, dirSign) {
  let target = draggedIdx;
  if (dirSign > 0) {
    for (let i = draggedIdx + 1; i < mids.length; i++) {
      if (leadingEdge > mids[i]) target = i;
      else break;
    }
  } else if (dirSign < 0) {
    for (let i = draggedIdx - 1; i >= 0; i--) {
      if (leadingEdge < mids[i]) target = i;
      else break;
    }
  }
  return target;
}

// Minimal reorder ops transforming currentIds into targetIds; emits {id, afterId} only for mismatched positions (afterId null = head).
export function reorderOps(currentIds, targetIds) {
  const ops = [];
  const cur = currentIds.slice();
  for (let i = 0; i < targetIds.length; i++) {
    if (cur[i] === targetIds[i]) continue;
    const id = targetIds[i];
    const from = cur.indexOf(id);
    if (from === -1) continue;
    cur.splice(from, 1);
    cur.splice(i, 0, id);
    ops.push({ id, afterId: i === 0 ? null : targetIds[i - 1] });
  }
  return ops;
}

// Reachability over blocker→blocked edges: can `start` reach `goal`?
function canReach(adj, start, goal) {
  if (start === goal) return true;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const node = stack.pop();
    for (const next of adj.get(node) || []) {
      if (next === goal) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

function buildAdj(edges) {
  const adj = new Map();
  for (const { from, to } of edges) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  return adj;
}

// Would adding newEdge create a cycle? Yes iff `to` can already reach `from`, or it's a self-loop.
export function wouldCreateCycle(edges, newEdge) {
  if (newEdge.from === newEdge.to) return true;
  return canReach(buildAdj(edges), newEdge.to, newEdge.from);
}

// Does the directed graph contain any cycle? Standard DFS three-coloring
// over every node referenced by an edge.
export function hasCycle(edges) {
  const adj = buildAdj(edges);
  const nodes = new Set();
  for (const { from, to } of edges) {
    nodes.add(from);
    nodes.add(to);
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map([...nodes].map((n) => [n, WHITE]));
  const visit = (node) => {
    color.set(node, GREY);
    for (const next of adj.get(node) || []) {
      const c = color.get(next);
      if (c === GREY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };
  for (const node of nodes) {
    if (color.get(node) === WHITE && visit(node)) return true;
  }
  return false;
}
