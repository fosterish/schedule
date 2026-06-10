import { render } from "preact";

import { setUnauthorizedHandler } from "@data/api";
import { startClock } from "@state/clock";
import * as session from "@state/session";
import { App } from "@ui/app";
import "@ui/styles/tokens.css";
import "@ui/styles/base.css";

// A 401 mid-session drops the user; the auth gate then routes to /login.
setUnauthorizedHandler(session.handleUnauthorized);

// Local-first boot: resolve the session first (the cache is keyed per user), then
// attach that user's cache and converge. The auth gate routes to /login if none.
async function boot(): Promise<void> {
  startClock();
  await session.loadSession();
  if (session.user.value) await session.beginSession();
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  void boot();
}
