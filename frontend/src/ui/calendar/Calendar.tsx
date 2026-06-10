import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import type { ScheduleView } from "@lib/schedule/resolve";
import { todayDate } from "@state/clock";
import { effectiveBindings, effectiveSchedules, effectiveTemplates } from "@state/pending";
import * as scheduleOps from "@state/mutations/schedule";
import { dateView } from "@state/views";
import { paletteColor } from "@ui/palette";
import { TrashButton } from "@ui/components/TrashButton";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@ui/components/icons";

import s from "./Calendar.module.css";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Calendar(): JSX.Element {
  const { route } = useLocation();
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const today = todayDate();

  const boundDates = new Set(effectiveBindings.value.map((b) => b.date));
  const monthName = new Date(ym.y, ym.m, 1).toLocaleString(undefined, { month: "long", year: "numeric" });

  const startCol = new Date(ym.y, ym.m, 1).getDay();
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(ym.y, ym.m, 1 - startCol + i));

  function gotoMonth(delta: number): void {
    const d = new Date(ym.y, ym.m + delta, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() });
  }

  const templates = effectiveTemplates.value
    .map((t) => effectiveSchedules.value.find((sch) => sch.id === t.scheduleId))
    .filter((sch): sch is NonNullable<typeof sch> => sch != null);

  return (
    <div class={s.screen}>
      <header class={s.header}>
        <h1 class={s.heading}>{monthName}</h1>
        <button type="button" class={s.navBtn} title="Previous month" onClick={() => gotoMonth(-1)}>
          <ChevronLeftIcon />
        </button>
        <button type="button" class={s.navBtn} title="Next month" onClick={() => gotoMonth(1)}>
          <ChevronRightIcon />
        </button>
        <button type="button" class={s.todayBtn} onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })}>
          Today
        </button>
      </header>

      <div class={s.scroll}>
        <section class={s.templates}>
          <div class={s.templatesHead}>
            <span>Templates</span>
            <button
              type="button"
              class={s.iconBtn}
              title="New template"
              onClick={() => {
                const id = scheduleOps.createTemplate();
                if (id != null) route(`/template/${id}`);
              }}
            >
              <PlusIcon />
            </button>
          </div>
          {templates.map((t) => (
            <div key={t.id} class={s.templateRow}>
              <button type="button" class={s.templateName} onClick={() => route(`/template/${t.id}`)}>
                {t.name || "Untitled template"}
              </button>
              <TrashButton onClick={() => scheduleOps.deleteSchedule(t.id)} label="Delete template" />
            </div>
          ))}
          {templates.length === 0 && <p class={s.empty}>No templates.</p>}
        </section>

        <div class={s.gridHead}>
          {DOW.map((d) => (
            <div key={d} class={s.dow}>
              {d}
            </div>
          ))}
        </div>
        <div class={s.grid}>
          {cells.map((d) => {
            const ds = ymd(d);
            const inMonth = d.getMonth() === ym.m;
            const isToday = ds === today;
            const scheduled = boundDates.has(ds);
            const view = scheduled ? dateView(ds) : null;
            const cls = [s.cell, inMonth ? "" : s.out, scheduled ? s.scheduled : "", isToday ? s.today : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <button key={ds} type="button" class={cls} onClick={() => route(isToday ? "/today" : `/date/${ds}`)}>
                <span class={s.num}>{d.getDate()}</span>
                <span class={s.mini}>{view && <MiniTimeline view={view} />}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MiniTimeline({ view }: { view: ScheduleView }): JSX.Element | null {
  if (view.items.length === 0) return null;
  const start = view.items[0]!.start;
  const end = view.items[view.items.length - 1]!.end;
  const total = end - start;
  if (total <= 0) return null;
  return (
    <span class={s.miniBar}>
      {view.items.map((it) => (
        <span
          key={it.id}
          class={s.miniBlock}
          style={`left:${((it.start - start) / total) * 100}%;width:${Math.max(2, ((it.end - it.start) / total) * 100)}%;background:${paletteColor(it.color)}`}
        />
      ))}
    </span>
  );
}

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
