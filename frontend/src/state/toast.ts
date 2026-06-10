import { signal } from "@preact/signals";

export type ToastKind = "error" | "info";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  // Set during the fade-out preceding removal; drives the CSS transition.
  fading?: boolean;
}

const DEFAULT_TTL_MS = 4000;
// Timeout-less toasts linger this long before fading; all toasts fade over FADE_MS.
const LINGER_MS = 3000;
const FADE_MS = 1000;

// Transient, dismissible notices (e.g. a rejected edit). Lives in a signal so any
// component can raise one without prop drilling; the Toaster renders the stack.
export const toasts = signal<Toast[]>([]);

let nextId = 1;

export function pushToast(message: string, kind: ToastKind = "info", ttlMs = DEFAULT_TTL_MS): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, kind }];
  // Reserve the final FADE_MS of the lifetime for the fade-out, preserving the
  // overall TTL; timeout-less toasts linger then fade rather than persisting.
  const lingerMs = ttlMs > 0 ? Math.max(0, ttlMs - FADE_MS) : LINGER_MS;
  window.setTimeout(() => fadeToast(id), lingerMs);
}

function fadeToast(id: number): void {
  if (!toasts.value.some((t) => t.id === id)) return;
  toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, fading: true } : t));
  window.setTimeout(() => dismissToast(id), FADE_MS);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
