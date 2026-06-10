import { batch, signal } from "@preact/signals";

import type { ScheduleId } from "@bindings/ScheduleId";
import type { ScheduleItemId } from "@bindings/ScheduleItemId";
import type { TaskId } from "@bindings/TaskId";

// View-local UI state lifted out of components so unmount/remount (standard
// routing) preserves appearance with no keep-alive. No persistence except zoom.

// Selection (one per editing surface; tapping selects, second tap deselects).
export const selectedItem = signal<ScheduleItemId | null>(null);
export const selectedTask = signal<TaskId | null>(null);

// When set, the schedule editor focuses this field on the selection it lands on.
export type FocusField = "title" | "description" | null;
export const focusOnSelect = signal<FocusField>(null);

// Explicit time-cursor minute: the schedule's play head. null = live (snaps to
// `now` in today mode) / hidden (date & template modes). Run actions (play/skip/
// stop) and their enablement evaluate here, so dragging the cursor steers them.
export const cursorMinute = signal<number | null>(null);

// Bumped to ask the timeline to pan the selected item back into view after a
// move that isn't a fresh selection (e.g. typing a new start/end time).
export const panRequest = signal(0);

export function panToSelected(): void {
  panRequest.value++;
}

export function selectItem(id: ScheduleItemId | null, focus: FocusField = null): void {
  selectedItem.value = id;
  focusOnSelect.value = id == null ? null : focus;
}

export function selectTask(id: TaskId | null, focus: FocusField = null): void {
  selectedTask.value = id;
  focusOnSelect.value = id == null ? null : focus;
}

// Timeline px/minute. Persisted: the one piece of UI state worth surviving reload.
const ZOOM_KEY = "schedule.zoom";
export const zoom = signal<number>(loadZoom());
export const scrollTop = signal<number>(0);

// A just-created schedule whose timeline should snap to fit once (overriding the
// persisted zoom carried over from the previous schedule). Cleared after fitting.
export const fitScheduleId = signal<ScheduleId | null>(null);

// Natural pixel height of the selected item's content, so the timeline can zoom
// the block tall enough to fit it. 0 when nothing is selected.
export const selectedContentHeight = signal<number>(0);

export function setZoom(value: number): void {
  zoom.value = value;
  try {
    localStorage.setItem(ZOOM_KEY, String(value));
  } catch {
    // private mode / disabled storage: zoom just won't persist.
  }
}

// Per-tab last sub-route, so a tab button returns where the user was (in-memory:
// a deleted /projects/:id or /date/:d must not be restored across reloads).
export const lastScheduleRoute = signal<string | null>(null);
export const lastProjectsRoute = signal<string | null>(null);

// Clear view-local state on logout; ids and routes belong to the old account.
// Zoom is intentionally kept: it's a device preference, not user data.
export function reset(): void {
  batch(() => {
    selectedItem.value = null;
    selectedTask.value = null;
    focusOnSelect.value = null;
    cursorMinute.value = null;
    selectedContentHeight.value = 0;
    fitScheduleId.value = null;
    scrollTop.value = 0;
    lastScheduleRoute.value = null;
    lastProjectsRoute.value = null;
  });
}

function loadZoom(): number {
  try {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    // ignore
  }
  return 1;
}
