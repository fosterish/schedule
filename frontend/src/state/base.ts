import { batch, signal } from "@preact/signals";

import type { Dependency } from "@bindings/Dependency";
import type { Project } from "@bindings/Project";
import type { Schedule } from "@bindings/Schedule";
import type { ScheduleBinding } from "@bindings/ScheduleBinding";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { Settings } from "@bindings/Settings";
import type { Task } from "@bindings/Task";
import type { Template } from "@bindings/Template";
import type { BaseTables } from "@data/db";

// Last-synced rows, normalized per table. The effective tables the UI reads are
// these replayed with the pending queue (see pending.ts); a delta pull just
// refreshes these signals.
export const projects = signal<Project[]>([]);
export const tasks = signal<Task[]>([]);
export const dependencies = signal<Dependency[]>([]);
export const schedules = signal<Schedule[]>([]);
export const items = signal<ScheduleItem[]>([]);
export const bindings = signal<ScheduleBinding[]>([]);
export const templates = signal<Template[]>([]);
export const settings = signal<Settings[]>([]);

// The user's revision cursor: the last synced version.
export const version = signal(0);

export function setBase(base: BaseTables, ver: number): void {
  batch(() => {
    projects.value = base.projects;
    tasks.value = base.tasks;
    dependencies.value = base.dependencies;
    schedules.value = base.schedules;
    items.value = base.items;
    bindings.value = base.bindings;
    templates.value = base.templates;
    settings.value = base.settings;
    version.value = ver;
  });
}

const EMPTY: BaseTables = {
  projects: [],
  tasks: [],
  dependencies: [],
  schedules: [],
  items: [],
  bindings: [],
  templates: [],
  settings: [],
};

// Drop all rows on logout so the next account never sees the previous one's data.
export function clearBase(): void {
  setBase(EMPTY, 0);
}
