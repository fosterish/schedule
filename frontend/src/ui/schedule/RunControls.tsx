import type { JSX } from "preact";

import type { ScheduleId } from "@bindings/ScheduleId";
import type { RunFlags } from "@lib/schedule/run";
import * as scheduleOps from "@state/mutations/schedule";

import { PlayIcon, SkipIcon, StopIcon } from "@ui/components/icons";

import s from "./RunControls.module.css";

interface Props {
  scheduleId: ScheduleId | null;
  flags: RunFlags | null;
  // The cursor minute (play head), or the live clock when the cursor is unset.
  atMinute: number | null;
}

// Play / skip / stop for the live schedule; enablement comes from run.flags and
// each action commits the run transform at the cursor minute. With no live
// schedule the controls stay visible but disabled.
export function RunControls({ scheduleId, flags, atMinute }: Props): JSX.Element {
  const act = (action: "play" | "skip" | "stop") => () => {
    if (scheduleId != null && atMinute != null) scheduleOps.runAction(scheduleId, action, atMinute);
  };
  return (
    <div class={s.controls}>
      <button type="button" class={s.btn} disabled={!flags?.play.enabled} title="Play" onClick={act("play")}>
        <PlayIcon />
      </button>
      <button type="button" class={s.btn} disabled={!flags?.skip.enabled} title="Skip" onClick={act("skip")}>
        <SkipIcon />
      </button>
      <button type="button" class={s.btn} disabled={!flags?.stop.enabled} title="Stop" onClick={act("stop")}>
        <StopIcon />
      </button>
    </div>
  );
}
