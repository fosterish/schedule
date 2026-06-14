// Zoom is px-per-minute. Stops are fit * ZOOM_FACTOR^k for k in [0, ZOOM_STOPS).
const ZOOM_FACTOR = 2;
const ZOOM_STOPS = 8;

// Minimum editor height in px; the selection floor uses the larger of this and
// the item's measured content height.
export const EDITOR_MIN_PX = 320;

export interface Span {
  start: number;
  end: number;
}

// The schedule's hard bounds, extended to `now` (today mode) so the live cursor
// stays on-screen even before the start / after the end.
export function spanOf(bounds: Span, now: number | null): Span {
  if (now == null) return bounds;
  return { start: Math.min(bounds.start, now), end: Math.max(bounds.end, now) };
}

export function minuteOf(y: number, span: Span, pxPerMin: number): number {
  return Math.round(y / pxPerMin) + span.start;
}

// Labeled tick intervals in minutes, finest to coarsest (1 min .. 2 hours).
const TICK_INTERVALS = [1, 5, 15, 30, 60, 120];

// Minimum on-screen gap between labeled lines; below it, step to a coarser
// interval so labels never crowd.
const MIN_TICK_GAP_PX = 48;

// Finest interval whose on-screen gap stays at or above the threshold; falls
// back to the coarsest (2 hours) when even that is too tight.
export function tickInterval(pxPerMin: number): number {
  for (const interval of TICK_INTERVALS) {
    if (interval * pxPerMin >= MIN_TICK_GAP_PX) return interval;
  }
  return TICK_INTERVALS[TICK_INTERVALS.length - 1]!;
}

// Labeled minute marks across the span at the zoom-appropriate interval.
export function tickLines(span: Span, pxPerMin: number): number[] {
  const interval = tickInterval(pxPerMin);
  const first = Math.ceil(span.start / interval) * interval;
  const last = Math.floor(span.end / interval) * interval;
  const out: number[] = [];
  for (let m = first; m <= last; m += interval) out.push(m);
  return out;
}

export interface ZoomBounds {
  min: number;
  max: number;
}

// min is the floor (whole schedule, or selected item's need); max is the
// button/pinch ceiling a short item may exceed.
export function zoomBounds(fit: number, floor: number): ZoomBounds {
  const top = fit * ZOOM_FACTOR ** (ZOOM_STOPS - 1);
  return { min: Math.max(fit, floor), max: Math.max(top, floor) };
}

export function clampZoom(z: number, bounds: ZoomBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, z));
}

// Values the buttons step through: factor stops inside the bounds, plus the
// bounds themselves.
export function zoomLadder(fit: number, floor: number): number[] {
  const { min, max } = zoomBounds(fit, floor);
  const set = new Set<number>([min, max]);
  for (let k = 0; k < ZOOM_STOPS; k++) {
    const stop = fit * ZOOM_FACTOR ** k;
    if (stop > min && stop < max) set.add(stop);
  }
  return [...set].sort((a, b) => a - b);
}

export function nextZoomIn(z: number, ladder: number[]): number | null {
  for (const stop of ladder) if (stop > z * 1.001) return stop;
  return null;
}

export function nextZoomOut(z: number, ladder: number[]): number | null {
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (ladder[i]! < z * 0.999) return ladder[i]!;
  }
  return null;
}
