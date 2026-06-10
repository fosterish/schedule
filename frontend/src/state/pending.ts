import { computed, signal } from "@preact/signals";

import type { Operation } from "@bindings/Operation";
import type { Snapshot } from "@bindings/Snapshot";
import * as ops from "@lib/ops";

import * as base from "./base";

// Unacked optimistic ops, in apply order. Mirrors the IndexedDB queue.
export const pending = signal<Operation[]>([]);

// Base replayed through the pending queue: the snapshot the UI actually reads.
// ops.apply mutates its argument, so we hand it fresh arrays over the base rows.
const effective = computed<Snapshot>(() => {
  const snap: Snapshot = {
    version: base.version.value,
    projects: [...base.projects.value],
    tasks: [...base.tasks.value],
    dependencies: [...base.dependencies.value],
    schedules: [...base.schedules.value],
    items: [...base.items.value],
    bindings: [...base.bindings.value],
    templates: [...base.templates.value],
  };
  for (const op of pending.value) ops.apply(op, snap);
  return snap;
});

export const effectiveProjects = computed(() => effective.value.projects);
export const effectiveTasks = computed(() => effective.value.tasks);
export const effectiveDependencies = computed(() => effective.value.dependencies);
export const effectiveSchedules = computed(() => effective.value.schedules);
export const effectiveItems = computed(() => effective.value.items);
export const effectiveBindings = computed(() => effective.value.bindings);
export const effectiveTemplates = computed(() => effective.value.templates);

// The effective snapshot, for computing op inverses at commit time.
export function effectiveSnapshot(): Snapshot {
  return effective.value;
}
