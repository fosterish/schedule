import type { Model } from "@bindings/Model";
import type { ModelRef } from "@bindings/ModelRef";
import type { Operation } from "@bindings/Operation";
import type { Snapshot } from "@bindings/Snapshot";

// State-based, per-row mutation: an Upsert writes one row's full state, a Delete
// removes it. Composites (reorder, run, cascades) expand to an Operation[] of
// these; per-row LWW on rev.updated resolves them on sync.

// Optimistic local apply: upsert replaces-or-inserts the row, delete drops it.
// Mutates `snap` in place (the effective view; tombstones live in data/sync).
export function apply(op: Operation, snap: Snapshot): void {
  if (op.kind === "upsert") applyUpsert(snap, op.model);
  else applyDelete(snap, op.ref);
}

// The inverse op for the undo stack, read against the pre-apply snapshot.
// Upsert ⇒ restore the prior row, or delete it if it was new. Delete ⇒ restore
// the row with its tombstone cleared.
export function invert(op: Operation, before: Snapshot): Operation {
  if (op.kind === "upsert") {
    const ref = refOf(op.model);
    const prior = findModel(before, ref);
    return prior ? { kind: "upsert", model: prior } : { kind: "delete", ref };
  }
  const prior = findModel(before, op.ref);
  if (!prior) return op; // nothing to restore: a delete of an absent row is inert
  return { kind: "upsert", model: clearDeleted(prior) };
}

// The delete target identifying a model's row.
export function refOf(model: Model): ModelRef {
  switch (model.kind) {
    case "project":
      return { kind: "project", id: model.id };
    case "task":
      return { kind: "task", id: model.id };
    case "dependency":
      return {
        kind: "dependency",
        id: { blocked: model.blockedId, blocker: model.blockerId },
      };
    case "schedule":
      return { kind: "schedule", id: model.id };
    case "scheduleItem":
      return { kind: "scheduleItem", id: model.id };
    case "scheduleBinding":
      return { kind: "scheduleBinding", id: model.date };
    case "template":
      return { kind: "template", id: model.scheduleId };
    case "settings":
      return { kind: "settings", id: model.userId };
    default: {
      const never: never = model;
      return never;
    }
  }
}

function applyUpsert(snap: Snapshot, model: Model): void {
  switch (model.kind) {
    case "project":
      put(snap.projects, withoutKind(model), (r) => r.id === model.id);
      break;
    case "task":
      put(snap.tasks, withoutKind(model), (r) => r.id === model.id);
      break;
    case "dependency":
      put(
        snap.dependencies,
        withoutKind(model),
        (r) => r.blockedId === model.blockedId && r.blockerId === model.blockerId,
      );
      break;
    case "schedule":
      put(snap.schedules, withoutKind(model), (r) => r.id === model.id);
      break;
    case "scheduleItem":
      put(snap.items, withoutKind(model), (r) => r.id === model.id);
      break;
    case "scheduleBinding":
      put(snap.bindings, withoutKind(model), (r) => r.date === model.date);
      break;
    case "template":
      put(snap.templates, withoutKind(model), (r) => r.scheduleId === model.scheduleId);
      break;
    case "settings":
      put(snap.settings, withoutKind(model), (r) => r.userId === model.userId);
      break;
    default: {
      const never: never = model;
      void never;
    }
  }
}

function applyDelete(snap: Snapshot, ref: ModelRef): void {
  switch (ref.kind) {
    case "project":
      snap.projects = snap.projects.filter((r) => r.id !== ref.id);
      break;
    case "task":
      snap.tasks = snap.tasks.filter((r) => r.id !== ref.id);
      break;
    case "dependency":
      snap.dependencies = snap.dependencies.filter(
        (r) => !(r.blockedId === ref.id.blocked && r.blockerId === ref.id.blocker),
      );
      break;
    case "schedule":
      snap.schedules = snap.schedules.filter((r) => r.id !== ref.id);
      break;
    case "scheduleItem":
      snap.items = snap.items.filter((r) => r.id !== ref.id);
      break;
    case "scheduleBinding":
      snap.bindings = snap.bindings.filter((r) => r.date !== ref.id);
      break;
    case "template":
      snap.templates = snap.templates.filter((r) => r.scheduleId !== ref.id);
      break;
    case "settings":
      snap.settings = snap.settings.filter((r) => r.userId !== ref.id);
      break;
    default: {
      const never: never = ref;
      void never;
    }
  }
}

// The row at `ref`, wrapped back into a Model, or null if absent.
function findModel(snap: Snapshot, ref: ModelRef): Model | null {
  switch (ref.kind) {
    case "project": {
      const r = snap.projects.find((x) => x.id === ref.id);
      return r ? { kind: "project", ...r } : null;
    }
    case "task": {
      const r = snap.tasks.find((x) => x.id === ref.id);
      return r ? { kind: "task", ...r } : null;
    }
    case "dependency": {
      const r = snap.dependencies.find(
        (x) => x.blockedId === ref.id.blocked && x.blockerId === ref.id.blocker,
      );
      return r ? { kind: "dependency", ...r } : null;
    }
    case "schedule": {
      const r = snap.schedules.find((x) => x.id === ref.id);
      return r ? { kind: "schedule", ...r } : null;
    }
    case "scheduleItem": {
      const r = snap.items.find((x) => x.id === ref.id);
      return r ? { kind: "scheduleItem", ...r } : null;
    }
    case "scheduleBinding": {
      const r = snap.bindings.find((x) => x.date === ref.id);
      return r ? { kind: "scheduleBinding", ...r } : null;
    }
    case "template": {
      const r = snap.templates.find((x) => x.scheduleId === ref.id);
      return r ? { kind: "template", ...r } : null;
    }
    case "settings": {
      const r = snap.settings.find((x) => x.userId === ref.id);
      return r ? { kind: "settings", ...r } : null;
    }
    default: {
      const never: never = ref;
      return never;
    }
  }
}

function clearDeleted(model: Model): Model {
  return { ...model, rev: { ...model.rev, deleted: null } };
}

function put<T>(arr: T[], row: T, match: (r: T) => boolean): void {
  const i = arr.findIndex(match);
  if (i >= 0) arr[i] = row;
  else arr.push(row);
}

function withoutKind<T extends { kind: unknown }>(model: T): Omit<T, "kind"> {
  const row: Record<string, unknown> = { ...model };
  delete row.kind;
  return row as Omit<T, "kind">;
}
