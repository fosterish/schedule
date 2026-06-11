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
import { App } from "@ui/app";

// A 401 mid-session drops the user; the auth gate then routes to /login.
setUnauthorizedHandler(session.handleUnauthorized);

// Local-first boot: resolve the session first (the cache is keyed per user), then
// attach that user's cache and converge. The auth gate routes to /login if none.
async function boot(): Promise<void> {
  startClock();
  startReminders();
  await session.loadSession();
  if (session.user.value) await session.beginSession();
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  void boot();
}
