import m from "mithril";
import { api, onApiMutation } from "../api.js";
import { Popup } from "../components/popup.js";
import { DEFAULT_ITEM_COLOR, paletteColor } from "../palette.js";
// URL fragments whose mutations can change calendar data; undo/redo included since either can replay them.
function calendarAffected(url) {
  return (
    url.includes("/api/schedules") ||
    url.includes("/api/schedule_items") ||
    url.includes("/api/calendar/") ||
    url.includes("/api/day/today/") ||
    url.includes("/api/history/undo") ||
    url.includes("/api/history/redo") ||
    // Project-bound items inherit project color, so project mutations must invalidate the layout cache.
    url.includes("/api/projects")
  );
}

function isCalendarActive() {
  return (m.route.get() || "") === "/calendar";
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

function ymd(date) {
  const y = date.getFullYear();
  const m_ = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m_}-${d}`;
}

// Parse `YYYY-MM-DD` as local time; `new Date(str)` treats it as UTC midnight and drifts a day west of UTC.
function parseLocalYmd(s) {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d);
}

function firstOfMonth(y, m) {
  return new Date(y, m, 1);
}

function weekdayMondayBased(d) {
  // Convert JS 0=Sun weekday to Monday-based 0=Mon..6=Sun for backend lookups.
  return (d.getDay() + 6) % 7;
}

function weekdaySundayBased(d) {
  // JS already returns 0=Sun..6=Sat. Used for calendar grid layout only.
  return d.getDay();
}

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

export const Calendar = {
  oninit(vnode) {
    const now = new Date();
    vnode.state.y = now.getFullYear();
    vnode.state.m = now.getMonth(); // 0-indexed
    vnode.state.weekdays = null; // map of weekday(0..6) -> binding
    vnode.state.overrides = {}; // date string -> override row
    vnode.state.layoutCache = {}; // schedule_id -> layout
    vnode.state.popupDate = null; // date string while popup open
    vnode.state.loading = false;
    this.reload(vnode);
    // Calendar stays mounted across tabs; edits while hidden just mark data stale to avoid refetching for nobody.
    vnode.state._dirty = false;
    vnode.state._unsubMut = onApiMutation((url) => {
      if (!calendarAffected(url)) return;
      if (isCalendarActive()) {
        vnode.state.layoutCache = {};
        this.reload(vnode);
      } else {
        vnode.state._dirty = true;
      }
    });
  },
  onremove(vnode) {
    if (vnode.state._unsubMut) vnode.state._unsubMut();
  },
  onupdate(vnode) {
    if (vnode.state._dirty && isCalendarActive()) {
      vnode.state._dirty = false;
      vnode.state.layoutCache = {};
      this.reload(vnode);
    }
  },
  reload(vnode) {
    // Grid spans 6 weeks (42 cells) from the Sunday on/before the 1st; overrides and layouts each fetch once.
    vnode.state.loading = true;
    const y = vnode.state.y;
    const month = vnode.state.m;
    const firstCell = new Date(y, month, 1 - weekdaySundayBased(firstOfMonth(y, month)));
    const lastCell = new Date(firstCell);
    lastCell.setDate(firstCell.getDate() + 41);
    const start = ymd(firstCell);
    const end = ymd(lastCell);

    const wdPromise = api.getWeekdays().then((rows) => {
      const map = {};
      for (const r of rows) map[r.weekday] = r;
      vnode.state.weekdays = map;
      m.redraw();
    }, () => {});

    // Project color/name comes from the layout endpoint's resolved `payload`, so the calendar doesn't cache `listProjects`.

    const ovPromise = api.getOverridesRange(start, end).then((rows) => {
      const map = {};
      for (const r of rows || []) if (r && r.schedule) map[r.date] = r;
      vnode.state.overrides = map;
      m.redraw();
    }, () => {
      vnode.state.overrides = {};
    });

    Promise.all([wdPromise, ovPromise]).then(() => {
      vnode.state.loading = false;
      this.loadLayouts(vnode);
      m.redraw();
    });
  },
  loadLayouts(vnode) {
    const seen = new Set();
    const need = [];
    const collect = (sched) => {
      if (!sched || seen.has(sched.id)) return;
      seen.add(sched.id);
      if (!vnode.state.layoutCache[sched.id]) need.push(sched.id);
    };
    if (vnode.state.weekdays) {
      for (const k of Object.keys(vnode.state.weekdays))
        collect(vnode.state.weekdays[k].schedule);
    }
    for (const k of Object.keys(vnode.state.overrides))
      collect(vnode.state.overrides[k].schedule);
    if (need.length === 0) return;
    api.scheduleLayouts(need).then((map) => {
      for (const k of Object.keys(map || {})) {
        vnode.state.layoutCache[Number(k)] = map[k];
      }
      m.redraw();
    });
  },
  view(vnode) {
    const y = vnode.state.y;
    const month = vnode.state.m;
    const monthName = new Date(y, month, 1).toLocaleString(undefined, {
      month: "long",
      year: "numeric",
    });
    const first = firstOfMonth(y, month);
    const startCol = weekdaySundayBased(first);
    const numDays = daysInMonth(y, month);
    const today = ymd(new Date());

    // Build 6 weeks (42 cells) starting from the Sunday before the 1st.
    const cells = [];
    const startDate = new Date(y, month, 1 - startCol);
    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      cells.push(d);
    }

    // Header mirrors the Schedule tab's layout so global `h2`/toolbar rules apply; grid lives in sibling `.tab-scroll`.
    const gotoMonth = (deltaMonths) => {
      let yy = y;
      let mm = month + deltaMonths;
      while (mm < 0) {
        mm += 12;
        yy--;
      }
      while (mm > 11) {
        mm -= 12;
        yy++;
      }
      vnode.state.y = yy;
      vnode.state.m = mm;
      this.reload(vnode);
    };
    return [
      m(".tab-fixed-header", [
        m(".toolbar-row.toolbar-row-primary", [m("h2", monthName)]),
        m(".toolbar-row.toolbar-row-secondary", [
          m(
            "button.icon-btn",
            {
              title: "Previous month",
              onclick: () => gotoMonth(-1),
            },
            m("span.icon.icon-chevron-left")
          ),
          m(
            "button.icon-btn",
            {
              title: "Next month",
              onclick: () => gotoMonth(1),
            },
            m("span.icon.icon-chevron-right")
          ),
          m(
            "button.today-btn",
            {
              onclick: () => {
                const now = new Date();
                vnode.state.y = now.getFullYear();
                vnode.state.m = now.getMonth();
                this.reload(vnode);
              },
            },
            "Today"
          ),
          // Trailing spacer pins the chevron + Today cluster left; the calendar has no right-side controls.
          m(".spacer-h"),
        ]),
      ]),
      m(".tab-scroll", [
        m(
          ".calendar-grid-head",
          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) =>
            m(".calendar-dow", d)
          )
        ),
        m(
          ".calendar-grid",
          cells.map((d) => {
            const ds = ymd(d);
            const inMonth = d.getMonth() === month;
            const wd = weekdayMondayBased(d);
            const override = vnode.state.overrides[ds];
            const weekday = vnode.state.weekdays
              ? vnode.state.weekdays[wd]
              : null;
            const sched =
              (override && override.schedule) ||
              (weekday && weekday.schedule) ||
              null;
            const isToday = ds === today;
            return m(
              ".calendar-cell",
              {
                key: ds,
                class: [
                  inMonth ? "in" : "out",
                  isToday ? "today" : "",
                  override ? "has-override" : "",
                ]
                  .filter(Boolean)
                  .join(" "),
                onclick: () => {
                  vnode.state.popupDate = ds;
                },
              },
              [
                m(".calendar-cell-num", String(d.getDate())),
                // `.calendar-cell-body` is a flex spacer that vertically centers the mini-timeline regardless of cell height.
                m(
                  ".calendar-cell-body",
                  sched
                    ? m(MiniTimeline, {
                        schedule: sched,
                        layout: vnode.state.layoutCache[sched.id],
                        height: 28,
                        // Dim the mini-timeline when the cell shows the weekday template rather than a date override.
                        template: !override,
                      })
                    : null
                ),
              ]
            );
          })
        ),
      ]),
      vnode.state.popupDate
        ? m(DayPopup, {
            date: vnode.state.popupDate,
            weekday: vnode.state.weekdays
              ? vnode.state.weekdays[
                  weekdayMondayBased(parseLocalYmd(vnode.state.popupDate))
                ]
              : null,
            override: vnode.state.overrides[vnode.state.popupDate],
            layoutCache: vnode.state.layoutCache,
            onclose: () => {
              vnode.state.popupDate = null;
              this.reload(vnode);
            },
          })
        : null,
    ];
  },
};

const MiniTimeline = {
  view(vnode) {
    const sched = vnode.attrs.schedule;
    const layout = vnode.attrs.layout;
    // Callers pick the height so the component renders compactly in a cell and roomy in the popup.
    const height = vnode.attrs.height;
    const containerStyle = height != null ? `height:${height}px` : "";
    // `template: true` dims the whole mini-timeline for weekday-template cells; popup cards leave it unset (full opacity).
    const containerClass = vnode.attrs.template
      ? ".mini-timeline.mini-timeline--template"
      : ".mini-timeline";
    if (!sched)
      return m(containerClass, { style: containerStyle });
    const total = sched.end_min - sched.start_min;
    if (total <= 0)
      return m(
        containerClass,
        { style: containerStyle },
        m(".muted", { style: "font-size:10px" }, "—")
      );
    const items = layout && layout.items ? layout.items : [];
    return m(
      containerClass,
      { style: containerStyle },
      items.map((it) => {
        const left = ((it.assigned_start - sched.start_min) / total) * 100;
        const width = Math.max(
          1,
          ((it.assigned_end - it.assigned_start) / total) * 100
        );
        // Only show the inline label for Task-mode items; `payload.kind` is authoritative, with `use_inline` as a fallback.
        const tooltip =
          it.payload && it.payload.kind !== "inline"
            ? ""
            : it.use_inline === false
              ? ""
              : it.inline_label || "";
        // The resolved `payload` carries the project's color; fall back to the item's own color when absent.
        const colorKey = miniBlockColorKey(it);
        return m(".mini-block", {
          style: `left:${left}%; width:${width}%; --mini-color:${paletteColor(colorKey)}`,
          title: tooltip,
        });
      })
    );
  },
};

function miniBlockColorKey(it) {
  const p = it.payload;
  if (p) {
    if (p.kind === "task" && p.color) return p.color;
    if (p.kind === "empty" && p.project_color) return p.project_color;
  }
  return it.color || DEFAULT_ITEM_COLOR;
}

const DayPopup = {
  view(vnode) {
    const { date, weekday, override, layoutCache, onclose } = vnode.attrs;
    const dObj = parseLocalYmd(date);
    const wdIdx = weekdayMondayBased(dObj);
    const wdName = WEEKDAY_NAMES[wdIdx];
    const hasOverride = !!(override && override.schedule);
    const hasTemplate = !!(weekday && weekday.schedule);

    // Both cards are pure navigation; creation is owned by the destination view's empty state.
    const navigate = (path) => {
      onclose();
      m.route.set(path);
    };

    // Use the local-time YMD helper for the today check; `toISOString()` would shift the date in negative-UTC offsets.
    const isToday = date === ymd(new Date());

    const openDaySchedule = () => {
      // On the current date, route to the live `/today` view instead of the historical `/date/<ymd>` view.
      if (isToday) {
        navigate("/today");
      } else {
        navigate("/date/" + encodeURIComponent(date));
      }
    };

    const openWeekdayTemplate = () => {
      navigate("/weekday/" + wdIdx);
    };

    const cardBody = (sched, emptyText) =>
      sched
        ? m(MiniTimeline, {
            schedule: sched,
            layout: layoutCache && layoutCache[sched.id],
            height: 56,
          })
        : m(".day-card-empty", emptyText);

    // Empty-card text is navigation-flavoured ("Go to …"); the cards never create or fork.
    const dayEmptyText = isToday ? "Go to today" : "Go to this day";
    const weekdayEmptyText = `Go to the ${wdName} template`;

    return m(
      Popup,
      { title: date + " (" + wdName + ")", onclose },
      m(".day-popup-cards", [
        m(
          "button.day-card",
          { onclick: openDaySchedule, type: "button" },
          [
            m(".day-card-label", "Day schedule"),
            m(
              ".day-card-body",
              cardBody(
                hasOverride ? override.schedule : null,
                dayEmptyText
              )
            ),
          ]
        ),
        m(
          "button.day-card",
          { onclick: openWeekdayTemplate, type: "button" },
          [
            m(".day-card-label", "Weekday template"),
            m(
              ".day-card-body",
              cardBody(
                hasTemplate ? weekday.schedule : null,
                weekdayEmptyText
              )
            ),
          ]
        ),
      ])
    );
  },
};
