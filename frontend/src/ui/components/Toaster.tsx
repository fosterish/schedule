import type { JSX } from "preact";

import { dismissToast, toasts } from "@state/toast";

import { CloseIcon } from "./icons";
import s from "./Toaster.module.css";

// Global notice stack, mounted once in the shell. Reads the toast signal so any
// raised notice appears regardless of which view is active.
export function Toaster(): JSX.Element | null {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div class={s.stack} role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          class={`${t.kind === "error" ? `${s.toast} ${s.error}` : s.toast}${t.fading ? ` ${s.fading}` : ""}`}
        >
          <span class={s.message}>{t.message}</span>
          <button type="button" class={s.dismiss} aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
