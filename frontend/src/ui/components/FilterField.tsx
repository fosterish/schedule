import type { JSX } from "preact";

import { CloseIcon } from "./icons";
import s from "./FilterField.module.css";

interface Props {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  class?: string;
  disabled?: boolean;
}

export function FilterField({ value, onInput, placeholder = "Filter\u2026", ariaLabel = "Filter", class: cls, disabled = false }: Props): JSX.Element {
  return (
    <div class={cls ? `${s.root} ${cls}` : s.root}>
      <input
        type="text"
        class={s.input}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      {value !== "" && (
        <button type="button" class={s.clear} aria-label="Clear filter" onClick={() => onInput("")}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
