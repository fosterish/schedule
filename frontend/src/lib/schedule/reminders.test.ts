import { describe, expect, test } from "vitest";

import * as reminders from "@lib/schedule/reminders";

const DAY = 0;
const leads = { fixedMin: 10, dynamicMin: 0 };

function item(
  startMinute: number,
  fixedStart: boolean,
  title = "x",
  endMinute = startMinute + 60,
): reminders.ReminderItem {
  return { startMinute, endMinute, fixedStart, title };
}

describe("reminders.plan", () => {
  test("fixed-start items fire lead minutes before start", () => {
    const out = reminders.plan([item(600, true, "Standup")], 480, DAY, leads);
    expect(out).toEqual([
      {
        fireAtMs: 590 * 60_000,
        payload: { title: "Standup", body: "Starts in 10 min \u00b7 10:00 \u2013 11:00 (1h)" },
      },
    ]);
  });

  test("only the next dynamic-start item is scheduled", () => {
    const out = reminders.plan(
      [item(600, false, "a"), item(700, false, "b"), item(800, false, "c")],
      480,
      DAY,
      leads,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.payload.title).toBe("a");
    expect(out[0]!.payload.body).toBe("Starting now \u00b7 10:00 \u2013 11:00 (1h)");
  });

  test("past items and items whose lead window has passed are skipped", () => {
    const out = reminders.plan(
      [item(400, true), item(485, true), item(600, true)],
      480,
      DAY,
      leads,
    );
    // 400 already started; 485 - 10 = 475 <= now; only 600 survives.
    expect(out).toHaveLength(1);
    expect(out[0]!.fireAtMs).toBe(590 * 60_000);
  });

  test("mixes fixed items and the next dynamic, sorted by fire time", () => {
    const out = reminders.plan(
      [item(900, true, "fixed-late"), item(620, false, "dyn"), item(700, false, "dyn2")],
      480,
      DAY,
      leads,
    );
    expect(out.map((r) => r.payload.title)).toEqual(["dyn", "fixed-late"]);
  });

  test("dayStartMs offsets every fire time", () => {
    const base = 1_000_000;
    const out = reminders.plan([item(600, true)], 480, base, leads);
    expect(out[0]!.fireAtMs).toBe(base + 590 * 60_000);
  });
});
