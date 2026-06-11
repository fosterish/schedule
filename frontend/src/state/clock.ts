import { signal } from "@preact/signals";

// Minute-of-day [0,1439]; the schedule resolver's live clock.
export const nowMinute = signal(currentMinute());

// Start ticking; returns a stop function. The server has no reliable timezone,
// so all "today" reasoning uses the client's local date/minute.
export function startClock(): () => void {
  const tick = () => {
    nowMinute.value = currentMinute();
  };
  tick();
  const id = setInterval(tick, 1_000);
  return () => clearInterval(id);
}

export function todayDate(): string {
  return localDate(new Date());
}

export function yesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function currentMinute(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
