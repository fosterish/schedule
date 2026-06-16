// Pure reminder planner: from today's resolved items, schedule a notification
// for every future fixed-start item and for the single next dynamic-start item.
// Fire times are absolute epoch ms; the server only relays them.

import { fmtClock, fmtDurationHuman } from "@lib/timefmt";

export interface ReminderItem {
  // Resolved start in the schedule frame (minutes from frame minute 0).
  startMinute: number;
  // Resolved end in the schedule frame (minutes from frame minute 0).
  endMinute: number;
  // The start edge is pinned (an absolute time), not flowed from neighbours.
  fixedStart: boolean;
  title: string;
}

export interface ReminderLeads {
  fixedMin: number;
  dynamicMin: number;
}

export interface PlannedReminder {
  fireAtMs: number;
  payload: { title: string; body: string };
}

const MS_PER_MIN = 60_000;

export function plan(
  items: ReminderItem[],
  nowMinute: number,
  dayStartMs: number,
  leads: ReminderLeads,
): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const future = items.filter((it) => it.startMinute > nowMinute);

  for (const it of future) {
    if (it.fixedStart) add(out, it, leads.fixedMin, nowMinute, dayStartMs);
  }

  const nextDynamic = future
    .filter((it) => !it.fixedStart)
    .sort((a, b) => a.startMinute - b.startMinute)[0];
  if (nextDynamic) add(out, nextDynamic, leads.dynamicMin, nowMinute, dayStartMs);

  return out.sort((a, b) => a.fireAtMs - b.fireAtMs);
}

// Skip when the lead window has already passed: firing in the past would deliver
// immediately and re-fire on every recompute (uploads replace the whole set).
function add(
  out: PlannedReminder[],
  it: ReminderItem,
  leadMin: number,
  nowMinute: number,
  dayStartMs: number,
): void {
  const fireMinute = it.startMinute - leadMin;
  if (fireMinute <= nowMinute) return;
  out.push({
    fireAtMs: dayStartMs + fireMinute * MS_PER_MIN,
    payload: { title: it.title, body: body(it, leadMin) },
  });
}

function body(it: ReminderItem, leadMin: number): string {
  const lead = leadMin > 0 ? `Starts in ${leadMin} min` : "Starting now";
  const span = `${fmtClock(it.startMinute)} \u2013 ${fmtClock(it.endMinute)} (${fmtDurationHuman(
    it.endMinute - it.startMinute,
  )})`;
  return `${lead} \u00b7 ${span}`;
}
