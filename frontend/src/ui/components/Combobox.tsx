import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { fuzzyFilter } from "@lib/fuzzy";

import { ChevronDownIcon, CloseIcon } from "./icons";
import s from "./Combobox.module.css";

interface Props<T> {
  items: T[];
  value: T | null;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getColor?: (item: T) => string;
  onSelect: (item: T | null) => void;
  placeholder?: string;
  class?: string;
  valueClass?: string | undefined;
}

// Anchored fuzzy-filter dropdown (a menu, not a modal) for the project/task
// pickers and dependency search.
export function Combobox<T>({
  items,
  value,
  getKey,
  getLabel,
  getColor,
  onSelect,
  placeholder = "Select\u2026",
  class: cls,
  valueClass,
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close(): void {
    setOpen(false);
    setQuery("");
  }

  const filtered = fuzzyFilter(items, query, getLabel);
  const label = value != null ? getLabel(value) : placeholder;

  return (
    <div class={cls ? `${s.root} ${cls}` : s.root} ref={root}>
      <button
        type="button"
        class={s.control}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span class={s.lead}>
          {value != null && getColor && (
            <span class={s.swatch} style={{ background: getColor(value) }} />
          )}
          <span class={value != null ? [s.value, valueClass].filter(Boolean).join(" ") : s.placeholder}>
            {label}
          </span>
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div class={s.menu} role="listbox">
          <div class={s.searchRow}>
            <input
              class={s.search}
              autofocus
              value={query}
              placeholder={"Filter\u2026"}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            {query !== "" && (
              <button type="button" class={s.searchClear} aria-label="Clear filter" onClick={() => setQuery("")}>
                <CloseIcon />
              </button>
            )}
          </div>
          {filtered.map((it) => (
            <button
              key={getKey(it)}
              type="button"
              class={s.option}
              role="option"
              aria-selected={value != null && getKey(value) === getKey(it)}
              onClick={() => {
                onSelect(it);
                close();
              }}
            >
              {getColor && <span class={s.swatch} style={{ background: getColor(it) }} />}
              {getLabel(it)}
            </button>
          ))}
          {filtered.length === 0 && <div class={s.empty}>No matches</div>}
        </div>
      )}
    </div>
  );
}
