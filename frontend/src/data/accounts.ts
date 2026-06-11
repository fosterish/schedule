// A device-local registry of accounts that have logged in here, so the login
// screen can offer them and a per-user cache can be forgotten. Stored outside
// any user's database (which is wiped on "forget me").

import * as db from "./db";

export interface Account {
  id: string;
  username: string;
  // Epoch ms of the last successful sync on this device; absent until first sync.
  lastSyncedAt?: number;
}

const KEY = "schedule.accounts";

export function list(): Account[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Account[]) : [];
  } catch {
    return [];
  }
}

// Record (or refresh) an account, most-recent last.
export function remember(account: Account): void {
  const next = [...list().filter((a) => a.id !== account.id), account];
  save(next);
}

// Stamp an account's last successful sync, preserving registry order.
export function touch(id: string): void {
  let changed = false;
  const next = list().map((a) => {
    if (a.id !== id) return a;
    changed = true;
    return { ...a, lastSyncedAt: Date.now() };
  });
  if (changed) save(next);
}

// Forget an account: drop it from the registry and delete its cached database.
export async function forget(id: string): Promise<void> {
  save(list().filter((a) => a.id !== id));
  await db.forgetUser(id);
}

function save(accounts: Account[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(accounts));
  } catch {
    // private mode / disabled storage: the registry just won't persist.
  }
}
