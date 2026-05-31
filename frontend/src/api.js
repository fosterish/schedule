import m from "mithril";

const mutationListeners = new Set();
export function onApiMutation(fn) {
  mutationListeners.add(fn);
  return () => mutationListeners.delete(fn);
}

async function request(method, url, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    if (!location.pathname.startsWith("/login")) {
      m.route.set("/login");
    }
    throw new AuthError();
  }
  if (res.status === 204) {
    if (method !== "GET") notifyMutationListeners(url, method);
    return null;
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave parsed null */
  }
  if (!res.ok) {
    const msg = (parsed && parsed.error) || text || res.statusText;
    throw new ApiError(msg, res.status, parsed);
  }
  if (method !== "GET") notifyMutationListeners(url, method);
  return parsed;
}

function notifyMutationListeners(url, method) {
  for (const fn of mutationListeners) {
    try {
      fn(url, method);
    } catch (_) {}
  }
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
    this.status = 401;
  }
}

// Builds the `/api/day/today/<verb>` URL, optionally appending the `at_min` query param.
function runUrl(verb, atMin) {
  const base = `/api/day/today/${verb}`;
  if (atMin == null) return base;
  return `${base}?at_min=${encodeURIComponent(atMin)}`;
}

export const api = {
  health: () => request("GET", "/api/health"),
  me: () => request("GET", "/api/auth/me"),
  login: (username, password) =>
    request("POST", "/api/auth/login", { username, password }),
  logout: () => request("POST", "/api/auth/logout"),

  // projects
  listProjects: () => request("GET", "/api/projects"),
  getProject: (id) => request("GET", `/api/projects/${id}`),
  createProject: (body) => request("POST", "/api/projects", body || {}),
  patchProject: (id, body) => request("PATCH", `/api/projects/${id}`, body),
  archiveProject: (id) => request("POST", `/api/projects/${id}/archive`),
  deleteProject: (id) => request("DELETE", `/api/projects/${id}`),

  // tasks
  listTasks: (projectId) => request("GET", `/api/projects/${projectId}/tasks`),
  createTask: (projectId, body) =>
    request("POST", `/api/projects/${projectId}/tasks`, body || {}),
  // Bulk-deletes all completed subtasks in one transaction (single composite undo entry).
  deleteCompletedTasks: (projectId) =>
    request("DELETE", `/api/projects/${projectId}/tasks/completed`),
  getTask: (id) => request("GET", `/api/tasks/${id}`),
  patchTask: (id, body) => request("PATCH", `/api/tasks/${id}`, body),
  deleteTask: (id) => request("DELETE", `/api/tasks/${id}`),
  completeTask: (id) => request("POST", `/api/tasks/${id}/complete`),
  uncompleteTask: (id) => request("POST", `/api/tasks/${id}/uncomplete`),
  reorderTask: (id, after_task_id) =>
    request("POST", `/api/tasks/${id}/reorder`, { after_task_id }),
  listDeps: (id) => request("GET", `/api/tasks/${id}/dependencies`),
  addDep: (id, blocker_id) =>
    request("POST", `/api/tasks/${id}/dependencies`, { blocker_id }),
  removeDep: (id, blocker_id) =>
    request("DELETE", `/api/tasks/${id}/dependencies/${blocker_id}`),

  // schedules
  listSchedules: () => request("GET", "/api/schedules"),
  getSchedule: (id) => request("GET", `/api/schedules/${id}`),
  createSchedule: (body) => request("POST", "/api/schedules", body || {}),
  patchSchedule: (id, body) => request("PATCH", `/api/schedules/${id}`, body),
  deleteSchedule: (id) => request("DELETE", `/api/schedules/${id}`),
  scheduleLayout: (id) => request("GET", `/api/schedules/${id}/layout`),
  scheduleLayouts: (ids) => {
    const cleaned = Array.from(new Set((ids || []).filter((x) => x != null)));
    if (cleaned.length === 0) return Promise.resolve({});
    const q = encodeURIComponent(cleaned.join(","));
    return request("GET", `/api/schedules/layouts?ids=${q}`);
  },

  // schedule items
  listItems: (scheduleId) =>
    request("GET", `/api/schedules/${scheduleId}/items`),
  // Atomic insert: backend applies reorders and inserts the row in one transaction (one undo entry).
  insertItemAtomic: (scheduleId, body) =>
    request(
      "POST",
      `/api/schedules/${scheduleId}/items/insert`,
      body || {}
    ),
  patchItem: (id, body) => request("PATCH", `/api/schedule_items/${id}`, body),
  deleteItem: (id) => request("DELETE", `/api/schedule_items/${id}`),
  reorderItem: (id, after_item_id, anchor_updates) =>
    request("POST", `/api/schedule_items/${id}/reorder`, {
      after_item_id,
      ...(anchor_updates && anchor_updates.length
        ? { anchor_updates }
        : {}),
    }),

  // calendar
  getWeekdays: () => request("GET", "/api/calendar/weekdays"),
  putWeekdays: (bindings) =>
    request("PUT", "/api/calendar/weekdays", { bindings }),
  getWeekday: (w) => request("GET", `/api/calendar/weekdays/${w}`),
  createWeekdayTemplate: (w) =>
    request("POST", `/api/calendar/weekdays/${w}/create`),
  getOverride: (date) => request("GET", `/api/calendar/overrides/${date}`),
  getOverridesRange: (start, end) =>
    request(
      "GET",
      `/api/calendar/overrides?start=${encodeURIComponent(
        start
      )}&end=${encodeURIComponent(end)}`
    ),
  putOverride: (date, schedule_id) =>
    request("POST", `/api/calendar/overrides/${date}`, { schedule_id }),
  deleteOverride: (date) =>
    request("DELETE", `/api/calendar/overrides/${date}`),
  createOverride: (date) =>
    request("POST", `/api/calendar/overrides/${date}/create`),
  forkWeekdayTemplate: (date) =>
    request("POST", `/api/calendar/overrides/${date}/fork-weekday-template`),

  // day
  day: (date) =>
    request("GET", `/api/day${date ? "?date=" + encodeURIComponent(date) : ""}`),
  // `atMin` overrides the server's current minute, letting the action run against a client-chosen time.
  todayPlay: (atMin) => request("POST", runUrl("play", atMin)),
  todayStop: (atMin) => request("POST", runUrl("stop", atMin)),
  todaySkip: (atMin) => request("POST", runUrl("skip", atMin)),

  // Every history wrapper requires an explicit `context` ("schedule" or "project"); the server rejects requests without one.
  historyState: (context) =>
    request(
      "GET",
      `/api/history/state?context=${encodeURIComponent(context)}`
    ),
  historyUndo: (context) =>
    request(
      "POST",
      `/api/history/undo?context=${encodeURIComponent(context)}`
    ),
  historyRedo: (context) =>
    request(
      "POST",
      `/api/history/redo?context=${encodeURIComponent(context)}`
    ),
};
