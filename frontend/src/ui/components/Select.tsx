import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { ChevronDownIcon } from "./icons";
import s from "./Select.module.css";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  class?: string;
}

// Compact dropdown for a small fixed set of options (no search), used for the
// project/task selection-mode pickers.
export function Select<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  class: cls,
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div class={cls ? `${s.root} ${cls}` : s.root} ref={root}>
      <button
        type="button"
        class={s.control}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span class={s.value}>{current?.label}</span>
        <ChevronDownIcon />
      </button>
      {open && !disabled && (
        <div class={s.menu} role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              class={s.option}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
