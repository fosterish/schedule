import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";

import type { ScheduleItem } from "@bindings/ScheduleItem";
import * as layout from "@lib/schedule/layout";
import * as run from "@lib/schedule/run";
import * as split from "@lib/schedule/split";
import type { ScheduleView } from "@lib/schedule/resolve";
import { effectiveItems, effectiveSchedules, effectiveTemplates } from "@state/pending";
import * as scheduleOps from "@state/mutations/schedule";
import * as uistate from "@state/uistate";
import { AutoField } from "@ui/components/AutoField";
import { Combobox } from "@ui/components/Combobox";
import { HistoryControls } from "@ui/components/HistoryControls";
import { NewButton } from "@ui/components/NewButton";
import { TrashButton } from "@ui/components/TrashButton";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SplitIcon } from "@ui/components/icons";

import { RunControls } from "./RunControls";
import { ScheduleBoundsBar } from "./ScheduleBounds";
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

  // The toolbar's properties section (right on wide screens, bottom row when
  // narrow): editable start/end fields. The tools section holds the icon buttons.
  const propsSection = (): JSX.Element | null =>
    schedule ? (
      <div class={s.props}>
        <ScheduleBoundsBar
          start={schedule.start}
          end={schedule.end}
          onSet={(edge, minute) =>
            scheduleOps.patchScheduleBounds(schedule.id, edge === "start" ? { start: minute } : { end: minute })
          }
        />
      </div>
    ) : null;

  // Split acts at the cursor (the play head), falling back to now. It targets the
  // item that strictly contains that minute, so it's disabled in a gap, on a
  // boundary between items, or on a schedule edge.
  const splitMinute = uistate.cursorMinute.value ?? view?.nowMinute ?? null;
  const splitTargetId =
    schedule && view && splitMinute != null ? split.targetAt(view.items, splitMinute) : null;
  const splitItem = (): void => {
    if (schedule && splitMinute != null && scheduleOps.splitItem(schedule.id, splitMinute) != null) {
      uistate.panToCursor();
    }
  };

  // The Split tool closes every mode's toolbar, set off by a vertical rule.
  const splitTool = (
    <>
      <div class={s.divider} aria-hidden="true" />
      <button
        type="button"
        class={s.splitBtn}
        title="Split item at cursor"
        disabled={splitTargetId == null}
        onClick={splitItem}
      >
        <SplitIcon />
      </button>
    </>
  );

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
        <div class={s.subheader}>
          <div class={s.tools}>
            <div class={s.toolsMain}>
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
            {splitTool}
          </div>
          {propsSection()}
        </div>
      )}
      {mode === "template" && (
        <div class={s.subheader}>
          <div class={s.tools}>
            <div class={s.toolsMain}>
              <button type="button" class={s.todayBtn} onClick={() => route("/today")}>
                Today
              </button>
            </div>
            {splitTool}
          </div>
          {propsSection()}
        </div>
      )}
      {mode === "today" && (
        <div class={s.subheader}>
          <div class={s.tools}>
            <div class={s.toolsMain}>
              <RunControls scheduleId={schedule?.id ?? null} flags={flags} atMinute={runMinute} />
            </div>
            {splitTool}
          </div>
          {propsSection()}
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
