import type { JSX } from "preact";
import { useMemo } from "preact/hooks";

import * as commit from "@state/commit";
import * as history from "@state/history";

import { RedoIcon, UndoIcon } from "./icons";
import s from "./HistoryControls.module.css";

// Undo/redo for one editing context (schedule or project); button states track
// that context's stacks only.
export function HistoryControls({ context, disabled = false }: { context: history.Context; disabled?: boolean }): JSX.Element {
  const canUndo = useMemo(() => history.canUndo(context), [context]);
  const canRedo = useMemo(() => history.canRedo(context), [context]);
  return (
    <div class={s.group}>
      <button
        type="button"
        class={s.btn}
        title="Undo"
        disabled={disabled || !canUndo.value}
        onClick={() => commit.undo(context)}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        class={s.btn}
        title="Redo"
        disabled={disabled || !canRedo.value}
        onClick={() => commit.redo(context)}
      >
        <RedoIcon />
      </button>
    </div>
  );
}
