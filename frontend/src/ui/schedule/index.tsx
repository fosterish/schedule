import type { JSX } from "preact";

import { todayDate } from "@state/clock";
import { dateView, scheduleViewToday, templateView } from "@state/views";

import { ScheduleScreen } from "./ScheduleScreen";

export function ScheduleToday(): JSX.Element {
  return <ScheduleScreen view={scheduleViewToday.value} mode="today" date={todayDate()} />;
}

export function ScheduleDate({ date }: { date?: string }): JSX.Element | null {
  if (!date) return null;
  return <ScheduleScreen view={dateView(date)} mode="date" date={date} />;
}

export function ScheduleTemplate({ id }: { id?: string }): JSX.Element | null {
  if (!id) return null;
  return <ScheduleScreen view={templateView(id)} mode="template" date={null} />;
}
