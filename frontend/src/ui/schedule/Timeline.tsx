import type { JSX, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import type { ScheduleId } from "@bindings/ScheduleId";
import type { ScheduleItem } from "@bindings/ScheduleItem";
import * as layout from "@lib/schedule/layout";
import * as reorder from "@lib/schedule/reorder";
import * as resize from "@lib/schedule/resize";
import type { ScheduleView, ScheduleViewItem } from "@lib/schedule/resolve";
import type { RunAction, RunFlags } from "@lib/schedule/run";
import { fmtClock } from "@lib/timefmt";
import * as scheduleOps from "@state/mutations/schedule";
import * as uistate from "@state/uistate";
import { randomItemColor } from "@ui/palette";
import {
  CloseIcon,
  PlayIcon,
  PlusIcon,
  SkipIcon,
  StopIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@ui/components/icons";

import { Block } from "./Block";
import { ScheduleBound } from "./ScheduleBounds";
import {
  EDITOR_MIN_PX,
  type Span,
  clampZoom,
  minuteOf,
  nextZoomIn,
  nextZoomOut,
  spanOf,
  tickLines,
  zoomBounds,
  zoomLadder,
} from "./geometry";
import s from "./Timeline.module.css";

// Scroll container vertical padding (top + bottom), excluded from fit height.
const SCROLL_PAD_PX = 64;

// Entry pan (tab switch / reload): the most recent fixed edge rests this far
// below the top; the cursor is kept at least this far above the bottom.
const ENTRY_EDGE_TOP_PX = 56;
const ENTRY_CURSOR_BOTTOM_PX = 96;

interface DragState {
  draggedId: string;
  startY: number;
  deltaPx: number;
  moved: boolean;
  // A touch reorder armed by a long press shows its ghost before any movement.
  touch: boolean;
  preview: reorder.ScheduleReorder | null;
}

const DRAG_THRESHOLD_PX = 4;

// Mild magnetic pull (in px) toward item edges when placing/dragging the cursor.
const CURSOR_SNAP_PX = 7;

type ResizeTarget =
  | { kind: "item"; id: string; edge: resize.Edge }
  | { kind: "schedule"; edge: resize.Edge };

// A live edge-resize (drag handle): the clamped preview span/frames and the raw
// desired minute committed on release.
interface ResizeState {
  target: ResizeTarget;
  startY: number;
  startValue: number;
  desired: number;
  moved: boolean;
  span: Span;
  frames: { id: string; start: number; end: number }[];
}

// Touch press that stays roughly still this long arms a reorder; a quicker swipe
// scrolls instead.
const HOLD_MS = 500;
const RUN_ICON: Record<RunAction, JSX.Element> = {
  play: <PlayIcon />,
  skip: <SkipIcon />,
  stop: <StopIcon />,
};

const RUN_BADGE_LABEL: Record<RunAction, string> = {
  play: "Start this item",
  skip: "Skip to this item",
  stop: "Stop this item",
};

// Layout morph: every vertical position is (minute - span.start) * zoom. Interpolating
// these inputs (per-item minutes, span origin, zoom) with one progress lets a
// duration or zoom change glide instead of snapping, with zoom set instantly.
const MORPH_MS = 220;

interface LayoutSnapshot {
  zoom: number;
  spanStart: number;
  spanEnd: number;
  minutes: Map<string, { start: number; end: number }>;
}

// Hold `minute` at an anchor offset from the viewport top, recomputing scroll
// from the eased scale every frame so it never drifts out of view. The anchor
// eases from where the minute sits now to where it should end up (equal anchors
// keep it stationary; differing ones glide it, e.g. a selection to the top).
interface MorphPin {
  minute: number;
  fromAnchorPx: number;
  toAnchorPx: number;
}

// What the next morph should anchor: a minute and its desired final offset.
interface PinIntent {
  minute: number;
  anchorPx: number;
}

interface Morph {
  from: LayoutSnapshot;
  to: LayoutSnapshot;
  start: number;
  pin: MorphPin | null;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpLayout(from: LayoutSnapshot, to: LayoutSnapshot, t: number): LayoutSnapshot {
  const minutes = new Map<string, { start: number; end: number }>();
  for (const [id, m] of to.minutes) {
    const f = from.minutes.get(id) ?? m;
    minutes.set(id, { start: lerp(f.start, m.start, t), end: lerp(f.end, m.end, t) });
  }
  return {
    zoom: lerp(from.zoom, to.zoom, t),
    spanStart: lerp(from.spanStart, to.spanStart, t),
    spanEnd: lerp(from.spanEnd, to.spanEnd, t),
    minutes,
  };
}

function layoutSig(l: LayoutSnapshot): string {
  let sig = `${l.zoom.toFixed(4)}|${l.spanStart}|${l.spanEnd}`;
  for (const [id, m] of l.minutes) sig += `|${id}:${m.start}:${m.end}`;
  return sig;
}

interface Props {
  view: ScheduleView;
  rawById: Map<string, ScheduleItem>;
  scheduleId: ScheduleId;
  cursorEnabled: boolean;
  flags: RunFlags | null;
  // Exposes `insert` so the wide-screen header button can add an item too.
  insertRef?: RefObject<() => void>;
}

export function Timeline({ view, rawById, scheduleId, cursorEnabled, flags, insertRef }: Props): JSX.Element {
  const now = view.nowMinute;

  const scroll = useRef<HTMLDivElement | null>(null);
  const timelineEl = useRef<HTMLDivElement | null>(null);
  const pinch = useRef<{ dist: number; zoom: number; minute: number } | null>(null);
  // Set during a pinch move; a post-commit effect parks this minute under the
  // live finger midpoint so the gesture zooms around its focal point.
  const pinchScroll = useRef<{ minute: number; screenY: number } | null>(null);
  const cursorDrag = useRef<{ startY: number; startMinute: number } | null>(null);
  const zoomRaf = useRef<number | null>(null);
  const justDragged = useRef(false);
  // Touch long-press to reorder: timer until armed, the press Y to detect a
  // scroll, and the armed flag that blocks the timeline's native pan.
  const holdTimer = useRef<number | null>(null);
  const holdStartY = useRef(0);
  const touchReorder = useRef(false);
  // Geometry morph bookkeeping: last-shown layout, the active tween, and the
  // signature used to detect when the target layout changed.
  const displayedRef = useRef<LayoutSnapshot | null>(null);
  const morphRef = useRef<Morph | null>(null);
  // The eased scale + pin this render drew with, so the post-commit scroll
  // adjustment uses identical numbers (no rAF/render clock skew).
  const morphFrame = useRef<{ zoom: number; spanStart: number; t: number; pin: MorphPin | null } | null>(null);
  const sigRef = useRef("");
  const needMorph = useRef(false);
  const forceMorph = useRef(false);
  const pendingPin = useRef<PinIntent | null>(null);
  const prevViewportH = useRef(0);
  // The schedule already given its one entry pan, so it isn't re-panned on every
  // viewport resize (only on mount / when the schedule itself changes).
  const entryPannedFor = useRef<ScheduleId | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizeDrag, setResizeDrag] = useState<ResizeState | null>(null);
  const [viewportH, setViewportH] = useState(0);
  const [, bumpFrame] = useState(0);

  // A previewing reorder or edge-resize may have grown the window; show its span
  // so the bound lines and items move together until the drag commits.
  const bounds: Span = drag?.preview
    ? drag.preview.span
    : resizeDrag
      ? resizeDrag.span
      : view.schedule
        ? { start: view.schedule.start, end: view.schedule.end }
        : { start: layout.DEFAULT_START, end: layout.DEFAULT_END };
  const span = spanOf(bounds, cursorEnabled ? now : null);
  const spanMinutes = Math.max(1, span.end - span.start);

  // Shared so the toolbar/badges run actions at the cursor (the play head), not
  // at `now`. Setting it to `now` is the same as live.
  const cursor = uistate.cursorMinute.value;
  const setCursor = (v: number | null): void => {
    uistate.cursorMinute.value = v;
  };
  const displayCursor = cursorEnabled ? (cursor ?? now) : cursor;
  const isLive = cursorEnabled && (cursor == null || cursor === now);
  const showClose = cursorEnabled ? !isLive : cursor != null;
  const selectedId = uistate.selectedItem.value;
  const panNonce = uistate.panRequest.value;

  // fit: whole schedule visible. selectionFloor: zoom needed to fit the selected
  // item's editor, sized to its measured content (grows with the description).
  const fit = viewportH > 0 ? Math.max(viewportH - SCROLL_PAD_PX, 1) / spanMinutes : 0;
  const selected = selectedId != null ? view.items.find((x) => x.id === selectedId) : undefined;
  const contentNeed = Math.max(EDITOR_MIN_PX, uistate.selectedContentHeight.value);
  const selectionFloor = selected ? contentNeed / Math.max(1, selected.end - selected.start) : 0;
  // Selecting raises zoom to the editor's required level; the morph animates it.
  const lockLevel = Math.max(fit, selectionFloor);
  // Target scale; display is clamped to the fit floor. Interactions read this
  // (the true layout), while rendering reads the eased `disp` below.
  const pxPerMin = fit > 0 ? Math.max(uistate.zoom.value, fit) : uistate.zoom.value;

  // Lift stored zoom up to the fit floor on viewport/schedule change; never down.
  // Skip mid-animation.
  useEffect(() => {
    if (fit <= 0 || zoomRaf.current != null) return;
    if (uistate.zoom.value < fit) uistate.setZoom(fit);
  }, [fit]);

  // A freshly created schedule snaps to fit once, overriding the persisted zoom
  // carried over from the previous schedule (which the lift above never lowers).
  useEffect(() => {
    if (fit <= 0 || uistate.fitScheduleId.value !== scheduleId) return;
    uistate.fitScheduleId.value = null;
    uistate.setZoom(fit);
  }, [fit, scheduleId]);

  // Bring a play-head `target` minute into view: pin the most recent fixed edge
  // at or before it a comfortable offset below the top, then zoom out only as far
  // as needed so the target also clears a comfortable margin above the bottom.
  // The morph glides it into place.
  function panToMinute(target: number): void {
    if (fit <= 0 || viewportH <= 0) return;
    const edges = [bounds.start, bounds.end];
    for (const it of view.items) {
      const b = rawById.get(it.id)?.bounds;
      if (b?.start != null) edges.push(it.start);
      if (b?.end != null) edges.push(it.end);
    }
    const prior = edges.filter((e) => e <= target);
    const edge = prior.length > 0 ? Math.max(...prior) : target;

    const base = Math.max(uistate.zoom.value, fit);
    const gap = target - edge;
    const room = viewportH - ENTRY_EDGE_TOP_PX - ENTRY_CURSOR_BOTTOM_PX;
    const targetZoom = gap > 0 && room > 0 ? Math.max(fit, Math.min(base, room / gap)) : base;

    pendingPin.current = { minute: edge, anchorPx: ENTRY_EDGE_TOP_PX };
    forceMorph.current = true;
    uistate.setZoom(targetZoom);
    bumpFrame((f) => f + 1);
  }

  // On entering the schedule (mount via tab switch / reload), pan the live cursor
  // into view. Once per schedule, after the viewport is measured.
  useEffect(() => {
    if (!cursorEnabled || now == null || fit <= 0 || viewportH <= 0) return;
    if (entryPannedFor.current === scheduleId) return;
    entryPannedFor.current = scheduleId;
    panToMinute(now);
  }, [viewportH, fit, cursorEnabled, scheduleId]);

  // An explicit request (e.g. after a split) re-pans the play head into view.
  const cursorPanNonce = uistate.cursorPanRequest.value;
  useEffect(() => {
    if (cursorPanNonce === 0 || displayCursor == null) return;
    panToMinute(displayCursor);
  }, [cursorPanNonce]);

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const measure = (): void => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function select(id: string, focus: "title" | "description" | null): void {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    uistate.selectItem(id, focus);
  }

  // Raise zoom to the editor's level and pin the selected item near the top.
  // Re-asserted on every fire (selection, the content-height re-measure that
  // follows it, and a pan request after a typed-time move that relocated the
  // item) so an in-flight glide continues to the top instead of freezing
  // mid-pan; a settled item already sits at 24px, so this holds it in place.
  useEffect(() => {
    if (selectedId == null || !selected) return;
    pendingPin.current = { minute: selected.start, anchorPx: 24 };
    forceMorph.current = true;
    uistate.setZoom(lockLevel);
    bumpFrame((f) => f + 1);
  }, [selectedId, selectionFloor, panNonce]);

  useEffect(
    () => () => {
      cancelZoom();
      cancelHold();
    },
    [],
  );

  // Start the morph rAF after commit; the morph itself is set up during render.
  useLayoutEffect(() => {
    if (needMorph.current && zoomRaf.current == null) {
      needMorph.current = false;
      runMorph();
    }
  });

  // After each frame commits its new heights, hold the pinned minute at its
  // anchor using the exact scale this render used (read from morphFrame). Doing
  // it post-commit, not in the rAF tick, keeps scroll and heights from the same
  // frame, so items far from the top don't shimmer from a clock skew.
  useLayoutEffect(() => {
    const f = morphFrame.current;
    const el = scroll.current;
    if (!f || !f.pin || !el) return;
    const anchor = lerp(f.pin.fromAnchorPx, f.pin.toAnchorPx, f.t);
    const top = Math.round((f.pin.minute - f.spanStart) * f.zoom);
    el.scrollTop = Math.max(0, timelineOffset(el) + top - anchor);
  });

  function cancelZoom(): void {
    if (zoomRaf.current != null) {
      cancelAnimationFrame(zoomRaf.current);
      zoomRaf.current = null;
    }
  }

  function timelineOffset(el: HTMLDivElement): number {
    const tl = timelineEl.current;
    if (!tl) return 0;
    return tl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  }

  // Re-render each frame; geometry reads the eased value and the layout effect
  // above sets scroll from the same frame's scale.
  function runMorph(): void {
    const step = (): void => {
      const m = morphRef.current;
      if (!m) {
        zoomRaf.current = null;
        return;
      }
      bumpFrame((f) => f + 1);
      zoomRaf.current = performance.now() - m.start >= MORPH_MS ? null : requestAnimationFrame(step);
    };
    zoomRaf.current = requestAnimationFrame(step);
  }

  // Step the factor-based ladder, keeping the viewport-center minute pinned.
  // Zooming exits the per-item lock; the live zoom value handles rapid clicks.
  function zoomStep(dir: 1 | -1): void {
    if (fit <= 0) return;
    if (selected) uistate.selectItem(null);
    const ladder = zoomLadder(fit, 0);
    const base = Math.max(uistate.zoom.value, fit);
    const target = dir > 0 ? nextZoomIn(base, ladder) : nextZoomOut(base, ladder);
    if (target == null) return;
    const el = scroll.current;
    if (el) {
      const center = (el.scrollTop + el.clientHeight / 2 - timelineOffset(el)) / pxPerMin + span.start;
      pendingPin.current = { minute: center, anchorPx: el.clientHeight / 2 };
    }
    uistate.setZoom(target);
  }

  function minuteAt(clientY: number): number {
    const r = timelineEl.current?.getBoundingClientRect();
    return r ? clampMinute(minuteOf(clientY - r.top, span, pxPerMin), span) : span.start;
  }

  // Nudge a cursor minute to the nearest item edge within a small screen radius,
  // so it lands cleanly on a boundary without fighting fine placement elsewhere.
  function snapCursor(minute: number): number {
    const radius = CURSOR_SNAP_PX / pxPerMin;
    let best = minute;
    let bestDist = radius;
    for (const it of view.items) {
      for (const edge of [it.start, it.end]) {
        const d = Math.abs(edge - minute);
        if (d <= bestDist) {
          bestDist = d;
          best = edge;
        }
      }
    }
    return best;
  }

  function onTimelineClick(e: JSX.TargetedMouseEvent<HTMLDivElement>): void {
    // A captured drag dispatches its closing click here; swallow it so a reorder
    // doesn't also drop the time cursor at the release point.
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    if (selectedId != null) {
      uistate.selectItem(null);
      return;
    }
    setCursor(snapCursor(minuteAt(e.clientY)));
  }

  function cancelHold(): void {
    if (holdTimer.current != null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  // Abort any pending/active reorder without committing it, restoring panning and
  // clearing the ghost. Used when a gesture is interrupted (pointer cancel, or a
  // long-press that the browser turns into a context menu).
  function cancelDrag(): void {
    cancelHold();
    touchReorder.current = false;
    if (drag) setDrag(null);
    if (resizeDrag) setResizeDrag(null);
  }

  // Press on a fixed edge's grab handle (item or schedule line). Capture at once
  // so the gesture is a resize, not a pan/select; the click it ends on is
  // swallowed (justDragged). Resizing also drops any other item's selection.
  function onResizeDown(target: ResizeTarget, startValue: number) {
    return (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      e.stopPropagation();
      justDragged.current = true;
      cancelHold();
      scroll.current?.setPointerCapture(e.pointerId);
      if (target.kind === "item" && selectedId != null && selectedId !== target.id) uistate.selectItem(null);
      const frames = view.items.map((i) => ({ id: i.id, start: i.start, end: i.end }));
      setResizeDrag({ target, startY: e.clientY, startValue, desired: startValue, moved: false, span: bounds, frames });
    };
  }

  function onResizeMove(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    const rd = resizeDrag;
    if (!rd) return;
    const deltaPx = e.clientY - rd.startY;
    if (!rd.moved && Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
    const desired = Math.round(rd.startValue + deltaPx / pxPerMin);
    const items = view.items.map((i) => ({ id: i.id, bounds: rawById.get(i.id)!.bounds }));
    const base: Span = view.schedule
      ? { start: view.schedule.start, end: view.schedule.end }
      : { start: layout.DEFAULT_START, end: layout.DEFAULT_END };
    if (rd.target.kind === "item") {
      const t = rd.target;
      const index = items.findIndex((it) => it.id === t.id);
      if (index < 0) return;
      const r = resize.slideEdge(items, base, index, t.edge, desired);
      setResizeDrag({ ...rd, moved: true, desired, span: r.span, frames: r.layout });
    } else {
      const val =
        rd.target.edge === "start"
          ? resize.clampScheduleStart(items, base, desired)
          : resize.clampScheduleEnd(items, base, desired);
      const sp: Span = rd.target.edge === "start" ? { start: val, end: base.end } : { start: base.start, end: val };
      setResizeDrag({ ...rd, moved: true, desired, span: sp, frames: layout.compute(items, sp) });
    }
  }

  function onResizeUp(): void {
    const rd = resizeDrag;
    setResizeDrag(null);
    if (!rd || !rd.moved) return;
    // Seed the morph's "from" with the on-screen preview so the commit glides
    // from where the edge was released instead of snapping back first.
    const baseSnap = displayedRef.current;
    if (baseSnap) {
      const minutes = new Map(rd.frames.map((f) => [f.id, { start: f.start, end: f.end }]));
      displayedRef.current = { ...baseSnap, spanStart: rd.span.start, spanEnd: rd.span.end, minutes };
      forceMorph.current = true;
    }
    if (rd.target.kind === "item") {
      scheduleOps.slideItemEdge(scheduleId, rd.target.id, rd.target.edge, rd.desired);
    } else {
      scheduleOps.patchScheduleBounds(scheduleId, rd.target.edge === "start" ? { start: rd.desired } : { end: rd.desired });
    }
  }

  function onItemDown(item: { id: string; start: number; end: number }) {
    return (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      justDragged.current = false;
      // Fixed items are immovable: leave selection to the click, never drag.
      const raw = rawById.get(item.id);
      if (raw && reorder.isAnchored(raw.bounds)) return;
      // Reorders start only from non-interactive areas, so presses on the selected
      // item's editor fields/buttons reach the control (identical on touch/mouse).
      if ((e.target as Element | null)?.closest("input, textarea, select, button, a")) return;
      const pid = e.pointerId;
      const startY = e.clientY;
      // A long-press arms a touch reorder outright (captures the pointer). The
      // dragged item keeps its selection so its editor stays mounted: collapsing it
      // mid-gesture detaches the pressed node, whose touchmove then escapes the
      // scroll container's pan guard. A mouse press only stages the drag; capture
      // waits for real movement (see onItemMove) so a plain click still selects.
      const begin = (touch: boolean): void => {
        if (touch) scroll.current?.setPointerCapture(pid);
        // Reordering a different item deselects the current one; reordering the
        // selected item keeps its selection (and mounted editor) through to drop.
        if (selectedId != null && selectedId !== item.id) uistate.selectItem(null);
        setDrag({ draggedId: item.id, startY, deltaPx: 0, moved: false, touch, preview: null });
      };
      // Mouse drags immediately; touch waits out a hold so a swipe can scroll.
      if (e.pointerType === "touch") {
        holdStartY.current = startY;
        cancelHold();
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          touchReorder.current = true;
          begin(true);
        }, HOLD_MS);
        return;
      }
      begin(false);
    };
  }

  function onItemMove(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    if (resizeDrag) {
      onResizeMove(e);
      return;
    }
    if (holdTimer.current != null) {
      if (Math.abs(e.clientY - holdStartY.current) > DRAG_THRESHOLD_PX) cancelHold();
      return;
    }
    if (!drag) return;
    const deltaPx = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
    // A mouse drag captures on first movement (not on press) so the click that ends
    // a plain press isn't stolen by the capture target and still selects.
    if (!drag.moved && !drag.touch) scroll.current?.setPointerCapture(e.pointerId);
    const deltaMin = deltaPx / pxPerMin;
    const dir: reorder.DragDir = deltaMin >= 0 ? "down" : "up";
    const items = view.items.map((i) => ({ id: i.id, bounds: rawById.get(i.id)!.bounds }));
    const frames = view.items.map((i) => ({ start: i.start, end: i.end }));
    const dragged = view.items.find((i) => i.id === drag.draggedId)!;
    const leadingEdge = (dir === "down" ? dragged.end : dragged.start) + deltaMin;
    const res = reorder.detect(items, frames, drag.draggedId, dir, leadingEdge, bounds);
    setDrag({ ...drag, deltaPx, moved: true, preview: res.ok ? res.value : null });
  }

  function onItemUp(): void {
    if (resizeDrag) {
      onResizeUp();
      return;
    }
    cancelHold();
    touchReorder.current = false;
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    justDragged.current = true;
    if (!d.preview) return;
    // Seed the morph's "from" with the on-screen preview (non-dragged items
    // already at their reordered slots, the dragged item at the drop point), so
    // the commit glides the dragged item into place instead of snapping the whole
    // list back to the original order and re-animating.
    const base = displayedRef.current;
    if (base) {
      const minutes = new Map(d.preview.layout.map((f) => [f.id, { start: f.start, end: f.end }]));
      const dragged = base.minutes.get(d.draggedId);
      if (dragged) {
        const shift = d.deltaPx / base.zoom;
        minutes.set(d.draggedId, { start: dragged.start + shift, end: dragged.end + shift });
      }
      displayedRef.current = { ...base, minutes };
      forceMorph.current = true;
    }
    scheduleOps.applyReorder(scheduleId, d.draggedId, d.preview);
  }

  function cursorDown(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    cursorDrag.current = { startY: e.clientY, startMinute: displayCursor ?? span.start };
  }

  function cursorMove(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    const d = cursorDrag.current;
    if (!d) return;
    setCursor(snapCursor(clampMinute(Math.round(d.startMinute + (e.clientY - d.startY) / pxPerMin), span)));
  }

  function cursorUp(): void {
    cursorDrag.current = null;
  }

  function insert(): void {
    // An explicit (detached) cursor steers the slot; a live/absent cursor leaves
    // placement to the least-strain rule, anchored at `now`.
    const explicit = isLive ? null : cursor;
    const id = scheduleOps.insertItem(scheduleId, explicit, now, randomItemColor);
    if (id != null) uistate.selectItem(id, "title");
  }

  // Keep the header button's handle pointing at the current closure (cursor/now).
  useEffect(() => {
    if (insertRef) insertRef.current = insert;
  });

  const previewFrames = drag?.preview
    ? new Map(drag.preview.layout.map((f) => [f.id, f] as const))
    : resizeDrag
      ? new Map(resizeDrag.frames.map((f) => [f.id, f] as const))
      : null;
  const badges = mediaBadges(view, flags, now);
  // Buttons step the normal ladder; using them while selected first deselects.
  const ladder = fit > 0 ? zoomLadder(fit, 0) : [];
  const zoomBase = pxPerMin;

  // Detect a layout change and start a morph from the last-shown geometry to the
  // new target. Suppressed during continuous gestures (drag/pinch) and on
  // viewport resize, where the display should track the target directly.
  const target: LayoutSnapshot = {
    zoom: pxPerMin,
    spanStart: span.start,
    spanEnd: span.end,
    minutes: new Map(view.items.map((i) => [i.id, { start: i.start, end: i.end }])),
  };
  const pin = pendingPin.current;
  pendingPin.current = null;
  const viewportChanged = viewportH !== prevViewportH.current;
  prevViewportH.current = viewportH;
  const suppress = drag != null || resizeDrag != null || pinch.current != null || viewportChanged;
  const sig = layoutSig(target);
  if (forceMorph.current || sig !== sigRef.current) {
    sigRef.current = sig;
    forceMorph.current = false;
    const prev = displayedRef.current;
    const el = scroll.current;
    if (prev && !suppress) {
      // Anchor minute: an explicit pin's, else the selected item's start (keep
      // it stationary). fromAnchor is where that minute sits right now; toAnchor
      // is the pin's target, or fromAnchor when just holding it in place.
      const anchorMinute = pin ? pin.minute : selected ? target.minutes.get(selected.id)?.start ?? selected.start : null;
      let resolvedPin: MorphPin | null = null;
      if (anchorMinute != null && el) {
        const fromAnchorPx = timelineOffset(el) + (anchorMinute - prev.spanStart) * prev.zoom - el.scrollTop;
        resolvedPin = { minute: anchorMinute, fromAnchorPx, toAnchorPx: pin ? pin.anchorPx : fromAnchorPx };
      }
      morphRef.current = { from: prev, to: target, start: performance.now(), pin: resolvedPin };
      needMorph.current = true;
    } else {
      morphRef.current = null;
    }
  }
  let disp = target;
  const morph = morphRef.current;
  if (morph) {
    const t = easeInOut(Math.min(1, (performance.now() - morph.start) / MORPH_MS));
    disp = lerpLayout(morph.from, morph.to, t);
    morphFrame.current = { zoom: disp.zoom, spanStart: disp.spanStart, t, pin: morph.pin };
    if (t >= 1) morphRef.current = null;
  } else {
    morphFrame.current = null;
  }
  displayedRef.current = disp;
  const height = (disp.spanEnd - disp.spanStart) * disp.zoom;
  const dy = (minute: number): number => (minute - disp.spanStart) * disp.zoom;

  // After a pinch frame commits its new height, scroll so the focal minute sits
  // under the live finger midpoint, zooming around where the pinch began.
  useLayoutEffect(() => {
    const a = pinchScroll.current;
    const el = scroll.current;
    if (!a || !el) return;
    pinchScroll.current = null;
    el.scrollTop = Math.max(0, timelineOffset(el) + (a.minute - disp.spanStart) * disp.zoom - a.screenY);
  });

  return (
    <div class={s.wrap} data-selection-surface>
      <div
        ref={scroll}
        class={s.scroll}
        onScroll={(e) => (uistate.scrollTop.value = e.currentTarget.scrollTop)}
        onTouchStart={(e) => {
          if (e.touches.length === 2) {
            const tl = timelineEl.current;
            const minute = tl ? span.start + (touchMidY(e) - tl.getBoundingClientRect().top) / pxPerMin : span.start;
            pinch.current = { dist: touchDist(e), zoom: uistate.zoom.value, minute };
          }
        }}
        onTouchMove={(e) => {
          // An armed reorder or an edge-resize owns the gesture; stop the pan.
          if (touchReorder.current || resizeDrag) {
            e.preventDefault();
            return;
          }
          if (pinch.current && e.touches.length === 2) {
            e.preventDefault();
            const z = (pinch.current.zoom * touchDist(e)) / pinch.current.dist;
            if (selected) uistate.selectItem(null);
            const b = fit > 0 ? zoomBounds(fit, 0) : null;
            const el = scroll.current;
            if (el) pinchScroll.current = { minute: pinch.current.minute, screenY: touchMidY(e) - el.getBoundingClientRect().top };
            uistate.setZoom(b ? clampZoom(z, b) : z);
          }
        }}
        onTouchEnd={(e) => {
          if (e.touches.length < 2) pinch.current = null;
        }}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
        onPointerCancel={cancelDrag}
        onContextMenu={(e) => {
          // Android fires contextmenu on the same long-press that arms a reorder;
          // suppress the menu so the drag continues instead of being stranded.
          if (drag != null || touchReorder.current || holdTimer.current != null) {
            e.preventDefault();
          }
        }}
        onClick={onTimelineClick}
      >
        <div ref={timelineEl} class={s.timeline} style={`height:${height}px`}>
          {tickLines(span, disp.zoom).map((m) => (
            <div key={m} class={s.tickLine} style={`top:${dy(m)}px`}>
              <span class={s.tickLabel}>{fmtClock(m)}</span>
            </div>
          ))}
          {view.schedule && (
            <>
              <ScheduleBound
                edge="start"
                top={dy(bounds.start)}
                onResizeStart={onResizeDown({ kind: "schedule", edge: "start" }, bounds.start)}
              />
              <ScheduleBound
                edge="end"
                top={dy(bounds.end)}
                onResizeStart={onResizeDown({ kind: "schedule", edge: "end" }, bounds.end)}
              />
            </>
          )}
          {view.items.map((item) => {
            const isDragged = drag?.draggedId === item.id;
            const frame = previewFrames?.get(item.id);
            const dm = disp.minutes.get(item.id) ?? { start: item.start, end: item.end };
            const startMin = frame ? frame.start : dm.start;
            const endMin = frame ? frame.end : dm.end;
            // Snap edges to whole pixels: shared boundaries stay contiguous and
            // Firefox stops leaving a 1px seam between a block's border and its
            // gradient at fractional zoom offsets.
            const yStart = Math.round(dy(startMin));
            const yEnd = Math.round(dy(endMin));
            const top = isDragged ? Math.round(dy(dm.start) + drag.deltaPx) : yStart;
            const blockHeight = Math.max(1, yEnd - yStart);
            return (
              <Block
                key={item.id}
                item={item}
                raw={rawById.get(item.id)}
                top={top}
                height={blockHeight}
                tagStart={frame ? frame.start : item.start}
                tagEnd={frame ? frame.end : item.end}
                selected={selectedId === item.id}
                dragging={!!isDragged && (drag.moved || drag.touch)}
                onSelect={(focus) => select(item.id, focus)}
                onPointerDown={onItemDown(item)}
                onResizeStart={(edge, e) =>
                  onResizeDown({ kind: "item", id: item.id, edge }, edge === "start" ? item.start : item.end)(e)
                }
              />
            );
          })}
          {badges.map((b) => {
            const bm = disp.minutes.get(b.item.id) ?? { start: b.item.start, end: b.item.end };
            return (
            <div key={b.item.id} class={s.mediaBadges} style={`top:${dy((bm.start + bm.end) / 2)}px`}>
              {b.kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  class={s.mediaBadge}
                  title={RUN_BADGE_LABEL[kind]}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (displayCursor != null) scheduleOps.runAction(scheduleId, kind, displayCursor);
                  }}
                >
                  {RUN_ICON[kind]}
                </button>
              ))}
            </div>
            );
          })}
          {displayCursor != null && (
            <div
              class={isLive ? `${s.cursor} ${s.cursorLive}` : `${s.cursor} ${s.cursorDetached}`}
              style={`top:${dy(displayCursor)}px`}
            >
              <div
                class={s.cursorHit}
                onPointerDown={cursorDown}
                onPointerMove={cursorMove}
                onPointerUp={cursorUp}
                onClick={(e) => e.stopPropagation()}
              />
              <div class={s.cursorLine} />
              <span class={s.cursorLabel}>{fmtClock(displayCursor)}</span>
              {showClose && (
                <button
                  type="button"
                  class={s.cursorClose}
                  title={cursorEnabled ? "Snap cursor back to now" : "Hide cursor"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCursor(null);
                  }}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div class={s.zoom}>
        <button
          type="button"
          class={s.zoomBtn}
          title="Zoom out"
          disabled={nextZoomOut(zoomBase, ladder) == null}
          onClick={() => zoomStep(-1)}
        >
          <ZoomOutIcon />
        </button>
        <button
          type="button"
          class={s.zoomBtn}
          title="Zoom in"
          disabled={nextZoomIn(zoomBase, ladder) == null}
          onClick={() => zoomStep(1)}
        >
          <ZoomInIcon />
        </button>
      </div>
      <button type="button" class={s.insert} title="Add item at cursor" onClick={insert}>
        <PlusIcon />
      </button>
    </div>
  );
}

interface BadgeGroup {
  item: ScheduleViewItem;
  kinds: RunAction[];
}

function mediaBadges(view: ScheduleView, flags: RunFlags | null, now: number | null): BadgeGroup[] {
  if (!flags || now == null) return [];
  const byTarget = new Map<string, RunAction[]>();
  for (const kind of ["play", "skip", "stop"] as const) {
    const f = flags[kind];
    if (f.enabled && f.target != null) {
      const arr = byTarget.get(f.target) ?? [];
      arr.push(kind);
      byTarget.set(f.target, arr);
    }
  }
  const out: BadgeGroup[] = [];
  for (const [id, kinds] of byTarget) {
    const item = view.items.find((i) => i.id === id);
    if (item) out.push({ item, kinds });
  }
  return out;
}

function clampMinute(minute: number, span: Span): number {
  return Math.min(span.end, Math.max(span.start, minute));
}

function touchDist(e: TouchEvent): number {
  const a = e.touches[0]!;
  const b = e.touches[1]!;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidY(e: TouchEvent): number {
  return (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
}
