import { computed, signal } from "@preact/signals";

import type { Settings } from "@bindings/Settings";
import * as layout from "@lib/schedule/layout";
import * as push from "@data/push";

import { commit } from "./commit";
import { localRev } from "./mint";
import { effectiveSettings } from "./pending";
import { user } from "./session";

const DEFAULT_LEAD_FIXED = 10;
const DEFAULT_LEAD_DYNAMIC = 0;

// --- synced, user-scoped preferences (shared across the user's devices) ---

const row = computed<Settings | null>(() => effectiveSettings.value[0] ?? null);

export const leadFixedMin = computed(() => row.value?.leadFixedMin ?? DEFAULT_LEAD_FIXED);
export const leadDynamicMin = computed(() => row.value?.leadDynamicMin ?? DEFAULT_LEAD_DYNAMIC);
export const defaultStart = computed(() => row.value?.defaultStart ?? layout.DEFAULT_START);
export const defaultEnd = computed(() => row.value?.defaultEnd ?? layout.DEFAULT_END);

// Upsert the singleton row, filling unset fields from the current row or the
// defaults, then committing through the normal sync path.
function update(patch: Partial<Omit<Settings, "userId" | "rev">>): void {
  const userId = user.value?.id;
  if (userId == null) return;
  const current = row.value;
  const next: Settings = {
    userId,
    leadFixedMin: current?.leadFixedMin ?? DEFAULT_LEAD_FIXED,
    leadDynamicMin: current?.leadDynamicMin ?? DEFAULT_LEAD_DYNAMIC,
    defaultStart: current?.defaultStart ?? layout.DEFAULT_START,
    defaultEnd: current?.defaultEnd ?? layout.DEFAULT_END,
    ...patch,
    rev: localRev(),
  };
  commit([{ kind: "upsert", model: { kind: "settings", ...next } }], "settings");
}

export const setLeadFixedMin = (n: number): void => update({ leadFixedMin: n });
export const setLeadDynamicMin = (n: number): void => update({ leadDynamicMin: n });
export const setDefaultStart = (n: number): void => update({ defaultStart: n });
export const setDefaultEnd = (n: number): void => update({ defaultEnd: n });

// --- device-local notification toggle (tied to this device's subscription) ---

export const notificationsEnabled = signal(false);

export const pushSupported = (): boolean => push.supported();

// Flip the device-local toggle, requesting permission on enable. Returns false
// when the user has blocked notifications, so the UI can surface it.
export async function toggleNotifications(): Promise<boolean> {
  const next = !notificationsEnabled.value;
  if (next && !(await push.ensurePermission())) return false;
  setNotificationsEnabled(next);
  return true;
}

let activeUser: string | null = null;

export function load(userId: string): void {
  activeUser = userId;
  notificationsEnabled.value = localStorage.getItem(key(userId)) === "1";
}

export function reset(): void {
  activeUser = null;
  notificationsEnabled.value = false;
}

export function setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled.value = enabled;
  if (activeUser != null) localStorage.setItem(key(activeUser), enabled ? "1" : "0");
}

function key(userId: string): string {
  return `schedule.notifications.${userId}`;
}
