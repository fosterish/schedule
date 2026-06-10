import { v7 as uuidv7 } from "uuid";

import type { Revisions } from "@bindings/Revisions";

// Client-minted, time-ordered ids. The branded *Id types are string aliases, so
// a uuid is directly assignable; this just names the intent at call sites.
export function newId(): string {
  return uuidv7();
}

// Placeholder revision for an optimistic row. The pending queue replays over the
// server-authoritative base in order (ops.apply ignores rev), and the server
// assigns the real per-user revision on flush, so the local value is inert.
export function localRev(): Revisions {
  return { updated: 0, deleted: null };
}
