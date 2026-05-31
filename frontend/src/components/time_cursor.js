import m from "mithril";
import { fmtClock } from "./time_parse.js";

// Time-cursor overlay; parent owns the minute. Today mode paints live red at nowMin; weekday/date mode is detachable.

const DRAG_THRESHOLD_PX = 4;
// Snap distance (minutes) to item edges and timeline bounds; small so it doesn't override a deliberate drag.
const SNAP_MIN = 5;


// Clamp min to the renderable range; effectiveStart may be < schedule.start_min in today mode, bottom is schedule.end_min.
function clampToRange(min, effectiveStart, schedule) {
  if (min < effectiveStart) return effectiveStart;
  if (min > schedule.end_min) return schedule.end_min;
  return min;
}

// Snap min to the nearest item edge or range boundary within SNAP_MIN, else return it unchanged.
function snapToTargets(min, effectiveStart, schedule, items) {
  let best = min;
  let bestDist = SNAP_MIN + 1; // strictly outside the window
  const consider = (target) => {
    if (target == null) return;
    const d = Math.abs(target - min);
    if (d < bestDist) {
      bestDist = d;
      best = target;
    }
  };
  consider(effectiveStart);
  consider(schedule.end_min);
  if (items && items.length) {
    for (const it of items) {
      consider(it.assigned_start);
      consider(it.assigned_end);
    }
  }
  return bestDist <= SNAP_MIN ? best : min;
}

export const TimeCursor = {
  oninit(vnode) {
    vnode.state.drag = null;
  },
  onremove(vnode) {
    const d = vnode.state.drag;
    if (d) {
      document.removeEventListener("pointermove", d.move);
      document.removeEventListener("pointerup", d.up);
      document.removeEventListener("pointercancel", d.up);
    }
  },
  view(vnode) {
    const a = vnode.attrs;
    if (a.cursorMin == null) return null;

    const isLive = a.nowMin != null && a.cursorMin === a.nowMin;
    // X button: hidden on live today; resets to live when off-now; hides the cursor in non-today mode.
    const showClose = a.nowMin != null ? !isLive : true;

    const cls =
      ".time-cursor" +
      (isLive ? ".time-cursor-live" : ".time-cursor-detached") +
      (vnode.state.drag && vnode.state.drag.moved ? ".time-cursor-dragging" : "");

    const top = (a.cursorMin - a.effectiveStart) * a.pxPerMin;

    return m(
      cls,
      { style: `top:${top}px` },
      m(
        ".time-cursor-hitzone",
        {
          onpointerdown: (e) => {
            if (e.button !== 0) return;
            // Don't let this become a generic timeline click that re-positions via the wrap's handler.
            e.stopPropagation();
            e.preventDefault();
            startDrag(vnode, e);
          },
          // Swallow the synthesised click so a tap on the grabber doesn't bubble up and re-position the cursor.
          onclick: (e) => e.stopPropagation(),
        }
      ),
      m(".time-cursor-line"),
      m(".time-cursor-label", fmtClock(a.cursorMin)),
      showClose
        ? m(
            "button.time-cursor-close",
            {
              type: "button",
              title:
                a.nowMin != null
                  ? "Snap cursor back to now"
                  : "Hide cursor",
              "aria-label":
                a.nowMin != null
                  ? "Snap cursor back to now"
                  : "Hide cursor",
              onpointerdown: (e) => {
                // Swallow so the wrap's click-to-position handler doesn't also fire.
                e.stopPropagation();
              },
              onclick: (e) => {
                e.stopPropagation();
                if (a.nowMin != null) {
                  if (a.onReset) a.onReset();
                } else {
                  if (a.onHide) a.onHide();
                }
              },
            },
            m("span.icon.icon-close")
          )
        : null
    );
  },
};

function startDrag(vnode, event) {
  const a = vnode.attrs;
  const startY = event.clientY;
  const startMin = a.cursorMin;
  const session = {
    startY,
    startMin,
    moved: false,
  };
  const move = (ev) => {
    const deltaY = ev.clientY - startY;
    if (!session.moved) {
      if (Math.abs(deltaY) <= DRAG_THRESHOLD_PX) return;
      session.moved = true;
    }
    const aLatest = vnode.attrs;
    const deltaMin = deltaY / aLatest.pxPerMin;
    const rawMin = Math.round(startMin + deltaMin);
    const clamped = clampToRange(
      rawMin,
      aLatest.effectiveStart,
      aLatest.schedule
    );
    const snapped = snapToTargets(
      clamped,
      aLatest.effectiveStart,
      aLatest.schedule,
      aLatest.items
    );
    if (aLatest.onChange) aLatest.onChange(snapped);
    m.redraw();
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    vnode.state.drag = null;
    // If the drag never crossed the threshold the cursor stays put (a no-op click).
    m.redraw();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  vnode.state.drag = { move, up, moved: false, get: () => session };
}

