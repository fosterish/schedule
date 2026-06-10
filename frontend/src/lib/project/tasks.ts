import type { Task } from "@bindings/Task";

// Incomplete first, completed second; relative order preserved within each.
export function partitionByCompletion(tasks: Iterable<Task>): [Task[], Task[]] {
  const incomplete: Task[] = [];
  const completed: Task[] = [];
  for (const t of tasks) (t.completedAt != null ? completed : incomplete).push(t);
  return [incomplete, completed];
}

// List position, ties broken by id, matching the backend's resolution order.
export function compareTaskOrder(a: Task, b: Task): number {
  if (a.listOrder !== b.listOrder) return a.listOrder < b.listOrder ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
