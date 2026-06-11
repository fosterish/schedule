import { precacheAndRoute, type PrecacheEntry } from "workbox-precaching";

// vite-plugin-pwa (injectManifest): we own the worker so it can handle push, and
// still precache the app shell for offline use via the injected manifest.
const sw = self as unknown as ServiceWorkerGlobalScope;

// Literal `self.__WB_MANIFEST` is required: the plugin string-replaces it at
// build. It's undefined in dev (no injection), so default to an empty list.
precacheAndRoute((self as unknown as { __WB_MANIFEST?: PrecacheEntry[] }).__WB_MANIFEST ?? []);

// Activate a new worker (and its push handlers) immediately, taking over open
// tabs instead of waiting for them to close.
sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event) => event.waitUntil(sw.clients.claim()));

interface ReminderPayload {
  title: string;
  body?: string;
}

sw.addEventListener("push", (event) => {
  const data = readPayload(event);
  event.waitUntil(
    sw.registration.showNotification(data.title, {
      body: data.body ?? "",
      icon: iconUrl(),
      badge: iconUrl(),
      tag: "schedule-reminder",
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusApp());
});

function readPayload(event: PushEvent): ReminderPayload {
  try {
    const json = event.data?.json() as Partial<ReminderPayload> | undefined;
    if (json && typeof json.title === "string") {
      const payload: ReminderPayload = { title: json.title };
      if (typeof json.body === "string") payload.body = json.body;
      return payload;
    }
  } catch {
    // Malformed/absent payload falls back to a generic notice.
  }
  return { title: "Schedule reminder" };
}

// Focus an existing app window if one is open, else open the app at its scope.
async function focusApp(): Promise<void> {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if ("focus" in client) {
      await client.focus();
      return;
    }
  }
  await sw.clients.openWindow(sw.registration.scope);
}

function iconUrl(): string {
  return new URL("pwa-192x192.png", sw.registration.scope).href;
}
