import type { Color } from "@bindings/Color";
import type { ProjectId } from "@bindings/ProjectId";
import type { Schedule } from "@bindings/Schedule";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import type { TaskId } from "@bindings/TaskId";
import type { ProjectIndex } from "@lib/project/index";

import * as layout from "./layout";

const DAY_MINUTES = 1440;

export type ScheduleMode =
  | { kind: "today"; overflow: boolean }
  | { kind: "date"; date: string }
  | { kind: "template" };

export interface RankIndicator {
  projectRank: number | null;
  taskRank: number | null;
}

export type ItemPayload =
  | { kind: "inline"; label: string; description: string | null }
  | {
      kind: "task";
      taskId: TaskId;
      taskName: string;
      taskDescription: string | null;
      projectId: ProjectId;
      projectName: string;
      color: Color;
      completed: boolean;
      rank: RankIndicator | null;
    }
  | {
      kind: "noTask";
      projectId: ProjectId;
      projectName: string;
      projectColor: Color;
      projectHasTasks: boolean;
      rank: RankIndicator | null;
    }
  | { kind: "noProject"; rank: RankIndicator | null };

export interface ScheduleViewItem {
  id: ScheduleItemId;
  start: number;
  end: number;
  color: Color;
  payload: ItemPayload;
}

export interface ScheduleView {
  mode: ScheduleMode;
  schedule: Schedule | null;
  items: ScheduleViewItem[];
  nowMinute: number | null;
  validation: layout.LayoutResult;
}

// Resolve one item's payload via the inline → specific-task → specific-project
// → ranked-project chain. A specific completed task still resolves to a task
// (completed: true); other misses split into noTask (project known) / noProject.
export function item(projects: ProjectIndex, it: ScheduleItem): ItemPayload {
  if (it.useInline) {
    return {
      kind: "inline",
      label: it.inlineLabel ?? "",
      description: it.inlineDescription,
    };
  }
  if (it.taskId != null) {
    const task = projects.task(it.taskId);
    const project = task && projects.project(task.projectId);
    if (!task || !project) return { kind: "noProject", rank: null };
    return {
      kind: "task",
      taskId: task.id,
      taskName: task.name,
      taskDescription: task.description,
      projectId: project.id,
      projectName: project.name,
      color: project.color,
      completed: task.completedAt != null,
      rank: null,
    };
  }
  if (it.projectId != null) {
    return inProject(projects, it.projectId, it.taskRank, {
      projectRank: null,
      taskRank: it.taskRank,
    });
  }
  const rank: RankIndicator = {
    projectRank: it.projectRank,
    taskRank: it.taskRank,
  };
  const pid = projects.pickByRank(it.projectRank);
  if (pid == null) return { kind: "noProject", rank };
  return inProject(projects, pid, it.taskRank, rank);
}

// Pin the project/task an item resolves to now, immune to later rank shifts.
// Null for inline, already task-fixed, or unresolved items.
export function pin(projects: ProjectIndex, it: ScheduleItem): Partial<ScheduleItem> | null {
  if (it.useInline || it.taskId != null) return null;
  const projectId = it.projectId ?? projects.pickByRank(it.projectRank);
  if (projectId == null) return null;
  const task = projects.pickTaskByRank(projectId, it.taskRank);
  const patch: Partial<ScheduleItem> = {};
  if (it.projectId == null) patch.projectId = projectId;
  if (task) patch.taskId = task.id;
  return Object.keys(patch).length > 0 ? patch : null;
}

// Mode.Date(date): no live clock.
export function date(
  projects: ProjectIndex,
  schedule: Schedule,
  items: ScheduleItem[],
  date: string,
): ScheduleView {
  return assemble(projects, schedule, items, { kind: "date", date }, null);
}

// Mode.Template: no live clock.
export function template(
  projects: ProjectIndex,
  schedule: Schedule,
  items: ScheduleItem[],
): ScheduleView {
  return assemble(projects, schedule, items, { kind: "template" }, null);
}

// Yesterday-overflow wins while yesterday is still running: show it (shifted +1
// day) until now passes its hard end. Otherwise show today's schedule, else empty.
export function today(
  projects: ProjectIndex,
  todayData: [Schedule, ScheduleItem[]] | null,
  yesterdayData: [Schedule, ScheduleItem[]] | null,
  nowMinute: number,
): ScheduleView {
  if (yesterdayData) {
    const [schedule, items] = yesterdayData;
    if (nowMinute + DAY_MINUTES < schedule.end) {
      return assemble(
        projects,
        schedule,
        items,
        { kind: "today", overflow: true },
        nowMinute + DAY_MINUTES,
      );
    }
  }
  if (todayData) {
    const [schedule, items] = todayData;
    return assemble(
      projects,
      schedule,
      items,
      { kind: "today", overflow: false },
      nowMinute,
    );
  }
  return {
    mode: { kind: "today", overflow: false },
    schedule: null,
    items: [],
    nowMinute,
    validation: { ok: true, value: undefined },
  };
}

function inProject(
  projects: ProjectIndex,
  pid: ProjectId,
  taskRank: number,
  rank: RankIndicator,
): ItemPayload {
  const project = projects.project(pid);
  if (!project) return { kind: "noProject", rank };
  const task = projects.pickTaskByRank(pid, taskRank);
  if (task) {
    return {
      kind: "task",
      taskId: task.id,
      taskName: task.name,
      taskDescription: task.description,
      projectId: project.id,
      projectName: project.name,
      color: project.color,
      completed: false,
      rank,
    };
  }
  return {
    kind: "noTask",
    projectId: project.id,
    projectName: project.name,
    projectColor: project.color,
    projectHasTasks: projects.projectHasTasks(pid),
    rank,
  };
}

// Resolve each item, lay them out, and pair the surviving frames with payloads.
function assemble(
  projects: ProjectIndex,
  schedule: Schedule,
  rawItems: ScheduleItem[],
  mode: ScheduleMode,
  nowMinute: number | null,
): ScheduleView {
  const sorted = [...rawItems].sort(byPosition);
  const layoutItems = sorted.map(toLayoutItem);
  const span = { start: schedule.start, end: schedule.end };
  const frames = layout.compute(layoutItems, span);
  const validation = layout.validate(layoutItems, frames, span);
  const byId = new Map(sorted.map((it) => [it.id, it]));
  const items: ScheduleViewItem[] = [];
  for (const f of frames) {
    const raw = byId.get(f.id);
    if (!raw) continue;
    const payload = item(projects, raw);
    items.push({
      id: f.id,
      start: f.start,
      end: f.end,
      color: displayColor(raw, payload),
      payload,
    });
  }
  return { mode, schedule, items, nowMinute, validation };
}

// The color an item renders with: its project's for task/noTask, else its inline.
export function color(projects: ProjectIndex, it: ScheduleItem): Color {
  return displayColor(it, item(projects, it));
}

function displayColor(raw: ScheduleItem, payload: ItemPayload): Color {
  switch (payload.kind) {
    case "task":
      return payload.color;
    case "noTask":
      return payload.projectColor;
    case "inline":
    case "noProject":
      return raw.inlineColor;
  }
}

function toLayoutItem(it: ScheduleItem): layout.LayoutItem {
  return { id: it.id, bounds: it.bounds };
}

function byPosition(a: ScheduleItem, b: ScheduleItem): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
