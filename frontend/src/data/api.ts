import type { Snapshot } from "@bindings/Snapshot";
import type { SyncOps } from "@bindings/SyncOps";
import type { SyncResult } from "@bindings/SyncResult";

// Deployment base without a trailing slash ("" at root, "/schedule" behind the
// reverse proxy); prepended to every request so the app works at either mount.
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

export interface User {
  id: string;
  username: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends ApiError {
  constructor() {
    super("unauthorized", 401);
    this.name = "AuthError";
  }
}

// The request never reached the server (no network, DNS, CORS). Distinct from
// ApiError: a normal offline condition, not a server-side failure.
export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super("offline", { cause });
    this.name = "OfflineError";
  }
}

// Wired by the app to route to /login on 401; keeps data/ free of ui/ imports.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw new OfflineError(e);
  }
  if (res.status === 401) {
    onUnauthorized?.();
    throw new AuthError();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(errorMessage(parsed) ?? text ?? res.statusText, res.status);
  }
  return parsed as T;
}

function errorMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const e = (parsed as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

export const me = (): Promise<User> => request("GET", "/api/auth/me");

export const login = (username: string, password: string): Promise<void> =>
  request("POST", "/api/auth/login", { username, password });

export const logout = (): Promise<void> => request("POST", "/api/auth/logout");

export const getSnapshot = (since: number): Promise<Snapshot> =>
  request("GET", since > 0 ? `/api/snapshot?since=${since}` : "/api/snapshot");

export const postSync = (body: SyncOps): Promise<SyncResult> =>
  request("POST", "/api/sync", body);
