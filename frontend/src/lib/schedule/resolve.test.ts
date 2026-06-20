import { describe, expect, test } from "vitest";

import type { Project } from "@bindings/Project";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { Schedule } from "@bindings/Schedule";
import type { Task } from "@bindings/Task";
import * as project from "@lib/project";
import * as resolve from "@lib/schedule/resolve";

function proj(p: Partial<Project> & { id: string }): Project {
  return {
    id: p.id,
    userId: "u1",
    name: p.name ?? p.id,
    value: p.value ?? 1,
    time: p.time ?? 1,
    color: p.color ?? "blue",
    archivedAt: null,
    createdAt: p.createdAt ?? 0,
    rev: { updated: 1, deleted: null },
  };
}

function task(t: Partial<Task> & { id: string; projectId: string }): Task {
  return {
    id: t.id,
    projectId: t.projectId,
    name: t.name ?? t.id,
    description: t.description ?? null,
    listOrder: t.listOrder ?? "a0",
    completedAt: t.completedAt ?? null,
    createdAt: 0,
    rev: { updated: 1, deleted: null },
  };
}

function sitem(o: Partial<ScheduleItem> & { id: string }): ScheduleItem {
  return {
    id: o.id,
    scheduleId: "s1",
    position: o.position ?? "a0",
    bounds: o.bounds ?? {
      start: null,
      end: null,
      fixedDuration: null,
      durationTarget: 60,
    },
    useInline: o.useInline ?? false,
    inlineLabel: o.inlineLabel ?? null,
    inlineDescription: o.inlineDescription ?? null,
    inlineColor: o.inlineColor ?? "blue",
    projectId: o.projectId ?? null,
    projectRank: o.projectRank ?? 1,
    taskId: o.taskId ?? null,
    taskRank: o.taskRank ?? 1,
    rev: { updated: 1, deleted: null },
  };
}

const schedule: Schedule = {
  id: "s1",
  userId: "u1",
  name: "Day",
  start: 480,
  end: 1320,
  rev: { updated: 1, deleted: null },
};

const index = () =>
  new project.ProjectIndex(
    [proj({ id: "p", color: "lime", value: 4, time: 1 })],
    [
      task({ id: "t1", projectId: "p", listOrder: "a0" }),
      task({ id: "done", projectId: "p", listOrder: "a1", completedAt: 9 }),
    ],
    [],
  );

describe("item payload chain", () => {
  test("inline", () => {
    const p = resolve.item(
      index(),
      sitem({ id: "i", useInline: true, inlineLabel: "Lunch" }),
    );
    expect(p).toEqual({ kind: "inline", label: "Lunch", description: null });
  });

  test("specific task, incomplete", () => {
    const p = resolve.item(index(), sitem({ id: "i", taskId: "t1" }));
    expect(p.kind).toBe("task");
    if (p.kind === "task") {
      expect(p.taskId).toBe("t1");
      expect(p.completed).toBe(false);
      expect(p.color).toBe("lime");
      expect(p.rank).toBeNull();
    }
  });

  test("specific completed task resolves to task with completed: true", () => {
    const p = resolve.item(index(), sitem({ id: "i", taskId: "done" }));
    expect(p.kind).toBe("task");
    if (p.kind === "task") expect(p.completed).toBe(true);
  });

  test("specific missing task -> noProject", () => {
    const p = resolve.item(index(), sitem({ id: "i", taskId: "ghost" }));
    expect(p).toEqual({ kind: "noProject", rank: null });
  });

  test("specific project picks ranked eligible task", () => {
    const p = resolve.item(index(), sitem({ id: "i", projectId: "p", taskRank: 1 }));
    expect(p.kind).toBe("task");
    if (p.kind === "task") expect(p.rank).toEqual({ projectRank: null, taskRank: 1 });
  });

  test("specific project, no eligible task -> noTask", () => {
    const p = resolve.item(index(), sitem({ id: "i", projectId: "p", taskRank: 2 }));
    expect(p.kind).toBe("noTask");
    if (p.kind === "noTask") {
      expect(p.projectHasTasks).toBe(true);
      expect(p.rank).toEqual({ projectRank: null, taskRank: 2 });
    }
  });

  test("ranked project + task", () => {
    const p = resolve.item(
      index(),
      sitem({ id: "i", projectRank: 1, taskRank: 1 }),
    );
    expect(p.kind).toBe("task");
    if (p.kind === "task") expect(p.rank).toEqual({ projectRank: 1, taskRank: 1 });
  });

  test("rank past the last project -> noProject", () => {
    const p = resolve.item(
      index(),
      sitem({ id: "i", projectRank: 5, taskRank: 1 }),
    );
    expect(p).toEqual({ kind: "noProject", rank: { projectRank: 5, taskRank: 1 } });
  });
});

describe("pin", () => {
  test("inline item: no change", () => {
    expect(resolve.pin(index(), sitem({ id: "i", useInline: true }))).toBeNull();
  });

  test("already task-fixed: no change", () => {
    expect(resolve.pin(index(), sitem({ id: "i", taskId: "t1" }))).toBeNull();
  });

  test("ranked project + task: pins both ids", () => {
    expect(resolve.pin(index(), sitem({ id: "i", projectRank: 1, taskRank: 1 }))).toEqual({
      projectId: "p",
      taskId: "t1",
    });
  });

  test("fixed project, ranked task: pins only the task id", () => {
    expect(resolve.pin(index(), sitem({ id: "i", projectId: "p", taskRank: 1 }))).toEqual({
      taskId: "t1",
    });
  });

  test("fixed project, no eligible task: nothing to pin", () => {
    expect(resolve.pin(index(), sitem({ id: "i", projectId: "p", taskRank: 2 }))).toBeNull();
  });

  test("ranked project with no eligible task: pins only the project id", () => {
    expect(resolve.pin(index(), sitem({ id: "i", projectRank: 1, taskRank: 2 }))).toEqual({
      projectId: "p",
    });
  });

  test("rank past the last project: nothing to pin", () => {
    expect(resolve.pin(index(), sitem({ id: "i", projectRank: 5 }))).toBeNull();
  });
});

describe("views", () => {
  const items = [
    sitem({
      id: "a",
      position: "a0",
      useInline: true,
      inlineLabel: "A",
      bounds: { start: 480, end: null, fixedDuration: null, durationTarget: 60 },
    }),
    sitem({
      id: "b",
      position: "a1",
      useInline: true,
      inlineLabel: "B",
      bounds: { start: null, end: 600, fixedDuration: null, durationTarget: 60 },
    }),
  ];

  test("date view: mode, no clock, laid-out items", () => {
    const view = resolve.date(index(), schedule, items, "2026-06-08");
    expect(view.mode).toEqual({ kind: "date", date: "2026-06-08" });
    expect(view.nowMinute).toBeNull();
    expect(view.validation.ok).toBe(true);
    expect(view.items.map((i) => [i.id, i.start, i.end])).toEqual([
      ["a", 480, 540],
      ["b", 540, 600],
    ]);
  });

  test("template view", () => {
    const view = resolve.template(index(), schedule, items);
    expect(view.mode).toEqual({ kind: "template" });
    expect(view.nowMinute).toBeNull();
  });
});

describe("today", () => {
  // The schedule's hard end drives the overflow check, so set it to match.
  const running = (start: number, end: number): [Schedule, ScheduleItem[]] => [
    { ...schedule, start, end },
    [
      sitem({
        id: "y",
        useInline: true,
        bounds: { start, end, fixedDuration: null, durationTarget: 60 },
      }),
    ],
  ];

  test("yesterday still running wins, frame-shifted +1 day", () => {
    // yesterday's schedule ends at minute 1500 (00:60 next day); now is 30.
    const view = resolve.today(index(), running(1380, 1380), running(1200, 1500), 30);
    expect(view.mode).toEqual({ kind: "today", overflow: true });
    expect(view.nowMinute).toBe(30 + 1440);
  });

  test("yesterday finished -> today schedule", () => {
    const view = resolve.today(index(), running(480, 540), running(1200, 1300), 200);
    expect(view.mode).toEqual({ kind: "today", overflow: false });
    expect(view.items[0]!.id).toBe("y");
    expect(view.nowMinute).toBe(200);
  });

  test("no schedules -> empty", () => {
    const view = resolve.today(index(), null, null, 600);
    expect(view.schedule).toBeNull();
    expect(view.items).toEqual([]);
    expect(view.mode).toEqual({ kind: "today", overflow: false });
  });
});
