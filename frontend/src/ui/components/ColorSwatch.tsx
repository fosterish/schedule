import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { Color } from "@bindings/Color";
import { PALETTE, paletteColor } from "@ui/palette";

import s from "./ColorSwatch.module.css";

interface Props {
  value: Color;
  onPick: (color: Color) => void;
  class?: string;
}

// Round swatch opening an anchored palette popover (not a modal), attached
// below the swatch.
export function ColorSwatch({ value, onPick, class: cls }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div class={cls ? `${s.root} ${cls}` : s.root} ref={root}>
      <button
        type="button"
        class={s.swatch}
        style={{ background: paletteColor(value) }}
        aria-label="Color"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {open && (
        <div class={s.popover}>
          {PALETTE.map((p) => (
            <button
              key={p.key}
              type="button"
              class={p.key === value ? `${s.option} ${s.selected}` : s.option}
              style={{ background: p.hex }}
              title={p.label}
              aria-label={p.label}
              onClick={(e) => {
                e.stopPropagation();
                onPick(p.key);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
