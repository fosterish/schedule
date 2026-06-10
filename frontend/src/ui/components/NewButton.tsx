import type { JSX } from "preact";

import { PlusIcon } from "./icons";
import s from "./NewButton.module.css";

// Wide-screen header add button; the round bottom-anchored button takes over on
// narrow screens.
export function NewButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button type="button" class={s.btn} onClick={onClick} disabled={disabled}>
      <PlusIcon />
      <span>{label}</span>
    </button>
  );
}
