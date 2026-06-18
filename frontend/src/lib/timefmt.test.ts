import { describe, expect, it } from "vitest";

import { fmtClock, parseClockToMin, parseDurationToMin } from "./timefmt";

describe("fmtClock", () => {
  it("formats within a day", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(485)).toBe("08:05");
    expect(fmtClock(1439)).toBe("23:59");
  });

  it("marks day overflow/underflow", () => {
    expect(fmtClock(1440)).toBe("00:00+1");
    expect(fmtClock(1500)).toBe("01:00+1");
    expect(fmtClock(2880)).toBe("00:00+2");
    expect(fmtClock(2940)).toBe("01:00+2");
    expect(fmtClock(-30)).toBe("23:30-1");
  });

  it("renders null as a dash", () => {
    expect(fmtClock(null)).toBe("\u2014");
  });

  it("formats 12-hour clock with AM/PM", () => {
    expect(fmtClock(0, true)).toBe("12:00 AM");
    expect(fmtClock(485, true)).toBe("8:05 AM");
    expect(fmtClock(720, true)).toBe("12:00 PM");
    expect(fmtClock(1350, true)).toBe("10:30 PM");
    expect(fmtClock(1439, true)).toBe("11:59 PM");
    expect(fmtClock(1500, true)).toBe("1:00 AM+1");
    expect(fmtClock(-30, true)).toBe("11:30 PM-1");
    expect(fmtClock(null, true)).toBe("\u2014");
  });
});

describe("parseClockToMin", () => {
  it("parses canonical HH:MM with day suffix", () => {
    expect(parseClockToMin("08:05")).toBe(485);
    expect(parseClockToMin("00:30+1")).toBe(1470);
    expect(parseClockToMin("23:00-1")).toBe(-60);
  });

  it("treats bare numbers as hours", () => {
    expect(parseClockToMin("8")).toBe(480);
    expect(parseClockToMin("10")).toBe(600);
    expect(parseClockToMin("8+1")).toBe(1920);
  });

  it("rolls hours past 23 into the next day", () => {
    expect(parseClockToMin("24:00")).toBe(1440);
    expect(fmtClock(parseClockToMin("24:00"))).toBe("00:00+1");
  });

  it("parses colon minutes but rejects duration unit suffixes", () => {
    expect(parseClockToMin(":135")).toBe(135);
    expect(parseClockToMin("25h")).toBeNull();
    expect(parseClockToMin("1h30m")).toBeNull();
  });

  it("parses 12-hour am/pm suffixes, ignoring spaces", () => {
    expect(parseClockToMin("10:30pm")).toBe(1350);
    expect(parseClockToMin("5 pm")).toBe(1020);
    expect(parseClockToMin("12am")).toBe(0);
    expect(parseClockToMin("12:30am")).toBe(30);
    expect(parseClockToMin("12pm")).toBe(720);
    expect(parseClockToMin("8 AM")).toBe(480);
    expect(parseClockToMin("0am")).toBeNull();
    expect(parseClockToMin("13pm")).toBeNull();
  });

  it("accepts the two-day ceiling expressed any number of ways", () => {
    expect(parseClockToMin("00:00+2")).toBe(2880);
    expect(parseClockToMin("24:00+1")).toBe(2880);
    expect(parseClockToMin("48:00")).toBe(2880);
  });

  it("rejects out-of-range and garbage", () => {
    expect(parseClockToMin("48:01")).toBeNull();
    expect(parseClockToMin("72:00")).toBeNull();
    expect(parseClockToMin("")).toBeNull();
    expect(parseClockToMin("nope")).toBeNull();
  });
});

describe("parseDurationToMin", () => {
  it("parses HH:MM, bare minutes, units, and colon", () => {
    expect(parseDurationToMin("01:30")).toBe(90);
    expect(parseDurationToMin("2")).toBe(2);
    expect(parseDurationToMin("2h")).toBe(120);
    expect(parseDurationToMin("90m")).toBe(90);
    expect(parseDurationToMin(":45")).toBe(45);
  });

  it("requires a positive duration", () => {
    expect(parseDurationToMin(":0")).toBeNull();
    expect(parseDurationToMin("")).toBeNull();
    expect(parseDurationToMin("nope")).toBeNull();
  });
});
