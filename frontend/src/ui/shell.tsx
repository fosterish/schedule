import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";

import * as session from "@state/session";
import {
  lastProjectsRoute,
  lastScheduleRoute,
  selectedItem,
  selectedTask,
  selectItem,
  selectTask,
} from "@state/uistate";

import { Toaster } from "./components/Toaster";
import s from "./shell.module.css";

// App chrome only: the tab bar and user menu. One route mounts at a time inside
// `children`; view state lives in signals so remounts are lossless. Hidden on
// the login route.
export function Shell({ children }: { children: ComponentChildren }): JSX.Element {
  const { path, route } = useLocation();

  // A selection belongs to its editing surface; a press anywhere outside that
  // surface clears it. Surfaces that deselect on their own (so a background tap
  // can also do more, e.g. drop a time cursor) mark themselves with the attr.
  useEffect(() => {
    function clearOnOutsidePress(e: PointerEvent): void {
      if (selectedItem.value == null && selectedTask.value == null) return;
      if ((e.target as Element | null)?.closest("[data-selection-surface]")) return;
      selectItem(null);
      selectTask(null);
    }
    document.addEventListener("pointerdown", clearOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", clearOnOutsidePress, true);
  }, []);

  if (path === "/login") return <>{children}</>;

  const user = session.user.value;
  const onSchedule = matches(path, ["/today", "/date", "/template"]);
  const onProjects = matches(path, ["/projects"]);
  const onCalendar = matches(path, ["/calendar"]);

  async function logout(): Promise<void> {
    await session.logout();
    route("/login");
  }

  const userActions = (
    <>
      {user && <span class={s.user}>{user.username}</span>}
      <button type="button" class={s.logout} onClick={() => void logout()}>
        Logout
      </button>
    </>
  );

  return (
    <div class={s.shell}>
      <header class={s.narrowBar}>{userActions}</header>
      <nav class={s.tabs}>
        <Tab label="Schedule" active={onSchedule} onClick={() => route(lastScheduleRoute.value ?? "/today")} />
        <Tab label="Projects" active={onProjects} onClick={() => route(lastProjectsRoute.value ?? "/projects")} />
        <Tab label="Calendar" active={onCalendar} onClick={() => route("/calendar")} />
        <span class={s.spacer} />
        <span class={s.wideUser}>{userActions}</span>
      </nav>
      <main class={s.body}>{children}</main>
      <Toaster />
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" class={active ? `${s.tab} ${s.active}` : s.tab} aria-current={active} onClick={onClick}>
      {label}
    </button>
  );
}

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}
