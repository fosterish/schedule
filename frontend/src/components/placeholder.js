// Client-side placeholder row spliced into the items array during popup insert; never sent to the backend until Add.

import { randomItemColor } from "../palette.js";

/// Sentinel placeholder id; negative because real AUTOINCREMENT ids are always positive, so id-based checks can disambiguate.
export const PLACEHOLDER_ID = -1;

/// Default placeholder duration target; 60 matches the backend's NewScheduleItem.duration_target default.
export const PLACEHOLDER_DURATION_DEFAULT = 60;

/// Patch start_min on an anchored placeholder, shifting end_min by the same delta so the span is preserved.
export function anchoredPlaceholderStartPatch(draft, newStartMin) {
  const dur = Math.max(1, draft.end_min - draft.start_min);
  return { start_min: newStartMin, end_min: newStartMin + dur };
}

export function makePlaceholderDraft(scheduleId, _cursorMin) {
  return {
    _placeholder: true,
    id: PLACEHOLDER_ID,
    schedule_id: scheduleId,
    use_inline: true,
    inline_label: null,
    inline_description: null,
    color: randomItemColor(),
    start_min: null,
    end_min: null,
    duration_target: PLACEHOLDER_DURATION_DEFAULT,
    project_id: null,
    project_rank: 1,
    task_id: null,
    task_rank: 1,
  };
}
