import type { Color } from "@bindings/Color";
import type { ItemBounds } from "@bindings/ItemBounds";
import type { Operation } from "@bindings/Operation";
import type { OrderKey } from "@bindings/OrderKey";
import type { Schedule } from "@bindings/Schedule";
import type { ScheduleBinding } from "@bindings/ScheduleBinding";
import type { ScheduleId } from "@bindings/ScheduleId";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import type { Template } from "@bindings/Template";
import { keyBetween } from "@lib/fractional";
import * as insert from "@lib/schedule/insert";
import * as layout from "@lib/schedule/layout";
import * as reorder from "@lib/schedule/reorder";
import * as resize from "@lib/schedule/resize";
import * as run from "@lib/schedule/run";

import { commit } from "../commit";
import {
  effectiveBindings,
  effectiveItems,
  effectiveProjects,
  effectiveSchedules,
  effectiveTasks,
  effectiveTemplates,
} from "../pending";
import { user } from "../session";
import { localRev, newId } from "../mint";
import { defaultEnd, defaultStart } from "../settings";
import { pushToast } from "../toast";
import { fitScheduleId, panToSelected } from "../uistate";

// All schedule mutations expand to row upserts/deletes and commit under the
// "schedule" undo context. Composite intents (insert, reorder, run) lean on the
// pure lib planners and only mint ids/keys here, where impurity is allowed.

const CTX = "schedule";
const DAY_MINUTES = 1440;

// --- items ---

// Drop a fresh inline item near the explicit `cursor` (null = no cursor, place it
// at the least-strained future opening relative to `now`). Returns the new id for
// selection, or null if the insert would over-constrain the day.
export function insertItem(
  scheduleId: ScheduleId,
  cursor: number | null,
  now: number | null,
  color: Color,
): ScheduleItemId | null {
  const span = scheduleSpan(scheduleId);
  if (!span) return null;
  const rows = sortedItems(scheduleId);
  const draft: ItemBounds = { start: null, end: null, fixedDuration: null, durationTarget: 60 };
  const plan = insert.insertAt(rows.map(toLayoutItem), draft, span, cursor, now);
  if (!plan.ok) return null;

  const id = newId();
  const row: ScheduleItem = {
    id,
    scheduleId,
    position: positionAfter(rows, plan.value.afterId, null),
    bounds: plan.value.bounds,
    useInline: true,
    inlineLabel: null,
    inlineDescription: null,
    inlineColor: color,
    projectId: null,
    projectRank: 1,
    taskId: null,
    taskRank: 1,
    rev: localRev(),
  };
  commit([upsertItem(row)], CTX);
  return id;
}

export function patchItem(id: ScheduleItemId, patch: Partial<ScheduleItem>): void {
  const row = effectiveItems.value.find((it) => it.id === id);
  if (!row) return;
  commit([upsertItem({ ...row, ...patch })], CTX);
}

// Patch an item's bounds, growing the schedule window to admit a fixed anchor
// that lands outside it (never shrinking).
export function patchItemBounds(id: ScheduleItemId, bounds: Partial<ItemBounds>): void {
  const row = effectiveItems.value.find((it) => it.id === id);
  if (!row) return;
  const merged = { ...row.bounds, ...bounds };
  const ops: Operation[] = [upsertItem({ ...row, bounds: merged })];
  const sched = effectiveSchedules.value.find((s) => s.id === row.scheduleId);
  const grown = sched && grownBounds(sched, merged);
  if (sched && grown) ops.push(scheduleUpsert({ ...sched, ...grown }));
  commit(ops, CTX);
}

export function deleteItem(id: ScheduleItemId): void {
  commit([{ kind: "delete", ref: { kind: "scheduleItem", id } }], CTX);
}

// Slide a fixed edge (drag handle or spinner) to `desired`, clamped against
// neighbours' fixed edges and min durations; the schedule grows outward when the
// edge presses past its boundary. A rigid item translates whole.
export function slideItemEdge(
  scheduleId: ScheduleId,
  id: ScheduleItemId,
  edge: resize.Edge,
  desired: number,
): void {
  const span = scheduleSpan(scheduleId);
  if (!span) return;
  const rows = sortedItems(scheduleId);
  const index = rows.findIndex((it) => it.id === id);
  if (index < 0) return;
  const r = resize.slideEdge(rows.map(toLayoutItem), span, index, edge, desired);
  commitSlide(scheduleId, rows[index]!, r.bounds, r.span);
}

// Slide a fixed-duration item's length (spinner): the anchored edge holds, the
// derived edge moves under the same wall/growth rules.
export function slideItemDuration(scheduleId: ScheduleId, id: ScheduleItemId, desired: number): void {
  const span = scheduleSpan(scheduleId);
  if (!span) return;
  const rows = sortedItems(scheduleId);
  const index = rows.findIndex((it) => it.id === id);
  if (index < 0) return;
  const r = resize.slideDuration(rows.map(toLayoutItem), span, index, desired);
  commitSlide(scheduleId, rows[index]!, r.bounds, r.span);
}

// Set an edge to an exact typed value by relocating the item to the slot nearest
// that value. Infeasible placements are rejected with a toast naming the blocker.
export function setItemEdgeValue(
  scheduleId: ScheduleId,
  id: ScheduleItemId,
  edge: resize.Edge,
  value: number,
): void {
  const span = scheduleSpan(scheduleId);
  if (!span) return;
  const rows = sortedItems(scheduleId);
  const index = rows.findIndex((it) => it.id === id);
  if (index < 0) return;
  const plan = resize.reinsertByValue(rows.map(toLayoutItem), span, index, edge, value);
  if (!plan.ok) {
    const blocker = plan.error.blockerId != null ? rows.find((it) => it.id === plan.error.blockerId) : null;
    const name = blocker ? itemName(blocker) : null;
    pushToast(name ? `Can\u2019t set that time \u2014 it would overlap \u201c${name}\u201d.` : "Can\u2019t set that time here.", "error");
    return;
  }
  const moved = rows[index]!;
  const position = positionAfter(rows, plan.value.afterId, id);
  commitSlide(scheduleId, { ...moved, position }, plan.value.bounds, plan.value.span);
  // The item may have jumped to a far slot; keep it in view (selection persists).
  panToSelected();
}

function commitSlide(
  scheduleId: ScheduleId,
  row: ScheduleItem,
  bounds: ItemBounds,
  span: layout.Span,
): void {
  const ops: Operation[] = [upsertItem({ ...row, bounds })];
  const sched = effectiveSchedules.value.find((s) => s.id === scheduleId);
  if (sched && (span.start !== sched.start || span.end !== sched.end)) {
    ops.push(scheduleUpsert({ ...sched, start: span.start, end: span.end }));
  }
  commit(ops, CTX);
}

// A blocking item's display name for a rejection toast: inline label, else its
// task / project name.
function itemName(row: ScheduleItem): string {
  if (row.useInline) return row.inlineLabel?.trim() || "Untitled";
  if (row.taskId != null) {
    const t = effectiveTasks.value.find((x) => x.id === row.taskId);
    if (t) return t.name.trim() || "Untitled task";
  }
  if (row.projectId != null) {
    const p = effectiveProjects.value.find((x) => x.id === row.projectId);
    if (p) return p.name.trim() || "Untitled project";
  }
  return "another item";
}

// Apply a feasible reorder: reposition the dragged item and, when moving onto the
// head/tail grew the window, persist the new schedule bounds in the same commit.
export function applyReorder(
  scheduleId: ScheduleId,
  draggedId: ScheduleItemId,
  result: reorder.ScheduleReorder,
): void {
  const rows = sortedItems(scheduleId);
  const moved = rows.find((it) => it.id === draggedId);
  if (!moved) return;
  const position = positionAfter(rows, result.afterId, draggedId);
  const ops: Operation[] = [upsertItem({ ...moved, position })];
  const sched = effectiveSchedules.value.find((s) => s.id === scheduleId);
  if (sched && (result.span.start !== sched.start || result.span.end !== sched.end)) {
    ops.push(scheduleUpsert({ ...sched, start: result.span.start, end: result.span.end }));
  }
  commit(ops, CTX);
}

// Play/skip/stop at the cursor minute. Returns whether the action was enabled.
export function runAction(scheduleId: ScheduleId, action: run.RunAction, nowMinute: number): boolean {
  const span = scheduleSpan(scheduleId);
  if (!span) return false;
  const rows = sortedItems(scheduleId);
  const layoutItems = rows.map(toLayoutItem);
  const plan = run.apply(action, layoutItems, layout.compute(layoutItems, span), nowMinute, span);
  if (!plan.ok) return false;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ops: Operation[] = [];
  for (const p of plan.value.patches) {
    const row = byId.get(p.id);
    if (row) ops.push(upsertItem({ ...row, bounds: p.bounds }));
  }
  for (const id of plan.value.deletes) {
    ops.push({ kind: "delete", ref: { kind: "scheduleItem", id } });
  }
  if (ops.length > 0) commit(ops, CTX);
  return true;
}

// --- schedules / bindings / templates ---

export function renameSchedule(id: ScheduleId, name: string): void {
  const row = effectiveSchedules.value.find((s) => s.id === id);
  if (!row) return;
  commit([{ kind: "upsert", model: { kind: "schedule", ...row, name } }], CTX);
}

// Set the schedule's hard bounds, clamped to the DB invariants (start in
// [0,1439], 0 < end-start <= 1440) and kept outside any fixed item anchors.
export function patchScheduleBounds(id: ScheduleId, patch: { start?: number; end?: number }): void {
  const sched = effectiveSchedules.value.find((s) => s.id === id);
  if (!sched) return;
  const items = sortedItems(id).map(toLayoutItem);
  let start = sched.start;
  let end = sched.end;
  if (patch.start != null) start = resize.clampScheduleStart(items, { start, end }, patch.start);
  if (patch.end != null) end = resize.clampScheduleEnd(items, { start, end }, patch.end);
  if (start === sched.start && end === sched.end) return;
  commit([scheduleUpsert({ ...sched, start, end })], CTX);
}

// Create an empty schedule bound to a date, returning its id.
export function createScheduleForDate(date: string): ScheduleId | null {
  const userId = user.value?.id;
  if (userId == null) return null;
  const id = newId();
  const { start, end } = defaultRange();
  const schedule: Schedule = { id, userId, name: "", start, end, rev: localRev() };
  const binding: ScheduleBinding = { userId, date, scheduleId: id, rev: localRev() };
  commit(
    [
      { kind: "upsert", model: { kind: "schedule", ...schedule } },
      { kind: "upsert", model: { kind: "scheduleBinding", ...binding } },
    ],
    CTX,
  );
  fitScheduleId.value = id;
  return id;
}

// Clone a template schedule (and its items) into a new dated schedule.
export function forkTemplateToDate(templateScheduleId: ScheduleId, date: string): ScheduleId | null {
  const userId = user.value?.id;
  if (userId == null) return null;
  const src = effectiveSchedules.value.find((s) => s.id === templateScheduleId);
  if (!src) return null;
  const id = newId();
  const schedule: Schedule = { id, userId, name: "", start: src.start, end: src.end, rev: localRev() };
  const binding: ScheduleBinding = { userId, date, scheduleId: id, rev: localRev() };
  const itemOps = sortedItems(templateScheduleId).map((it) =>
    upsertItem({ ...it, id: newId(), scheduleId: id, rev: localRev() }),
  );
  commit(
    [
      { kind: "upsert", model: { kind: "schedule", ...schedule } },
      { kind: "upsert", model: { kind: "scheduleBinding", ...binding } },
      ...itemOps,
    ],
    CTX,
  );
  fitScheduleId.value = id;
  return id;
}

// Create a day-agnostic template schedule, returning its id.
export function createTemplate(): ScheduleId | null {
  const userId = user.value?.id;
  if (userId == null) return null;
  const id = newId();
  const { start, end } = defaultRange();
  const schedule: Schedule = { id, userId, name: "", start, end, rev: localRev() };
  commit(
    [
      { kind: "upsert", model: { kind: "schedule", ...schedule } },
      { kind: "upsert", model: { kind: "template", userId, scheduleId: id, rev: localRev() } },
    ],
    CTX,
  );
  fitScheduleId.value = id;
  return id;
}

// Remove a schedule and everything anchored to it (items, date bindings, any
// template marker).
export function deleteSchedule(id: ScheduleId): void {
  const ops: Operation[] = [{ kind: "delete", ref: { kind: "schedule", id } }];
  for (const it of effectiveItems.value.filter((i) => i.scheduleId === id)) {
    ops.push({ kind: "delete", ref: { kind: "scheduleItem", id: it.id } });
  }
  for (const b of effectiveBindings.value.filter((b) => b.scheduleId === id)) {
    ops.push({ kind: "delete", ref: { kind: "scheduleBinding", id: b.date } });
  }
  if (effectiveTemplates.value.some((t: Template) => t.scheduleId === id)) {
    ops.push({ kind: "delete", ref: { kind: "template", id } });
  }
  commit(ops, CTX);
}

// --- helpers ---

function sortedItems(scheduleId: ScheduleId): ScheduleItem[] {
  return effectiveItems.value
    .filter((it) => it.scheduleId === scheduleId)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

function toLayoutItem(it: ScheduleItem): layout.LayoutItem {
  return { id: it.id, bounds: it.bounds };
}

function upsertItem(row: ScheduleItem): Operation {
  return { kind: "upsert", model: { kind: "scheduleItem", ...row } };
}

// Key strictly between the item at `afterId` (null = head) and its successor,
// in `position` order with `excludeId` (the moved item) removed.
function positionAfter(
  rows: ScheduleItem[],
  afterId: ScheduleItemId | null,
  excludeId: ScheduleItemId | null,
): OrderKey {
  const seq = excludeId == null ? rows : rows.filter((it) => it.id !== excludeId);
  if (afterId == null) return keyBetween(null, seq[0]?.position ?? null);
  const i = seq.findIndex((it) => it.id === afterId);
  return keyBetween(seq[i]?.position ?? null, seq[i + 1]?.position ?? null);
}

function scheduleUpsert(row: Schedule): Operation {
  return { kind: "upsert", model: { kind: "schedule", ...row } };
}

function scheduleSpan(scheduleId: ScheduleId): layout.Span | null {
  const s = effectiveSchedules.value.find((x) => x.id === scheduleId);
  return s ? { start: s.start, end: s.end } : null;
}

// The user's default range, clamped to the schedule DB invariants (start in
// [0,1439], 0 < end-start <= 1440) so a stored preference can never reject.
function defaultRange(): { start: number; end: number } {
  const start = clampInt(defaultStart.value, 0, 1439);
  const end = clampInt(defaultEnd.value, start + 1, start + DAY_MINUTES);
  return { start, end };
}

// New bounds that grow the window outward to admit a fixed item anchor, clamped
// to the DB invariants, or null when the anchors already fit. Never shrinks.
function grownBounds(sched: Schedule, b: ItemBounds): { start: number; end: number } | null {
  let start = sched.start;
  let end = sched.end;
  for (const v of [b.start, b.end]) {
    if (v == null) continue;
    if (v < start) start = v;
    if (v > end) end = v;
  }
  start = clampInt(start, 0, 1439);
  end = clampInt(end, start + 1, start + DAY_MINUTES);
  return start === sched.start && end === sched.end ? null : { start, end };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(v < lo ? lo : v > hi ? hi : v);
}
