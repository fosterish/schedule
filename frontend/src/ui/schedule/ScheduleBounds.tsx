import type { JSX } from "preact";

import { fmtClock, parseClockToMin } from "@lib/timefmt";
import { AutoField } from "@ui/components/AutoField";
import { DotsIcon } from "@ui/components/icons";
import { Stepper } from "@ui/components/Stepper";

import s from "./ScheduleBounds.module.css";

const STEP = 15;

// Snap to the next 15-min grid line in the step direction, or a full step when
// already aligned.
function snap(value: number, dir: number): number {
  if (value % STEP === 0) return value + dir * STEP;
  return dir > 0 ? Math.ceil(value / STEP) * STEP : Math.floor(value / STEP) * STEP;
}

interface Props {
  label: string;
  minute: number;
  edge: "start" | "end";
  top: number;
  onSet: (minute: number) => void;
  onResizeStart?: (e: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
}

// A light-gray marker for one schedule bound: a hairline at the bound minute with
// an editable clock field + 15-min spinner, clustered above the start / below the
// end. A centered grab handle (above the start, below the end) drags the bound.
export function ScheduleBound({ label, minute, edge, top, onSet, onResizeStart }: Props): JSX.Element {
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
      <div class={s.cluster}>
        <span class={s.label}>{label}</span>
        <AutoField
          value={fmtClock(minute)}
          onCommit={(t) => {
            const v = parseClockToMin(t);
            if (v != null) onSet(v);
          }}
          ariaLabel={`Schedule ${label.toLowerCase()}`}
          selectOnFocus
          commitOnBlur
          class={s.value!}
        />
        <Stepper onStep={(d) => onSet(snap(minute, d))} label={label} />
      </div>
    </div>
  );
}
