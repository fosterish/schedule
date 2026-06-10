import type { Color } from "@bindings/Color";
import type { Dependency } from "@bindings/Dependency";
import type { Operation } from "@bindings/Operation";
import type { Project } from "@bindings/Project";
import type { ProjectId } from "@bindings/ProjectId";
import type { Task } from "@bindings/Task";
import type { TaskId } from "@bindings/TaskId";
import { keyBetween } from "@lib/fractional";
import * as proj from "@lib/project";

import { commit } from "../commit";
import { effectiveDependencies, effectiveProjects, effectiveTasks } from "../pending";
import { localRev, newId } from "../mint";
import { user } from "../session";

// Project/task/dependency mutations under the "projects" undo context. Composite
// intents mint ids/keys here; pure ordering and graph logic lives in lib/project.

const CTX = "project";

// --- projects ---

export function createProject(color: Color): ProjectId | null {
  const userId = user.value?.id;
  if (userId == null) return null;
  const id = newId();
  const row: Project = {
    id,
    userId,
    name: "",
    value: 1,
    time: 1,
    color,
    archivedAt: null,
    createdAt: Date.now(),
    rev: localRev(),
  };
  commit([{ kind: "upsert", model: { kind: "project", ...row } }], CTX);
  return id;
}

export function patchProject(id: ProjectId, patch: Partial<Project>): void {
  const row = effectiveProjects.value.find((p) => p.id === id);
  if (!row) return;
  commit([{ kind: "upsert", model: { kind: "project", ...row, ...patch } }], CTX);
}

export function toggleProjectArchived(id: ProjectId): void {
  const row = effectiveProjects.value.find((p) => p.id === id);
  if (!row) return;
  patchProject(id, { archivedAt: row.archivedAt == null ? Date.now() : null });
}

// Remove a project and everything under it: its tasks and any dependency that
// references one of those tasks.
export function deleteProject(id: ProjectId): void {
  const taskIds = new Set(effectiveTasks.value.filter((t) => t.projectId === id).map((t) => t.id));
  const ops: Operation[] = [];
  for (const d of effectiveDependencies.value) {
    if (taskIds.has(d.blockedId) || taskIds.has(d.blockerId)) {
      ops.push(deleteDep(d.blockedId, d.blockerId));
    }
  }
  for (const tid of taskIds) ops.push({ kind: "delete", ref: { kind: "task", id: tid } });
  ops.push({ kind: "delete", ref: { kind: "project", id } });
  commit(ops, CTX);
}

// --- tasks ---

export function createTask(projectId: ProjectId): TaskId | null {
  if (user.value == null) return null;
  const id = newId();
  const siblings = tasksOf(projectId);
  const last = siblings[siblings.length - 1]?.listOrder ?? null;
  const row: Task = {
    id,
    projectId,
    name: "",
    description: null,
    listOrder: keyBetween(last, null),
    completedAt: null,
    createdAt: Date.now(),
    rev: localRev(),
  };
  commit([{ kind: "upsert", model: { kind: "task", ...row } }], CTX);
  return id;
}

export function patchTask(id: TaskId, patch: Partial<Task>): void {
  const row = effectiveTasks.value.find((t) => t.id === id);
  if (!row) return;
  commit([{ kind: "upsert", model: { kind: "task", ...row, ...patch } }], CTX);
}

export function toggleTaskComplete(id: TaskId): void {
  const row = effectiveTasks.value.find((t) => t.id === id);
  if (!row) return;
  patchTask(id, { completedAt: row.completedAt == null ? Date.now() : null });
}

export function deleteTask(id: TaskId): void {
  const ops: Operation[] = [];
  for (const d of effectiveDependencies.value) {
    if (d.blockedId === id || d.blockerId === id) ops.push(deleteDep(d.blockedId, d.blockerId));
  }
  ops.push({ kind: "delete", ref: { kind: "task", id } });
  commit(ops, CTX);
}

// Remove every completed task in a project (and their dependencies) in one commit.
export function deleteCompletedTasks(projectId: ProjectId): void {
  const ids = new Set(
    effectiveTasks.value.filter((t) => t.projectId === projectId && t.completedAt != null).map((t) => t.id),
  );
  if (ids.size === 0) return;
  const ops: Operation[] = [];
  for (const d of effectiveDependencies.value) {
    if (ids.has(d.blockedId) || ids.has(d.blockerId)) ops.push(deleteDep(d.blockedId, d.blockerId));
  }
  for (const id of ids) ops.push({ kind: "delete", ref: { kind: "task", id } });
  commit(ops, CTX);
}

// Reposition a task after `afterId` (null = head) in listOrder space.
export function reorderTask(projectId: ProjectId, id: TaskId, afterId: TaskId | null): void {
  const seq = tasksOf(projectId).filter((t) => t.id !== id);
  const before = afterId == null ? null : (seq.find((t) => t.id === afterId)?.listOrder ?? null);
  const i = afterId == null ? -1 : seq.findIndex((t) => t.id === afterId);
  const after = afterId == null ? (seq[0]?.listOrder ?? null) : (seq[i + 1]?.listOrder ?? null);
  patchTask(id, { listOrder: keyBetween(before, after) });
}

// --- dependencies ---

export interface DepKey {
  blockedId: TaskId;
  blockerId: TaskId;
}

// Add an edge, reordering the task list so every blocker precedes its blocked
// task. Returns false (committing nothing) if the edge would close a cycle.
export function addDependency(blockedId: TaskId, blockerId: TaskId): boolean {
  return changeDeps(null, { blockedId, blockerId });
}

// Swap one edge for another atomically (used to retarget or flip a row).
export function replaceDependency(remove: DepKey, add: DepKey): boolean {
  return changeDeps(remove, add);
}

export function removeDependency(blockedId: TaskId, blockerId: TaskId): void {
  changeDeps({ blockedId, blockerId }, null);
}

// --- helpers ---

function tasksOf(projectId: ProjectId): Task[] {
  return effectiveTasks.value
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (a.listOrder < b.listOrder ? -1 : a.listOrder > b.listOrder ? 1 : 0));
}

// Single mutation path for edge add/remove/replace: rejects cycles on add, then
// commits the row change plus the minimal task moves that satisfy the new DAG.
function changeDeps(remove: DepKey | null, add: DepKey | null): boolean {
  const anchor = add ?? remove;
  if (!anchor) return false;
  const projectId = effectiveTasks.value.find((t) => t.id === anchor.blockedId)?.projectId;
  if (projectId == null) return false;

  const taskIds = new Set(tasksOf(projectId).map((t) => t.id));
  const result: Dependency[] = [];
  for (const d of effectiveDependencies.value) {
    if (!taskIds.has(d.blockedId) || !taskIds.has(d.blockerId)) continue;
    if (remove && d.blockedId === remove.blockedId && d.blockerId === remove.blockerId) continue;
    if (add && d.blockedId === add.blockedId && d.blockerId === add.blockerId) continue;
    result.push(d);
  }
  if (add) result.push({ blockedId: add.blockedId, blockerId: add.blockerId, rev: localRev() });

  const edges = proj.graph.edgesFromDeps(result);
  if (add && proj.graph.hasCycle(edges)) return false;

  const ops: Operation[] = [];
  if (remove) ops.push(deleteDep(remove.blockedId, remove.blockerId));
  if (add) {
    ops.push({ kind: "upsert", model: { kind: "dependency", blockedId: add.blockedId, blockerId: add.blockerId, rev: localRev() } });
  }
  ops.push(...reorderOps(projectId, edges));
  commit(ops, CTX);
  return true;
}

// Minimal listOrder rewrites to make `edges` forward-pointing, preserving the
// user's order wherever the DAG allows (stable topo sort).
function reorderOps(projectId: ProjectId, edges: proj.graph.Edge[]): Operation[] {
  const work = tasksOf(projectId).map((t) => ({ id: t.id, key: t.listOrder, row: t }));
  const currentIds = work.map((w) => w.id);
  const target = proj.graph.sortByDeps(currentIds, edges);
  const ops: Operation[] = [];
  for (const move of proj.reorder.transform(currentIds, target)) {
    const idx = work.findIndex((w) => w.id === move.id);
    if (idx < 0) continue;
    const [item] = work.splice(idx, 1);
    if (!item) continue;
    const afterIdx = move.afterId == null ? -1 : work.findIndex((w) => w.id === move.afterId);
    const before = afterIdx < 0 ? null : work[afterIdx]!.key;
    const after = work[afterIdx + 1]?.key ?? null;
    item.key = keyBetween(before, after);
    work.splice(afterIdx + 1, 0, item);
    ops.push({ kind: "upsert", model: { kind: "task", ...item.row, listOrder: item.key } });
  }
  return ops;
}

function deleteDep(blockedId: TaskId, blockerId: TaskId): Operation {
  return { kind: "delete", ref: { kind: "dependency", id: { blocked: blockedId, blocker: blockerId } } };
}
