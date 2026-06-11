import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { LocationProvider, Route, Router, useLocation } from "preact-iso";

import * as session from "@state/session";

import { Calendar } from "./calendar";
import { Loading } from "./components/Loading";
import { Login } from "./login/Login";
import { ProjectDetail, ProjectsList } from "./projects";
import { ScheduleDate, ScheduleTemplate, ScheduleToday } from "./schedule";
import { Settings } from "./settings";
import { Shell } from "./shell";

const NotFound = (): JSX.Element => <div style={{ padding: 16 }}>Not found</div>;

function Index(): null {
  const { route } = useLocation();
  useEffect(() => route("/today", true), []);
  return null;
}

// Holds rendering until the session is known, then gates everything but /login
// behind an authenticated user.
function AuthGate({ children }: { children: ComponentChildren }): JSX.Element | null {
  const { path, route } = useLocation();
  const booted = session.booted.value;
  const user = session.user.value;
  const blocked = user == null && path !== "/login";

  useEffect(() => {
    if (booted && blocked) route("/login", true);
  }, [booted, blocked, path]);

  if (!booted || blocked) return null;
  return <>{children}</>;
}

// Holds the app behind a spinner during a fresh login's first data load, so the
// user never sees an empty schedule flash before the cache/pull arrives.
function Loaded({ children }: { children: ComponentChildren }): JSX.Element {
  if (session.loadingData.value) return <Loading />;
  return <>{children}</>;
}

export function App(): JSX.Element {
  return (
    <LocationProvider>
      <AuthGate>
        <Loaded>
          <Shell>
            <Router>
              <Route path="/" component={Index} />
              <Route path="/today" component={ScheduleToday} />
              <Route path="/date/:date" component={ScheduleDate} />
              <Route path="/template/:id" component={ScheduleTemplate} />
              <Route path="/projects" component={ProjectsList} />
              <Route path="/projects/:id" component={ProjectDetail} />
              <Route path="/calendar" component={Calendar} />
              <Route path="/settings" component={Settings} />
              <Route path="/login" component={Login} />
              <Route default component={NotFound} />
            </Router>
          </Shell>
        </Loaded>
      </AuthGate>
    </LocationProvider>
  );
}
