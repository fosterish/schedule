import { describe, expect, test } from "vitest";

import type { Dependency } from "@bindings/Dependency";
import type { Project } from "@bindings/Project";
import type { Task } from "@bindings/Task";
import * as project from "@lib/project";

const { ProjectIndex, graph, reorder, tasks } = project;

function proj(p: Partial<Project> & { id: string }): Project {
  return {
    id: p.id,
    userId: "u1",
    name: p.name ?? p.id,
    value: p.value ?? 1,
    time: p.time ?? 1,
    color: "blue",
    archivedAt: p.archivedAt ?? null,
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
    createdAt: t.createdAt ?? 0,
    rev: { updated: 1, deleted: null },
  };
}

function dep(blockedId: string, blockerId: string): Dependency {
  return { blockedId, blockerId, rev: { updated: 1, deleted: null } };
}

describe("graph", () => {
  test("edgesFromDeps maps blocker -> blocked", () => {
    expect(graph.edgesFromDeps([dep("b", "a")])).toEqual([{ from: "a", to: "b" }]);
  });

  test("edgeFromDep direction", () => {
    expect(graph.edgeFromDep("blocks", "a", "b")).toEqual({ from: "a", to: "b" });
    expect(graph.edgeFromDep("blockedBy", "a", "b")).toEqual({ from: "b", to: "a" });
  });

  test("sortByDeps keeps user order where deps allow", () => {
    const edges = [{ from: "c", to: "a" }];
    expect(graph.sortByDeps(["a", "b", "c"], edges)).toEqual(["b", "c", "a"]);
  });

  test("sortByDeps bails to append on a cycle", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    expect(graph.sortByDeps(["a", "b"], edges)).toEqual(["a", "b"]);
  });

  test("getDragViolations flags the offending neighbor", () => {
    const edges = [{ from: "a", to: "b" }];
    expect(graph.getDragViolations(["b", "a"], "a", edges)).toEqual(["b"]);
    expect(graph.getDragViolations(["a", "b"], "a", edges)).toEqual([]);
  });

  test("hasCycle detects a candidate cycle when appended", () => {
    const edges = [{ from: "a", to: "b" }];
    expect(graph.hasCycle(edges)).toBe(false);
    expect(graph.hasCycle([...edges, { from: "b", to: "a" }])).toBe(true);
    expect(graph.hasCycle([{ from: "a", to: "a" }])).toBe(true);
  });
});

describe("ProjectIndex ranking", () => {
  test("value/time DESC, zero time last, createdAt then id tiebreak", () => {
    const idx = new ProjectIndex(
      [
        proj({ id: "low", value: 1, time: 2 }), // 0.5
        proj({ id: "high", value: 4, time: 1 }), // 4
        proj({ id: "zero", value: 9, time: 0 }), // null -> last
        proj({ id: "mid", value: 2, time: 1 }), // 2
        proj({ id: "arch", value: 99, time: 1, archivedAt: 5 }),
      ],
      [],
      [],
    );
    expect(idx.pickByRank(1)).toBe("high");
    expect(idx.pickByRank(2)).toBe("mid");
    expect(idx.pickByRank(3)).toBe("low");
    expect(idx.pickByRank(4)).toBe("zero");
    expect(idx.pickByRank(5)).toBeNull();
    expect(idx.pickByRank(0)).toBeNull();
  });
});

describe("ProjectIndex eligibility", () => {
  test("skips completed and blocked tasks, counts in listOrder", () => {
    const idx = new ProjectIndex(
      [proj({ id: "p" })],
      [
        task({ id: "t1", projectId: "p", listOrder: "a0", completedAt: 10 }),
        task({ id: "t2", projectId: "p", listOrder: "a1" }),
        task({ id: "t3", projectId: "p", listOrder: "a2" }),
      ],
      [dep("t3", "t2")], // t3 blocked by incomplete t2
    );
    expect(idx.pickTaskByRank("p", 1)?.id).toBe("t2");
    expect(idx.pickTaskByRank("p", 2)).toBeNull();
    expect(idx.taskHasBlockers(task({ id: "t3", projectId: "p" }))).toBe(true);
    expect(idx.taskHasBlockers(task({ id: "t2", projectId: "p" }))).toBe(false);
  });

  test("blocked task becomes eligible once its blocker completes", () => {
    const idx = new ProjectIndex(
      [proj({ id: "p" })],
      [
        task({ id: "t1", projectId: "p", listOrder: "a0", completedAt: 10 }),
        task({ id: "t2", projectId: "p", listOrder: "a1" }),
      ],
      [dep("t2", "t1")],
    );
    expect(idx.pickTaskByRank("p", 1)?.id).toBe("t2");
  });
});

describe("reorder", () => {
  const order = ["a", "b", "c"];
  const mids = [10, 30, 50];

  test("ok(null) when nothing crossed", () => {
    const r = reorder.detect(order, mids, "a", "down", 15, []);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("ok move emits afterId", () => {
    const r = reorder.detect(order, mids, "a", "down", 35, []);
    expect(r.ok && r.value).toEqual({ id: "a", afterId: "b" });
  });

  test("err on dep conflict with culprits", () => {
    const edges = [{ from: "a", to: "c" }]; // a must precede c
    const r = reorder.detect(order, mids, "a", "down", 55, edges);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.conflictIds).toEqual(["c"]);
  });

  test("transform yields minimal moves", () => {
    expect(reorder.transform(["a", "b", "c"], ["b", "a", "c"])).toEqual([
      { id: "b", afterId: null },
    ]);
  });
});

describe("tasks", () => {
  test("partitionByCompletion preserves within-group order", () => {
    const list = [
      task({ id: "t1", projectId: "p" }),
      task({ id: "t2", projectId: "p", completedAt: 5 }),
      task({ id: "t3", projectId: "p" }),
    ];
    const [incomplete, completed] = tasks.partitionByCompletion(list);
    expect(incomplete.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(completed.map((t) => t.id)).toEqual(["t2"]);
  });

  test("compareTaskOrder by listOrder then id", () => {
    const a = task({ id: "z", projectId: "p", listOrder: "a0" });
    const b = task({ id: "a", projectId: "p", listOrder: "a1" });
    expect(tasks.compareTaskOrder(a, b)).toBeLessThan(0);
  });
});
