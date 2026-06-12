import { computed, effect, signal } from "@preact/signals";

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

// --- device notifications: persisted intent gated by live browser permission ---

// `intent` is the user's persisted wish for this device; `permissionGranted`
// mirrors the browser's actual Notification permission. The toggle shows on only
// when both hold, so a permission revoked in browser settings turns it off
// without forgetting the wish (re-granting turns it back on).
const intent = signal(false);
const permissionGranted = signal(currentPermission());

export const notificationsEnabled = computed(() => intent.value && permissionGranted.value);

export const pushSupported = (): boolean => push.supported();

let activeUser: string | null = null;

function currentPermission(): boolean {
  return push.supported() && Notification.permission === "granted";
}

function wantSubscription(): boolean {
  return user.value != null && intent.value && permissionGranted.value;
}

// User gesture: record the wish and, when enabling, request permission. Returns
// false when notifications are blocked, so the UI can surface it. The intent
// sticks even if blocked, so granting permission later flips the toggle on.
export async function toggleNotifications(): Promise<boolean> {
  if (notificationsEnabled.value) {
    setIntent(false);
    return true;
  }
  setIntent(true);
  const granted = await push.ensurePermission();
  permissionGranted.value = currentPermission();
  return granted;
}

// Wire browser-state listeners once at boot: an effect that reconciles this
// device's subscription with the wish, a permission-change watcher, and a
// focus/visibility re-check that also runs the daily heartbeat.
export function startNotifications(): void {
  effect(() => {
    wantSubscription(); // read deps so the effect re-runs on any change
    void sync();
  });

  void navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((status) => {
      status.onchange = () => {
        permissionGranted.value = currentPermission();
      };
    })
    .catch(() => {
      // Permissions API can't query "notifications" here; focus refresh covers it.
    });

  const onVisible = (): void => {
    if (document.visibilityState !== "visible") return;
    permissionGranted.value = currentPermission();
    void sync();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

export function load(userId: string): void {
  activeUser = userId;
  intent.value = localStorage.getItem(key(userId)) === "1";
  permissionGranted.value = currentPermission();
}

export function reset(): void {
  // Forget the in-memory wish so the effect tears down this device's
  // subscription; the persisted intent stays for the user's next login.
  clearHeartbeat();
  activeUser = null;
  intent.value = false;
}

function setIntent(enabled: boolean): void {
  intent.value = enabled;
  if (activeUser != null) localStorage.setItem(key(activeUser), enabled ? "1" : "0");
}

// Converge this device's subscription with the wish: subscribe + register when
// wanted (re-registering at most once per calendar day, or whenever the endpoint
// rotates), otherwise drop it. Coalesces concurrent calls.
let running = false;
let rerun = false;
async function sync(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await converge();
    } while (rerun);
  } finally {
    running = false;
  }
}

async function converge(): Promise<void> {
  if (!wantSubscription()) {
    if ((await push.getEndpoint()) != null) await push.unsubscribe();
    clearHeartbeat();
    return;
  }
  // Already subscribed and registered today? Nothing to do, no network.
  const current = await push.getEndpoint();
  if (current != null && stampedToday(current)) return;
  const endpoint = await push.ensureSubscription();
  if (endpoint == null || stampedToday(endpoint)) return;
  if (await push.register()) recordHeartbeat(endpoint);
}

function stampedToday(endpoint: string): boolean {
  return activeUser != null && localStorage.getItem(hbKey(activeUser)) === stamp(endpoint);
}

function recordHeartbeat(endpoint: string): void {
  if (activeUser != null) localStorage.setItem(hbKey(activeUser), stamp(endpoint));
}

function clearHeartbeat(): void {
  if (activeUser != null) localStorage.removeItem(hbKey(activeUser));
}

function stamp(endpoint: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return `${day}|${endpoint}`;
}

function key(userId: string): string {
  return `schedule.notifications.${userId}`;
}

function hbKey(userId: string): string {
  return `schedule.notifications.hb.${userId}`;
}
