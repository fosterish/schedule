import { describe, expect, test } from "vitest";

import type { Dependency } from "@bindings/Dependency";
import type { Model } from "@bindings/Model";
import type { Project } from "@bindings/Project";
import type { Snapshot } from "@bindings/Snapshot";
import * as ops from "@lib/ops";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 0,
    projects: [],
    tasks: [],
    dependencies: [],
    schedules: [],
    items: [],
    bindings: [],
    templates: [],
    settings: [],
    ...over,
  };
}

function project(p: Partial<Project> & { id: string }): Project {
  return {
    id: p.id,
    userId: "u1",
    name: p.name ?? p.id,
    value: p.value ?? 1,
    time: p.time ?? 1,
    color: p.color ?? "blue",
    archivedAt: p.archivedAt ?? null,
    createdAt: p.createdAt ?? 0,
    rev: p.rev ?? { updated: 1, deleted: null },
  };
}

const projectModel = (p: Partial<Project> & { id: string }): Model => ({
  kind: "project",
  ...project(p),
});

const dep = (blockedId: string, blockerId: string): Dependency => ({
  blockedId,
  blockerId,
  rev: { updated: 1, deleted: null },
});

describe("ops.apply", () => {
  test("upsert inserts a new row", () => {
    const snap = snapshot();
    ops.apply({ kind: "upsert", model: projectModel({ id: "p1" }) }, snap);
    expect(snap.projects).toEqual([project({ id: "p1" })]);
  });

  test("upsert replaces an existing row by id and strips the kind tag", () => {
    const snap = snapshot({ projects: [project({ id: "p1", name: "old" })] });
    ops.apply(
      { kind: "upsert", model: projectModel({ id: "p1", name: "new", rev: { updated: 2, deleted: null } }) },
      snap,
    );
    expect(snap.projects).toHaveLength(1);
    expect(snap.projects[0]).toEqual(project({ id: "p1", name: "new", rev: { updated: 2, deleted: null } }));
    expect("kind" in snap.projects[0]!).toBe(false);
  });

  test("delete removes the row", () => {
    const snap = snapshot({ projects: [project({ id: "p1" }), project({ id: "p2" })] });
    ops.apply({ kind: "delete", ref: { kind: "project", id: "p1" } }, snap);
    expect(snap.projects.map((p) => p.id)).toEqual(["p2"]);
  });

  test("delete matches a dependency by its composite key", () => {
    const snap = snapshot({ dependencies: [dep("a", "b"), dep("a", "c")] });
    ops.apply(
      { kind: "delete", ref: { kind: "dependency", id: { blocked: "a", blocker: "b" } } },
      snap,
    );
    expect(snap.dependencies).toEqual([dep("a", "c")]);
  });
});

describe("ops.refOf", () => {
  test("derives the typed ref per model kind", () => {
    expect(ops.refOf(projectModel({ id: "p1" }))).toEqual({ kind: "project", id: "p1" });
    expect(ops.refOf({ kind: "dependency", ...dep("a", "b") })).toEqual({
      kind: "dependency",
      id: { blocked: "a", blocker: "b" },
    });
  });
});

describe("ops.invert", () => {
  test("upsert of a new row inverts to a delete", () => {
    const before = snapshot();
    const op = { kind: "upsert", model: projectModel({ id: "p1" }) } as const;
    expect(ops.invert(op, before)).toEqual({ kind: "delete", ref: { kind: "project", id: "p1" } });
  });

  test("upsert of an existing row inverts to an upsert of the prior row", () => {
    const prior = project({ id: "p1", name: "old" });
    const before = snapshot({ projects: [prior] });
    const op = { kind: "upsert", model: projectModel({ id: "p1", name: "new" }) } as const;
    expect(ops.invert(op, before)).toEqual({ kind: "upsert", model: { kind: "project", ...prior } });
  });

  test("delete inverts to an upsert with the tombstone cleared", () => {
    const prior = project({ id: "p1", rev: { updated: 5, deleted: null } });
    const before = snapshot({ projects: [prior] });
    const op = { kind: "delete", ref: { kind: "project", id: "p1" } } as const;
    expect(ops.invert(op, before)).toEqual({
      kind: "upsert",
      model: { kind: "project", ...prior, rev: { updated: 5, deleted: null } },
    });
  });

  test("delete of an absent row inverts to itself (inert)", () => {
    const op = { kind: "delete", ref: { kind: "project", id: "ghost" } } as const;
    expect(ops.invert(op, snapshot())).toEqual(op);
  });

  test("apply then apply(invert) round-trips the snapshot", () => {
    const before = snapshot({ projects: [project({ id: "p1", name: "old" })] });
    const after = structuredClone(before);
    const op = { kind: "upsert", model: projectModel({ id: "p1", name: "new" }) } as const;
    const undo = ops.invert(op, before);
    ops.apply(op, after);
    ops.apply(undo, after);
    expect(after).toEqual(before);
  });
});
