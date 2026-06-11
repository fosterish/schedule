import { signal } from "@preact/signals";

import * as accounts from "@data/accounts";
import * as api from "@data/api";
import * as db from "@data/db";

import * as commit from "./commit";
import * as settings from "./settings";
import { reset as resetView } from "./uistate";
import { startSyncLoop, stopSyncLoop } from "./syncer";

// The authenticated user, or null when logged out / not yet known.
export const user = signal<api.User | null>(null);

// False until the first session resolution completes, so the UI can hold the
// auth decision (don't bounce to /login) until we actually know.
export const booted = signal(false);

// True only during a fresh login's first convergence (cold pull or rehydrate),
// so the UI shows a loading screen instead of an empty schedule. Set nowhere else.
export const loadingData = signal(false);

// Resolve the session from the cookie; null on any auth failure.
export async function loadSession(): Promise<void> {
  try {
    user.value = await api.me();
  } catch {
    user.value = null;
  } finally {
    booted.value = true;
  }
}

// Attach the just-authenticated user's cache and converge. Hydrate is awaited so
// the loading screen has data to reveal; the first sync runs in the background
// and clears `loadingData` (and starts the wakeup loop) when it settles.
export async function beginSession(): Promise<void> {
  const current = user.value;
  if (!current) return;
  loadingData.value = true;
  await db.setActiveUser(current.id);
  settings.load(current.id);
  accounts.remember(current);
  await commit.hydrate();
  void completeInitialLoad();
}

async function completeInitialLoad(): Promise<void> {
  try {
    await commit.synchronize();
  } catch {
    // Offline/error: keep whatever hydrate produced (cached rows, or empty).
  } finally {
    loadingData.value = false;
  }
  if (user.value) startSyncLoop();
}

// Classified so the UI (which may not import data/) can message the user without
// touching the error types: bad credentials, no connection, or an actual fault.
export type LoginOutcome = "ok" | "invalid" | "offline" | "error";

export async function login(username: string, password: string): Promise<LoginOutcome> {
  try {
    await api.login(username, password);
    await loadSession();
    if (!user.value) return "error";
    await beginSession();
    return "ok";
  } catch (e) {
    if (e instanceof api.AuthError) return "invalid";
    if (e instanceof api.OfflineError) return "offline";
    return "error";
  }
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // Tear down locally even if the network request fails.
  }
  await detach();
}

// A 401 mid-session: drop the user the same way logout does (minus the request).
export function handleUnauthorized(): void {
  if (user.value == null) return;
  void detach();
}

// The device-local account registry, surfaced for the login screen (ui/ can't
// reach data/ directly).
export type Account = accounts.Account;
export const knownAccounts = (): Account[] => accounts.list();
export const forgetAccount = (id: string): Promise<void> => accounts.forget(id);

// Stop syncing, forget the in-memory mirror, and release the cache connection.
// The user's database stays on disk for their next login.
async function detach(): Promise<void> {
  stopSyncLoop();
  user.value = null;
  loadingData.value = false;
  commit.reset();
  resetView();
  settings.reset();
  await db.setActiveUser(null);
}
