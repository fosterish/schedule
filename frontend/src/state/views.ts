import { computed } from "@preact/signals";

import type { Schedule } from "@bindings/Schedule";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import * as project from "@lib/project";
import type { ScheduleView } from "@lib/schedule/resolve";
import * as resolve from "@lib/schedule/resolve";

import { nowMinute, todayDate, yesterdayDate } from "./clock";
import {
  effectiveBindings,
  effectiveDependencies,
  effectiveItems,
  effectiveProjects,
  effectiveSchedules,
  effectiveTasks,
} from "./pending";

// Rebuilt whenever the effective project/task/dependency rows change.
export const projectIndex = computed(
  () =>
    new project.ProjectIndex(
      effectiveProjects.value,
      effectiveTasks.value,
      effectiveDependencies.value,
    ),
);

// The Today tab: yesterday-overflow aware, ticking with nowMinute.
export const scheduleViewToday = computed<ScheduleView>(() =>
  resolve.today(
    projectIndex.value,
    scheduleForDate(todayDate()),
    scheduleForDate(yesterdayDate()),
    nowMinute.value,
  ),
);

// Same view, but reads the clock untracked so it only recomputes when the
// schedule content changes. Reminders snapshot "now" at edit time and must not
// churn on every tick (which would clear pending reminders mid-flight).
export const scheduleViewForReminders = computed<ScheduleView>(() =>
  resolve.today(
    projectIndex.value,
    scheduleForDate(todayDate()),
    scheduleForDate(yesterdayDate()),
    nowMinute.peek(),
  ),
);

// A routed date view, or null when no schedule is bound to that date.
export function dateView(date: string): ScheduleView | null {
  const bound = scheduleForDate(date);
  return bound ? resolve.date(projectIndex.value, bound[0], bound[1], date) : null;
}

// A routed template view, or null when the schedule is gone.
export function templateView(scheduleId: string): ScheduleView | null {
  const schedule = effectiveSchedules.value.find((s) => s.id === scheduleId);
  if (!schedule) return null;
  return resolve.template(projectIndex.value, schedule, itemsOf(scheduleId));
}

function scheduleForDate(date: string): [Schedule, ScheduleItem[]] | null {
  const binding = effectiveBindings.value.find((b) => b.date === date);
  if (!binding) return null;
  const schedule = effectiveSchedules.value.find((s) => s.id === binding.scheduleId);
  if (!schedule) return null;
  return [schedule, itemsOf(schedule.id)];
}

function itemsOf(scheduleId: string): ScheduleItem[] {
  return effectiveItems.value.filter((i) => i.scheduleId === scheduleId);
}
