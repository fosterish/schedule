import type { JSX } from "preact";
import { useRef } from "preact/hooks";

import type { ScheduleItem } from "@bindings/ScheduleItem";
import { fmtClock, fmtDurationHuman, parseClockToMin, parseDurationToMin } from "@lib/timefmt";
import * as scheduleOps from "@state/mutations/schedule";
import * as settings from "@state/settings";

import { ColorSwatch } from "@ui/components/ColorSwatch";
import { RadioBar } from "@ui/components/RadioBar";
import { StepperField } from "@ui/components/StepperField";
import { AnchorIcon } from "@ui/components/icons";

import s from "./ItemEditor.module.css";

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
        value={fmtClock(frameStart, settings.hour12.value)}
        fixed={startFixed}
        onEdit={(t) => {
          const v = parseClockToMin(t);
          if (v == null) return;
          if (startDerived) scheduleOps.setItemDuration(sid, raw.id, frameEnd - v);
          else scheduleOps.setItemEdgeValue(sid, raw.id, "start", v);
        }}
        onToggle={() => scheduleOps.toggleItemEdge(sid, raw.id, "start")}
        onStep={(d) => scheduleOps.stepItemEdge(sid, raw.id, "start", d)}
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
          if (durationFixed) scheduleOps.setItemDuration(sid, raw.id, v);
          else scheduleOps.patchItemBounds(raw.id, { durationTarget: v });
        }}
        onToggle={() => scheduleOps.toggleItemDuration(sid, raw.id)}
        onStep={(d) => scheduleOps.stepItemDuration(sid, raw.id, d)}
      />
      <AnchorRow
        label="End"
        value={fmtClock(frameEnd, settings.hour12.value)}
        fixed={endFixed}
        onEdit={(t) => {
          const v = parseClockToMin(t);
          if (v == null) return;
          if (endDerived) scheduleOps.setItemDuration(sid, raw.id, v - frameStart);
          else scheduleOps.setItemEdgeValue(sid, raw.id, "end", v);
        }}
        onToggle={() => scheduleOps.toggleItemEdge(sid, raw.id, "end")}
        onStep={(d) => scheduleOps.stepItemEdge(sid, raw.id, "end", d)}
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
  const row = useRef<HTMLDivElement | null>(null);
  // An anchor press may not blur the field (Safari/Firefox); commit it first.
  const flush = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && row.current?.contains(active)) active.blur();
  };
  // Toggle on the press, not the trailing click: committing the field can reflow
  // the item out from under the pointer, dropping a click released over a gap.
  const press = (): void => {
    flush();
    onToggle();
  };
  // Keyboard activation (Enter/Space) has no pointerdown and reports detail 0.
  const keyToggle = (e: MouseEvent): void => {
    if (e.detail === 0) onToggle();
  };
  return (
    <div class={s.row} ref={row}>
      <span class={s.label}>{label}</span>
      <div>
        <StepperField
          value={value}
          onCommit={onEdit}
          ariaLabel={label}
          disabled={disabled}
          onStep={stepper ? onStep : undefined}
        />
        {!hideToggle ? (
          <button
            type="button"
            class={btnClass}
            aria-pressed={fixed}
            title={fixed ? "Unpin" : "Pin"}
            onPointerDown={press}
            onClick={keyToggle}
          >
            <AnchorIcon />
          </button>
        ) : (
          <div class={s.togglePlaceholder} />
        )}
      </div>
    </div>
  );
}
