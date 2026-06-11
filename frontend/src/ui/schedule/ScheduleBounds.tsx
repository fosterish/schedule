import type { JSX } from "preact";

import { fmtClock, parseClockToMin } from "@lib/timefmt";
import { DotsIcon } from "@ui/components/icons";
import { StepperField } from "@ui/components/StepperField";

import s from "./ScheduleBounds.module.css";

const STEP = 15;

// Snap to the next 15-min grid line in the step direction, or a full step when
// already aligned.
function snap(value: number, dir: number): number {
  if (value % STEP === 0) return value + dir * STEP;
  return dir > 0 ? Math.ceil(value / STEP) * STEP : Math.floor(value / STEP) * STEP;
}

interface BoundProps {
  edge: "start" | "end";
  top: number;
  onResizeStart?: (e: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
}

// A light-gray marker for one schedule bound: a hairline at the bound minute with
// a centered grab handle (above the start, below the end) that drags the bound.
// The editable time value lives in the toolbar (ScheduleBoundsBar).
export function ScheduleBound({ edge, top, onResizeStart }: BoundProps): JSX.Element {
  const cls = `${s.bound} ${edge === "start" ? s.start : s.end}`;
  return (
    <div class={cls} style={`top:${top}px`} onClick={(e) => e.stopPropagation()}>
      <div class={s.line} />
      {onResizeStart && (
        <div
          class={s.handle}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e);
          }}
        >
          <DotsIcon />
        </div>
      )}
    </div>
  );
}

interface BarProps {
  start: number;
  end: number;
  onSet: (edge: "start" | "end", minute: number) => void;
}

// Editable start/end clock fields for the toolbar: each a label, a clock field,
// and a 15-min spinner.
export function ScheduleBoundsBar({ start, end, onSet }: BarProps): JSX.Element {
  return (
    <div class={s.bar}>
      <BoundField label="Start" minute={start} onSet={(v) => onSet("start", v)} />
      <BoundField label="End" minute={end} onSet={(v) => onSet("end", v)} />
    </div>
  );
}

function BoundField({ label, minute, onSet }: { label: string; minute: number; onSet: (m: number) => void }): JSX.Element {
  return (
    <div class={s.group}>
      <span class={s.label}>{label}</span>
      <StepperField
        value={fmtClock(minute)}
        onCommit={(t) => {
          const v = parseClockToMin(t);
          if (v != null) onSet(v);
        }}
        ariaLabel={`Schedule ${label.toLowerCase()}`}
        onStep={(d) => onSet(snap(minute, d))}
        bordered
      />
    </div>
  );
}
