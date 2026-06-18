import { render } from "preact";

// Foundational styles first so component CSS (incl. classes that `composes` the
// shared .btn base) is emitted after them and can override the base.
import "@ui/styles/tokens.css";
import "@ui/styles/base.css";
import "@ui/styles/button.module.css";

import { setUnauthorizedHandler } from "@data/api";
import { startClock } from "@state/clock";
import { startReminders } from "@state/reminders";
import * as session from "@state/session";
import { startClockFormat, startNotifications } from "@state/settings";
import { App } from "@ui/app";

// A 401 mid-session drops the user; the auth gate then routes to /login.
setUnauthorizedHandler(session.handleUnauthorized);

// Local-first boot: resolve the session first (the cache is keyed per user), then
// attach that user's cache and converge. The auth gate routes to /login if none.
async function boot(): Promise<void> {
  startClock();
  startReminders();
  startNotifications();
  startClockFormat();
  await session.loadSession();
  if (session.user.value) await session.beginSession();
}

// Pressing a button doesn't reliably move focus (Safari/Firefox leave it on the
// field), so a focused in-place field's commit-on-blur wouldn't run before the
// button's click. Blur it explicitly on pointerdown so the typed value commits
// first. Capture phase + pointerdown both precede the field's blur and click.
document.addEventListener(
  "pointerdown",
  (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest("button")) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== target && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.blur();
    }
  },
  true,
);

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  void boot();
}
