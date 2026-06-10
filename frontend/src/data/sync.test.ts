import { describe, expect, test } from "vitest";

import type { Dependency } from "@bindings/Dependency";
import type { Operation } from "@bindings/Operation";
import type { Project } from "@bindings/Project";
import type { Snapshot } from "@bindings/Snapshot";
import type { SyncResult } from "@bindings/SyncResult";
import type { BaseTables, PendingEntry } from "@data/db";
import { mergeSnapshot, planFlush } from "@data/sync";

function project(id: string, updated: number, deleted: number | null = null): Project {
  return {
    id,
    userId: "u1",
    name: id,
    value: 1,
    time: 1,
    color: "blue",
    archivedAt: null,
    createdAt: 0,
    rev: { updated, deleted },
  };
}

function dep(blockedId: string, blockerId: string, updated: number, deleted: number | null = null): Dependency {
  return { blockedId, blockerId, rev: { updated, deleted } };
}

function base(over: Partial<BaseTables> = {}): BaseTables {
  return {
    projects: [],
    tasks: [],
    dependencies: [],
    schedules: [],
    items: [],
    bindings: [],
    templates: [],
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { version: 0, ...base(), ...over };
}

describe("mergeSnapshot", () => {
  test("adds rows absent from the base", () => {
    const merged = mergeSnapshot(base(), snapshot({ projects: [project("p1", 5)] }));
    expect(merged.projects).toEqual([project("p1", 5)]);
  });

  test("a strictly newer incoming row replaces the stored one", () => {
    const merged = mergeSnapshot(
      base({ projects: [project("p1", 3)] }),
      snapshot({ projects: [project("p1", 7)] }),
    );
    expect(merged.projects).toEqual([project("p1", 7)]);
  });

  test("a stale-or-equal incoming row is ignored (LWW)", () => {
    const merged = mergeSnapshot(
      base({ projects: [project("p1", 9)] }),
      snapshot({ projects: [project("p1", 9), project("p1", 4)] }),
    );
    expect(merged.projects).toEqual([project("p1", 9)]);
  });

  test("a newer tombstone removes the row", () => {
    const merged = mergeSnapshot(
      base({ projects: [project("p1", 3), project("p2", 3)] }),
      snapshot({ projects: [project("p1", 8, 8)] }),
    );
    expect(merged.projects.map((p) => p.id)).toEqual(["p2"]);
  });

  test("a tombstone for an absent row is a no-op", () => {
    const merged = mergeSnapshot(base(), snapshot({ projects: [project("ghost", 8, 8)] }));
    expect(merged.projects).toEqual([]);
  });

  test("merges dependencies by their composite key", () => {
    const merged = mergeSnapshot(
      base({ dependencies: [dep("a", "b", 2)] }),
      snapshot({ dependencies: [dep("a", "b", 5), dep("a", "c", 5)] }),
    );
    expect(merged.dependencies).toEqual([dep("a", "b", 5), dep("a", "c", 5)]);
  });
});

describe("planFlush", () => {
  const upsertP = (id: string): Operation => ({ kind: "upsert", model: { kind: "project", ...project(id, 1) } });
  const sent = (...entries: { seq: number; op: Operation }[]): PendingEntry[] => entries;

  test("drops every applied op and does not re-pull", () => {
    const queue = sent({ seq: 1, op: upsertP("p1") }, { seq: 2, op: upsertP("p2") });
    const result: SyncResult = {
      version: 10,
      applied: [
        { kind: "project", id: "p1" },
        { kind: "project", id: "p2" },
      ],
      rejected: [],
    };
    expect(planFlush(queue, result)).toEqual({ resolvedSeqs: [1, 2], needsPull: false });
  });

  test("drops rejected ops too and flags a re-pull", () => {
    const queue = sent({ seq: 1, op: upsertP("p1") }, { seq: 2, op: upsertP("p2") });
    const result: SyncResult = {
      version: 10,
      applied: [{ kind: "project", id: "p1" }],
      rejected: [{ target: { kind: "project", id: "p2" }, storedRev: 99 }],
    };
    expect(planFlush(queue, result)).toEqual({ resolvedSeqs: [1, 2], needsPull: true });
  });

  test("keeps an op the server did not resolve", () => {
    const queue = sent({ seq: 1, op: upsertP("p1") }, { seq: 2, op: upsertP("p2") });
    const result: SyncResult = {
      version: 10,
      applied: [{ kind: "project", id: "p1" }],
      rejected: [],
    };
    expect(planFlush(queue, result)).toEqual({ resolvedSeqs: [1], needsPull: false });
  });
});
