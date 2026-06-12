import type { JSX } from "preact";

import { TrashIcon } from "./icons";
import s from "./TrashButton.module.css";

interface Props {
  onClick: () => void;
  label?: string;
  class?: string;
  disabled?: boolean;
}

// A deliberately subtle delete affordance (muted, not red).
export function TrashButton({ onClick, label = "Delete", class: cls, disabled = false }: Props): JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      class={cls ? `${s.trash} ${cls}` : s.trash}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <TrashIcon />
    </button>
  );
}
