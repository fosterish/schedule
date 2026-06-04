import m from "mithril";
import { api, onApiMutation } from "./api.js";

// Per-context undo/redo availability. Keys mirror the backend's `history.context` CHECK constraint values.
export const historyState = {
  schedule: { can_undo: false, can_redo: false },
  project: { can_undo: false, can_redo: false },
};

const listeners = new Set();

// Refresh availability for one context, or every context when omitted.
export async function refreshHistory(context) {
  const contexts = context ? [context] : Object.keys(historyState);
  await Promise.all(
    contexts.map(async (ctx) => {
      try {
        const s = await api.historyState(ctx);
        historyState[ctx].can_undo = !!s.can_undo;
        historyState[ctx].can_redo = !!s.can_redo;
      } catch (_) {
        /* leave previous values; the next mutation/poll will retry */
      }
    })
  );
  m.redraw();
}

export async function doUndo(context) {
  if (!context) throw new Error("doUndo: context required");
  const slot = historyState[context];
  if (!slot || !slot.can_undo) return;
  try {
    await api.historyUndo(context);
  } catch (e) {
    console.error("Undo failed:", e);
    return;
  }
  await refreshHistory(context);
  notifyConsumers(context);
}

export async function doRedo(context) {
  if (!context) throw new Error("doRedo: context required");
  const slot = historyState[context];
  if (!slot || !slot.can_redo) return;
  try {
    await api.historyRedo(context);
  } catch (e) {
    console.error("Redo failed:", e);
    return;
  }
  await refreshHistory(context);
  notifyConsumers(context);
}

// Subscribers receive the context that changed so they can decide whether to reload.
export function onHistoryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyConsumers(context) {
  for (const fn of listeners) {
    try {
      fn(context);
    } catch (_) {}
  }
}

// Active undo/redo context is picked from the current route; unrecognized routes return null.
function currentContext() {
  const route = (m.route.get() || "").split("?")[0];
  if (
    route === "/today" ||
    route.startsWith("/template/") ||
    route.startsWith("/date/")
  ) {
    return "schedule";
  }
  if (route === "/projects" || /^\/projects\/\d+$/.test(route)) {
    return "project";
  }
  return null;
}

function onKeydown(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const ctx = currentContext();
  if (!ctx) return;
  if (e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    doUndo(ctx);
  } else if ((e.key === "Z" && e.shiftKey) || (e.key === "y" && !e.shiftKey)) {
    e.preventDefault();
    doRedo(ctx);
  }
}

let installed = false;
export function installHistoryGlobal() {
  if (installed) return;
  installed = true;
  // Initial fetch covers every context so any tab's first paint shows correct toolbar state.
  refreshHistory();
  document.addEventListener("keydown", onKeydown);
  onApiMutation((url) => {
    if (url.includes("/api/history/")) return;
    // Heuristic mapping a mutation URL to its context; misclassifying only costs a cheap wasted refetch.
    const ctx =
      url.includes("/api/projects") ||
      url.includes("/api/tasks") ||
      url.includes("/api/tasks/")
        ? "project"
        : url.includes("/api/schedules") ||
            url.includes("/api/schedule_items") ||
            url.includes("/api/calendar/") ||
            url.includes("/api/day")
          ? "schedule"
          : null;
    if (!ctx) return;
    // Optimistic local update for instant toolbar feedback; background refetch reconciles, and we clear redo to match the backend.
    const slot = historyState[ctx];
    if (slot && (!slot.can_undo || slot.can_redo)) {
      slot.can_undo = true;
      slot.can_redo = false;
      m.redraw();
    }
    refreshHistory(ctx);
  });
}
