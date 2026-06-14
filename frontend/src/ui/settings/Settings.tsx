import type { JSX } from "preact";

import * as layout from "@lib/schedule/layout";
import { fmtClock, fmtDurationHuman, parseClockToMin, parseDurationToMin } from "@lib/timefmt";
import * as settings from "@state/settings";
import { pushToast } from "@state/toast";
import { StepperField } from "@ui/components/StepperField";

import s from "./Settings.module.css";

const LEAD_STEP = 5;
const CLOCK_STEP = 15;

// Snap to the next grid line in the step direction, or a full step when aligned.
function snap(value: number, dir: number, step: number): number {
  if (value % step === 0) return value + dir * step;
  return dir > 0 ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

export function Settings(): JSX.Element {
  const enabled = settings.notificationsEnabled.value;
  const supported = settings.pushSupported();

  async function toggleNotifications(): Promise<void> {
    if (!(await settings.toggleNotifications())) {
      pushToast("Notifications are blocked. Enable them in your browser settings.", "error");
    }
  }

  function commitLead(set: (n: number) => void, text: string): void {
    const v = parseDurationToMin(text);
    if (v != null && v >= 0) set(v);
  }

  function stepLead(value: number, set: (n: number) => void, dir: number): void {
    set(Math.max(0, snap(value, dir, LEAD_STEP)));
  }

  function commitStart(text: string): void {
    const v = parseClockToMin(text);
    if (v != null && v >= 0 && v <= layout.MAX_SCHEDULE_START) settings.setDefaultStart(v);
  }

  function commitEnd(text: string): void {
    const v = parseClockToMin(text);
    const start = settings.defaultStart.value;
    if (v != null && v > start && v <= layout.FRAME_END) settings.setDefaultEnd(v);
  }

  function stepStart(dir: number): void {
    const v = snap(settings.defaultStart.value, dir, CLOCK_STEP);
    if (v >= 0 && v <= layout.MAX_SCHEDULE_START) settings.setDefaultStart(v);
  }

  function stepEnd(dir: number): void {
    const start = settings.defaultStart.value;
    const v = snap(settings.defaultEnd.value, dir, CLOCK_STEP);
    if (v > start && v <= layout.FRAME_END) settings.setDefaultEnd(v);
  }

  return (
    <div class={s.screen}>
      <header class={s.header}>
        <h1 class={s.heading}>Settings</h1>
      </header>
      <div class={s.body}>
        <section class={s.section}>
          <h2 class={s.sectionTitle}>Notifications</h2>
          <label class={s.row}>
            <span class={s.rowLabel}>Enable on this device</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              class={enabled ? `${s.switch} ${s.on}` : s.switch}
              disabled={!supported}
              onClick={() => void toggleNotifications()}
            >
              <span class={s.knob} />
            </button>
          </label>
          {supported ? (
            <p class={s.hint}>Reminders and lead times are shared across all your devices.</p>
          ) : (
            <p class={s.hint}>This device doesn’t support notifications.</p>
          )}
          <SteppedField
            label="Lead before fixed-start items"
            value={fmtDurationHuman(settings.leadFixedMin.value)}
            ariaLabel="Lead time for fixed-start items"
            onCommit={(t) => commitLead(settings.setLeadFixedMin, t)}
            onStep={(d) => stepLead(settings.leadFixedMin.value, settings.setLeadFixedMin, d)}
          />
          <SteppedField
            label="Lead before the next flexible item"
            value={fmtDurationHuman(settings.leadDynamicMin.value)}
            ariaLabel="Lead time for the next flexible item"
            onCommit={(t) => commitLead(settings.setLeadDynamicMin, t)}
            onStep={(d) => stepLead(settings.leadDynamicMin.value, settings.setLeadDynamicMin, d)}
          />
        </section>

        <section class={s.section}>
          <h2 class={s.sectionTitle}>New schedule defaults</h2>
          <p class={s.hint}>The time range new days and templates start with.</p>
          <SteppedField
            label="Start"
            value={fmtClock(settings.defaultStart.value)}
            ariaLabel="Default schedule start"
            onCommit={commitStart}
            onStep={stepStart}
          />
          <SteppedField
            label="End"
            value={fmtClock(settings.defaultEnd.value)}
            ariaLabel="Default schedule end"
            onCommit={commitEnd}
            onStep={stepEnd}
          />
        </section>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  ariaLabel: string;
  onCommit: (text: string) => void;
  onStep: (delta: number) => void;
}

function SteppedField({ label, value, ariaLabel, onCommit, onStep }: FieldProps): JSX.Element {
  return (
    <div class={s.row}>
      <span class={s.rowLabel}>{label}</span>
      <StepperField value={value} onCommit={onCommit} ariaLabel={ariaLabel} onStep={onStep} bordered />
    </div>
  );
}
