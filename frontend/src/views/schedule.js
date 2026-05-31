import m from "mithril";
import { api, onApiMutation } from "../api.js";
import { Popup } from "../components/popup.js";
import { AutoField } from "../components/autosave.js";
import { computeLayout, MIN_DURATION } from "../components/layout.js";
import { computeReorderPreview } from "../components/reorder.js";
import { ColorPicker } from "../components/color_picker.js";
import { TimeCursor } from "../components/time_cursor.js";
import { explicitCursorMin } from "../components/cursor_insert.js";
import { computeRunningFlags } from "../components/day_flags.js";
import {
  DEFAULT_ITEM_COLOR,
  paletteColor,
} from "../palette.js";
import {
  anchoredPlaceholderStartPatch,
  makePlaceholderDraft,
  PLACEHOLDER_DURATION_DEFAULT,
} from "../components/placeholder.js";
import { solveInsertion } from "../components/insert_solver.js";
import {
  fmtClock,
  fmtDuration,
  parseClockToMin,
  parseDurationToMin,
} from "../components/time_parse.js";
import {
  historyState,
  doUndo,
  doRedo,
  onHistoryChange,
} from "../history.js";

// Undo/redo and the reload listener are scoped here so a Projects-tab undo doesn't reload Schedule.
const HISTORY_CONTEXT = "schedule";

// Storing zoom as a float (not an array index) lets the dynamic fit floor mix with these fixed levels.
const FIXED_STEPS = [1, 2, 4, 8];
const ZOOM_DEFAULT = 1;
// Drop fixed steps within this multiplicative gap above fitZoom so a near-1x fit doesn't render an indistinguishable adjacent step.
const FIT_DEDUP_TOLERANCE = 1.05;
// Half-percent slack so "current zoom is at fitZoom" survives float jitter.
const ZOOM_EPS = 0.005;

function loadZoom() {
  const raw = localStorage.getItem("schedule.zoom");
  if (raw != null) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : ZOOM_DEFAULT;
  }
  // One-time migration from the legacy integer-index representation; old steps were [0.5, 1, 2, 4, 8].
  const legacy = localStorage.getItem("schedule.zoomIndex");
  if (legacy != null) {
    const idx = parseInt(legacy, 10);
    const legacySteps = [0.5, 1, 2, 4, 8];
    const z =
      Number.isFinite(idx) && idx >= 0 && idx < legacySteps.length
        ? legacySteps[idx]
        : ZOOM_DEFAULT;
    localStorage.setItem("schedule.zoom", String(z));
    localStorage.removeItem("schedule.zoomIndex");
    return z;
  }
  return ZOOM_DEFAULT;
}

function saveZoom(z) {
  localStorage.setItem("schedule.zoom", String(z));
}


// Project/task mutations are included because project-bound blocks resolve against that state; history is excluded to avoid double-reloading.
function scheduleAffected(url) {
  if (url.includes("/api/history/")) return false;
  return (
    url.includes("/api/schedules") ||
    url.includes("/api/schedule_items") ||
    url.includes("/api/calendar/") ||
    url.includes("/api/day/") ||
    url.includes("/api/projects") ||
    url.includes("/api/tasks")
  );
}

function isScheduleActive(vnode) {
  const route = m.route.get() || "";
  const a = vnode.attrs;
  if (a.mode === "today") return route === "/today";
  if (a.mode === "weekday") return route === "/weekday/" + a.weekday;
  if (a.mode === "date") return route === "/date/" + a.date;
  return false;
}


// Persisted last-viewed schedule sub-route so the Schedule tab restores where the user was; empty-state routes count.
const LAST_SCHEDULE_ROUTE_KEY = "schedule:lastRoute";

// Reject values not matching these three schedule prefixes so a stale localStorage entry can't navigate to a non-existent path.
function isScheduleRoute(route) {
  if (typeof route !== "string") return false;
  if (route === "/today" || route.startsWith("/today?")) return true;
  if (route.startsWith("/weekday/")) return true;
  if (route.startsWith("/date/")) return true;
  return false;
}

// Module-level (not per-instance): the top-level and sub-route Schedules are separate components; a per-instance cache would desync localStorage.
let cachedLastScheduleRoute = (() => {
  try {
    return localStorage.getItem(LAST_SCHEDULE_ROUTE_KEY);
  } catch (_) {
    return null;
  }
})();

export function loadLastScheduleRoute() {
  return isScheduleRoute(cachedLastScheduleRoute)
    ? cachedLastScheduleRoute
    : null;
}

function saveLastScheduleRoute(route) {
  if (!isScheduleRoute(route)) return;
  if (route === cachedLastScheduleRoute) return;
  try {
    localStorage.setItem(LAST_SCHEDULE_ROUTE_KEY, route);
  } catch (_) {
    /* localStorage unavailable; keep the cache so the session stays self-consistent without retrying the doomed write. */
  }
  cachedLastScheduleRoute = route;
}

export const Schedule = {
  oninit(vnode) {
    vnode.state.day = null; // { schedule, items, source, now_min, ... }
    vnode.state.layout = null; // { schedule, items, errors } for non-today
    vnode.state.editingItem = null;
    // Pending placeholder draft for "+ Add item": solveInsertion splices it into the timeline each render; the popup edits it directly.
    vnode.state.placeholder = null;
    // Resets to true each time the popup opens; not persisted.
    vnode.state.allowRepositioning = true;
    vnode.state.editingProps = false;
    vnode.state.menuOpen = false;
    saveLastScheduleRoute(m.route.get() || "/today");
    vnode.state.zoom = loadZoom();
    vnode.state.nowMin = null;
    // Minutes to add to the local clock to reach the active schedule's frame; 1440 during yesterday's overflow.
    vnode.state.nowFrameOffset = 0;
    // Time-cursor minute: starts live at nowMin in today mode, null (hidden) elsewhere; it's the insertion target.
    vnode.state.cursorMin = null;
    vnode.state.loading = false;
    vnode.state.tick = setInterval(() => {
      const prevNow = vnode.state.nowMin;
      const next = nowMin() + vnode.state.nowFrameOffset;
      vnode.state.nowMin = next;
      // Live cursor follows the clock; if detached (drifted from prevNow) leave it. Still redraw — effectiveStart depends on nowMin.
      if (vnode.attrs.mode !== "today") return;
      if (vnode.state.cursorMin === prevNow) {
        vnode.state.cursorMin = next;
      }
      m.redraw();
    }, 1000);
    vnode.state.nowMin = nowMin();
    vnode.state.cursorMin = vnode.state.nowMin;
    // Set when a mutation arrives for a hidden schedule tab; onupdate refreshes once it becomes visible again.
    vnode.state._dirty = false;
    this.reload(vnode);
    // Reload only when the changed context is ours, so a Projects-tab undo doesn't refetch this view.
    vnode.state._unsubHistory = onHistoryChange((ctx) => {
      if (ctx === HISTORY_CONTEXT) this.reload(vnode);
    });
    vnode.state._unsubMut = onApiMutation((url) => {
      if (!scheduleAffected(url)) return;
      if (isScheduleActive(vnode)) {
        this.reload(vnode);
      } else {
        // Top-level Schedule stays mounted across tabs; defer the refetch until visible so hidden tabs don't fetch in the background.
        vnode.state._dirty = true;
      }
    });
    // Fit-zoom floor depends on the live viewport height, so recompute on resize. Bail when the scroll node is gone.
    vnode.state._onResize = () => {
      if (!vnode.state._scrollEl) return;
      m.redraw();
    };
    window.addEventListener("resize", vnode.state._onResize);
  },
  onremove(vnode) {
    clearInterval(vnode.state.tick);
    if (vnode.state._unsubHistory) vnode.state._unsubHistory();
    if (vnode.state._unsubMut) vnode.state._unsubMut();
    if (vnode.state._onResize)
      window.removeEventListener("resize", vnode.state._onResize);
  },
  onupdate(vnode) {
    // The top-level today instance never unmounts, so onupdate (not oninit) catches navigation back to /today. Dedup makes it cheap.
    if (isScheduleActive(vnode)) {
      saveLastScheduleRoute(m.route.get() || "/today");
    }
    if (
      vnode.state._lastMode !== vnode.attrs.mode ||
      vnode.state._lastWeekday !== vnode.attrs.weekday ||
      vnode.state._lastDate !== vnode.attrs.date
    ) {
      vnode.state._lastMode = vnode.attrs.mode;
      vnode.state._lastWeekday = vnode.attrs.weekday;
      vnode.state._lastDate = vnode.attrs.date;
      // Reset the cursor on every mode change; the mode delta is the natural trigger (reload lacks a fresh-vs-refresh signal).
      if (vnode.attrs.mode === "today") {
        vnode.state.cursorMin = vnode.state.nowMin;
      } else {
        vnode.state.cursorMin = null;
      }
      // Keep prior data visible while we refetch so navigating tabs / dates
      // doesn't blank out the view.
      vnode.state._dirty = false;
      this.reload(vnode);
      return;
    }
    if (vnode.state._dirty && isScheduleActive(vnode)) {
      vnode.state._dirty = false;
      this.reload(vnode);
    }
  },
  // Resolves once fresh data is in state and a redraw is queued; callers defer closing covering UI until then.
  reload(vnode) {
    const a = vnode.attrs;
    vnode.state.loading = true;
    const done = () => {
      vnode.state.loading = false;
      m.redraw();
    };
    if (a.mode === "today") {
      return api.day().then(
        (d) => {
          vnode.state.day = d;
          vnode.state.layout = null;
          // If today resolved to yesterday's overflow, now_min is +1440; capture that shift so local ticks stay in the same frame.
          const local = nowMin();
          const remote = d ? d.now_min : null;
          let offset = 0;
          if (remote != null) {
            const diff = remote - local;
            // Snap to the nearest 1440-minute multiple so a 1-minute clock
            // skew between client and server doesn't produce a misalignment.
            offset = Math.round(diff / 1440) * 1440;
          }
          const prevOffset = vnode.state.nowFrameOffset;
          const prevNow = vnode.state.nowMin;
          const prevCursor = vnode.state.cursorMin;
          vnode.state.nowFrameOffset = offset;
          vnode.state.nowMin = local + offset;
          // If the cursor was live before reload, re-pin it to the new now; otherwise leave the detached value alone.
          if (prevCursor == null || prevCursor === prevNow) {
            vnode.state.cursorMin = vnode.state.nowMin;
          } else if (prevOffset !== offset) {
            // Frame flipped under a detached cursor — shift it by the same delta to keep the same wall-clock minute.
            vnode.state.cursorMin = prevCursor + (offset - prevOffset);
          }
          done();
        },
        () => done()
      );
    } else if (a.mode === "weekday") {
      return api.getWeekday(a.weekday).then(
        (row) => {
          if (row.schedule)
            return api.scheduleLayout(row.schedule.id).then(
              (lo) => {
                vnode.state.layout = lo;
                vnode.state.day = null;
                done();
              },
              () => done()
            );
          vnode.state.layout = { schedule: null, items: [], errors: [] };
          vnode.state.day = null;
          done();
          return undefined;
        },
        () => done()
      );
    } else if (a.mode === "date") {
      return api.getOverride(a.date).then(
        (row) => {
          if (row && row.schedule)
            return api.scheduleLayout(row.schedule.id).then(
              (lo) => {
                vnode.state.layout = lo;
                vnode.state.day = null;
                vnode.state.weekdayTemplateForDate = null;
                done();
              },
              () => done()
            );
          vnode.state.layout = { schedule: null, items: [], errors: [] };
          vnode.state.day = null;
          // Fetch the weekday binding alongside the missing override so the empty state can decide whether to show the Fork button.
          const wd = weekdayMondayBasedFromDate(parseLocalYmdInline(a.date));
          return api.getWeekday(wd).then(
            (wdRow) => {
              vnode.state.weekdayTemplateForDate =
                wdRow && wdRow.schedule ? wdRow.schedule : null;
              done();
            },
            () => {
              vnode.state.weekdayTemplateForDate = null;
              done();
            }
          );
        },
        () => done()
      );
    }
    return Promise.resolve();
  },

  view(vnode) {
    const s = vnode.state;
    const a = vnode.attrs;
    if (a.mode === "today") {
      // On first paint s.day is null; render nothing (not "Loading…") so the tab isn't torn down before data arrives.
      if (!s.day) return null;
      return renderToday(vnode, this);
    } else {
      if (!s.layout) return null;
      return renderSpecific(vnode, this);
    }
  },
};

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function renderToday(vnode, self) {
  const s = vnode.state;
  const d = s.day;
  const sched = d.schedule;
  // Editing requires a real date override; the yesterday-overflow display (source weekday_template) is intentionally read-only.
  const editable = !!sched && d.source === "date_override";
  const title = "Today";
  const hasItems = !!(d.items && d.items.length > 0);
  // Cursor minute is the source of truth for play/skip/stop; backend applies the same at_min the client sends.
  const running = computeRunningFlags(
    sched,
    d.items || [],
    s.cursorMin != null ? s.cursorMin : s.nowMin
  );
  // Probe the solver with a dynamic draft (repositioning on) so Add stays enabled whenever some valid placement exists.
  const insertCursor = explicitCursorMin(s.cursorMin, s.nowMin);
  const canAdd =
    editable && (!sched || canAddProbe(sched, d.items || [], insertCursor));
  // Solver result for the open placeholder; computed here so the timeline and popup share one object.
  const solverOut = s.placeholder
    ? solveInsertion({
        items: d.items || [],
        schedule: sched,
        draft: s.placeholder,
        cursorMin: insertCursor,
        allowRepositioning: s.allowRepositioning,
      })
    : null;
  // On conflict, render the original layout; otherwise feed the solver's with-placeholder items so the live block appears.
  const renderItems =
    solverOut && !solverOut.conflict ? solverOut.items : d.items;
  // Play/skip/stop badges pinned at each target item's midpoint, shown only when the button is enabled; kept in toolbar order.
  const mediaBadges = [];
  for (const kind of ["play", "skip", "stop"]) {
    const enabled =
      editable && hasItems && running[`${kind}_enabled`];
    const itemId = running[`${kind}_target`];
    if (enabled && itemId != null) {
      mediaBadges.push({ kind, itemId });
    }
  }
  return [
    m(".tab-fixed-header", [
      m(".toolbar-row.toolbar-row-primary", [
        m("h2", title),
        m(".spacer-h"),
        addItemButton({
          disabled: !canAdd,
          onclick: () => addItemToday(vnode, self),
        }),
        iconButton({
          icon: "menu-dots",
          title: "Edit schedule properties",
          disabled: !editable,
          onclick: () => {
            if (!editable) return;
            s.editingProps = true;
          },
        }),
      ]),
      m(".toolbar-row.toolbar-row-secondary", [
        m(".row.row-tight", [
          iconButton({
            icon: "play",
            title: "Play (set start)",
            disabled: !editable || !hasItems || !running.play_enabled,
            onclick: () => doRun(vnode, self, "play"),
          }),
          iconButton({
            icon: "skip",
            title: "Skip (stop + play)",
            disabled: !editable || !hasItems || !running.skip_enabled,
            onclick: () => doRun(vnode, self, "skip"),
          }),
          iconButton({
            icon: "stop",
            title: "Stop (set end)",
            disabled: !editable || !hasItems || !running.stop_enabled,
            onclick: () => doRun(vnode, self, "stop"),
          }),
        ]),
        m(".spacer-h"),
        zoomControls(vnode, !!sched),
        m(".toolbar-sep"),
        undoRedoControls(),
      ]),
    ]),
    scrollPane(vnode,
      sched
        ? renderTimeline(vnode, self, {
            schedule: sched,
            items: renderItems,
            isToday: true,
            nowMin: s.nowMin,
            cursorMin: s.cursorMin,
            mediaBadges,
            onBadge: (kind) => doRun(vnode, self, kind),
            onCursorChange: (next) => setCursor(vnode, next),
            onCursorReset: () => setCursor(vnode, s.nowMin),
            onCursorHide: () => setCursor(vnode, null),
          })
        : renderTodayEmptyState(vnode, self, d.weekday_template)
    ),
    editable && s.editingProps
      ? m(SchedulePropsPopup, {
          schedule: sched,
          items: d.items || [],
          onDelete: () => deleteTodaySchedule(vnode, self),
          onclose: () => closeAfterReload(vnode, self, "editingProps"),
        })
      : null,
    // Two ItemPopup invocations: "placeholder" (Add Item, drives solverOut/insert) and "edit" (existing block, two anchors).
    editable && s.placeholder
      ? m(ItemPopup, {
          mode: "placeholder",
          it: s.placeholder,
          solverOut,
          items: d.items || [],
          schedule: sched,
          focusName: !!s.editingItemFocusName,
          cursorMin: s.cursorMin,
          allowRepositioning: s.allowRepositioning,
          onAllowRepositioningChange: (next) => {
            s.allowRepositioning = next;
            m.redraw();
          },
          onCommit: () => commitPlaceholder(vnode, self),
          onclose: () => closePlaceholder(vnode),
        })
      : editable && s.editingItem
      ? m(ItemPopup, {
          mode: "edit",
          it: s.editingItem,
          // The day endpoint lays out every item, so the popup gets fresh assigned_start/assigned_end without an extra round-trip.
          laidOutItem: (d.items || []).find(
            (x) => x.id === s.editingItem.id
          ),
          items: d.items || [],
          schedule: sched,
          focusName: !!s.editingItemFocusName,
          onclose: () => closeAfterReload(vnode, self, "editingItem"),
        })
      : null,
  ];
}

// Centralised cursorMin setter so the clamp lives in one place. next == null hides the cursor (non-today mode only).
function setCursor(vnode, next) {
  if (next == null) {
    vnode.state.cursorMin = null;
    m.redraw();
    return;
  }
  const s = vnode.state;
  const isToday = vnode.attrs.mode === "today";
  const sched = isToday
    ? s.day && s.day.schedule
    : s.layout && s.layout.schedule;
  if (sched) {
    const eff = effectiveStartFor(sched, isToday, s.nowMin);
    if (next < eff) next = eff;
    if (next > sched.end_min) next = sched.end_min;
  }
  vnode.state.cursorMin = next;
  m.redraw();
}

// Empty state: Create always shown; Fork appears when a weekday template exists for today.
function renderTodayEmptyState(vnode, self, weekdayTemplate) {
  const wdName = weekdayNameForToday();
  return m(
    ".empty-state",
    m("p.empty-state-msg", "No schedule for today"),
    m(".empty-state-actions", [
      m(
        "button.primary",
        { onclick: () => createTodaySchedule(vnode, self) },
        m("span.icon.icon-plus"),
        m("span.label", "Create new schedule")
      ),
      weekdayTemplate
        ? m(
            "button.primary",
            { onclick: () => forkTodayFromTemplate(vnode, self) },
            m("span.icon.icon-plus"),
            m("span.label", `Fork the ${wdName} template`)
          )
        : null,
    ])
  );
}

// Create a blank today schedule (no fork). createOverride is idempotent, so a double-click during reload is safe.
async function createTodaySchedule(vnode, self) {
  const date = vnode.state.day && vnode.state.day.date
    ? vnode.state.day.date
    : todayDateString();
  try {
    await api.createOverride(date);
  } catch (e) {
    console.error("Failed to create schedule:", e);
    return;
  }
  await self.reload(vnode);
}

// forkWeekdayTemplate is idempotent and falls back to a blank create when no template is bound.
async function forkTodayFromTemplate(vnode, self) {
  const date = vnode.state.day && vnode.state.day.date
    ? vnode.state.day.date
    : todayDateString();
  try {
    await api.forkWeekdayTemplate(date);
  } catch (e) {
    console.error("Failed to fork template:", e);
    return;
  }
  await self.reload(vnode);
}

// Editing is gated on editable, so this only fires for date-override schedules; reload then falls back to the empty state.
async function deleteTodaySchedule(vnode, self) {
  const d = vnode.state.day;
  if (!d || !d.schedule) return;
  try {
    await api.deleteSchedule(d.schedule.id);
  } catch (e) {
    console.error("Delete failed:", e);
    return;
  }
  vnode.state.editingProps = false;
  await self.reload(vnode);
  m.redraw();
}

// Monday-based 0..6 weekday frame matching the backend's calendar_weekday_bindings.weekday.
function weekdayMondayBasedFromDate(d) {
  return (d.getDay() + 6) % 7;
}

function weekdayNameForToday() {
  return WEEKDAY_NAMES[weekdayMondayBasedFromDate(new Date())];
}

// Close the popup only after reload completes, else it vanishes one redraw before new data, revealing the pre-commit layout.
function closeAfterReload(vnode, self, key) {
  const reset = () => {
    vnode.state[key] = key === "editingItem" ? null : false;
    if (key === "editingItem") vnode.state.editingItemFocusName = false;
    m.redraw();
  };
  const p = self.reload(vnode);
  if (p && typeof p.then === "function") {
    p.then(reset, reset);
  } else {
    reset();
  }
}

function renderSpecific(vnode, self) {
  const s = vnode.state;
  const a = vnode.attrs;
  const lo = s.layout;
  const sched = lo.schedule;
  const title = sched ? sched.name : prospectiveTitle(a);
  // Add item and the props icon are grayed when no schedule is bound; addItemSpecific also bails defensively.
  const insertCursor = explicitCursorMin(s.cursorMin, s.nowMin);
  const canAdd =
    !!sched && canAddProbe(sched, lo.items || [], insertCursor);
  // Same solver-out plumbing as renderToday — see the comment block
  // there for the placeholder / canAdd / renderItems contract.
  const solverOut = s.placeholder
    ? solveInsertion({
        items: lo.items || [],
        schedule: sched,
        draft: s.placeholder,
        cursorMin: insertCursor,
        allowRepositioning: s.allowRepositioning,
      })
    : null;
  const renderItems =
    solverOut && !solverOut.conflict ? solverOut.items : lo.items;
  return [
    m(".tab-fixed-header", [
      m(".toolbar-row.toolbar-row-primary", [
        m("h2", title),
        m(".spacer-h"),
        addItemButton({
          disabled: !canAdd,
          onclick: () => addItemSpecific(vnode, self),
        }),
        iconButton({
          icon: "menu-dots",
          title: "Edit schedule properties",
          disabled: !sched,
          onclick: () => {
            if (!sched) return;
            s.editingProps = true;
          },
        }),
      ]),
      m(".toolbar-row.toolbar-row-secondary", [
        // Chevrons step weekday Mon→Sun cyclically or date by one calendar day; spacer-h pushes the zoom/undo cluster right.
        a.mode === "weekday"
          ? iconButton({
              icon: "chevron-left",
              title: "Previous weekday",
              onclick: () =>
                m.route.set("/weekday/" + ((a.weekday + 6) % 7)),
            })
          : a.mode === "date"
          ? iconButton({
              icon: "chevron-left",
              title: "Previous day",
              onclick: () =>
                m.route.set("/date/" + shiftDateYmd(a.date, -1)),
            })
          : null,
        a.mode === "weekday"
          ? iconButton({
              icon: "chevron-right",
              title: "Next weekday",
              onclick: () =>
                m.route.set("/weekday/" + ((a.weekday + 1) % 7)),
            })
          : a.mode === "date"
          ? iconButton({
              icon: "chevron-right",
              title: "Next day",
              onclick: () =>
                m.route.set("/date/" + shiftDateYmd(a.date, 1)),
            })
          : null,
        m(
          "button.today-btn",
          { onclick: () => goToToday() },
          "Today"
        ),
        m(".spacer-h"),
        zoomControls(vnode, !!sched),
        m(".toolbar-sep"),
        undoRedoControls(),
      ]),
    ]),
    scrollPane(vnode,
      sched
        ? renderTimeline(vnode, self, {
            schedule: sched,
            items: renderItems,
            isToday: false,
            cursorMin: s.cursorMin,
            onCursorChange: (next) => setCursor(vnode, next),
            onCursorHide: () => setCursor(vnode, null),
          })
        : renderSpecificEmptyState(vnode, self, a)
    ),
    sched && s.editingProps
      ? m(SchedulePropsPopup, {
          schedule: sched,
          items: lo.items || [],
          onDelete: () => deleteSpecificSchedule(vnode, self),
          onclose: () => closeAfterReload(vnode, self, "editingProps"),
        })
      : null,
    // Mirrors renderToday's dual-popup arrangement: placeholder takes
    // precedence over a regular edit so a stale `editingItem` doesn't
    // shadow the Add-Item popup.
    sched && s.placeholder
      ? m(ItemPopup, {
          mode: "placeholder",
          it: s.placeholder,
          solverOut,
          items: lo.items || [],
          schedule: sched,
          focusName: !!s.editingItemFocusName,
          cursorMin: s.cursorMin,
          allowRepositioning: s.allowRepositioning,
          onAllowRepositioningChange: (next) => {
            s.allowRepositioning = next;
            m.redraw();
          },
          onCommit: () => commitPlaceholder(vnode, self),
          onclose: () => closePlaceholder(vnode),
        })
      : sched && s.editingItem
      ? m(ItemPopup, {
          mode: "edit",
          it: s.editingItem,
          laidOutItem: (lo.items || []).find(
            (x) => x.id === s.editingItem.id
          ),
          items: lo.items || [],
          schedule: sched,
          focusName: !!s.editingItemFocusName,
          onclose: () => closeAfterReload(vnode, self, "editingItem"),
        })
      : null,
  ];
}

// "Today" button: pure navigation; lands on the empty state when today has no override or template.
function goToToday() {
  m.route.set("/today");
}

// After deletion the view stays put and its empty state takes over, so we reload rather than routing away.
async function deleteSpecificSchedule(vnode, self) {
  const lo = vnode.state.layout;
  if (!lo || !lo.schedule) return;
  try {
    await api.deleteSchedule(lo.schedule.id);
  } catch (e) {
    console.error("Delete failed:", e);
    return;
  }
  vnode.state.editingProps = false;
  await self.reload(vnode);
  m.redraw();
}

// Local-time YYYY-MM-DD parser: new Date("YYYY-MM-DD") parses as UTC midnight, shifting a day in negative-UTC offsets.
function parseLocalYmdInline(s) {
  const [y, mo, d] = String(s).split("-").map(Number);
  return new Date(y, mo - 1, d);
}

function shiftDateYmd(s, delta) {
  const d = parseLocalYmdInline(s);
  d.setDate(d.getDate() + delta);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function prospectiveTitle(a) {
  if (a.mode === "weekday") return WEEKDAY_NAMES[a.weekday];
  if (a.mode === "date") return a.date;
  return "(unknown)";
}

function undoRedoControls() {
  // Read only this view's history slice so the button states ignore Projects-tab edits.
  const slot = historyState[HISTORY_CONTEXT];
  return m(".row.row-tight", [
    iconButton({
      icon: "undo",
      title: "Undo (Ctrl/Cmd+Z)",
      disabled: !slot.can_undo,
      onclick: () => doUndo(HISTORY_CONTEXT),
    }),
    iconButton({
      icon: "redo",
      title: "Redo (Ctrl/Cmd+Shift+Z)",
      disabled: !slot.can_redo,
      onclick: () => doRedo(HISTORY_CONTEXT),
    }),
  ]);
}

// Zoom out/in. Legal stops are availableSteps(vnode); disabled state depends on the live viewport height (resize listener re-evaluates).
function zoomControls(vnode, enabled) {
  const zoom = vnode.state.zoom;
  const steps = availableSteps(vnode);
  let nextBelow = null;
  let nextAbove = null;
  for (const s of steps) {
    if (s < zoom * (1 - ZOOM_EPS)) {
      if (nextBelow == null || s > nextBelow) nextBelow = s;
    } else if (s > zoom * (1 + ZOOM_EPS)) {
      if (nextAbove == null || s < nextAbove) nextAbove = s;
    }
  }
  return m(".row.row-tight", [
    iconButton({
      icon: "zoom-out",
      title: "Zoom out",
      disabled: !enabled || nextBelow == null,
      onclick: () => changeZoom(vnode, nextBelow),
    }),
    iconButton({
      icon: "zoom-in",
      title: "Zoom in",
      disabled: !enabled || nextAbove == null,
      onclick: () => changeZoom(vnode, nextAbove),
    }),
  ]);
}

// Top of the rendered timeline; in today mode it can precede schedule.start so the live cursor stays visible.
function effectiveStartFor(sched, isToday, nowMin) {
  return isToday && nowMin != null && nowMin < sched.start_min
    ? nowMin
    : sched.start_min;
}

// Pixel height available to the timeline: scroll viewport minus tab-scroll padding and timeline-wrap top padding. 0 when unmeasurable.
function viewableTimelineHeight(scrollEl) {
  if (!scrollEl) return 0;
  const scs = getComputedStyle(scrollEl);
  const padTop = parseFloat(scs.paddingTop) || 0;
  const padBottom = parseFloat(scs.paddingBottom) || 0;
  let wrapPadTop = 0;
  const wrap = scrollEl.querySelector(".timeline-wrap");
  if (wrap) {
    wrapPadTop = parseFloat(getComputedStyle(wrap).paddingTop) || 0;
  }
  return scrollEl.clientHeight - padTop - padBottom - wrapPadTop;
}

// Zoom at which the rendered timeline exactly fills the viewable area; null when unmeasurable (falls back to fixed steps).
function computeFitZoom(vnode) {
  const s = vnode.state;
  if (!s._scrollEl) return null;
  const isToday = vnode.attrs.mode === "today";
  const sched = isToday
    ? s.day && s.day.schedule
    : s.layout && s.layout.schedule;
  if (!sched) return null;
  const start = effectiveStartFor(sched, isToday, s.nowMin);
  const spanMin = sched.end_min - start;
  if (spanMin <= 0) return null;
  const viewableH = viewableTimelineHeight(s._scrollEl);
  if (viewableH <= 0) return null;
  return viewableH / spanMin;
}

// [fitZoom, ...FIXED_STEPS] with steps within FIT_DEDUP_TOLERANCE of fitZoom dropped; falls back to FIXED_STEPS when fitZoom is unmeasurable.
function availableSteps(vnode) {
  const fit = computeFitZoom(vnode);
  if (fit == null) return FIXED_STEPS.slice();
  const filtered = FIXED_STEPS.filter((s) => s > fit * FIT_DEDUP_TOLERANCE);
  return [fit, ...filtered];
}

// Animate zoom and scrollTop together (~250ms) so the viewport-center minute stays pinned; .zooming gates the CSS transition.
function changeZoom(vnode, newZoom) {
  if (newZoom == null || !Number.isFinite(newZoom)) return;
  const s = vnode.state;
  // Clamp at the live floor: stored zoom can sit below it, but a click must never go lower.
  const fit = computeFitZoom(vnode);
  if (fit != null) newZoom = Math.max(newZoom, fit);
  if (Math.abs(newZoom - s.zoom) < 1e-6) return;

  const scroller = s._scrollEl;
  const oldZoom = s.zoom;

  // No scroll container yet (before oncreate): snap without animating; the next paint positions it sensibly.
  if (!scroller) {
    s.zoom = newZoom;
    saveZoom(newZoom);
    return;
  }

  // Minute 0 isn't at scrollTop 0 (padding above the timeline), so pin relative to the timeline's measured offset.
  const timelineEl = scroller.querySelector(".timeline");
  if (!timelineEl) {
    s.zoom = newZoom;
    saveZoom(newZoom);
    return;
  }
  const offsetPx =
    timelineEl.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;

  const oldScrollTop = scroller.scrollTop;
  const viewportH = scroller.clientHeight;
  const centerOld = oldScrollTop + viewportH / 2;
  const centerMinutePx = centerOld - offsetPx;

  s.zoom = newZoom;
  saveZoom(newZoom);
  s.zooming = true;
  if (s._zoomRaf) cancelAnimationFrame(s._zoomRaf);
  m.redraw();

  const duration = 250;
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // Linear matches the CSS linear transition; a non-linear curve would let the center minute drift mid-animation.
    const z = oldZoom + (newZoom - oldZoom) * t;
    const targetScroll =
      offsetPx + (centerMinutePx * z) / oldZoom - viewportH / 2;
    scroller.scrollTop = Math.max(0, targetScroll);
    if (t < 1) {
      s._zoomRaf = requestAnimationFrame(tick);
    } else {
      s._zoomRaf = null;
      s.zooming = false;
      m.redraw();
    }
  };
  s._zoomRaf = requestAnimationFrame(tick);
}

// Capture the scroll container's DOM node via oncreate so the zoom animation can read/write scrollTop; the wrapper is always rendered.
function scrollPane(vnode, children) {
  return m(
    ".tab-scroll",
    {
      oncreate: (vn) => {
        vnode.state._scrollEl = vn.dom;
      },
    },
    children
  );
}

// Trigger always rendered so toolbar layout doesn't shift; disabled (and won't open) when there's nothing to act on.
function menuControl(vnode, opts) {
  const s = vnode.state;
  return m(".menu", [
    m(
      "button.icon-btn",
      {
        title: "Schedule actions",
        disabled: !opts.enabled,
        onclick: () => {
          if (!opts.enabled) return;
          s.menuOpen = !s.menuOpen;
        },
      },
      m("span.icon.icon-menu-dots")
    ),
    s.menuOpen && opts.enabled
      ? m(
          ".menu-items",
          { onclick: () => (s.menuOpen = false) },
          opts.items.map((it) =>
            m("button", { onclick: it.onclick }, it.label)
          )
        )
      : null,
  ]);
}

function iconButton({ icon, title, disabled, onclick, style }) {
  return m(
    "button.icon-btn",
    { title, disabled, onclick, style },
    m("span.icon.icon-" + icon)
  );
}

// disabled is wired through so the empty state can gray the button without omitting the node (which would shift layout).
function addItemButton({ onclick, disabled }) {
  return m(
    "button.primary",
    { onclick, disabled: !!disabled, title: "Add item" },
    m("span.icon.icon-plus"),
    m("span.label", "Add item")
  );
}

// Compact span like "1h 50m" / "1h" / "50m" for the inline range display; floors at "0m".
function fmtRange(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const mm = total % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (mm > 0 || h === 0) parts.push(`${mm}m`);
  return parts.join(" ");
}

function renderTimeline(vnode, self, opts) {
  // Drag previews override the rendered items/schedule; edge drags can auto-expand the schedule, so use the preview's schedule when present.
  const previewState = vnode.state.dragPreview;
  const ds = vnode.state.dragSession;
  const sched =
    previewState && previewState.schedule
      ? previewState.schedule
      : opts.schedule;
  const baseItems = opts.items; // laid-out items from the backend
  const items = previewState ? previewState.layout : baseItems;
  const rawItems = previewState ? previewState.rawItems : baseItemsAsRaw(baseItems);

  // Zoom is a px/min multiplier directly: at zoom == 1× the map is 1:1, so pxPerMin === zoom.
  const pxPerMin = vnode.state.zoom;
  // In today mode when now precedes the schedule start, extend the timeline back to now so the live cursor shows.
  const effectiveStart = effectiveStartFor(sched, opts.isToday, opts.nowMin);
  const totalMin = sched.end_min - effectiveStart;
  const height = totalMin * pxPerMin;

  // During a reorder we render the dragged item twice: a dashed placeholder at its reserved slot and a cursor-pinned ghost.
  const draggedId =
    ds && ds.mode === "reorder" && previewState ? ds.draggedId : null;

  const blockChildren = (raw, it) => {
    const { name, desc } = blockNameAndDesc(raw);
    // Append an ellipsis for multi-line descriptions so hidden text is obvious; single-line overflow is handled by CSS text-overflow.
    const hasMultiLineDesc = !!(desc && desc.includes("\n"));
    const firstLineDesc = desc ? desc.split("\n")[0] : "";
    const inlineDesc = desc
      ? hasMultiLineDesc
        ? firstLineDesc + "\u2026"
        : firstLineDesc
      : "";
    return [
      m(".block-header", [
        m(".block-name", name),
        desc ? m(".block-inline-desc", inlineDesc) : null,
        m(
          ".block-times",
          `${fmtClock(it.assigned_start)} \u2013 ${fmtClock(it.assigned_end)} (${fmtRange(
            it.assigned_end - it.assigned_start
          )})`
        ),
      ]),
      desc ? m(".block-desc", desc) : null,
    ];
  };

  const blocks = items.map((it, idx) => {
    const raw = rawItems[idx];
    const isDragged = it.id === draggedId;
    // Both the reorder drag-target slot and the Add-Item draft get .placeholder; neither is draggable.
    const isPlaceholderBlock = !!raw && raw._placeholder;
    const isSlotPlaceholder = isDragged || isPlaceholderBlock;
    const cls =
      ".timeline-block" +
      (isSlotPlaceholder ? ".placeholder" : "") +
      fixednessClasses(raw);
    return m(
      cls,
      {
        key: it.id,
        style: blockStyle(it, effectiveStart, pxPerMin, raw),
        onpointerdown:
          isDragged || isPlaceholderBlock
            ? null
            : (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                startDrag(vnode, self, {
                  event: e,
                  schedule: sched,
                  effectiveStart,
                  items: rawItems,
                  laidOut: items,
                  pxPerMin,
                  draggedIdx: idx,
                  element: e.currentTarget,
                });
              },
      },
      blockChildren(raw, it)
    );
  });

  let ghost = null;
  if (draggedId != null) {
    const ghostIdx = rawItems.findIndex((r) => r.id === draggedId);
    if (ghostIdx >= 0) {
      const raw = rawItems[ghostIdx];
      const it = items[ghostIdx];
      const topPx = previewState.ghostTopPx;
      // Ghost/placeholder keep pre-drag height for fully-fixed items; dynamic items take height from the post-reorder layout.
      const heightPx = ds.grabbedFullyFixed
        ? ds.originalHeightPx
        : Math.max(1, (it.assigned_end - it.assigned_start) * pxPerMin);
      const ghostHex = paletteColor(resolveBlockColorKey(raw));
      ghost = m(
        ".timeline-block.dragging" + fixednessClasses(raw),
        {
          style: `top:${topPx}px;height:${heightPx}px;--block-color:${ghostHex}`,
        },
        blockChildren(raw, it)
      );
    }
  }

  const hourLines = [];
  const firstHour = Math.ceil(effectiveStart / 60);
  const lastHour = Math.floor(sched.end_min / 60);
  for (let h = firstHour; h <= lastHour; h++) {
    const min = h * 60;
    const top = (min - effectiveStart) * pxPerMin;
    hourLines.push(
      m(
        ".hour-line",
        { style: `top:${top}px` },
        m("span.hour-label", fmtClock(min))
      )
    );
  }
  // Pass nowMin only in today mode so TimeCursor can recognise "live" (red) vs detached/specific (neutral) without checking attrs.mode.
  const cursorVisible =
    opts.cursorMin != null &&
    opts.cursorMin >= effectiveStart &&
    opts.cursorMin <= sched.end_min;
  const cursorEl = cursorVisible
    ? m(TimeCursor, {
        cursorMin: opts.cursorMin,
        nowMin: opts.isToday ? opts.nowMin : null,
        effectiveStart,
        schedule: sched,
        pxPerMin,
        items,
        onChange: opts.onCursorChange,
        onReset: opts.onCursorReset,
        onHide: opts.onCursorHide,
      })
    : null;
  // Group enabled play/skip/stop badges by target item, pinned at each item's midpoint; matching by id tracks live geometry.
  const mediaBadgeEls = [];
  if (opts.mediaBadges && opts.mediaBadges.length) {
    const byItem = new Map();
    for (const badge of opts.mediaBadges) {
      if (!byItem.has(badge.itemId)) byItem.set(badge.itemId, []);
      byItem.get(badge.itemId).push(badge.kind);
    }
    for (const [itemId, kinds] of byItem) {
      const it = items.find((x) => x.id === itemId);
      if (!it) continue;
      const midMin = (it.assigned_start + it.assigned_end) / 2;
      const top = (midMin - effectiveStart) * pxPerMin;
      mediaBadgeEls.push(
        m(
          ".media-badges",
          { key: `mb-${itemId}`, style: `top:${top}px` },
          kinds.map((kind) =>
            m(
              "button.media-badge",
              {
                title: `${kind[0].toUpperCase()}${kind.slice(1)} this item`,
                // Stop bubbling to the timeline-wrap handler, which would otherwise reposition the cursor.
                onpointerdown: (e) => e.stopPropagation(),
                onclick: (e) => {
                  e.stopPropagation();
                  if (opts.onBadge) opts.onBadge(kind);
                },
              },
              m("span.icon.icon-" + kind)
            )
          )
        )
      );
    }
  }

  // Marker lines at the schedule's start/end, visible even when the timeline extends past them (early today clock or drag-expansion).
  const boundHandle = (edge) =>
    m(".bound-handle", {
      title: `Drag to move schedule ${edge}`,
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Stale eligibility could otherwise let the post-drag click reposition the cursor.
        vnode.state._cursorClickEligible = false;
        startBoundDrag(vnode, self, {
          event: e,
          edge,
          schedule: sched,
          effectiveStart,
          items: rawItems,
          pxPerMin,
        });
      },
    });
  const startBound = m(
    ".schedule-bound.start",
    {
      style: `top:${(sched.start_min - effectiveStart) * pxPerMin}px`,
    },
    m("span.label", "start"),
    boundHandle("start")
  );
  const endBound = m(
    ".schedule-bound.end",
    {
      style: `top:${(sched.end_min - effectiveStart) * pxPerMin}px`,
    },
    m("span.label", "end"),
    boundHandle("end")
  );

  return m(
    ".timeline-wrap",
    {
      ontouchstart: (e) => {
        if (e.touches.length === 2) handlePinchStart(vnode, e);
      },
      ontouchmove: (e) => {
        if (vnode.state.pinch) handlePinchMove(vnode, e);
      },
      ontouchend: (e) => {
        if (vnode.state.pinch && e.touches.length < 2) handlePinchEnd(vnode);
      },
      // Empty-area clicks reposition the cursor; gate on the pointerdown target so a drag ending on empty space isn't mistaken.
      onpointerdown: (e) => {
        vnode.state._cursorClickEligible =
          !e.target.closest(".timeline-block") &&
          !e.target.closest(".time-cursor");
      },
      onclick: (e) => {
        if (!opts.onCursorChange) return;
        const eligible = vnode.state._cursorClickEligible;
        vnode.state._cursorClickEligible = false;
        if (!eligible) return;
        // Defensive: a missed propagation stop would land here with a block/cursor ancestor; skip — the click was meant for it.
        if (e.target.closest(".timeline-block")) return;
        if (e.target.closest(".time-cursor")) return;
        const timelineEl = e.currentTarget.querySelector(".timeline");
        if (!timelineEl) return;
        const rect = timelineEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const min = Math.round(y / pxPerMin) + effectiveStart;
        opts.onCursorChange(min);
      },
    },
    m(
      ".timeline" + (vnode.state.zooming ? ".zooming" : ""),
      { style: `height:${height}px` },
      startBound,
      endBound,
      hourLines,
      blocks,
      mediaBadgeEls,
      ghost,
      cursorEl
    )
  );
}

// Convert backend-laid-out items into the raw-row shape expected by computeLayout.
function baseItemsAsRaw(items) {
  return items.map((it) => ({
    id: it.id,
    position: it.position,
    start_min: it.start_min,
    end_min: it.end_min,
    duration_target: it.duration_target,
    use_inline: it.use_inline,
    inline_label: it.inline_label,
    inline_description: it.inline_description,
    color: it.color,
    project_id: it.project_id,
    project_rank: it.project_rank,
    task_id: it.task_id,
    task_rank: it.task_rank,
    payload: it.payload,
    // Preserve the placeholder sentinel so the renderer tags the draft and skips drag handlers; real rows lack this field.
    _placeholder: it._placeholder,
  }));
}

// ===========================================================================
// Drag interactions
// ===========================================================================

function startDrag(vnode, self, opts) {
  const { event, schedule, effectiveStart, items, laidOut, pxPerMin, draggedIdx, element } = opts;
  const raw = items[draggedIdx];
  const slot = laidOut[draggedIdx];
  const rect = element.getBoundingClientRect();
  const clickY = event.clientY;
  const clickRelative = clickY - rect.top; // px from top of block

  // Edge slide zone: capped at 24px, 40% of height; only on fixed sides. Middle clicks are always reorder.
  const edgeZone = Math.min(24, rect.height * 0.4);
  const distTop = clickRelative;
  const distBottom = rect.height - clickRelative;
  const hasFixedStart = raw.start_min != null;
  const hasFixedEnd = raw.end_min != null;
  let mode = "reorder";
  if (hasFixedStart && hasFixedEnd) {
    if (distTop <= edgeZone || distBottom <= edgeZone) {
      mode = distTop < distBottom ? "edge_start" : "edge_end";
    }
  } else if (hasFixedStart) {
    if (distTop <= edgeZone) mode = "edge_start";
  } else if (hasFixedEnd) {
    if (distBottom <= edgeZone) mode = "edge_end";
  }

  // Capture pre-drag sizes; reorder treats every item's size as static for the whole gesture, looked up by id.
  const sizesById = new Map();
  for (let k = 0; k < items.length; k++) {
    sizesById.set(
      items[k].id,
      Math.max(1, laidOut[k].assigned_end - laidOut[k].assigned_start)
    );
  }

  vnode.state.dragSession = {
    mode,
    startY: clickY,
    moved: false,
    schedule,
    // Use the same effectiveStart origin as renderTimeline so the ghost and placeholder line up with the rendered blocks.
    effectiveStart: effectiveStart != null ? effectiveStart : schedule.start_min,
    rawItems: items,
    laidOut,
    pxPerMin,
    draggedId: raw.id,
    draggedIdxOriginal: draggedIdx,
    originalStartMin: raw.start_min,
    originalEndMin: raw.end_min,
    originalPosition: raw.position,
    // Dragged block top (timeline-local px) at drag start; ghostTop = originalTop + deltaY.
    originalTopPx:
      (slot.assigned_start -
        (effectiveStart != null ? effectiveStart : schedule.start_min)) *
      pxPerMin,
    originalHeightPx: Math.max(
      1,
      (slot.assigned_end - slot.assigned_start) * pxPerMin
    ),
    sizesById,
    clickRelativePx: clickRelative,
    pointerId: event.pointerId,
    // Fully-fixed grabbed items keep their pre-drag ghost/placeholder size; dynamic items relax to fit the post-reorder layout.
    grabbedFullyFixed: raw.start_min != null && raw.end_min != null,
  };

  const moveHandler = (e) => onDragMove(vnode, self, e);
  const upHandler = (e) => onDragEnd(vnode, self, e);
  // Escape cancels the gesture and reverts to the pre-drag state.
  const keyHandler = (e) => {
    if (e.key === "Escape") cancelDrag(vnode);
  };
  vnode.state.dragSession._moveHandler = moveHandler;
  vnode.state.dragSession._upHandler = upHandler;
  vnode.state.dragSession._keyHandler = keyHandler;
  document.addEventListener("pointermove", moveHandler);
  document.addEventListener("pointerup", upHandler);
  document.addEventListener("pointercancel", upHandler);
  document.addEventListener("keydown", keyHandler);
  // No pointer capture: listeners are on document, and capturing a DOM-reordered element can fire pointercancel mid-gesture.
}

// Slide the schedule start/end via the bound-line handles; reuses the shared drag move/up/key handlers.
function startBoundDrag(vnode, self, opts) {
  const { event, edge, schedule, effectiveStart, items, pxPerMin } = opts;
  vnode.state.dragSession = {
    mode: edge === "start" ? "schedule_start" : "schedule_end",
    startY: event.clientY,
    moved: false,
    schedule,
    effectiveStart: effectiveStart != null ? effectiveStart : schedule.start_min,
    rawItems: items,
    pxPerMin,
    originalStartMin: schedule.start_min,
    originalEndMin: schedule.end_min,
    pointerId: event.pointerId,
  };
  const moveHandler = (e) => onDragMove(vnode, self, e);
  const upHandler = (e) => onDragEnd(vnode, self, e);
  const keyHandler = (e) => {
    if (e.key === "Escape") cancelDrag(vnode);
  };
  vnode.state.dragSession._moveHandler = moveHandler;
  vnode.state.dragSession._upHandler = upHandler;
  vnode.state.dragSession._keyHandler = keyHandler;
  document.addEventListener("pointermove", moveHandler);
  document.addEventListener("pointerup", upHandler);
  document.addEventListener("pointercancel", upHandler);
  document.addEventListener("keydown", keyHandler);
}

function pointerInside(el, event) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = event.clientX;
  const y = event.clientY;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function cancelDrag(vnode) {
  const ds = vnode.state.dragSession;
  if (!ds) return;
  document.removeEventListener("pointermove", ds._moveHandler);
  document.removeEventListener("pointerup", ds._upHandler);
  document.removeEventListener("pointercancel", ds._upHandler);
  if (ds._keyHandler) document.removeEventListener("keydown", ds._keyHandler);
  vnode.state.dragSession = null;
  vnode.state.dragPreview = null;
  m.redraw();
}

// One-shot capture-phase click swallow defusing the touchscreen "ghost click" after pointerup, which would otherwise close the just-opened popup.
function suppressNextClick() {
  const swallow = (e) => {
    cleanup();
    e.stopPropagation();
    e.preventDefault();
  };
  const cleanup = () => {
    window.removeEventListener("click", swallow, true);
    clearTimeout(t);
  };
  window.addEventListener("click", swallow, true);
  // Long enough to cover the compat-click delay, short enough not to affect the next real click.
  const t = setTimeout(cleanup, 400);
}

// Movement before a pointerdown becomes a drag; small enough to feel responsive, large enough to ignore click jitter.
const DRAG_THRESHOLD_PX = 4;

function onDragMove(vnode, self, event) {
  const ds = vnode.state.dragSession;
  if (!ds) return;
  const deltaY = event.clientY - ds.startY;
  if (!ds.moved) {
    if (Math.abs(deltaY) <= DRAG_THRESHOLD_PX) return;
    ds.moved = true;
  }
  if (ds.mode === "reorder") {
    applyReorderPreview(vnode, deltaY);
  } else if (ds.mode === "edge_start") {
    applyEdgePreview(vnode, "start", Math.round(deltaY / ds.pxPerMin));
  } else if (ds.mode === "edge_end") {
    applyEdgePreview(vnode, "end", Math.round(deltaY / ds.pxPerMin));
  } else if (ds.mode === "schedule_start") {
    applyBoundPreview(vnode, "start", Math.round(deltaY / ds.pxPerMin));
  } else if (ds.mode === "schedule_end") {
    applyBoundPreview(vnode, "end", Math.round(deltaY / ds.pxPerMin));
  }
  m.redraw();
}

function applyReorderPreview(vnode, deltaY) {
  const ds = vnode.state.dragSession;
  // Ghost top = originalTop + deltaY, loosely clamped so it can reach boundary slots but won't fly off-screen.
  const totalHeightPx =
    (ds.schedule.end_min - ds.effectiveStart) * ds.pxPerMin;
  const rawTopPx = ds.originalTopPx + deltaY;
  const ghostTopPx = Math.max(
    -ds.originalHeightPx / 2,
    Math.min(totalHeightPx - ds.originalHeightPx / 2, rawTopPx)
  );

  // Convert ghost px→minutes using the ORIGINAL size, giving the leading edge a stable value despite any dynamic-ghost resize.
  const ghostTopMin = rawTopPx / ds.pxPerMin + ds.effectiveStart;
  const ghostBottomMin =
    (rawTopPx + ds.originalHeightPx) / ds.pxPerMin + ds.effectiveStart;

  // Direction of travel = sign of cumulative deltaY; zero falls through to "no reorder".
  const dirSign = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0;

  const result = computeReorderPreview({
    schedule: ds.schedule,
    items: ds.rawItems,
    laidOut: ds.laidOut,
    draggedId: ds.draggedId,
    ghostTopMin,
    ghostBottomMin,
    dirSign,
  });

  // Merge the recomputed layout with each raw row so the renderer has both assigned times and paint fields.
  const layoutItems = result.layout.items.map((li, k) =>
    Object.assign({}, result.reorderedRawItems[k], li)
  );

  vnode.state.dragPreview = {
    mode: "reorder",
    rawItems: result.reorderedRawItems,
    layout: layoutItems,
    newDraggedIdx: result.newDraggedIdx,
    newAfterId: result.newAfterId,
    anchorUpdates: result.anchorUpdates,
    schedule: result.scheduleEffective,
    ghostTopPx,
    allowed: result.allowed,
    hasReorder: result.hasReorder,
  };
}

function applyEdgePreview(vnode, edge, deltaMin) {
  const ds = vnode.state.dragSession;
  const items = ds.rawItems.map((it) => Object.assign({}, it));
  const idx = items.findIndex((r) => r.id === ds.draggedId);
  if (idx < 0) return;
  const it = items[idx];
  if (edge === "start") {
    let newStart = ds.originalStartMin + deltaMin;
    newStart = clampEdge(newStart, ds.schedule, items, idx, "start");
    it.start_min = newStart;
  } else {
    let newEnd = ds.originalEndMin + deltaMin;
    newEnd = clampEdge(newEnd, ds.schedule, items, idx, "end");
    it.end_min = newEnd;
  }
  // Mirror the backend's auto-expand: widen the preview schedule when an anchor falls outside it. The real update happens server-side.
  const previewSchedule = Object.assign({}, ds.schedule);
  if (it.start_min != null) {
    if (it.start_min < previewSchedule.start_min)
      previewSchedule.start_min = it.start_min;
    if (it.start_min > previewSchedule.end_min)
      previewSchedule.end_min = it.start_min;
  }
  if (it.end_min != null) {
    if (it.end_min > previewSchedule.end_min)
      previewSchedule.end_min = it.end_min;
    if (it.end_min < previewSchedule.start_min)
      previewSchedule.start_min = it.end_min;
  }
  const layout = computeLayout(previewSchedule, items);
  // clampEdge already reserves MIN_DURATION, so these errors are rare; reject any segment-level error, keeping the last valid preview.
  if (layout.items.some((li) => li.flags.below_min)) return;
  if (
    layout.errors.includes("BelowMinDuration") ||
    layout.errors.includes("OverflowSegment")
  )
    return;
  vnode.state.dragPreview = {
    mode: edge === "start" ? "edge_start" : "edge_end",
    rawItems: items,
    layout: layout.items.map((li, k) =>
      Object.assign({}, items[k], li)
    ),
    schedule: previewSchedule,
    edge,
    newValue: edge === "start" ? it.start_min : it.end_min,
  };
}

// Slide a schedule bound: clamp so no dynamic item hits zero duration and no fixed edge is crossed, then re-layout for the live preview.
function applyBoundPreview(vnode, edge, deltaMin) {
  const ds = vnode.state.dragSession;
  const items = ds.rawItems;
  const previewSchedule = Object.assign({}, ds.schedule);
  if (edge === "start") {
    previewSchedule.start_min = clampScheduleStart(
      ds.originalStartMin + deltaMin,
      ds.schedule,
      items
    );
  } else {
    previewSchedule.end_min = clampScheduleEnd(
      ds.originalEndMin + deltaMin,
      ds.schedule,
      items
    );
  }
  const layout = computeLayout(previewSchedule, items);
  // clampSchedule* already reserves MIN_DURATION; reject any residual segment error, keeping the last valid preview.
  if (layout.items.some((li) => li.flags.below_min)) return;
  if (
    layout.errors.includes("BelowMinDuration") ||
    layout.errors.includes("OverflowSegment")
  )
    return;
  vnode.state.dragPreview = {
    mode: edge === "start" ? "schedule_start" : "schedule_end",
    rawItems: items,
    layout: layout.items.map((li, k) => Object.assign({}, items[k], li)),
    schedule: previewSchedule,
    edge,
    newValue:
      edge === "start" ? previewSchedule.start_min : previewSchedule.end_min,
  };
}

// Clamp schedule.start_min so the layout stays solvable (reserving MIN_DURATION per preceding dynamic item); returns the original value if bounds cross.
function clampScheduleStart(value, schedule, items) {
  let firstAnchor = null;
  let dynamicBefore = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.start_min != null) {
      firstAnchor = it.start_min;
      break;
    }
    if (it.end_min != null) {
      // Fixed-end anchor: the item lives in the segment ending at its end_min, consuming one MIN_DURATION slice.
      firstAnchor = it.end_min;
      dynamicBefore++;
      break;
    }
    dynamicBefore++;
  }
  let hi;
  if (firstAnchor != null) {
    hi = firstAnchor - dynamicBefore * MIN_DURATION;
  } else if (items.length > 0) {
    // No fixed anchors anywhere: all items share the schedule window.
    hi = schedule.end_min - items.length * MIN_DURATION;
  } else {
    hi = schedule.end_min - 1;
  }
  // schedule.start_min must satisfy the SQLite CHECKs: [0, 1439], strictly less than end_min, 24h max span.
  hi = Math.min(hi, schedule.end_min - 1, 1439);
  const lo = Math.max(0, schedule.end_min - 1440);
  if (lo > hi) return value;
  return Math.max(lo, Math.min(hi, value));
}

// Mirror of `clampScheduleStart` for the trailing schedule edge.
function clampScheduleEnd(value, schedule, items) {
  let lastAnchor = null;
  let dynamicAfter = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.end_min != null) {
      lastAnchor = it.end_min;
      break;
    }
    if (it.start_min != null) {
      lastAnchor = it.start_min;
      dynamicAfter++;
      break;
    }
    dynamicAfter++;
  }
  let lo;
  if (lastAnchor != null) {
    lo = lastAnchor + dynamicAfter * MIN_DURATION;
  } else if (items.length > 0) {
    lo = schedule.start_min + items.length * MIN_DURATION;
  } else {
    lo = schedule.start_min + 1;
  }
  lo = Math.max(lo, schedule.start_min + 1);
  // end_min <= start_min + 1440 per the SQLite CHECK.
  const hi = schedule.start_min + 1440;
  if (lo > hi) return value;
  return Math.max(lo, Math.min(hi, value));
}

// clampEdge wrapper that finds the item by id; popups have the id but not the index.
function clampItemEdge(value, schedule, items, itemId, edge) {
  const idx = items.findIndex((x) => x.id === itemId);
  if (idx < 0) return value;
  return clampEdge(value, schedule, items, idx, edge);
}

function clampEdge(value, schedule, items, idx, edge) {
  // Reserve MIN_DURATION per intervening dynamic item; when a segment reaches the schedule edge, allow pulling to the 24h-span limit.
  let leftAnchor = schedule.start_min;
  let leftHasNeighbor = false;
  let leftSquash = 0;
  for (let k = idx - 1; k >= 0; k--) {
    const o = items[k];
    if (o.end_min != null) {
      leftAnchor = o.end_min;
      leftHasNeighbor = true;
      break;
    }
    if (o.start_min != null) {
      leftAnchor = o.start_min;
      leftHasNeighbor = true;
      break;
    }
    leftSquash++;
  }
  let rightAnchor = schedule.end_min;
  let rightHasNeighbor = false;
  let rightSquash = 0;
  for (let k = idx + 1; k < items.length; k++) {
    const o = items[k];
    if (o.start_min != null) {
      rightAnchor = o.start_min;
      rightHasNeighbor = true;
      break;
    }
    if (o.end_min != null) {
      rightAnchor = o.end_min;
      rightHasNeighbor = true;
      break;
    }
    rightSquash++;
  }
  // Push the bound outward when the segment is open at the schedule edge; the backend expands to absorb it.
  if (!leftHasNeighbor) leftAnchor = Math.max(0, schedule.end_min - 1440);
  if (!rightHasNeighbor) rightAnchor = schedule.start_min + 1440;

  const it = items[idx];
  let lo;
  let hi;
  if (edge === "start") {
    // Items left of idx in the segment each need MIN_DURATION between leftAnchor and the new start_min.
    lo = leftAnchor + leftSquash * MIN_DURATION;
    if (it.end_min != null) {
      // idx has a fixed end, so the right segment is unaffected — only idx needs MIN.
      hi = it.end_min - MIN_DURATION;
    } else {
      // idx is dynamic-end, so idx + rightSquash items form one segment ending at rightAnchor. Reserve MIN per item, including idx.
      hi = rightAnchor - (rightSquash + 1) * MIN_DURATION;
    }
  } else {
    if (it.start_min != null) {
      lo = it.start_min + MIN_DURATION;
    } else {
      lo = leftAnchor + (leftSquash + 1) * MIN_DURATION;
    }
    hi = rightAnchor - rightSquash * MIN_DURATION;
  }
  // Defensive: if bounds crossed, leave the edge unchanged; the caller keeps the previous valid preview.
  if (lo > hi) return value;
  return Math.max(lo, Math.min(hi, value));
}

async function onDragEnd(vnode, self, event) {
  const ds = vnode.state.dragSession;
  if (!ds) return;
  document.removeEventListener("pointermove", ds._moveHandler);
  document.removeEventListener("pointerup", ds._upHandler);
  document.removeEventListener("pointercancel", ds._upHandler);
  if (ds._keyHandler) document.removeEventListener("keydown", ds._keyHandler);
  const preview = vnode.state.dragPreview;
  vnode.state.dragSession = null;

  const isBoundDrag =
    ds.mode === "schedule_start" || ds.mode === "schedule_end";
  if (!ds.moved) {
    // treat as a click
    vnode.state.dragPreview = null;
    // Bound handles have no underlying item to open; a tap is a no-op.
    if (!isBoundDrag) {
      // The popup loads the full row itself, so we only need to identify which item to open.
      vnode.state.editingItem = {
        id: ds.draggedId,
        schedule_id: ds.schedule.id,
      };
      // Touch fires a synthesized compat click after pointerup that would close the just-mounted popup; swallow one click to prevent it.
      suppressNextClick();
    }
    m.redraw();
    return;
  }

  // Releasing outside the timeline (approximated by the scroll pane) cancels the gesture; pointercancel is treated the same.
  // Bound drags are exempt from the spatial check: dragging past the viewport edge is how you extend the schedule, and the value is already clamped.
  let releasedOutside = false;
  if (event && event.type === "pointercancel") {
    releasedOutside = true;
  } else if (!isBoundDrag && event && vnode.state._scrollEl) {
    releasedOutside = !pointerInside(vnode.state._scrollEl, event);
  }
  if (releasedOutside) {
    vnode.state.dragPreview = null;
    m.redraw();
    return;
  }

  // Commit by stable id rather than an index that may have shifted during the gesture.
  try {
    if (ds.mode === "reorder" && preview) {
      if (preview.allowed && preview.hasReorder) {
        // Send the changed anchors as anchor_updates alongside the position change so the backend applies them atomically.
        await api.reorderItem(
          ds.draggedId,
          preview.newAfterId,
          preview.anchorUpdates
        );
      }
      // !preview.allowed (dynamic in a fully-fixed slot) and !preview.hasReorder (no midpoint crossed) are both no-ops.
    } else if (ds.mode === "edge_start" && preview) {
      await api.patchItem(ds.draggedId, { start_min: preview.newValue });
    } else if (ds.mode === "edge_end" && preview) {
      await api.patchItem(ds.draggedId, { end_min: preview.newValue });
    } else if (ds.mode === "schedule_start" && preview) {
      await api.patchSchedule(ds.schedule.id, { start_min: preview.newValue });
    } else if (ds.mode === "schedule_end" && preview) {
      await api.patchSchedule(ds.schedule.id, { end_min: preview.newValue });
    }
  } catch (err) {
    console.error("drag commit failed:", err);
  }
  // Keep the drag preview until the refetched layout lands, else a one-frame window paints the pre-drag ordering.
  const p = self.reload(vnode);
  const reset = () => {
    vnode.state.dragPreview = null;
    m.redraw();
  };
  if (p && typeof p.then === "function") p.then(reset, reset);
  else reset();
}

// Pinch tracks finger distance (clamped to the fit floor and a soft max); release snaps to the nearest availableSteps entry.
function handlePinchStart(vnode, e) {
  const [a, b] = e.touches;
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  vnode.state.pinch = {
    startDist: dist,
    startZoom: vnode.state.zoom,
  };
}

function handlePinchMove(vnode, e) {
  if (e.touches.length < 2) return;
  const pinch = vnode.state.pinch;
  if (!pinch) return;
  const [a, b] = e.touches;
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const ratio = dist / pinch.startDist;
  let live = pinch.startZoom * ratio;
  const fit = computeFitZoom(vnode);
  if (fit != null) live = Math.max(fit, live);
  const max = FIXED_STEPS[FIXED_STEPS.length - 1] * 1.2;
  live = Math.min(max, live);
  if (Math.abs(live - vnode.state.zoom) > 1e-6) {
    vnode.state.zoom = live;
    m.redraw();
  }
}

function handlePinchEnd(vnode) {
  const steps = availableSteps(vnode);
  const z = vnode.state.zoom;
  let best = steps[0];
  let bestDist = Math.abs(steps[0] - z);
  for (let i = 1; i < steps.length; i++) {
    const d = Math.abs(steps[i] - z);
    if (d < bestDist) {
      bestDist = d;
      best = steps[i];
    }
  }
  const fit = computeFitZoom(vnode);
  if (fit != null && best < fit) best = fit;
  vnode.state.zoom = best;
  saveZoom(best);
  vnode.state.pinch = null;
  m.redraw();
}

function blockStyle(it, scheduleStart, pxPerMin, raw) {
  const top = (it.assigned_start - scheduleStart) * pxPerMin;
  const h = Math.max(1, (it.assigned_end - it.assigned_start) * pxPerMin);
  const hex = paletteColor(resolveBlockColorKey(raw));
  // --block-color drives the block's color treatment in style.css; one inline string serves placeholder, real block, and ghost.
  return `top:${top}px;height:${h}px;--block-color:${hex}`;
}

// Palette key for a block: project items take the project's color, inline items their own; reads the resolved payload.
function resolveBlockColorKey(raw) {
  const p = raw.payload;
  if (p) {
    if (p.kind === "task" && p.color) return p.color;
    if (p.kind === "empty") {
      if (p.project_color) return p.project_color;
      return raw.color || DEFAULT_ITEM_COLOR;
    }
  }
  return raw.color || DEFAULT_ITEM_COLOR;
}

// Selector suffix encoding which ends are fixed; style.css paints a gradient based on these classes.
function fixednessClasses(raw) {
  return (
    (raw.start_min != null ? ".start-fixed" : "") +
    (raw.end_min != null ? ".end-fixed" : "")
  );
}

// Resolve name/description from the row's payload (kind inline/task/empty); the no-payload branch only fires for drag-preview locals.
function blockNameAndDesc(raw) {
  const p = raw.payload;
  if (p && p.kind === "inline") {
    return {
      name: p.label || "(no label)",
      desc: p.description || null,
    };
  }
  if (p && p.kind === "task") {
    return {
      name: projectColonTaskName(
        p.project_name || "(unnamed project)",
        p.task_name || "(unnamed task)"
      ),
      desc: p.task_description || null,
    };
  }
  if (p && p.kind === "empty") {
    if (p.project_name) {
      // A project with no subtasks isn't "missing a rank" — render just the bold name. project_has_tasks counts any state.
      if (p.project_has_tasks === false) {
        return { name: m("strong", p.project_name), desc: null };
      }
      return {
        name: projectColonTaskName(p.project_name, "(no subtask at this rank)"),
        desc: null,
      };
    }
    return { name: "(no project at this rank)", desc: null };
  }
  // No payload (drag-preview local): render inline_label directly.
  return {
    name: raw.inline_label || "(no label)",
    desc: raw.inline_description || null,
  };
}

// Render project/colon/tail as separate elements so narrow-viewport CSS can stack them and hide the colon.
function projectColonTaskName(projectName, tail) {
  return [
    m("strong.block-name-project", projectName),
    m("span.block-name-sep", ": "),
    m("span.block-name-tail", tail),
  ];
}

function rawItemFrom(it) {
  // DayView items lack inline_label as top-level fields; mark with a sentinel so the popup fetches the canonical row.
  if (it.inline_label !== undefined) {
    return it;
  }
  return { _needsFetch: true, id: it.id, schedule_id: it.schedule_id };
}

// --- adders ---

async function doRun(vnode, self, kind) {
  const fn = kind === "play" ? api.todayPlay : kind === "stop" ? api.todayStop : api.todaySkip;
  // Always send the cursor minute: the server clock has no timezone and would act at the wrong minute.
  const s = vnode.state;
  const atMin = s.cursorMin != null ? s.cursorMin : s.nowMin;
  try {
    const updated = await fn(atMin);
    vnode.state.day = updated;
    m.redraw();
  } catch (e) {
    console.error("Schedule action failed:", e);
    self.reload(vnode);
  }
}

// Open the popup against a fresh placeholder draft; the view splices it via solveInsertion each render, commit POSTs insertItemAtomic.
function addItemToday(vnode, _self) {
  // The toolbar button is grayed without an editable override, so this runs only then; bail defensively otherwise.
  const day = vnode.state.day;
  if (!day || !day.schedule || day.source !== "date_override") {
    return;
  }
  openPlaceholder(vnode, day.schedule.id);
}

function addItemSpecific(vnode, _self) {
  // The toolbar button is grayed when no schedule is bound; bail defensively if a click lands here anyway.
  const lo = vnode.state.layout;
  if (!lo || !lo.schedule) return;
  openPlaceholder(vnode, lo.schedule.id);
}

// Shared Add-Item entry point; reset allowRepositioning to true each open so a previous session's state doesn't leak.
function openPlaceholder(vnode, scheduleId) {
  vnode.state.placeholder = makePlaceholderDraft(scheduleId, vnode.state.cursorMin);
  vnode.state.editingItemFocusName = true;
  vnode.state.allowRepositioning = true;
  m.redraw();
}

// Close without committing: drop the placeholder; no API call, so the timeline just re-renders without it.
function closePlaceholder(vnode) {
  vnode.state.placeholder = null;
  vnode.state.editingItemFocusName = false;
  m.redraw();
}

// Commit the placeholder via atomic insert, rerunning the solver so the body matches the last preview; cleared after reload.
async function commitPlaceholder(vnode, self) {
  const s = vnode.state;
  if (!s.placeholder) return;
  const isToday = vnode.attrs.mode === "today";
  const sched = isToday
    ? s.day && s.day.schedule
    : s.layout && s.layout.schedule;
  const items = isToday
    ? (s.day && s.day.items) || []
    : (s.layout && s.layout.items) || [];
  if (!sched) return;
  const solverOut = solveInsertion({
    items,
    schedule: sched,
    draft: s.placeholder,
    // Match the render-time substitution so the submitted slot is exactly what the popup last previewed.
    cursorMin: explicitCursorMin(s.cursorMin, s.nowMin),
    allowRepositioning: s.allowRepositioning,
  });
  if (solverOut.conflict) return; // shouldn't happen — Add is disabled
  const ph = s.placeholder;
  const body = {
    item: {
      use_inline: ph.use_inline,
      inline_label: ph.inline_label,
      inline_description: ph.inline_description,
      color: ph.color,
      start_min: ph.start_min,
      end_min: ph.end_min,
      duration_target: ph.duration_target,
      project_id: ph.project_id,
      project_rank: ph.project_rank,
      task_id: ph.task_id,
      task_rank: ph.task_rank,
    },
    reorders: solverOut.reorders,
  };
  // Wire convention: undefined → append at tail, null → head insert, id → after that id.
  const after = solverOut.afterItemId;
  if (after === null) body.item.after_item_id = null;
  else if (typeof after === "number") body.item.after_item_id = after;
  try {
    await api.insertItemAtomic(sched.id, body);
  } catch (e) {
    console.error("insertItemAtomic failed:", e);
    return;
  }
  // Defer clearing the placeholder until the refetch lands, so the timeline doesn't briefly drop the just-committed block.
  const p = self.reload(vnode);
  const reset = () => {
    s.placeholder = null;
    s.editingItemFocusName = false;
    m.redraw();
  };
  if (p && typeof p.then === "function") p.then(reset, reset);
  else reset();
}

// Probe the solver with a default-dynamic placeholder (repositioning on); grays the Add button when nothing fits.
function canAddProbe(sched, items, cursorMin) {
  if (!sched) return false;
  const probe = {
    _placeholder: true,
    id: -1,
    start_min: null,
    end_min: null,
    duration_target: PLACEHOLDER_DURATION_DEFAULT,
    use_inline: true,
    color: DEFAULT_ITEM_COLOR,
  };
  const result = solveInsertion({
    items,
    schedule: sched,
    draft: probe,
    cursorMin,
    allowRepositioning: true,
  });
  return result.conflict == null;
}

// Empty state for weekday/date views: a message plus Create, with Fork only in date mode when a template exists.
function renderSpecificEmptyState(vnode, self, a) {
  if (a.mode === "weekday") {
    return m(
      ".empty-state",
      m("p.empty-state-msg", "No template for this day"),
      m(
        ".empty-state-actions",
        m(
          "button.primary",
          { onclick: () => createSpecificSchedule(vnode, self) },
          m("span.icon.icon-plus"),
          m("span.label", "Create new template")
        )
      )
    );
  }
  const wdName =
    WEEKDAY_NAMES[weekdayMondayBasedFromDate(parseLocalYmdInline(a.date))];
  const hasTemplate = !!vnode.state.weekdayTemplateForDate;
  return m(
    ".empty-state",
    m("p.empty-state-msg", "No schedule for this day"),
    m(".empty-state-actions", [
      m(
        "button.primary",
        { onclick: () => createSpecificSchedule(vnode, self) },
        m("span.icon.icon-plus"),
        m("span.label", "Create new schedule")
      ),
      hasTemplate
        ? m(
            "button.primary",
            { onclick: () => forkSpecificFromTemplate(vnode, self) },
            m("span.icon.icon-plus"),
            m("span.label", `Fork the ${wdName} template`)
          )
        : null,
    ])
  );
}

// Create a blank weekday/date schedule; both create endpoints are idempotent, so a double-click during reload is safe.
async function createSpecificSchedule(vnode, self) {
  const a = vnode.attrs;
  try {
    if (a.mode === "weekday") await api.createWeekdayTemplate(a.weekday);
    else await api.createOverride(a.date);
  } catch (e) {
    console.error("Failed to create schedule:", e);
    return;
  }
  await self.reload(vnode);
}

// Date-mode only: fork the weekday template into a date override. forkWeekdayTemplate falls back to a blank create when none.
async function forkSpecificFromTemplate(vnode, self) {
  const a = vnode.attrs;
  if (a.mode !== "date") return;
  try {
    await api.forkWeekdayTemplate(a.date);
  } catch (e) {
    console.error("Failed to fork template:", e);
    return;
  }
  await self.reload(vnode);
}

// =====================================================================
// Item editor popup
// =====================================================================

async function loadLayoutItem(scheduleId, itemId) {
  if (!scheduleId || itemId == null) return null;
  try {
    const layout = await api.scheduleLayout(scheduleId);
    return layout.items.find((x) => x.id === itemId) || null;
  } catch {
    return null;
  }
}

// Sentinel option values for the Project/Task dropdowns; real entries use stringified numeric ids, so sentinels just avoid those.
const SEL_FIRST = "__first__";
const SEL_SECOND = "__second__";
const SEL_SEPARATOR = "__sep__";
// Disabled <option> acting as a non-selectable separator between sentinels and real entries.
const SEPARATOR_LABEL = "\u2500\u2500\u2500\u2500\u2500\u2500";

// Priority score (value / time_cost, 0 when time_cost is 0); inlined to avoid importing from the projects view.
function projectPriority(p) {
  if (!p || !p.time_cost) return 0;
  return p.value / p.time_cost;
}

// Pick the popup's Type from use_inline; default to "task" for legacy/missing rows.
function inferItemType(it) {
  if (!it) return "task";
  return it.use_inline === false ? "project" : "task";
}

// Resolved project id to navigate to: direct project_id wins, else a rank-resolved task payload's project; null otherwise.
function itemProjectId(it) {
  if (!it) return null;
  if (it.project_id != null) return it.project_id;
  const p = it.payload;
  if (p && p.kind === "task" && p.project_id != null) return p.project_id;
  return null;
}

// Fetch a project's task list, memoized per popup; switching projects clears the stale list to avoid showing foreign tasks.
function ensureTasksFor(vnode, projectId) {
  if (projectId == null) {
    vnode.state.tasks = null;
    vnode.state._tasksFor = null;
    return;
  }
  if (vnode.state._tasksFor === projectId) return;
  vnode.state._tasksFor = projectId;
  vnode.state.tasks = null;
  api.listTasks(projectId).then((tasks) => {
    if (vnode.state._tasksFor === projectId) {
      vnode.state.tasks = tasks;
      m.redraw();
    }
  });
}

const ItemPopup = {
  async oninit(vnode) {
    // Two modes: "placeholder" (it is the in-memory draft, atomic insert on Add) and "edit" (patches via api.patchItem).
    const mode = vnode.attrs.mode;
    // Description starts collapsed; flipped open below once the layout fetch reveals an existing description.
    vnode.state.descriptionExpanded = false;
    if (mode === "placeholder") {
      const ph = vnode.attrs.it;
      vnode.state.it = ph;
      vnode.state.type = inferItemType(ph);
      vnode.state.submitting = false;
      api.listProjects().then((ps) => {
        vnode.state.projects = ps.filter((p) => !p.archived_at);
        m.redraw();
      });
      if (ph.project_id != null) ensureTasksFor(vnode, ph.project_id);
      return;
    }
    const initial = vnode.attrs.it;
    // Edit mode: refetch via the layout endpoint for assigned_start/assigned_end (a strict superset of the raw row).
    const scheduleId =
      (initial && initial.schedule_id) ||
      (vnode.attrs.schedule && vnode.attrs.schedule.id);
    const it = await loadLayoutItem(scheduleId, initial.id);
    vnode.state.it = it;
    // Auto-expand Description when the item already has non-empty text, so existing text shows without an extra click.
    vnode.state.descriptionExpanded = !!(
      it && it.inline_description && it.inline_description.trim()
    );
    // Type is frontend-only popup state: seeded from the row, then the user's explicit pick is authoritative until close.
    vnode.state.type = inferItemType(it);
    api.listProjects().then((ps) => {
      vnode.state.projects = ps.filter((p) => !p.archived_at);
      m.redraw();
    });
    if (it && it.project_id != null) ensureTasksFor(vnode, it.project_id);
  },
  view(vnode) {
    const it = vnode.state.it;
    const sched = vnode.attrs.schedule;
    if (!it)
      return m(Popup, { onclose: vnode.attrs.onclose }, m(".empty", "Loading…"));
    const mode = vnode.attrs.mode;
    const isPlaceholder = mode === "placeholder";
    const solverOut = vnode.attrs.solverOut;
    // Resolved start/end: from the solver (placeholder, falling back to typed values on conflict) or the parent's layout item (edit).
    let assignedStart;
    let assignedEnd;
    if (isPlaceholder) {
      assignedStart =
        solverOut && solverOut.draftAssignedStart != null
          ? solverOut.draftAssignedStart
          : it.start_min;
      assignedEnd =
        solverOut && solverOut.draftAssignedEnd != null
          ? solverOut.draftAssignedEnd
          : it.end_min;
    } else {
      const laidOut = vnode.attrs.laidOutItem;
      assignedStart = laidOut ? laidOut.assigned_start : it.assigned_start;
      assignedEnd = laidOut ? laidOut.assigned_end : it.assigned_end;
    }

    // Placeholder mode flips both edges together (binary anchor); edit mode keeps each edge independent, preserving half-anchored rows.
    const startFixed = it.start_min != null;
    const endFixed = it.end_min != null;
    const bothFixed = startFixed && endFixed;

    // Edit mode PATCHes the row; placeholder mode mutates the in-memory draft. Both redraw so the popup (and solver) update immediately.
    const patch = isPlaceholder
      ? async (body) => {
          Object.assign(it, body);
          m.redraw();
        }
      : async (body) => {
          const np = await api.patchItem(it.id, body);
          Object.assign(it, np);
          m.redraw();
        };

    // All remaining conflicts come from the solver, which the schedule view already runs for the live timeline preview.
    const solverConflict = isPlaceholder && solverOut ? solverOut.conflict : null;
    const conflictMessage =
      solverConflict === "overlap_fixed"
        ? "Anchored time overlaps another fixed item."
        : solverConflict === "overlap_edge"
        ? "Anchored time is outside the schedule's bounds."
        : solverConflict === "squashed_dynamic"
        ? "Would squeeze a dynamic item below the minimum. Try enabling repositioning."
        : solverConflict === "no_slack"
        ? "Schedule is too tight to fit a new item — adjust an existing item first."
        : null;
    const canAdd = isPlaceholder && solverConflict == null;

    // Keep the task list synced with the selected project; sentinel-rank rows aren't preloaded (resolved server-side).
    if (it.project_id != null) ensureTasksFor(vnode, it.project_id);
    else if (vnode.state._tasksFor != null) {
      vnode.state._tasksFor = null;
      vnode.state.tasks = null;
    }

    const type = vnode.state.type;
    const projects = (vnode.state.projects || [])
      .slice()
      .sort((a, b) => projectPriority(b) - projectPriority(a));
    const tasks = vnode.state.tasks || [];

    // Project <select> value: specific id wins, else map ranks onto the sentinels (unrendered ranks fall to "first").
    let projectSelVal;
    if (it.project_id != null && projects.some((p) => p.id === it.project_id)) {
      projectSelVal = String(it.project_id);
    } else if (it.project_id == null && it.project_rank === 2) {
      projectSelVal = SEL_SECOND;
    } else {
      projectSelVal = SEL_FIRST;
    }

    // Task <select> value, same shape; a stale task_id from another project is absent, and the sentinel fallback handles it.
    let taskSelVal;
    if (it.task_id != null && tasks.some((t) => t.id === it.task_id)) {
      taskSelVal = String(it.task_id);
    } else if (it.task_id == null && it.task_rank === 2) {
      taskSelVal = SEL_SECOND;
    } else {
      taskSelVal = SEL_FIRST;
    }

    const isSpecificProject = it.project_id != null;

    // Toggling Type only flips use_inline; both column sets are preserved so notes and pre-staged project picks survive the switch.
    const onTypeChange = (e) => {
      const newType = e.target.value;
      vnode.state.type = newType;
      patch({ use_inline: newType === "task" });
    };

    const onProjectChange = (e) => {
      const v = e.target.value;
      // Reset Task to "first" so a leftover task_id doesn't follow; force use_inline:false to commit Project mode on an actual pick.
      const base = { use_inline: false };
      if (v === SEL_FIRST) {
        patch({ ...base, project_id: null, project_rank: 1, task_id: null, task_rank: 1 });
      } else if (v === SEL_SECOND) {
        patch({ ...base, project_id: null, project_rank: 2, task_id: null, task_rank: 1 });
      } else if (v !== SEL_SEPARATOR) {
        patch({
          ...base,
          project_id: Number(v),
          project_rank: 1,
          task_id: null,
          task_rank: 1,
        });
      }
    };

    const onTaskChange = (e) => {
      const v = e.target.value;
      // Carry through the current project state so each project-side patch stays self-consistent (see onProjectChange).
      const projFields = isSpecificProject
        ? { project_id: it.project_id, project_rank: 1 }
        : { project_id: null, project_rank: it.project_rank === 2 ? 2 : 1 };
      const base = { use_inline: false, ...projFields };
      if (v === SEL_FIRST) {
        patch({ ...base, task_id: null, task_rank: 1 });
      } else if (v === SEL_SECOND) {
        patch({ ...base, task_id: null, task_rank: 2 });
      } else if (v !== SEL_SEPARATOR) {
        patch({ ...base, task_id: Number(v), task_rank: 1 });
      }
    };

    // Color picker hidden in Project mode: project-bound items inherit the project's color, so a swatch row would have no effect.
    const colorPickerField =
      type === "task"
        ? m(".field", [
            m(".field-label", "Color"),
            m(ColorPicker, {
              value: it.color || DEFAULT_ITEM_COLOR,
              onpick: (key) => patch({ color: key }),
            }),
          ])
        : null;

    // Submit a placeholder: the parent builds the request body, so here we just toggle submitting and delegate.
    const submit = async () => {
      if (vnode.state.submitting) return;
      vnode.state.submitting = true;
      m.redraw();
      try {
        await vnode.attrs.onCommit();
      } finally {
        vnode.state.submitting = false;
        m.redraw();
      }
    };

    // Timing row: placeholder mode shows one anchor; edit mode shows two. Color picker renders below.
    const cursorMin = vnode.attrs.cursorMin;

    // Placeholder anchor toggles both edges; ON snaps to the time cursor with the desired duration, OFF drops both.
    const togglePlaceholderAnchor = () => {
      if (bothFixed) {
        patch({ start_min: null, end_min: null });
        return;
      }
      const dur = Math.max(
        1,
        it.duration_target || PLACEHOLDER_DURATION_DEFAULT
      );
      const seed =
        cursorMin != null
          ? cursorMin
          : assignedStart != null
          ? assignedStart
          : sched.start_min;
      patch({ start_min: seed, end_min: seed + dur });
    };

    // Edit mode: per-edge toggles. OFF→ON snapshots the laid-out value (no visual jump); ON→OFF nulls only that edge.
    const toggleStartAnchor = () => {
      if (startFixed) {
        patch({ start_min: null });
        return;
      }
      const s = assignedStart != null ? assignedStart : sched.start_min;
      patch({ start_min: s });
    };
    const toggleEndAnchor = () => {
      if (endFixed) {
        patch({ end_min: null });
        return;
      }
      const e = assignedEnd != null ? assignedEnd : sched.end_min;
      patch({ end_min: e });
    };

    // Anchor button factory; side ∈ "placeholder" | "start" | "end" selects the toggle, icon, and tooltip.
    const anchorBtn = (side) => {
      const isOn =
        side === "placeholder"
          ? bothFixed
          : side === "start"
          ? startFixed
          : endFixed;
      const onclick =
        side === "placeholder"
          ? togglePlaceholderAnchor
          : side === "start"
          ? toggleStartAnchor
          : toggleEndAnchor;
      const iconClass =
        side === "placeholder"
          ? "icon-anchor"
          : side === "start"
          ? "icon-anchor-left"
          : "icon-anchor-right";
      const title = isOn
        ? side === "placeholder"
          ? "Raise anchor (let the schedule pick the time)"
          : side === "start"
          ? "Raise start anchor (let this side float)"
          : "Raise end anchor (let this side float)"
        : side === "placeholder"
        ? "Drop anchor at the time cursor"
        : side === "start"
        ? "Drop anchor at the laid-out start time"
        : "Drop anchor at the laid-out end time";
      return m(
        "button.anchor-btn" + (isOn ? ".fixed" : ""),
        {
          type: "button",
          "aria-label": isOn ? "Make dynamic" : "Make fixed",
          "aria-pressed": isOn ? "true" : "false",
          title,
          onclick,
        },
        m("span.icon." + iconClass)
      );
    };

    // Start: editable ClockField when fixed, else a read-only stand-in. Edit mode clamps via clampItemEdge; placeholder defers to the solver.
    const startInput = startFixed
      ? m(".row.timing-field.timing-input-start", [
          m(ClockField, {
            value: it.start_min,
            min: sched.start_min,
            max: sched.end_min,
            onsave: (v) => {
              if (v == null) return;
              if (isPlaceholder) {
                return patch(anchoredPlaceholderStartPatch(it, v));
              }
              const clamped = clampItemEdge(
                v,
                sched,
                vnode.attrs.items || [],
                it.id,
                "start"
              );
              return patch({ start_min: clamped });
            },
          }),
        ])
      : m(".row.timing-field.timing-field-readonly.timing-input-start", [
          // type=text explicit: the global CSS rule keys off input[type="text"], so a bare <input> would lose its chrome.
          m("input[readonly]", {
            type: "text",
            value: assignedStart != null ? fmtClock(assignedStart) : "",
            tabindex: "-1",
          }),
        ]);

    // Duration field: "Duration" + (end−start) when bothFixed, else "Desired duration" + duration_target.
    const durationLabel = bothFixed ? "Duration" : "Desired duration";
    const durationValue = bothFixed
      ? Math.max(1, it.end_min - it.start_min)
      : it.duration_target;
    const durationInput = m(".row.timing-field.timing-input-dur", [
      m(DurationField, {
        value: durationValue,
        onsave: (v) => {
          const dur = Math.max(1, Math.floor(v));
          if (!bothFixed) {
            return patch({ duration_target: dur });
          }
          // Both edges fixed: resize end_min against start_min. Edit mode clamps against neighbours; placeholder defers to the solver.
          const desired = it.start_min + dur;
          if (isPlaceholder) {
            return patch({ end_min: desired });
          }
          const clamped = clampItemEdge(
            desired,
            sched,
            vnode.attrs.items || [],
            it.id,
            "end"
          );
          return patch({ end_min: clamped });
        },
      }),
    ]);

    // Assembled grid: labels on row 1, inputs+anchors on row 2. Placeholder uses 3 columns (one anchor); edit keeps both.
    const timingRow = m(
      ".timing-row" + (isPlaceholder ? ".placeholder" : ""),
      [
        isPlaceholder ? anchorBtn("placeholder") : anchorBtn("start"),
        m(".field-label.timing-label-start", "Start"),
        m(".field-label.timing-label-dur", durationLabel),
        startInput,
        durationInput,
        isPlaceholder ? null : anchorBtn("end"),
      ]
    );
    return m(
      Popup,
      {
        title: isPlaceholder ? "New schedule item" : "Schedule item",
        onclose: vnode.attrs.onclose,
        // Trash deletes the row; a placeholder has nothing to delete, so hide it.
        deleteLabel: isPlaceholder ? undefined : "Delete item",
        onDelete: isPlaceholder
          ? undefined
          : () => {
              api.deleteItem(it.id).then(() => vnode.attrs.onclose());
            },
        footer: isPlaceholder
          ? m(
              ".popup-add-row",
              conflictMessage
                ? m(".popup-warning", conflictMessage)
                : null,
              m(
                ".row.popup-add-row-controls",
                m(
                  "label.repos-checkbox",
                  m("input[type=checkbox]", {
                    checked: !!vnode.attrs.allowRepositioning,
                    onchange: (e) =>
                      vnode.attrs.onAllowRepositioningChange(
                        e.target.checked
                      ),
                  }),
                  " Allow repositioning of dynamic items"
                ),
                m(
                  "button.primary",
                  {
                    onclick: submit,
                    disabled: !!vnode.state.submitting || !canAdd,
                    title: canAdd
                      ? "Add this item to the schedule"
                      : conflictMessage ||
                        "Cannot add — resolve the issue first",
                  },
                  m("span.label", "Add")
                )
              )
            )
          : // Edit mode: offer a jump to the bound project's view; only when the item resolves to a project.
            (() => {
              if (type !== "project") return null;
              const pid = itemProjectId(it);
              if (pid == null) return null;
              // Direct footer child (not .popup-add-row, which stretches full-width) so flex-end hugs it to the right, sized to content.
              return m(
                "button",
                {
                  // Close first (dismiss the popup), then route — the tab switch unmounts this view's popup either way.
                  onclick: () => {
                    vnode.attrs.onclose();
                    m.route.set("/projects/" + pid);
                  },
                },
                m("span.label", "Go to project"),
                m("span.icon.icon-chevron-right")
              );
            })(),
      },
      // Wrap the field stack to hide AutoField's saved-tick in placeholder mode, since draft edits aren't persisted.
      m(".item-edit-body" + (isPlaceholder ? ".is-placeholder" : ""),
      // Identity row: Type select then Name/Project. Same two-row grid as .timing-row so controls share a baseline.
      m(".identity-row", [
        m(".field-label.identity-label-type", "Type"),
        m(
          ".field-label.identity-label-target",
          type === "task" ? "Name" : "Project"
        ),
        m(
          ".identity-input-type",
          m(
            "select",
            { value: type, onchange: onTypeChange },
            m("option", { value: "task" }, "Task"),
            m("option", { value: "project" }, "Project")
          )
        ),
        type === "task"
          ? m(
              ".identity-input-target",
              {
                // Autofocus only when opened via Add item (focusName); _focusedName guards against re-grabbing focus on a Type toggle.
                oncreate:
                  vnode.attrs.focusName && !vnode.state._focusedName
                    ? (vn) => {
                        vnode.state._focusedName = true;
                        const input = vn.dom.querySelector("input");
                        if (!input) return;
                        // Defer one frame so no other late mount work in the same tick steals focus back to the body.
                        requestAnimationFrame(() => {
                          input.focus();
                          input.select();
                        });
                      }
                    : undefined,
              },
              m(AutoField, {
                value: it.inline_label || "",
                onsave: (v) =>
                  patch({ inline_label: v === "" ? null : v }),
              })
            )
          : m(
              ".identity-input-target",
              m(
                "select",
                { value: projectSelVal, onchange: onProjectChange },
                m("option", { value: SEL_FIRST }, "Use first project"),
                m("option", { value: SEL_SECOND }, "Use second project"),
                m(
                  "option",
                  { value: SEL_SEPARATOR, disabled: true },
                  SEPARATOR_LABEL
                ),
                ...projects.map((p) =>
                  m("option", { value: String(p.id) }, p.name)
                )
              )
            ),
      ]),
      type === "task"
        ? m(".field", [
            // Collapsible header: the whole row toggles via click or Enter/Space (not a real button, to keep .field-label styling).
            m(
              ".field-label.collapsible-label",
              {
                onclick: () => {
                  vnode.state.descriptionExpanded =
                    !vnode.state.descriptionExpanded;
                },
                role: "button",
                tabindex: 0,
                "aria-expanded": vnode.state.descriptionExpanded
                  ? "true"
                  : "false",
                onkeydown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    vnode.state.descriptionExpanded =
                      !vnode.state.descriptionExpanded;
                  }
                },
              },
              m("span", "Description"),
              m(
                "span.icon.icon-chevron-right" +
                  (vnode.state.descriptionExpanded ? ".rotated" : "")
              )
            ),
            // Collapsing unmounts the AutoField; the chevron click blurs the textarea first, so AutoField commits any pending edit.
            vnode.state.descriptionExpanded
              ? m(AutoField, {
                  value: it.inline_description || "",
                  type: "textarea",
                  onsave: (v) =>
                    patch({ inline_description: v === "" ? null : v }),
                })
              : null,
          ])
        : m(".field", [
            m(".field-label", "Subtask"),
            m(
              "select",
              { value: taskSelVal, onchange: onTaskChange },
              m("option", { value: SEL_FIRST }, "Use first subtask"),
              m("option", { value: SEL_SECOND }, "Use second subtask"),
              // Separator and specific-task list render only for a specific project; otherwise a lone separator would imply nonexistent options.
              ...(isSpecificProject
                ? [
                    m(
                      "option",
                      { value: SEL_SEPARATOR, disabled: true },
                      SEPARATOR_LABEL
                    ),
                    ...tasks.map((t) =>
                      m("option", { value: String(t.id) }, t.name)
                    ),
                  ]
                : [])
            ),
          ]),
      // Start + Duration in one row with anchor button(s) outside; color picker follows.
      timingRow,
      colorPickerField
      )
    );
  },
};

// Snap interval for the spinners; each press jumps to the nearest multiple in the arrow's direction (see bump).
const TIME_SNAP_MIN = 15;

// HH:MM text field with a ▲/▼ spinner; plain text (not <input type=time>) keeps the locale-independent format. Validation via AutoField.
const ClockField = {
  view(vnode) {
    const a = vnode.attrs;
    const bump = (dir) => {
      const base = Math.round(a.value ?? a.min ?? 0);
      const next =
        dir > 0
          ? Math.floor(base / TIME_SNAP_MIN) * TIME_SNAP_MIN + TIME_SNAP_MIN
          : Math.ceil(base / TIME_SNAP_MIN) * TIME_SNAP_MIN - TIME_SNAP_MIN;
      a.onsave(next);
    };
    const validate = (raw) => {
      const t = String(raw ?? "").trim();
      if (t === "") {
        return a.allowEmpty ? { ok: true, value: null } : { ok: false };
      }
      const min = parseClockToMin(t);
      if (min == null) return { ok: false };
      return { ok: true, value: min };
    };
    return [
      m(AutoField, {
        value: a.value != null ? fmtClock(a.value) : "",
        placeholder: a.placeholder,
        validate,
        invalid: a.invalid,
        onsave: (v) => a.onsave(v),
      }),
      // tabindex: -1 keeps the spinners out of the tab cycle; the input is the tab-stop, Up/Down arrows still increment.
      m(".spinner", [
        m(
          "button.spinner-btn",
          {
            type: "button",
            tabindex: "-1",
            "aria-label": "Increase time",
            onclick: () => bump(1),
          },
          m("span.icon.icon-caret-up")
        ),
        m(
          "button.spinner-btn",
          {
            type: "button",
            tabindex: "-1",
            "aria-label": "Decrease time",
            onclick: () => bump(-1),
          },
          m("span.icon.icon-caret-down")
        ),
      ]),
    ];
  },
};

// Duration field like ClockField but without the day-rollover suffix; value is duration_target, floored at one snap step.
const DurationField = {
  view(vnode) {
    const a = vnode.attrs;
    const bump = (dir) => {
      const base = Math.round(a.value ?? 0);
      let next =
        dir > 0
          ? Math.floor(base / TIME_SNAP_MIN) * TIME_SNAP_MIN + TIME_SNAP_MIN
          : Math.ceil(base / TIME_SNAP_MIN) * TIME_SNAP_MIN - TIME_SNAP_MIN;
      // Duration is strictly positive (backend CHECK); snap-down from the smallest bucket would otherwise land on 00:00.
      next = Math.max(TIME_SNAP_MIN, next);
      a.onsave(next);
    };
    const validate = (raw) => {
      const t = String(raw ?? "").trim();
      if (t === "") return { ok: false };
      const min = parseDurationToMin(t);
      if (min == null || min <= 0) return { ok: false };
      return { ok: true, value: min };
    };
    return [
      m(AutoField, {
        value: a.value != null ? fmtDuration(a.value) : "",
        placeholder: a.placeholder,
        validate,
        onsave: (v) => a.onsave(v),
      }),
      // See ClockField for the rationale on `tabindex: -1` here.
      m(".spinner", [
        m(
          "button.spinner-btn",
          {
            type: "button",
            tabindex: "-1",
            "aria-label": "Increase duration",
            onclick: () => bump(1),
          },
          m("span.icon.icon-caret-up")
        ),
        m(
          "button.spinner-btn",
          {
            type: "button",
            tabindex: "-1",
            "aria-label": "Decrease duration",
            onclick: () => bump(-1),
          },
          m("span.icon.icon-caret-down")
        ),
      ]),
    ];
  },
};

// =====================================================================
// Schedule properties popup
// =====================================================================

const SchedulePropsPopup = {
  view(vnode) {
    const sched = vnode.attrs.schedule;
  // Always edits the bound schedule directly; the trash button surfaces the caller's delete handler when provided.
  const patch = async (body) => {
      const np = await api.patchSchedule(sched.id, body);
      Object.assign(sched, np);
      m.redraw();
    };
    return m(
      Popup,
      {
        title: "Schedule properties",
        onclose: vnode.attrs.onclose,
        deleteLabel: "Delete schedule",
        onDelete: vnode.attrs.onDelete,
      },
      m(".field", [
        m(".field-label", "Name"),
        m(AutoField, {
          value: sched.name,
          onsave: (v) => patch({ name: v }),
        }),
      ]),
      m(".field-grid", [
        m(".field", [
          m(".field-label", "Start"),
          m(".row.timing-field", [
            m(ClockField, {
              value: sched.start_min,
              onsave: (v) => {
                // ClockField with allowEmpty unset never hands us null; invalid/empty input is tinted red and suppressed upstream.
                const next = clampScheduleStart(
                  v,
                  sched,
                  vnode.attrs.items || []
                );
                return patch({ start_min: next });
              },
            }),
          ]),
        ]),
        m(".field", [
          m(".field-label", "End"),
          m(".row.timing-field", [
            m(ClockField, {
              value: sched.end_min,
              onsave: (v) => {
                const next = clampScheduleEnd(
                  v,
                  sched,
                  vnode.attrs.items || []
                );
                return patch({ end_min: next });
              },
            }),
          ]),
        ]),
      ])
    );
  },
};
