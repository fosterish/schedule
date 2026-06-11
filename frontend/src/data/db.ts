import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type StoreNames } from "idb";

import type { Dependency } from "@bindings/Dependency";
import type { Operation } from "@bindings/Operation";
import type { Project } from "@bindings/Project";
import type { Schedule } from "@bindings/Schedule";
import type { ScheduleBinding } from "@bindings/ScheduleBinding";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { Settings } from "@bindings/Settings";
import type { Task } from "@bindings/Task";
import type { Template } from "@bindings/Template";

// Last-synced rows, one array per syncable table (Snapshot without `version`).
export interface BaseTables {
  projects: Project[];
  tasks: Task[];
  dependencies: Dependency[];
  schedules: Schedule[];
  items: ScheduleItem[];
  bindings: ScheduleBinding[];
  templates: Template[];
  settings: Settings[];
}

// A queued op with its insertion sequence (the pending store's autoIncrement key).
export interface PendingEntry {
  seq: number;
  op: Operation;
}

interface ScheduleDB extends DBSchema {
  projects: { key: string; value: Project };
  tasks: { key: string; value: Task };
  dependencies: { key: [string, string]; value: Dependency };
  schedules: { key: string; value: Schedule };
  items: { key: string; value: ScheduleItem };
  bindings: { key: string; value: ScheduleBinding };
  templates: { key: string; value: Template };
  settings: { key: string; value: Settings };
  pending: { key: number; value: Operation };
  meta: { key: string; value: { key: string; value: number } };
}

const BASE_STORES = [
  "projects",
  "tasks",
  "dependencies",
  "schedules",
  "items",
  "bindings",
  "templates",
  "settings",
] as const;

// Each user's cache lives in its own database, so accounts coexist on one device
// without cross-contaminating rows, the pending queue, or the version cursor.
const dbName = (userId: string): string => `schedule:${userId}`;

let activeUserId: string | null = null;
let connection: Promise<IDBPDatabase<ScheduleDB>> | null = null;

// Point the cache at a user's database (or detach on logout). Closes the prior
// connection so the next `database()` reopens under the new name.
export async function setActiveUser(userId: string | null): Promise<void> {
  if (userId === activeUserId) return;
  if (connection) (await connection).close();
  connection = null;
  activeUserId = userId;
}

// The user whose cache is currently attached, or null when logged out.
export function activeUser(): string | null {
  return activeUserId;
}

// Drop a remembered account's cache entirely ("forget me").
export async function forgetUser(userId: string): Promise<void> {
  if (userId === activeUserId) await setActiveUser(null);
  await deleteDB(dbName(userId));
}

function database(): Promise<IDBPDatabase<ScheduleDB>> {
  if (activeUserId == null) throw new Error("db accessed with no active user");
  connection ??= openDB<ScheduleDB>(dbName(activeUserId), 2, {
    // Idempotent per store so the v1→v2 bump (adding `settings`) only creates
    // what's missing.
    upgrade(db) {
      const ensure = (
        name: StoreNames<ScheduleDB>,
        options: IDBObjectStoreParameters,
      ): void => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      };
      ensure("projects", { keyPath: "id" });
      ensure("tasks", { keyPath: "id" });
      ensure("dependencies", { keyPath: ["blockedId", "blockerId"] });
      ensure("schedules", { keyPath: "id" });
      ensure("items", { keyPath: "id" });
      ensure("bindings", { keyPath: "date" });
      ensure("templates", { keyPath: "scheduleId" });
      ensure("settings", { keyPath: "userId" });
      ensure("pending", { autoIncrement: true });
      ensure("meta", { keyPath: "key" });
    },
  });
  return connection;
}

export async function loadBase(): Promise<BaseTables> {
  const db = await database();
  const [projects, tasks, dependencies, schedules, items, bindings, templates, settings] =
    await Promise.all([
      db.getAll("projects"),
      db.getAll("tasks"),
      db.getAll("dependencies"),
      db.getAll("schedules"),
      db.getAll("items"),
      db.getAll("bindings"),
      db.getAll("templates"),
      db.getAll("settings"),
    ]);
  return { projects, tasks, dependencies, schedules, items, bindings, templates, settings };
}

// Replace the persisted base wholesale (sync produces the merged tables).
export async function persistBase(base: BaseTables): Promise<void> {
  const db = await database();
  const tx = db.transaction(BASE_STORES, "readwrite");
  await Promise.all([
    refill(tx.objectStore("projects"), base.projects),
    refill(tx.objectStore("tasks"), base.tasks),
    refill(tx.objectStore("dependencies"), base.dependencies),
    refill(tx.objectStore("schedules"), base.schedules),
    refill(tx.objectStore("items"), base.items),
    refill(tx.objectStore("bindings"), base.bindings),
    refill(tx.objectStore("templates"), base.templates),
    refill(tx.objectStore("settings"), base.settings),
  ]);
  await tx.done;
}

export async function appendPending(op: Operation): Promise<number> {
  const db = await database();
  return db.add("pending", op);
}

export async function loadPending(): Promise<PendingEntry[]> {
  const db = await database();
  const out: PendingEntry[] = [];
  let cursor = await db.transaction("pending").store.openCursor();
  while (cursor) {
    out.push({ seq: cursor.key, op: cursor.value });
    cursor = await cursor.continue();
  }
  return out;
}

export async function deletePending(seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  const db = await database();
  const tx = db.transaction("pending", "readwrite");
  await Promise.all(seqs.map((s) => tx.store.delete(s)));
  await tx.done;
}

export async function getVersion(): Promise<number> {
  const db = await database();
  return (await db.get("meta", "version"))?.value ?? 0;
}

export async function setVersion(version: number): Promise<void> {
  const db = await database();
  await db.put("meta", { key: "version", value: version });
}

interface Writable<T> {
  clear(): Promise<void>;
  put(value: T): Promise<unknown>;
}

async function refill<T>(store: Writable<T>, rows: T[]): Promise<void> {
  await store.clear();
  await Promise.all(rows.map((r) => store.put(r)));
}
