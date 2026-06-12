// Clock (HH:MM, +/-1 day) and duration (HH:MM) formatting and parsing. Both
// parsers accept bare minutes, :minutes, and unit-suffixed forms. Hours past 23
// roll into the next day (e.g. "25h" -> 01:00+1).

export function fmtClock(minute: number | null): string {
  if (minute == null) return "\u2014";
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const day = minute >= 1440 ? "+1" : minute < 0 ? "-1" : "";
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${pad(h)}:${pad(m)}${day}`;
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
  const t = s.trim();
  if (!t) return null;
  let total: number | null = null;
  const hm = /^(\d{1,2}):([0-5]\d)(\+1|-1)?$/.exec(t);
  if (hm) {
    total = Number(hm[1]) * 60 + Number(hm[2]) + daySuffix(hm[3]);
  } else {
    const suffix = /(\+1|-1)$/.exec(t);
    const flex = parseUnitOrColon(suffix ? t.slice(0, -suffix[0].length) : t);
    if (flex != null) total = flex + daySuffix(suffix?.[1]);
  }
  // Allow up to a full day of overflow/underflow; fmtClock renders +/-1.
  return total != null && total >= -1440 && total < 2880 ? total : null;
}

export function parseDurationToMin(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const flex = parseUnitOrColon(t);
  return flex != null && flex > 0 ? flex : null;
}

function daySuffix(s: string | undefined): number {
  return s === "+1" ? 1440 : s === "-1" ? -1440 : 0;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const UNIT_RE = /^(\d+)(hours?|hrs?|h|minutes?|mins?|m)/;

// Shape-only parse of bare minutes (`90`), colon minutes (`:135`), and
// unit-suffixed (`1h30m`) forms to total minutes; range checks live in the
// public parsers.
function parseUnitOrColon(t: string): number | null {
  const cleaned = t.toLowerCase().replace(/[\s,]/g, "");
  if (!cleaned) return null;
  const colon = /^:(\d+)$/.exec(cleaned);
  if (colon) return Number(colon[1]);
  const bare = /^(\d+)$/.exec(cleaned);
  if (bare) return Number(bare[1]);
  if (!/[a-z]/.test(cleaned)) return null;
  let rest = cleaned;
  let total = 0;
  while (rest.length > 0) {
    const m = UNIT_RE.exec(rest);
    if (!m) return null;
    total += m[2]!.startsWith("h") ? Number(m[1]) * 60 : Number(m[1]);
    rest = rest.slice(m[0]!.length);
  }
  return total;
}
