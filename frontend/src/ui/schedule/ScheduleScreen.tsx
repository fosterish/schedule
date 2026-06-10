import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";

import type { ScheduleItem } from "@bindings/ScheduleItem";
import * as layout from "@lib/schedule/layout";
import * as run from "@lib/schedule/run";
import type { ScheduleView } from "@lib/schedule/resolve";
import { effectiveItems, effectiveSchedules, effectiveTemplates } from "@state/pending";
import * as scheduleOps from "@state/mutations/schedule";
import * as uistate from "@state/uistate";
import { AutoField } from "@ui/components/AutoField";
import { Combobox } from "@ui/components/Combobox";
import { HistoryControls } from "@ui/components/HistoryControls";
import { NewButton } from "@ui/components/NewButton";
import { TrashButton } from "@ui/components/TrashButton";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@ui/components/icons";

import { RunControls } from "./RunControls";
import { Timeline } from "./Timeline";
import s from "./ScheduleScreen.module.css";

type Mode = "today" | "date" | "template";

interface Props {
  view: ScheduleView | null;
  mode: Mode;
  date: string | null;
}

export function ScheduleScreen({ view, mode, date }: Props): JSX.Element {
  const { path, route } = useLocation();
  // The insert action lives in Timeline (it reads the time cursor). The header's
  // wide-screen "New item" button triggers it through this handle.
  const insertRef = useRef<() => void>(null);
  useEffect(() => {
    uistate.lastScheduleRoute.value = path;
    uistate.selectItem(null);
    uistate.cursorMinute.value = null;
  }, [path]);

  if (mode === "template" && (!view || !view.schedule)) {
    return <div class={s.centered}>Template not found.</div>;
  }
  const schedule = view?.schedule ?? null;

  const rawRows = schedule
    ? effectiveItems.value
        .filter((it) => it.scheduleId === schedule.id)
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    : [];
  const rawById = new Map<string, ScheduleItem>(rawRows.map((it) => [it.id, it]));

  // Run actions evaluate at the cursor (the play head), falling back to the live
  // clock when the cursor is live/unset. Enablement, targets, and the action all
  // share this minute so dragging the cursor steers the controls and badges.
  let flags: run.RunFlags | null = null;
  let runMinute: number | null = null;
  if (schedule && view && mode === "today" && view.nowMinute != null) {
    runMinute = uistate.cursorMinute.value ?? view.nowMinute;
    const items = rawRows.map((it) => ({ id: it.id, bounds: it.bounds }));
    const span = { start: schedule.start, end: schedule.end };
    flags = run.flags(items, layout.compute(items, span), runMinute, span);
  }

  const hasTitle = (schedule?.name ?? "").trim() !== "";
  const titlePlaceholder =
    mode === "today" ? "Today" : mode === "date" && date != null ? fmtDateLabel(date) : "Untitled template";
  const showDateTag = mode === "date" && hasTitle && date != null;

  return (
    <div class={s.screen}>
      <header class={s.header}>
        <div class={showDateTag ? `${s.titleRow} ${s.titleRowHug}` : s.titleRow}>
          <AutoField
            value={schedule?.name ?? ""}
            onCommit={(name) => {
              if (schedule) scheduleOps.renameSchedule(schedule.id, name);
            }}
            placeholder={titlePlaceholder}
            ariaLabel="Schedule name"
            class={s.title!}
            disabled={!schedule}
            solidPlaceholder
            wrap
          />
          {showDateTag && (
            <span class={s.titleDate} aria-hidden="true">
              ({fmtDateLabel(date)})
            </span>
          )}
        </div>
        <HistoryControls context="schedule" />
        <NewButton label="New item" onClick={() => insertRef.current?.()} disabled={!schedule} />
        <TrashButton
          onClick={() => {
            if (schedule) scheduleOps.deleteSchedule(schedule.id);
          }}
          label="Delete schedule"
          disabled={!schedule}
        />
      </header>
      {mode === "date" && date != null && (
        <div class={`${s.subheader} ${s.subheaderStart}`}>
          <div class={s.nav}>
            <button type="button" class={s.navBtn} title="Previous day" onClick={() => route(`/date/${shiftDate(date, -1)}`)}>
              <ChevronLeftIcon />
            </button>
            <button type="button" class={s.navBtn} title="Next day" onClick={() => route(`/date/${shiftDate(date, 1)}`)}>
              <ChevronRightIcon />
            </button>
          </div>
          <button type="button" class={s.todayBtn} onClick={() => route("/today")}>
            Today
          </button>
        </div>
      )}
      {mode === "template" && (
        <div class={`${s.subheader} ${s.subheaderStart}`}>
          <button type="button" class={s.todayBtn} onClick={() => route("/today")}>
            Today
          </button>
        </div>
      )}
      {mode === "today" && (
        <div class={s.subheader}>
          <RunControls scheduleId={schedule?.id ?? null} flags={flags} atMinute={runMinute} />
        </div>
      )}
      {schedule && view ? (
        <Timeline
          view={view}
          rawById={rawById}
          scheduleId={schedule.id}
          cursorEnabled={mode === "today"}
          flags={flags}
          insertRef={insertRef}
        />
      ) : (
        <EmptyState date={date} mode={mode} />
      )}
    </div>
  );
}

function EmptyState({ date, mode }: { date: string | null; mode: Mode }): JSX.Element {
  if (date == null) return <div class={s.centered}>Nothing here.</div>;
  const templates = effectiveTemplates.value
    .map((t) => effectiveSchedules.value.find((sch) => sch.id === t.scheduleId))
    .filter((sch): sch is NonNullable<typeof sch> => sch != null);

  return (
    <div class={s.empty}>
      <p class={s.emptyMsg}>{mode === "today" ? "No schedule for today." : "No schedule for this day."}</p>
      <div class={s.emptyActions}>
        <button type="button" class={s.primary} onClick={() => scheduleOps.createScheduleForDate(date)}>
          <PlusIcon />
          <span>Create schedule</span>
        </button>
        {templates.length > 0 && (
          <Combobox
            items={templates}
            value={null}
            getKey={(t) => t.id}
            getLabel={(t) => t.name || "Untitled template"}
            placeholder={"Fork from template\u2026"}
            class={s.forkPicker!}
            onSelect={(t) => {
              if (t) scheduleOps.forkTemplateToDate(t.id, date);
            }}
          />
        )}
      </div>
    </div>
  );
}

function fmtDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
