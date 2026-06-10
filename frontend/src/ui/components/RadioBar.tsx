import type { JSX } from "preact";

import s from "./RadioBar.module.css";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

// Segmented control (no dots) used for the Task/Project item toggle.
export function RadioBar<T extends string>({ options, value, onChange }: Props<T>): JSX.Element {
  return (
    <div class={s.bar} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          class={o.value === value ? `${s.seg} ${s.active}` : s.seg}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
