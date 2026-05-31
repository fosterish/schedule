import m from "mithril";
import { api, AuthError } from "./api.js";
import { Shell } from "./shell.js";
import { Login } from "./views/login.js";
import { Schedule } from "./views/schedule.js";
import { Calendar } from "./views/calendar.js";
import { ProjectsList, ProjectDetail } from "./views/projects.js";

const mount = document.getElementById("app");

// Pathname routing under the deployment base ("" at root, "/schedule" behind the
// proxy) so route URLs like /schedule/today resolve to the same SPA root.
m.route.prefix = import.meta.env.BASE_URL.replace(/\/+$/, "");

// Startup smoke check to surface a down server during development.
api.health().catch(() => {});

// Safari ignores maximum-scale/touch-action for trackpad and legacy iOS pinch; suppress its gesture-zoom so page scale stays fixed.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// Top-level tab panes stay mounted (visibility-toggled) for instant return; sub-routes mount transiently and hide them.
const App = {
  oninit(vnode) {
    vnode.state.user = null;
    vnode.state.error = null;
    api.me().then(
      (me) => {
        vnode.state.user = me;
        m.redraw();
      },
      (err) => {
        if (!(err instanceof AuthError)) {
          vnode.state.error = err;
          m.redraw();
        }
      }
    );
  },
  view(vnode) {
    if (vnode.state.error) {
      return m(".empty", "Error: " + vnode.state.error.message);
    }
    // During the pending auth check render nothing; each tab shows its own loading indicator.
    if (!vnode.state.user) return null;

    const route = m.route.get() || "/today";
    const sub = pickSubRoute(route);
    // Routes outside this set and unmatched by `pickSubRoute` are treated as 404.
    const isTopRoute =
      route === "/today" || route === "/calendar" || route === "/projects";
    const isKnown = sub != null || isTopRoute;

    // Hide the Shell on unknown routes so the user can't keep operating from a broken URL.
    if (!isKnown) return m(NotFound);

    const showTop = sub == null;
    const visible = (tabRoute) =>
      showTop && route === tabRoute ? "" : "display:none";

    // Mithril throws on mixed keyed/unkeyed fragments, so hold the empty sub-slot with a keyed fragment.
    return m(Shell, { user: vnode.state.user }, [
      m(
        ".tab-pane",
        { key: "tab-schedule", style: visible("/today") },
        m(Schedule, { mode: "today" })
      ),
      m(
        ".tab-pane",
        { key: "tab-calendar", style: visible("/calendar") },
        m(Calendar)
      ),
      m(
        ".tab-pane",
        { key: "tab-projects", style: visible("/projects") },
        m(ProjectsList)
      ),
      sub || m.fragment({ key: "sub-empty" }),
    ]);
  },
};

// Returns a sub-route component for a well-formed sub-route, else null so the not-found pane handles malformed ones.
function pickSubRoute(route) {
  if (route.startsWith("/weekday/")) {
    const tail = route.slice("/weekday/".length);
    if (!/^[0-6]$/.test(tail)) return null;
    const w = Number(tail);
    return m(Schedule, { mode: "weekday", weekday: w, key: "weekday-" + w });
  }
  if (route.startsWith("/date/")) {
    const d = route.slice("/date/".length);
    // YYYY-MM-DD shape only; calendar legality (Feb 30) is left to the date view's not-found handling.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return m(Schedule, { mode: "date", date: d, key: "date-" + d });
  }
  if (/^\/projects\/\d+$/.test(route)) {
    const id = Number(route.slice("/projects/".length));
    return m(ProjectDetail, { id, key: "project-" + id });
  }
  return null;
}

const NotFound = {
  view() {
    return m(".not-found-screen", [
      m("h2", "Unknown route"),
      m(
        "button.primary",
        { onclick: () => m.route.set("/today") },
        "Go to schedule"
      ),
    ]);
  },
};

m.route(mount, "/today", {
  // Without this `/` redirect the wildcard matches root with empty `rest`, rendering a blank body.
  "/": {
    onmatch() {
      m.route.set("/today");
    },
  },
  "/login": Login,
  // Catch-all so every authenticated URL shares one App root; Mithril preserves its state across matches.
  "/:rest...": App,
});
