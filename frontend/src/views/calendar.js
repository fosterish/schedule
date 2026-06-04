import m from "mithril";
import { api, onApiMutation } from "../api.js";
import { trashIcon } from "../components/popup.js";
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

function ymd(date) {
  const y = date.getFullYear();
  const m_ = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m_}-${d}`;
}

function firstOfMonth(y, m) {
  return new Date(y, m, 1);
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
    vnode.state.templates = []; // schedule templates (day-agnostic)
    vnode.state.days = {}; // date string -> daily-schedule row
    vnode.state.layoutCache = {}; // schedule_id -> layout
    vnode.state.templatesExpanded = false;
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
    // Grid spans 6 weeks (42 cells) from the Sunday on/before the 1st; days and templates each fetch once.
    vnode.state.loading = true;
    const y = vnode.state.y;
    const month = vnode.state.m;
    const firstCell = new Date(y, month, 1 - weekdaySundayBased(firstOfMonth(y, month)));
    const lastCell = new Date(firstCell);
    lastCell.setDate(firstCell.getDate() + 41);
    const start = ymd(firstCell);
    const end = ymd(lastCell);

    const tplPromise = api.listTemplates().then((rows) => {
      vnode.state.templates = rows || [];
      m.redraw();
    }, () => {
      vnode.state.templates = [];
    });

    // Project color/name comes from the layout endpoint's resolved `payload`, so the calendar doesn't cache `listProjects`.

    const daysPromise = api.getDaysRange(start, end).then((rows) => {
      const map = {};
      for (const r of rows || []) if (r && r.schedule) map[r.date] = r;
      vnode.state.days = map;
      m.redraw();
    }, () => {
      vnode.state.days = {};
    });

    Promise.all([tplPromise, daysPromise]).then(() => {
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
    for (const t of vnode.state.templates) collect(t);
    for (const k of Object.keys(vnode.state.days))
      collect(vnode.state.days[k].schedule);
    if (need.length === 0) return;
    api.scheduleLayouts(need).then((map) => {
      for (const k of Object.keys(map || {})) {
        vnode.state.layoutCache[Number(k)] = map[k];
      }
      m.redraw();
    });
  },
  // Create a fresh template and jump straight to the Schedule tab to edit it.
  async createTemplate() {
    try {
      const sched = await api.createTemplate();
      if (sched && sched.id != null) m.route.set("/template/" + sched.id);
    } catch (e) {
      console.error("Failed to create template:", e);
    }
  },
  async deleteTemplate(vnode, id) {
    try {
      await api.deleteSchedule(id);
    } catch (e) {
      console.error("Failed to delete template:", e);
      return;
    }
    this.reload(vnode);
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
            "button",
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
        this.templatesAccordion(vnode),
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
            const day = vnode.state.days[ds];
            const sched = (day && day.schedule) || null;
            const isToday = ds === today;
            return m(
              ".calendar-cell",
              {
                key: ds,
                class: [
                  inMonth ? "in" : "out",
                  isToday ? "today" : "",
                  sched ? "has-schedule" : "",
                ]
                  .filter(Boolean)
                  .join(" "),
                // Cells are pure navigation; today routes to the live view, other days to their date view.
                onclick: () =>
                  m.route.set(isToday ? "/today" : "/date/" + ds),
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
                      })
                    : null
                ),
              ]
            );
          })
        ),
      ]),
    ];
  },
  templatesAccordion(vnode) {
    const expanded = vnode.state.templatesExpanded;
    const toggle = () => {
      vnode.state.templatesExpanded = !vnode.state.templatesExpanded;
    };
    return m(".field.calendar-templates", [
      m(
        ".field-label.collapsible-label",
        {
          onclick: toggle,
          role: "button",
          tabindex: 0,
          "aria-expanded": expanded ? "true" : "false",
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          },
        },
        m("span", "Schedule Templates"),
        m("span.icon.icon-chevron-right" + (expanded ? ".rotated" : ""))
      ),
      expanded
        ? m(".dep-list", [
            m(
              ".dep-rows",
              vnode.state.templates.map((t) =>
                m(".template-row", { key: t.id }, [
                  m(
                    "button.template-name",
                    {
                      type: "button",
                      onclick: () => m.route.set("/template/" + t.id),
                    },
                    t.name || "(unnamed)"
                  ),
                  m(
                    "button.icon-btn.dep-remove",
                    {
                      type: "button",
                      title: "Delete template",
                      "aria-label": "Delete template",
                      onclick: () => this.deleteTemplate(vnode, t.id),
                    },
                    trashIcon()
                  ),
                ])
              )
            ),
            m(
              "button.icon-btn.dep-add",
              {
                type: "button",
                title: "New schedule template",
                "aria-label": "New schedule template",
                onclick: () => this.createTemplate(),
              },
              m("span.icon.icon-plus")
            ),
          ])
        : null,
    ]);
  },
};

const MiniTimeline = {
  view(vnode) {
    const sched = vnode.attrs.schedule;
    const layout = vnode.attrs.layout;
    // Callers pick the height so the component renders compactly in a cell and roomy elsewhere.
    const height = vnode.attrs.height;
    const containerStyle = height != null ? `height:${height}px` : "";
    if (!sched) return m(".mini-timeline", { style: containerStyle });
    const total = sched.end_min - sched.start_min;
    if (total <= 0)
      return m(
        ".mini-timeline",
        { style: containerStyle },
        m(".muted", { style: "font-size:10px" }, "—")
      );
    const items = layout && layout.items ? layout.items : [];
    return m(
      ".mini-timeline",
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
