import * as commit from "./commit";

// The sync driver: turns discrete triggers into calls to commit.synchronize().
// commit() requests a debounced sync after each mutation; startSyncLoop adds a
// periodic poll plus online/visibility wakeups. Disabled until the loop starts,
// so unit tests that mutate state never touch the network.

const DEBOUNCE_MS = 1000;
const POLL_MS = 60_000;

let enabled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let queued = false;
let teardown: (() => void) | null = null;

// Coalesce a burst of mutations into one sync ~1s after the last one.
export function requestSync(): void {
  if (!enabled) return;
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => void run(), DEBOUNCE_MS);
}

// Wire periodic + connectivity triggers. The initial convergence is awaited by
// the session coordinator (see state/session), so the loop only adds wakeups.
export function startSyncLoop(): void {
  if (enabled) return;
  enabled = true;
  const wake = () => void run();
  const onVisible = () => {
    if (document.visibilityState === "visible") void run();
  };
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", onVisible);
  const poll = setInterval(() => void run(), POLL_MS);
  teardown = () => {
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(poll);
  };
}

// Stop all triggers on logout; a pending debounce is dropped too.
export function stopSyncLoop(): void {
  enabled = false;
  teardown?.();
  teardown = null;
  if (timer != null) clearTimeout(timer);
  timer = null;
}

// Single-flight: a sync requested mid-run is collapsed into one trailing run.
// Errors are swallowed; the queue persists for the next trigger.
async function run(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    await commit.synchronize();
  } catch {
    // Offline or transient failure; retry on the next trigger.
  } finally {
    running = false;
    if (queued) {
      queued = false;
      requestSync();
    }
  }
}
