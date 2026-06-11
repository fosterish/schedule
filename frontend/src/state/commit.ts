import type { Operation } from "@bindings/Operation";
import type { Snapshot } from "@bindings/Snapshot";
import * as db from "@data/db";
import * as sync from "@data/sync";
import * as ops from "@lib/ops";

import * as base from "./base";
import * as history from "./history";
import { pending, effectiveSnapshot } from "./pending";
import { requestSync } from "./syncer";

// The single mutator: optimistically apply a batch and record its inverse for
// undo. Composites are already expanded to an Operation[] by the lib layer.
export function commit(batchOps: Operation[], context: history.Context): void {
  if (batchOps.length === 0) return;
  history.recordUndo(context, applyAndEnqueue(batchOps));
}

export function undo(context: history.Context): void {
  const entry = history.popUndo(context);
  if (entry) history.pushRedo(context, applyAndEnqueue(entry));
}

export function redo(context: history.Context): void {
  const entry = history.popRedo(context);
  if (entry) history.pushUndo(context, applyAndEnqueue(entry));
}

// Boot: hydrate base + queue from IndexedDB so the first paint needs no network.
export async function hydrate(): Promise<void> {
  base.setBase(await db.loadBase(), await db.getVersion());
  pending.value = (await db.loadPending()).map((e) => e.op);
}

// Logout: drop the in-memory mirror so the next account starts clean. The cache
// itself survives on disk (see data/db setActiveUser).
export function reset(): void {
  base.clearBase();
  pending.value = [];
  history.clear();
}

// Flush the queue, pull, and refresh the signals from the reconciled stores.
// Offline leaves the queue intact for next time.
export async function synchronize(): Promise<void> {
  const { base: merged, version } = await sync.synchronize();
  base.setBase(merged, version);
  pending.value = (await db.loadPending()).map((e) => e.op);
}

// Apply the batch to the queue and return the inverse that undoes it. The
// inverse of each op is taken against the state just before it, then reversed,
// so replaying the result walks back through the batch exactly.
function applyAndEnqueue(batchOps: Operation[]): Operation[] {
  const working = clone(effectiveSnapshot());
  const inverse: Operation[] = [];
  for (const op of batchOps) {
    inverse.push(ops.invert(op, working));
    ops.apply(op, working);
  }
  inverse.reverse();

  pending.value = [...pending.value, ...batchOps];
  for (const op of batchOps) void db.appendPending(op);
  requestSync();
  return inverse;
}

function clone(snap: Snapshot): Snapshot {
  return {
    version: snap.version,
    projects: [...snap.projects],
    tasks: [...snap.tasks],
    dependencies: [...snap.dependencies],
    schedules: [...snap.schedules],
    items: [...snap.items],
    bindings: [...snap.bindings],
    templates: [...snap.templates],
    settings: [...snap.settings],
  };
}
