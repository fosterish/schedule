import type { Dependency } from "@bindings/Dependency";
import type { Project } from "@bindings/Project";
import type { ProjectId } from "@bindings/ProjectId";
import type { Task } from "@bindings/Task";
import type { TaskId } from "@bindings/TaskId";

import { compareTaskOrder } from "./tasks";

export * as graph from "./graph";
export * as reorder from "./reorder";
export * as tasks from "./tasks";

// In-memory resolution index over one user's effective rows: owns project
// ranking and task eligibility. Point-in-time; rebuild when the rows change.
export class ProjectIndex {
  private readonly projectsById = new Map<ProjectId, Project>();
  private readonly tasksById = new Map<TaskId, Task>();
  // Task ids per project, sorted (listOrder, id).
  private readonly tasksByProject = new Map<ProjectId, TaskId[]>();
  private readonly blockersByBlocked = new Map<TaskId, TaskId[]>();
  private readonly rankedProjectIds: ProjectId[];

  constructor(projects: Project[], tasks: Task[], deps: Dependency[]) {
    for (const p of projects) this.projectsById.set(p.id, p);
    for (const t of tasks) {
      this.tasksById.set(t.id, t);
      const list = this.tasksByProject.get(t.projectId);
      if (list) list.push(t.id);
      else this.tasksByProject.set(t.projectId, [t.id]);
    }
    for (const ids of this.tasksByProject.values()) {
      ids.sort((a, b) => {
        const ta = this.tasksById.get(a);
        const tb = this.tasksById.get(b);
        return ta && tb ? compareTaskOrder(ta, tb) : 0;
      });
    }
    for (const d of deps) {
      const list = this.blockersByBlocked.get(d.blockedId);
      if (list) list.push(d.blockerId);
      else this.blockersByBlocked.set(d.blockedId, [d.blockerId]);
    }
    this.rankedProjectIds = [...this.projectsById.values()]
      .filter((p) => p.archivedAt == null)
      .sort(compareProjectRank)
      .map((p) => p.id);
  }

  // 1-indexed into the ranked projects.
  pickByRank(rank: number): ProjectId | null {
    if (rank < 1) return null;
    return this.rankedProjectIds[rank - 1] ?? null;
  }

  // Non-archived projects in priority order.
  rankedProjects(): Project[] {
    return this.rankedProjectIds.map((id) => this.projectsById.get(id)!);
  }

  // A project's tasks in rank (listOrder, id) order.
  projectTasks(project: ProjectId): Task[] {
    const ids = this.tasksByProject.get(project) ?? [];
    return ids.map((id) => this.tasksById.get(id)!);
  }

  // rank-th eligible task in (listOrder, id) order.
  pickTaskByRank(project: ProjectId, rank: number): Task | null {
    if (rank < 1) return null;
    const ids = this.tasksByProject.get(project);
    if (!ids) return null;
    let count = 0;
    for (const id of ids) {
      const task = this.tasksById.get(id);
      if (!task || task.completedAt != null) continue;
      if (this.taskHasBlockers(task)) continue;
      if (++count === rank) return task;
    }
    return null;
  }

  project(id: ProjectId): Project | null {
    return this.projectsById.get(id) ?? null;
  }

  task(id: TaskId): Task | null {
    return this.tasksById.get(id) ?? null;
  }

  projectHasTasks(id: ProjectId): boolean {
    return (this.tasksByProject.get(id)?.length ?? 0) > 0;
  }

  // Any blocker still incomplete (a missing blocker counts as blocking).
  taskHasBlockers(task: Task): boolean {
    const blockers = this.blockersByBlocked.get(task.id);
    if (!blockers) return false;
    return blockers.some((b) => {
      const bt = this.tasksById.get(b);
      return !bt || bt.completedAt == null;
    });
  }
}

// Non-archived: value/time DESC (zero time sorts last), createdAt ASC, id ASC.
function compareProjectRank(a: Project, b: Project): number {
  const ra = a.time === 0 ? null : a.value / a.time;
  const rb = b.time === 0 ? null : b.value / b.time;
  const primary =
    ra === null && rb === null
      ? 0
      : ra === null
        ? 1
        : rb === null
          ? -1
          : rb - ra;
  if (primary !== 0) return primary;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
