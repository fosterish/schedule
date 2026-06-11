import type { PlannedReminder } from "@lib/schedule/reminders";

import * as api from "./api";

export function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// Must be called from a user gesture; returns whether notifications are allowed.
export async function ensurePermission(): Promise<boolean> {
  if (!supported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

// Register this device with the server. Reuses any existing browser subscription;
// returns false when push is unsupported or the server has no VAPID config.
export async function subscribe(): Promise<boolean> {
  if (!supported() || Notification.permission !== "granted") {
    console.debug("[push] subscribe skipped", {
      supported: supported(),
      permission: typeof Notification !== "undefined" ? Notification.permission : "n/a",
    });
    return false;
  }
  const key = await api.vapidPublicKey();
  if (!key) {
    console.debug("[push] subscribe aborted: server returned no VAPID key (push disabled)");
    return false;
  }
  console.debug("[push] got VAPID key; awaiting service worker");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(key) as BufferSource,
    }));
  console.debug("[push] browser subscription ready; registering with server", {
    reused: existing != null,
    endpoint: sub.endpoint,
  });
  await api.subscribePush(sub.toJSON());
  console.debug("[push] registered with server");
  return true;
}

export async function unsubscribe(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  try {
    await sub.unsubscribe();
  } catch {
    // The browser may already have dropped it; still clear the server row.
  }
  try {
    await api.unsubscribePush(endpoint);
  } catch {
    // Offline: the server prunes the device by TTL instead.
  }
}

// Replace the user's reminder set, tagged with this device's endpoint (which
// doubles as its heartbeat). No-op when this device isn't subscribed.
export async function uploadReminders(reminders: PlannedReminder[]): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    console.debug("[push] uploadReminders skipped: device not subscribed");
    return;
  }
  try {
    console.debug("[push] uploading reminders", { count: reminders.length });
    await api.putReminders(
      sub.endpoint,
      reminders.map((r) => ({ fireAtMs: r.fireAtMs, payload: r.payload })),
    );
  } catch (e) {
    // Best-effort: a failed upload (offline/logout) is retried on the next change.
    console.warn("[push] uploadReminders failed", e);
  }
}

function urlBase64ToBytes(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
