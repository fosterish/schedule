import m from "mithril";
import { api } from "./api.js";
import { installHistoryGlobal } from "./history.js";
import { loadLastScheduleRoute } from "./views/schedule.js";
import { loadLastProjectsRoute } from "./views/projects.js";

export const Shell = {
  oninit() {
    installHistoryGlobal();
  },
  view(vnode) {
    const user = vnode.attrs.user;
    const route = m.route.get() || "/today";
    const matchPrefix = (prefix) =>
      route === prefix || route.startsWith(prefix + "/");
    // The Schedule tab spans three prefixes (`/today`, `/weekday`, `/date`), so its active state ORs all three.
    const scheduleActive =
      matchPrefix("/today") ||
      matchPrefix("/weekday") ||
      matchPrefix("/date");

    const username = user && user.username ? user.username : "";

    const userActions = m(".shell-user", [
      m("span.user", { style: "margin-right:8px" }, username),
      m(
        "a.logout-link",
        {
          href: "#",
          onclick: (e) => {
            e.preventDefault();
            api.logout().finally(() => m.route.set("/login"));
          },
        },
        "Logout"
      ),
    ]);

    return m(".shell", [
      m("header.shell-bar-narrow", userActions),
      m(".tab-bar", [
        m(".tabs", [
          // Clicking the tab returns to the last-viewed schedule sub-route, falling back to `/today`.
          tab("/today", "Schedule", scheduleActive, () => {
            const last = loadLastScheduleRoute() || "/today";
            m.route.set(last);
          }),
          // Projects tab returns to the last-viewed projects sub-route, falling back to `/projects`.
          tab("/projects", "Projects", matchPrefix("/projects"), () => {
            const last = loadLastProjectsRoute() || "/projects";
            m.route.set(last);
          }),
          tab("/calendar", "Calendar", matchPrefix("/calendar")),
        ]),
        m(".tab-bar-spacer"),
        m(".shell-user-wide", userActions),
      ]),
      m(".tab-body", vnode.children),
    ]);
  },
};

function tab(href, label, active, onActivate) {
  // Mithril 2.3.8 has no `m.route.link` hook, so wire SPA navigation manually, bypassing the browser only on plain left-click.
  return m(
    "a.tab",
    {
      href,
      class: active ? "active" : "",
      onclick: (e) => {
        if (
          e.button !== 0 ||
          e.ctrlKey ||
          e.metaKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        if (onActivate) {
          onActivate();
        } else {
          m.route.set(href);
        }
      },
    },
    label
  );
}
