import type { JSX } from "preact";

import s from "./Loading.module.css";

// Full-screen spinner shown only during a fresh login's first data load.
export function Loading(): JSX.Element {
  return (
    <div class={s.screen} role="status" aria-label="Loading">
      <div class={s.spinner} />
    </div>
  );
}
