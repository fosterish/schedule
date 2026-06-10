import type { JSX, Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import s from "./AutoField.module.css";

interface Props {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  // Single logical line that soft-wraps and auto-grows; Enter still commits.
  wrap?: boolean;
  // Shrink the field's width to its text (via a mirror) so a sibling can sit
  // flush after it. Only meaningful with wrap/multiline.
  fitContent?: boolean;
  debounceMs?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
  class?: string;
  disabled?: boolean;
  // Render the placeholder like committed text (full color) until focused, then
  // dim it while editing. Used for the schedule/template title.
  solidPlaceholder?: boolean;
  // Select the whole value on focus so a click overwrites (e.g. time fields).
  selectOnFocus?: boolean;
  // Skip the per-keystroke debounced commit; commit only on blur or Enter.
  commitOnBlur?: boolean;
}

type FieldEvent = JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement>;
type FieldKeyEvent = JSX.TargetedKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>;

// In-place editor that commits per keystroke, debounced (~0.8s), plus on blur.
// With commitOnBlur it instead commits only on blur or Enter. External value
// updates are accepted only while not mid-edit, so the optimistic round-trip
// never clobbers what the user is typing. Multiline auto-grows to fit its text.
export function AutoField({
  value,
  onCommit,
  placeholder,
  multiline = false,
  wrap = false,
  fitContent = false,
  debounceMs = 800,
  autoFocus = false,
  ariaLabel,
  class: cls,
  disabled = false,
  solidPlaceholder = false,
  selectOnFocus = false,
  commitOnBlur = false,
}: Props): JSX.Element {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  const editing = useRef(false);
  const timer = useRef<number | null>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const justFocused = useRef(false);

  useEffect(() => {
    if (!editing.current) setLocal(value);
  }, [value]);

  const grow = multiline || wrap;

  // Layout effect (pre-paint) so a wrap grows the field in the same frame,
  // avoiding a one-frame flash of the clipped new line.
  useLayoutEffect(() => {
    if (!grow || fitContent) return;
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight omits the border, but border-box height includes it; add it
    // back so the content box isn't a couple px short (which scrolls line 1 up).
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
  }, [local, grow, fitContent]);

  // Focus via a ref, not the `autofocus` attribute (browsers honor dynamic
  // autofocus only once per document load). Re-assert on the next frame because
  // the select-to-zoom relayout otherwise steals focus right after mount.
  useEffect(() => {
    if (!autoFocus) return;
    const place = (): void => {
      const el = field.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // some input types reject setSelectionRange; focus alone is enough.
      }
    };
    place();
    const r = requestAnimationFrame(place);
    return () => cancelAnimationFrame(r);
  }, [autoFocus]);

  useEffect(() => () => clearTimer(), []);

  function clearTimer(): void {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function commit(next: string): void {
    clearTimer();
    editing.current = false;
    if (next !== value) onCommit(next);
  }

  function onFieldFocus(): void {
    setFocused(true);
    if (selectOnFocus) {
      justFocused.current = true;
      field.current?.select();
    }
  }

  // A click's mouseup lands the caret and clears the focus-time select-all;
  // swallow just that first one so the whole value stays selected.
  function onFieldMouseUp(e: MouseEvent): void {
    if (selectOnFocus && justFocused.current) {
      e.preventDefault();
      justFocused.current = false;
    }
  }

  function onBlur(): void {
    setFocused(false);
    commit(local);
  }

  function onInput(e: FieldEvent): void {
    const next = e.currentTarget.value;
    editing.current = true;
    setLocal(next);
    clearTimer();
    if (commitOnBlur) return;
    timer.current = window.setTimeout(() => commit(next), debounceMs);
  }

  function onKeyDown(e: FieldKeyEvent): void {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      clearTimer();
      editing.current = false;
      setLocal(value);
      e.currentTarget.blur();
    }
  }

  const base = cls ? `${s.field} ${cls}` : s.field;
  const className = solidPlaceholder && !focused ? `${base} ${s.solidPlaceholder}` : base;
  if (grow) {
    const textarea = (
      <textarea
        ref={field as Ref<HTMLTextAreaElement>}
        rows={1}
        cols={fitContent ? 1 : undefined}
        class={fitContent ? s.field! : className}
        value={local}
        placeholder={placeholder ?? ""}
        aria-label={ariaLabel ?? ""}
        disabled={disabled}
        onFocus={onFieldFocus}
        onInput={onInput}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
    if (!fitContent) return textarea;
    // A hidden mirror (::after fed by data-value) sizes the grid to the text,
    // letting the field hug its content regardless of `field-sizing` support.
    const wrapper = cls ? `${s.sizer} ${cls}` : s.sizer!;
    return (
      <span class={wrapper} data-value={local.length ? local : (placeholder ?? "")}>
        {textarea}
      </span>
    );
  }
  return (
    <input
      ref={field as Ref<HTMLInputElement>}
      type="text"
      class={className}
      value={local}
      placeholder={placeholder ?? ""}
      aria-label={ariaLabel ?? ""}
      disabled={disabled}
      onFocus={onFieldFocus}
      onMouseUp={onFieldMouseUp}
      onInput={onInput}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}
