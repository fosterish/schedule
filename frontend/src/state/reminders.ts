import { computed, effect } from "@preact/signals";

import * as push from "@data/push";
import * as remind from "@lib/schedule/reminders";
import type { ItemPayload } from "@lib/schedule/resolve";

import { effectiveItems } from "./pending";
import { user } from "./session";
import * as settings from "./settings";
import { scheduleViewForReminders } from "./views";

// Reminders, recomputed only when the schedule content or lead settings change
// (never on clock ticks), snapshotting "now" at that moment.
const plannedReminders = computed<remind.PlannedReminder[]>(() => {
  const view = scheduleViewForReminders.value;
  if (view.nowMinute == null) return [];
  const overflow = view.mode.kind === "today" && view.mode.overflow;
  const dayStartMs = midnightMs(overflow ? -1 : 0);
  const fixedById = new Map(effectiveItems.value.map((it) => [it.id, it.bounds.start != null]));
  const items: remind.ReminderItem[] = view.items.map((vi) => ({
    startMinute: vi.start,
    fixedStart: fixedById.get(vi.id) ?? false,
    title: titleOf(vi.payload),
  }));
  return remind.plan(items, view.nowMinute, dayStartMs, {
    fixedMin: settings.leadFixedMin.value,
    dynamicMin: settings.leadDynamicMin.value,
  });
});

let lastUpload = "";

// Keep the server's reminder set in sync whenever signed in. Reminders upload
// regardless of this device's notification toggle, since the user's other
// devices may be listening. Call once at boot. (This device's own push
// subscription is managed in state/settings.) 
export function startReminders(): void {
  effect(() => {
    const list = plannedReminders.value;
    if (user.value == null) {
      lastUpload = "";
      return;
    }
    const serialized = JSON.stringify(list);
    if (serialized === lastUpload) return;
    lastUpload = serialized;
    void push.uploadReminders(list);
  });
}

function titleOf(payload: ItemPayload): string {
  switch (payload.kind) {
    case "inline":
      return payload.label.trim() || "Untitled";
    case "task": {
      const project = payload.projectName.trim();
      const task = payload.taskName.trim() || "Untitled";
      return project ? `${project}: ${task}` : task;
    }
    case "noTask":
      return payload.projectName.trim() || "Untitled";
    case "noProject":
      return "Scheduled item";
  }
}

function midnightMs(dayOffset: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}
