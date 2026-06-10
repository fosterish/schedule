import { describe, expect, it } from "vitest";

import { fmtClock, fmtDuration, parseClockToMin, parseDurationToMin } from "./timefmt";

describe("fmtClock", () => {
  it("formats within a day", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(485)).toBe("08:05");
    expect(fmtClock(1439)).toBe("23:59");
  });

  it("marks day overflow/underflow", () => {
    expect(fmtClock(1440)).toBe("00:00+1");
    expect(fmtClock(1500)).toBe("01:00+1");
    expect(fmtClock(-30)).toBe("23:30-1");
  });

  it("renders null as a dash", () => {
    expect(fmtClock(null)).toBe("\u2014");
  });
});

describe("fmtDuration", () => {
  it("formats hours and minutes", () => {
    expect(fmtDuration(0)).toBe("00:00");
    expect(fmtDuration(90)).toBe("01:30");
  });

  it("clamps negatives and renders null as empty", () => {
    expect(fmtDuration(-5)).toBe("00:00");
    expect(fmtDuration(null)).toBe("");
  });
});

describe("parseClockToMin", () => {
  it("parses canonical HH:MM with day suffix", () => {
    expect(parseClockToMin("08:05")).toBe(485);
    expect(parseClockToMin("00:30+1")).toBe(1470);
    expect(parseClockToMin("23:00-1")).toBe(-60);
  });

  it("parses bare hours", () => {
    expect(parseClockToMin("8")).toBe(480);
    expect(parseClockToMin("8+1")).toBe(1920);
  });

  it("parses flexible forms within a day", () => {
    expect(parseClockToMin(":135")).toBe(135);
    expect(parseClockToMin("1h30m")).toBe(90);
  });

  it("rejects out-of-range and garbage", () => {
    expect(parseClockToMin("24:00")).toBeNull();
    expect(parseClockToMin("")).toBeNull();
    expect(parseClockToMin("nope")).toBeNull();
    expect(parseClockToMin("1500")).toBeNull();
  });
});

describe("parseDurationToMin", () => {
  it("parses HH:MM, bare hours, units, and colon", () => {
    expect(parseDurationToMin("01:30")).toBe(90);
    expect(parseDurationToMin("2")).toBe(120);
    expect(parseDurationToMin("90m")).toBe(90);
    expect(parseDurationToMin(":45")).toBe(45);
  });

  it("requires a positive duration", () => {
    expect(parseDurationToMin(":0")).toBeNull();
    expect(parseDurationToMin("")).toBeNull();
    expect(parseDurationToMin("nope")).toBeNull();
  });
});
