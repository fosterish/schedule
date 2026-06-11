import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import * as session from "@state/session";

import { TrashButton } from "../components/TrashButton";
import s from "./Login.module.css";

// Last-synced date, shown only when it wasn't today (today needs no reminder).
function syncedLabel(at: number | undefined): string | null {
  if (at == null) return null;
  const d = new Date(at);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return null;
  const year = d.getFullYear() === now.getFullYear() ? undefined : "numeric";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year });
}

export function Login(): JSX.Element {
  const { route } = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<session.Account[]>(() => session.knownAccounts());
  // Uncontrolled inputs: no re-render races with the browser's autofill, and the
  // password manager can write to the fields freely. Read imperatively on submit.
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Fill the username without a re-render (which would dismiss the password
  // manager's dropdown), then focus the password so suggestions surface there.
  function pick(name: string): void {
    if (usernameRef.current) usernameRef.current.value = name;
    passwordRef.current?.focus();
  }

  function forget(id: string): void {
    void session.forgetAccount(id);
    setKnown((list) => list.filter((a) => a.id !== id));
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await session.login(
      usernameRef.current?.value ?? "",
      passwordRef.current?.value ?? "",
    );
    setBusy(false);
    if (outcome === "ok") {
      route("/today");
      return;
    }
    setError(
      outcome === "invalid"
        ? "Invalid username or password"
        : outcome === "offline"
          ? "You appear to be offline"
          : "Login failed",
    );
  }

  return (
    <form class={s.card} onSubmit={submit}>
      <h1>Sign in</h1>
      <input
        ref={usernameRef}
        class={s.input}
        type="text"
        name="username"
        autocomplete="username"
        autofocus
        placeholder="Username"
      />
      <input
        ref={passwordRef}
        class={s.input}
        type="password"
        name="password"
        autocomplete="current-password"
        placeholder="Password"
      />
      {error != null && <p class={s.error}>{error}</p>}
      <button class={s.submit} type="submit" disabled={busy}>
        {busy ? "Signing in\u2026" : "Sign in"}
      </button>
      {known.length > 0 && (
        <div class={s.accounts}>
          <p class={s.accountsLabel}>On this device</p>
          {known.map((a) => {
            const synced = syncedLabel(a.lastSyncedAt);
            return (
              <div key={a.id} class={s.account}>
                <button type="button" class={s.accountName} onClick={() => pick(a.username)}>
                  {a.username}
                </button>
                {synced && <span class={s.synced}>{synced}</span>}
                <TrashButton label={`Forget ${a.username}`} onClick={() => forget(a.id)} />
              </div>
            );
          })}
        </div>
      )}
    </form>
  );
}
