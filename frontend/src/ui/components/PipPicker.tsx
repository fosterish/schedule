import type { JSX } from "preact";

import type { Color } from "@bindings/Color";
import { paletteColor } from "@ui/palette";

import s from "./PipPicker.module.css";

interface Props {
  value: number;
  count: number;
  color: Color;
  onPick?: (level: number) => void;
  readonly?: boolean;
}

// 1..count rating pips, filled up to `value` in the palette color. Interactive
// when onPick is given; clicks never bubble (rows route on click).
export function PipPicker({ value, count, color, onPick, readonly }: Props): JSX.Element {
  const hex = paletteColor(color);
  const filled = Math.max(0, Math.min(count, Math.round(value)));
  return (
    <div class={s.pips}>
      {Array.from({ length: count }, (_, i) => i + 1).map((level) => {
        const on = level <= filled;
        return (
          <button
            key={level}
            type="button"
            disabled={readonly}
            class={on ? `${s.pip} ${s.on}` : s.pip}
            style={on ? { background: hex, borderColor: hex } : undefined}
            aria-label={`Level ${level}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPick?.(level);
            }}
          />
        );
      })}
    </div>
  );
}
