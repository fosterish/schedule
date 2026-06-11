import type { ModelRef } from "@bindings/ModelRef";
import type { Operation } from "@bindings/Operation";
import type { Rejection } from "@bindings/Rejection";
import type { Revisions } from "@bindings/Revisions";
import type { Snapshot } from "@bindings/Snapshot";
import type { SyncResult } from "@bindings/SyncResult";
import * as ops from "@lib/ops";

import * as accounts from "./accounts";
import * as api from "./api";
import * as db from "./db";
import type { BaseTables, PendingEntry } from "./db";

export interface PullOutcome {
  base: BaseTables;
  version: number;
}

export interface FlushOutcome {
  rejected: Rejection[];
  needsPull: boolean;
}

// Flush the queue, then pull to converge with other devices and fetch
// authoritative state for any rejected ops. The single entry point.
export async function synchronize(): Promise<PullOutcome> {
  await flush();
  const outcome = await pull();
  const id = db.activeUser();
  if (id) accounts.touch(id);
  return outcome;
}

// Push the pending queue; drop the resolved ops. Does not advance the version
// cursor: applied rows enter the base only via `pull`, which owns the cursor.
// Background Sync calls this alone on reconnect; foreground convergence is `pull`.
export async function flush(): Promise<FlushOutcome> {
  const sent = await db.loadPending();
  if (sent.length === 0) return { rejected: [], needsPull: false };
  const since = await db.getVersion();
  const result = await api.postSync({ since, ops: sent.map((e) => e.op) });
  const { resolvedSeqs, needsPull } = planFlush(sent, result);
  await db.deletePending(resolvedSeqs);
  return { rejected: result.rejected, needsPull };
}

// Pull from the version cursor and LWW-merge into the persisted base.
export async function pull(): Promise<PullOutcome> {
  const since = await db.getVersion();
  const delta = await api.getSnapshot(since);
  // since=0 is the full live dataset (no tombstones), so it replaces the base;
  // a delta merges row-by-row.
  const base =
    since > 0 ? mergeSnapshot(await db.loadBase(), delta) : tablesOf(delta);
  await db.persistBase(base);
  await db.setVersion(delta.version);
  return { base, version: delta.version };
}

// Per-row LWW merge of a delta into the base: a strictly newer incoming row
// wins (tombstones remove it, otherwise it replaces); stale rows are ignored.
export function mergeSnapshot(base: BaseTables, delta: Snapshot): BaseTables {
  return {
    projects: mergeTable(base.projects, delta.projects, (p) => p.id),
    tasks: mergeTable(base.tasks, delta.tasks, (t) => t.id),
    dependencies: mergeTable(
      base.dependencies,
      delta.dependencies,
      (d) => `${d.blockedId}\u0000${d.blockerId}`,
    ),
    schedules: mergeTable(base.schedules, delta.schedules, (s) => s.id),
    items: mergeTable(base.items, delta.items, (i) => i.id),
    bindings: mergeTable(base.bindings, delta.bindings, (b) => b.date),
    templates: mergeTable(base.templates, delta.templates, (t) => t.scheduleId),
    settings: mergeTable(base.settings, delta.settings, (s) => s.userId),
  };
}

// Decide which sent ops the server resolved (applied or rejected) so they leave
// the queue, and whether a rejection warrants an immediate re-pull.
export function planFlush(
  sent: PendingEntry[],
  result: SyncResult,
): { resolvedSeqs: number[]; needsPull: boolean } {
  const resolved = new Set<string>();
  for (const ref of result.applied) resolved.add(refKey(ref));
  for (const r of result.rejected) resolved.add(refKey(r.target));
  const resolvedSeqs = sent
    .filter((e) => resolved.has(refKey(refOf(e.op))))
    .map((e) => e.seq);
  return { resolvedSeqs, needsPull: result.rejected.length > 0 };
}

function mergeTable<T extends { rev: Revisions }>(
  current: T[],
  incoming: T[],
  keyOf: (row: T) => string,
): T[] {
  const map = new Map(current.map((r) => [keyOf(r), r]));
  for (const row of incoming) {
    const k = keyOf(row);
    const existing = map.get(k);
    if (existing && existing.rev.updated >= row.rev.updated) continue;
    if (row.rev.deleted != null) map.delete(k);
    else map.set(k, row);
  }
  return [...map.values()];
}

function refOf(op: Operation): ModelRef {
  return op.kind === "upsert" ? ops.refOf(op.model) : op.ref;
}

function refKey(ref: ModelRef): string {
  return ref.kind === "dependency"
    ? `dependency:${ref.id.blocked}:${ref.id.blocker}`
    : `${ref.kind}:${ref.id}`;
}

function tablesOf(s: Snapshot): BaseTables {
  return {
    projects: s.projects,
    tasks: s.tasks,
    dependencies: s.dependencies,
    schedules: s.schedules,
    items: s.items,
    bindings: s.bindings,
    templates: s.templates,
    settings: s.settings,
  };
}
