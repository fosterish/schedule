import { computed, signal } from "@preact/signals";

import type { Operation } from "@bindings/Operation";

// Undo/redo are kept per editing context so a project edit can't undo a
// schedule edit. Each stack entry is an inverse op batch (see commit.ts).
// "settings" mutations sync through the same path but have no undo UI.
export type Context = "schedule" | "project" | "settings";

interface Stacks {
  undo: Operation[][];
  redo: Operation[][];
}

const scheduleStacks = signal<Stacks>({ undo: [], redo: [] });
const projectStacks = signal<Stacks>({ undo: [], redo: [] });
const settingsStacks = signal<Stacks>({ undo: [], redo: [] });

function stackOf(context: Context) {
  if (context === "schedule") return scheduleStacks;
  return context === "project" ? projectStacks : settingsStacks;
}

// A fresh edit: push its inverse and drop the redo branch.
export function recordUndo(context: Context, inverse: Operation[]): void {
  const sig = stackOf(context);
  sig.value = { undo: [...sig.value.undo, inverse], redo: [] };
}

// Redo keeps the undo branch intact (used when re-applying a redone batch).
export function pushUndo(context: Context, inverse: Operation[]): void {
  const sig = stackOf(context);
  sig.value = { undo: [...sig.value.undo, inverse], redo: sig.value.redo };
}

export function pushRedo(context: Context, inverse: Operation[]): void {
  const sig = stackOf(context);
  sig.value = { undo: sig.value.undo, redo: [...sig.value.redo, inverse] };
}

export function popUndo(context: Context): Operation[] | null {
  const sig = stackOf(context);
  const top = sig.value.undo.at(-1);
  if (!top) return null;
  sig.value = { undo: sig.value.undo.slice(0, -1), redo: sig.value.redo };
  return top;
}

export function popRedo(context: Context): Operation[] | null {
  const sig = stackOf(context);
  const top = sig.value.redo.at(-1);
  if (!top) return null;
  sig.value = { undo: sig.value.undo, redo: sig.value.redo.slice(0, -1) };
  return top;
}

// Discard every context's stacks on logout.
export function clear(): void {
  scheduleStacks.value = { undo: [], redo: [] };
  projectStacks.value = { undo: [], redo: [] };
  settingsStacks.value = { undo: [], redo: [] };
}

export const canUndo = (context: Context) =>
  computed(() => stackOf(context).value.undo.length > 0);

export const canRedo = (context: Context) =>
  computed(() => stackOf(context).value.redo.length > 0);
