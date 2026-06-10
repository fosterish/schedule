import type { Dependency } from "@bindings/Dependency";
import type { TaskId } from "@bindings/TaskId";

// blocker -> blocked.
export interface Edge {
  from: TaskId;
  to: TaskId;
}

// "blocks": self is the blocker; "blockedBy": self is the blocked task.
export type DepDirection = "blocks" | "blockedBy";

export function edgesFromDeps(deps: Iterable<Dependency>): Edge[] {
  const edges: Edge[] = [];
  for (const d of deps) edges.push({ from: d.blockerId, to: d.blockedId });
  return edges;
}

export function edgeFromDep(
  dir: DepDirection,
  selfId: TaskId,
  otherId: TaskId,
): Edge {
  return dir === "blocks"
    ? { from: selfId, to: otherId }
    : { from: otherId, to: selfId };
}

// Stable topological order: among unblocked nodes pick the earliest in
// `ordered`, so the user's order survives wherever deps allow. A cycle bails
// to a defensive append of the remaining ids.
export function sortByDeps(ordered: TaskId[], edges: Edge[]): TaskId[] {
  const ids = [...ordered];
  const present = new Set(ids);
  const adj = new Map<TaskId, TaskId[]>(ids.map((id) => [id, []]));
  const indeg = new Map<TaskId, number>(ids.map((id) => [id, 0]));
  for (const { from, to } of edges) {
    if (!present.has(from) || !present.has(to)) continue;
    adj.get(from)?.push(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }
  const used = new Set<TaskId>();
  const result: TaskId[] = [];
  while (result.length < ids.length) {
    const pick = ids.find((id) => !used.has(id) && indeg.get(id) === 0);
    if (pick === undefined) break;
    used.add(pick);
    result.push(pick);
    for (const to of adj.get(pick) ?? []) indeg.set(to, (indeg.get(to) ?? 0) - 1);
  }
  if (result.length < ids.length) {
    for (const id of ids) if (!used.has(id)) result.push(id);
  }
  return result;
}

// Ids whose edge with `dragged` is violated at its current position; the UI
// dull-reds these rows during a drag.
export function getDragViolations(
  ordered: TaskId[],
  dragged: TaskId,
  edges: Edge[],
): TaskId[] {
  const pos = positions(ordered);
  const di = pos.get(dragged);
  if (di === undefined) return [];
  const out = new Set<TaskId>();
  for (const { from, to } of edges) {
    const f = pos.get(from);
    const t = pos.get(to);
    if (f === undefined || t === undefined) continue;
    if (from === dragged && t < di) out.add(to);
    if (to === dragged && f > di) out.add(from);
  }
  return [...out];
}

// DFS three-coloring. Test a candidate edge by appending it before calling.
export function hasCycle(edges: Edge[]): boolean {
  const adj = buildAdj(edges);
  const nodes = new Set<TaskId>();
  for (const { from, to } of edges) {
    nodes.add(from);
    nodes.add(to);
  }
  const color = new Map<TaskId, "grey" | "black">();
  const visit = (node: TaskId): boolean => {
    color.set(node, "grey");
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next);
      if (c === "grey") return true;
      if (c === undefined && visit(next)) return true;
    }
    color.set(node, "black");
    return false;
  };
  for (const node of nodes) {
    if (color.get(node) === undefined && visit(node)) return true;
  }
  return false;
}

function positions(ordered: TaskId[]): Map<TaskId, number> {
  return new Map(ordered.map((id, i) => [id, i]));
}

function buildAdj(edges: Edge[]): Map<TaskId, TaskId[]> {
  const adj = new Map<TaskId, TaskId[]>();
  for (const { from, to } of edges) {
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  return adj;
}
