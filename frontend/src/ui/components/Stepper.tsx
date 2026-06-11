import type { JSX } from "preact";

import { ChevronDownIcon, ChevronUpIcon } from "./icons";
import s from "./Stepper.module.css";

interface Props {
  onStep: (delta: number) => void;
  label?: string;
}

// Up/down spinner shown beside a fixed start/duration/end value.
export function Stepper({ onStep, label }: Props): JSX.Element {
  return (
    <span class={s.stepper}>
      <button
        type="button"
        class={s.btn}
        tabIndex={-1}
        aria-label={label ? `Increase ${label}` : "Increase"}
        onClick={() => onStep(1)}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        class={s.btn}
        tabIndex={-1}
        aria-label={label ? `Decrease ${label}` : "Decrease"}
        onClick={() => onStep(-1)}
      >
        <ChevronDownIcon />
      </button>
    </span>
  );
}
