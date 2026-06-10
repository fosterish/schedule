import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Operation } from "@bindings/Operation";
import type { Project } from "@bindings/Project";

vi.mock("@data/db", () => ({
  appendPending: vi.fn(async () => 0),
  loadBase: vi.fn(),
  loadPending: vi.fn(async () => []),
  getVersion: vi.fn(async () => 0),
  setVersion: vi.fn(),
  persistBase: vi.fn(),
  deletePending: vi.fn(),
}));

const { commit, redo, undo } = await import("./commit");
const base = await import("./base");
const history = await import("./history");
const { effectiveProjects, pending } = await import("./pending");

function project(id: string, name: string): Project {
  return {
    id,
    userId: "u1",
    name,
    value: 1,
    time: 1,
    color: "blue",
    archivedAt: null,
    createdAt: 0,
    rev: { updated: 1, deleted: null },
  };
}

const upsert = (p: Project): Operation => ({ kind: "upsert", model: { kind: "project", ...p } });
const del = (id: string): Operation => ({ kind: "delete", ref: { kind: "project", id } });

beforeEach(() => {
  base.setBase(
    { projects: [], tasks: [], dependencies: [], schedules: [], items: [], bindings: [], templates: [] },
    0,
  );
  pending.value = [];
  while (history.popUndo("schedule")) {}
  while (history.popRedo("schedule")) {}
});

describe("commit", () => {
  test("optimistically applies a batch to the effective tables and queue", () => {
    commit([upsert(project("p1", "First"))], "schedule");
    expect(effectiveProjects.value.map((p) => p.name)).toEqual(["First"]);
    expect(pending.value).toHaveLength(1);
    expect(history.canUndo("schedule").value).toBe(true);
  });

  test("a new commit clears the redo branch", () => {
    commit([upsert(project("p1", "First"))], "schedule");
    undo("schedule");
    expect(history.canRedo("schedule").value).toBe(true);
    commit([upsert(project("p2", "Second"))], "schedule");
    expect(history.canRedo("schedule").value).toBe(false);
  });
});

describe("undo / redo", () => {
  test("undo reverts an insert; redo re-applies it", () => {
    commit([upsert(project("p1", "First"))], "schedule");
    undo("schedule");
    expect(effectiveProjects.value).toEqual([]);
    expect(history.canUndo("schedule").value).toBe(false);
    redo("schedule");
    expect(effectiveProjects.value.map((p) => p.name)).toEqual(["First"]);
  });

  test("undo restores the prior row state of an edit", () => {
    base.setBase(
      { projects: [project("p1", "Old")], tasks: [], dependencies: [], schedules: [], items: [], bindings: [], templates: [] },
      0,
    );
    commit([upsert(project("p1", "New"))], "schedule");
    expect(effectiveProjects.value[0]?.name).toBe("New");
    undo("schedule");
    expect(effectiveProjects.value[0]?.name).toBe("Old");
  });

  test("a multi-op batch undoes back to the starting state", () => {
    base.setBase(
      { projects: [project("p1", "Old")], tasks: [], dependencies: [], schedules: [], items: [], bindings: [], templates: [] },
      0,
    );
    commit([upsert(project("p1", "Edited")), upsert(project("p2", "Added")), del("p1")], "schedule");
    expect(effectiveProjects.value.map((p) => p.name)).toEqual(["Added"]);
    undo("schedule");
    expect(effectiveProjects.value.map((p) => p.name)).toEqual(["Old"]);
  });
});
