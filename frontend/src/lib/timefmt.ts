// Clock (HH:MM, +/-N days) and duration (HH:MM) formatting and parsing. Both
// parse :minutes; a bare number is hours for clocks ("10" -> 10:00) but minutes
// for durations. Clocks also accept 12-hour suffixes ("5pm" -> 17:00); only
// durations accept unit suffixes ("1h30m"). Clock hours past 23 roll into the
// next day ("24:00" -> 00:00+1); values span the two-day frame, up to 00:00+2
// (48h).

const DAY = 1440;
const CLOCK_MIN = -DAY;
const CLOCK_MAX = 2 * DAY;
const UNIT_RE = /^(\d+)(hours?|hrs?|h|minutes?|mins?|m)/;

export function fmtClock(minute: number | null, hour12 = false): string {
  if (minute == null) return "\u2014";
  const day = Math.floor(minute / DAY);
  const wrapped = minute - day * DAY;
  const suffix = day > 0 ? `+${day}` : day < 0 ? String(day) : "";
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  if (hour12) {
    const period = h < 12 ? "AM" : "PM";
    return `${h % 12 || 12}:${pad(m)} ${period}${suffix}`;
  }
  return `${pad(h)}:${pad(m)}${suffix}`;
}

export function fmtDuration(minute: number | null): string {
  if (minute == null) return "";
  const total = Math.max(0, Math.floor(minute));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// Compact human duration, e.g. "2h 30m", "45m", "3h".
export function fmtDurationHuman(minute: number | null): string {
  if (minute == null) return "";
  const total = Math.max(0, Math.round(minute));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function parseClockToMin(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[\s,]/g, "");
  if (!t) return null;
  // 12-hour forms: "5pm", "10:30pm" (hour 1-12, no day suffix).
  const ap = /^(\d{1,2})(?::([0-5]\d))?(am|pm)$/.exec(t);
  if (ap) {
    let h = Number(ap[1]);
    if (h < 1 || h > 12) return null;
    if (h === 12) h = ap[3] === "am" ? 0 : 12;
    else if (ap[3] === "pm") h += 12;
    return h * 60 + Number(ap[2] ?? 0);
  }
  let total: number | null = null;
  const hm = /^(\d{1,2}):([0-5]\d)([+-]\d+)?$/.exec(t);
  if (hm) {
    total = Number(hm[1]) * 60 + Number(hm[2]) + daySuffix(hm[3]);
  } else {
    const suffix = /([+-]\d+)$/.exec(t);
    const body = suffix ? t.slice(0, -suffix[0].length) : t;
    let flex: number | null = null;
    if (/^:\d+$/.test(body)) flex = Number(body.slice(1)); // colon minutes
    else if (/^\d+$/.test(body)) flex = Number(body) * 60; // bare number is hours
    if (flex != null) total = flex + daySuffix(suffix?.[1]);
  }
  // Spans the two-day frame plus a day of underflow; the absolute max is 00:00+2.
  return total != null && total >= CLOCK_MIN && total <= CLOCK_MAX ? total : null;
}

export function parseDurationToMin(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const cleaned = t.toLowerCase().replace(/[\s,]/g, "");
  let total = 0;
  if (/^:\d+$/.test(cleaned)) total = Number(cleaned.slice(1)); // colon minutes
  else if (/^\d+$/.test(cleaned)) total = Number(cleaned); // bare number is minutes
  else {
    // Sum unit-suffixed tokens like "1h30m", "45m", "2hrs".
    let rest = cleaned;
    while (rest.length > 0) {
      const m = UNIT_RE.exec(rest);
      if (!m) return null;
      total += m[2]!.startsWith("h") ? Number(m[1]) * 60 : Number(m[1]);
      rest = rest.slice(m[0]!.length);
    }
  }
  return total > 0 ? total : null;
}

function daySuffix(s: string | undefined): number {
  return s ? Number(s) * DAY : 0;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
