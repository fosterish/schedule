import type { JSX } from "preact";

import type { ScheduleItem } from "@bindings/ScheduleItem";
import { fmtClock, fmtDurationHuman, parseClockToMin, parseDurationToMin } from "@lib/timefmt";
import * as scheduleOps from "@state/mutations/schedule";

import { AutoField } from "@ui/components/AutoField";
import { ColorSwatch } from "@ui/components/ColorSwatch";
import { RadioBar } from "@ui/components/RadioBar";
import { Stepper } from "@ui/components/Stepper";
import { AnchorIcon } from "@ui/components/icons";

import s from "./ItemEditor.module.css";

const STEP = 15;

// Spinner step: snap to the next 15-min grid line in the click direction, or a
// full step when already aligned.
function snap(value: number, dir: number): number {
  if (value % STEP === 0) return value + dir * STEP;
  return dir > 0 ? Math.ceil(value / STEP) * STEP : Math.floor(value / STEP) * STEP;
}

interface Props {
  raw: ScheduleItem;
  frameStart: number;
  frameEnd: number;
}

// The controls below an item's title/description: color, Task/Project mode,
// project/task pickers, and the labeled Start / Duration / End anchors. The
// title and description themselves live in the Block head so they don't shift
// when selection toggles.
export function ItemEditor({ raw, frameStart, frameEnd }: Props): JSX.Element {
  const startFixed = raw.bounds.start != null;
  const endFixed = raw.bounds.end != null;
  const durationFixed = raw.bounds.fixedDuration != null;
  const bothEnds = startFixed && endFixed;
  const durationLabel = durationFixed || bothEnds ? "Duration" : "Desired duration";
  // A rigid item's unfixed edge is derived from the other edge + duration; typing
  // it adjusts the duration rather than pinning that edge.
  const startDerived = !startFixed && endFixed && durationFixed;
  const endDerived = !endFixed && startFixed && durationFixed;
  const sid = raw.scheduleId;
  const durationMin = durationFixed
    ? raw.bounds.fixedDuration!
    : bothEnds
      ? frameEnd - frameStart
      : raw.bounds.durationTarget;

  return (
    <div class={s.controls} onClick={(e) => e.stopPropagation()}>
      {raw.useInline && (
        <div class={s.row}>
          <span class={s.label}>Color</span>
          <span class={s.swatchCell}>
            <ColorSwatch
              value={raw.inlineColor}
              onPick={(c) => scheduleOps.patchItem(raw.id, { inlineColor: c })}
            />
          </span>
        </div>
      )}

      <AnchorRow
        label="Start"
        value={fmtClock(frameStart)}
        fixed={startFixed}
        onEdit={(t) => {
          const v = parseClockToMin(t);
          if (v == null) return;
          if (startDerived) scheduleOps.slideItemDuration(sid, raw.id, frameEnd - v);
          else scheduleOps.setItemEdgeValue(sid, raw.id, "start", v);
        }}
        onToggle={() => scheduleOps.patchItemBounds(raw.id, { start: startFixed ? null : frameStart })}
        onStep={(d) => scheduleOps.slideItemEdge(sid, raw.id, "start", snap(frameStart, d))}
      />
      <AnchorRow
        label={durationLabel}
        value={fmtDurationHuman(durationMin)}
        fixed={durationFixed}
        hideToggle={bothEnds}
        disabled={bothEnds}
        showStepper={!bothEnds}
        onEdit={(t) => {
          const v = parseDurationToMin(t);
          if (v == null) return;
          if (durationFixed) scheduleOps.slideItemDuration(sid, raw.id, v);
          else scheduleOps.patchItemBounds(raw.id, { durationTarget: v });
        }}
        onToggle={() =>
          scheduleOps.patchItemBounds(raw.id, {
            fixedDuration: durationFixed ? null : frameEnd - frameStart,
          })
        }
        onStep={(d) => {
          const v = Math.max(STEP, snap(durationMin, d));
          if (durationFixed) scheduleOps.slideItemDuration(sid, raw.id, v);
          else scheduleOps.patchItemBounds(raw.id, { durationTarget: v });
        }}
      />
      <AnchorRow
        label="End"
        value={fmtClock(frameEnd)}
        fixed={endFixed}
        onEdit={(t) => {
          const v = parseClockToMin(t);
          if (v == null) return;
          if (endDerived) scheduleOps.slideItemDuration(sid, raw.id, v - frameStart);
          else scheduleOps.setItemEdgeValue(sid, raw.id, "end", v);
        }}
        onToggle={() => scheduleOps.patchItemBounds(raw.id, { end: endFixed ? null : frameEnd })}
        onStep={(d) => scheduleOps.slideItemEdge(sid, raw.id, "end", snap(frameEnd, d))}
      />

      <div class={s.fullRow}>
        <RadioBar
          options={[
            { value: "task", label: "Task" },
            { value: "project", label: "Project" },
          ]}
          value={raw.useInline ? "task" : "project"}
          onChange={(v) => scheduleOps.patchItem(raw.id, { useInline: v === "task" })}
        />
      </div>
    </div>
  );
}

interface AnchorRowProps {
  label: string;
  value: string;
  fixed: boolean;
  hideToggle?: boolean;
  disabled?: boolean;
  showStepper?: boolean;
  onEdit: (text: string) => void;
  onToggle: () => void;
  onStep: (delta: number) => void;
}

function AnchorRow({
  label,
  value,
  fixed,
  hideToggle = false,
  disabled = false,
  showStepper,
  onEdit,
  onToggle,
  onStep,
}: AnchorRowProps): JSX.Element {
  const stepper = showStepper ?? fixed;
  const btnClass = fixed ? `${s.anchorBtn} ${s.anchorOn}` : s.anchorBtn!;
  return (
    <div class={s.row}>
      <span class={s.label}>{label}</span>
      <div class={s.valueWrap}>
        <AutoField
          value={value}
          onCommit={onEdit}
          ariaLabel={label}
          disabled={disabled}
          selectOnFocus
          commitOnBlur
          class={stepper ? `${s.anchorValue} ${s.anchorValueFixed}` : s.anchorValue!}
        />
        {stepper && (
          <span class={s.stepperSlot}>
            <Stepper onStep={onStep} />
          </span>
        )}
      </div>
      {!hideToggle && (
        <button
          type="button"
          class={btnClass}
          aria-pressed={fixed}
          title={fixed ? "Unpin" : "Pin"}
          onClick={onToggle}
        >
          <AnchorIcon />
        </button>
      )}
    </div>
  );
}
