import type { PlannedReminder } from "@lib/schedule/reminders";

import * as api from "./api";
import { urlBase64ToBytes } from "./vapid";

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

// Get or create this device's browser push subscription, returning its endpoint.
// Does not touch the server. Null when unsupported, permission isn't granted, or
// the server has no VAPID config.
export async function ensureSubscription(): Promise<string | null> {
  if (!supported() || Notification.permission !== "granted") return null;
  const key = await api.vapidPublicKey();
  if (!key) return null;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(key) as BufferSource,
    }));
  return sub.endpoint;
}

// This device's current push endpoint, or null when unsubscribed/unsupported.
// Used to detect a rotated subscription that needs re-registering.
export async function getEndpoint(): Promise<string | null> {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription())?.endpoint ?? null;
}

// Register this device's current subscription with the server, refreshing its
// last_seen heartbeat. No-op (never creates a subscription) when not subscribed.
// Returns whether the server was updated.
export async function register(): Promise<boolean> {
  if (!supported()) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  await api.subscribePush(sub.toJSON());
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

// Replace the user's reminder set so any of their listening devices can fire it.
// Uploaded by every signed-in device, even those without push of their own.
export async function uploadReminders(reminders: PlannedReminder[]): Promise<void> {
  try {
    console.debug("[push] uploading reminders", {
      pushed_at: new Date().toLocaleString(),
      reminders: reminders.map((r) => ({
        title: r.payload.title,
        at: new Date(r.fireAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      })),
    });
    await api.putReminders(reminders.map((r) => ({ fireAtMs: r.fireAtMs, payload: r.payload })));
  } catch (e) {
    // Best-effort: a failed upload (offline/logout) is retried on the next change.
    console.warn("[push] uploadReminders failed", e);
  }
}
