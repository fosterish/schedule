import type { JSX } from "preact";
import { useRef } from "preact/hooks";

import { AutoField } from "./AutoField";
import { Stepper } from "./Stepper";
import s from "./StepperField.module.css";

interface Props {
  value: string;
  onCommit: (text: string) => void;
  ariaLabel: string;
  // Provide to show an inset up/down spinner; called with +1 / -1.
  onStep?: ((delta: number) => void) | undefined;
  disabled?: boolean;
  // Draw a visible box around the field (e.g. as a form control in settings).
  bordered?: boolean;
}

// A compact, left-aligned time/duration field with an optional inset spinner,
// shared by the schedule editors and settings so they stay visually in sync.
export function StepperField({
  value,
  onCommit,
  ariaLabel,
  onStep,
  disabled = false,
  bordered = false,
}: Props): JSX.Element {
  const cls = [s.value, onStep ? s.stepped : "", bordered ? s.bordered : ""].filter(Boolean).join(" ");
  const wrap = useRef<HTMLDivElement | null>(null);
  // A spinner press may not blur the field (Safari/Firefox); commit it first.
  const flush = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && wrap.current?.contains(active)) active.blur();
  };
  return (
    <div class={s.wrap} ref={wrap}>
      <AutoField
        value={value}
        onCommit={onCommit}
        ariaLabel={ariaLabel}
        disabled={disabled}
        selectOnFocus
        commitOnBlur
        class={cls}
      />
      {onStep && (
        <span class={s.slot} onPointerDown={flush}>
          <Stepper onStep={onStep} label={ariaLabel} />
        </span>
      )}
    </div>
  );
}
