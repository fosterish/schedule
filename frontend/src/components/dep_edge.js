// Edges stored as (blocked_id, blocker_id). This helper maps the popup's blocked_by/blocking view onto that single directed edge.

export const DEP_BLOCKED_BY = "blocked_by";
export const DEP_BLOCKING = "blocking";

// Map (type, thisId, otherId) → stored edge {blockedId, blockerId}; api.addDep/removeDep consume it directly.
export function depEdge(type, thisId, otherId) {
  if (type === DEP_BLOCKING) {
    return { blockedId: otherId, blockerId: thisId };
  }
  return { blockedId: thisId, blockerId: otherId };
}
