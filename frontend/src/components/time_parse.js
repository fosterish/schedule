// Time parsing/formatting for clock (HH:MM, ±1 day) and duration (HH:MM); both accept bare hours, :minutes, and unit suffixes.

export function fmtClock(min) {
  if (min == null) return "—";
  const m_ = ((min % 1440) + 1440) % 1440;
  const day = min >= 1440 ? "+1" : min < 0 ? "-1" : "";
  const h = Math.floor(m_ / 60);
  const mm = m_ % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}${day}`;
}

export function fmtDuration(min) {
  if (min == null) return "";
  const m_ = Math.max(0, Math.floor(min));
  const h = Math.floor(m_ / 60);
  const mm = m_ % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// Parse unit-suffixed and bare-colon variants to total minutes; shape-only, range checks live in the public parsers.
function parseUnitOrColon(t) {
  const cleaned = t.toLowerCase().replace(/[\s,]/g, "");
  if (!cleaned) return null;
  // Bare-colon shorthand: ":135" → 135 minutes total.
  const colonMatch = /^:(\d+)$/.exec(cleaned);
  if (colonMatch) return Number(colonMatch[1]);
  // Unit parse requires at least one letter; pure-digit and HH:MM inputs are handled upstream.
  if (!/[a-z]/.test(cleaned)) return null;
  // Try longer unit names first so "h" doesn't match inside "hour"; optional 's' covers plural and singular.
  const UNIT_RE = /^(\d+)(hours?|hrs?|h|minutes?|mins?|m)/;
  let rest = cleaned;
  let total = 0;
  while (rest.length > 0) {
    const um = UNIT_RE.exec(rest);
    if (!um) return null;
    const n = Number(um[1]);
    const isHour = um[2].startsWith("h");
    total += isHour ? n * 60 : n;
    rest = rest.slice(um[0].length);
  }
  return total;
}

export function parseClockToMin(s) {
  const t = String(s).trim();
  if (!t) return null;
  // Canonical HH:MM with optional day suffix.
  let m_ = /^(\d{1,2}):([0-5]\d)(\+1|-1)?$/.exec(t);
  if (m_) {
    const h = Number(m_[1]);
    const mm = Number(m_[2]);
    if (h < 0 || h > 23) return null;
    const day = m_[3] === "+1" ? 1440 : m_[3] === "-1" ? -1440 : 0;
    return h * 60 + mm + day;
  }
  // Bare-hour shorthand.
  m_ = /^(\d{1,2})(\+1|-1)?$/.exec(t);
  if (m_) {
    const h = Number(m_[1]);
    if (h < 0 || h > 23) return null;
    const day = m_[2] === "+1" ? 1440 : m_[2] === "-1" ? -1440 : 0;
    return h * 60 + day;
  }
  // Flexible form must land within one day; cross-day +1/-1 only works via the canonical form.
  const flex = parseUnitOrColon(t);
  if (flex != null && flex >= 0 && flex < 1440) return flex;
  return null;
}

export function parseDurationToMin(s) {
  const t = String(s).trim();
  if (!t) return null;
  // Canonical HH:MM.
  let m_ = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m_) return Number(m_[1]) * 60 + Number(m_[2]);
  // Bare-hour shorthand.
  m_ = /^(\d{1,2})$/.exec(t);
  if (m_) return Number(m_[1]) * 60;
  // Flexible form. Durations are strictly positive.
  const flex = parseUnitOrColon(t);
  return flex != null && flex > 0 ? flex : null;
}
