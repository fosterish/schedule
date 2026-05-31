import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmtClock,
  fmtDuration,
  parseClockToMin,
  parseDurationToMin,
} from "../src/components/time_parse.js";

// ---------- fmtClock / fmtDuration ----------

test("fmtClock pads and joins HH:MM", () => {
  assert.equal(fmtClock(0), "00:00");
  assert.equal(fmtClock(65), "01:05");
  assert.equal(fmtClock(7 * 60 + 30), "07:30");
});

test("fmtClock annotates cross-day values", () => {
  assert.equal(fmtClock(1440 + 15), "00:15+1");
  assert.equal(fmtClock(-30), "23:30-1");
});

test("fmtClock(null) returns em-dash sentinel", () => {
  assert.equal(fmtClock(null), "—");
});

test("fmtDuration pads HH:MM and never goes negative", () => {
  assert.equal(fmtDuration(null), "");
  assert.equal(fmtDuration(0), "00:00");
  assert.equal(fmtDuration(75), "01:15");
  assert.equal(fmtDuration(-5), "00:00");
});

// ---------- parseClockToMin: canonical forms ----------

test("parseClockToMin accepts canonical HH:MM", () => {
  assert.equal(parseClockToMin("07:30"), 7 * 60 + 30);
  assert.equal(parseClockToMin("00:00"), 0);
  assert.equal(parseClockToMin("23:59"), 23 * 60 + 59);
});

test("parseClockToMin accepts bare hour shorthand", () => {
  assert.equal(parseClockToMin("7"), 7 * 60);
  assert.equal(parseClockToMin("0"), 0);
  assert.equal(parseClockToMin("23"), 23 * 60);
});

test("parseClockToMin honours +1 / -1 day suffix", () => {
  assert.equal(parseClockToMin("01:30+1"), 1440 + 90);
  assert.equal(parseClockToMin("23:00-1"), -1440 + 23 * 60);
  assert.equal(parseClockToMin("7+1"), 1440 + 7 * 60);
});

test("parseClockToMin rejects out-of-range hours", () => {
  assert.equal(parseClockToMin("24:00"), null);
  assert.equal(parseClockToMin("99"), null);
});

test("parseClockToMin rejects malformed inputs", () => {
  assert.equal(parseClockToMin(""), null);
  assert.equal(parseClockToMin("abc"), null);
  assert.equal(parseClockToMin("12:60"), null);
});

// ---------- parseClockToMin: colon-prefixed minutes ----------

test("parseClockToMin: ':30' → 00:30", () => {
  assert.equal(parseClockToMin(":30"), 30);
});

test("parseClockToMin: ':135' → 02:15", () => {
  assert.equal(parseClockToMin(":135"), 135);
});

test("parseClockToMin: ':0' → 00:00", () => {
  assert.equal(parseClockToMin(":0"), 0);
});

test("parseClockToMin rejects bare-colon counts that overflow a day", () => {
  assert.equal(parseClockToMin(":1440"), null);
  assert.equal(parseClockToMin(":99999"), null);
});

// ---------- parseClockToMin: unit-suffixed ----------

test("parseClockToMin parses '2 hours'", () => {
  assert.equal(parseClockToMin("2 hours"), 120);
});

test("parseClockToMin parses '1hour5min'", () => {
  assert.equal(parseClockToMin("1hour5min"), 65);
});

test("parseClockToMin parses '30 minutes'", () => {
  assert.equal(parseClockToMin("30 minutes"), 30);
});

test("parseClockToMin parses '5hr, 2 mins'", () => {
  assert.equal(parseClockToMin("5hr, 2 mins"), 5 * 60 + 2);
});

test("parseClockToMin parses '3 hrs'", () => {
  assert.equal(parseClockToMin("3 hrs"), 180);
});

test("parseClockToMin parses '120 min'", () => {
  assert.equal(parseClockToMin("120 min"), 120);
});

test("parseClockToMin treats short unit aliases interchangeably", () => {
  assert.equal(parseClockToMin("5h"), 5 * 60);
  assert.equal(parseClockToMin("45m"), 45);
  assert.equal(parseClockToMin("1H 5M"), 65);
  assert.equal(parseClockToMin("2 HOURS, 30 MINUTES"), 150);
});

test("parseClockToMin rejects unknown units and stray text", () => {
  assert.equal(parseClockToMin("2 days"), null);
  assert.equal(parseClockToMin("2 hr foo"), null);
  assert.equal(parseClockToMin("hour"), null);
});

test("parseClockToMin rejects unit values that overflow a day", () => {
  assert.equal(parseClockToMin("24 hours"), null);
  assert.equal(parseClockToMin("1440 min"), null);
});

// ---------- parseDurationToMin ----------

test("parseDurationToMin accepts canonical HH:MM", () => {
  assert.equal(parseDurationToMin("01:30"), 90);
  assert.equal(parseDurationToMin("00:05"), 5);
});

test("parseDurationToMin accepts bare hours", () => {
  assert.equal(parseDurationToMin("2"), 120);
});

test("parseDurationToMin: ':30' → 30", () => {
  assert.equal(parseDurationToMin(":30"), 30);
});

test("parseDurationToMin: ':135' → 135 (02:15)", () => {
  assert.equal(parseDurationToMin(":135"), 135);
});

test("parseDurationToMin parses unit-suffixed combos", () => {
  assert.equal(parseDurationToMin("2 hours"), 120);
  assert.equal(parseDurationToMin("1hour5min"), 65);
  assert.equal(parseDurationToMin("30 minutes"), 30);
  assert.equal(parseDurationToMin("5hr, 2 mins"), 302);
  assert.equal(parseDurationToMin("3 hrs"), 180);
  assert.equal(parseDurationToMin("120 min"), 120);
});

test("parseDurationToMin rejects non-positive results", () => {
  assert.equal(parseDurationToMin(":0"), null);
  assert.equal(parseDurationToMin("0 min"), null);
});

test("parseDurationToMin rejects empty / garbage / unknown units", () => {
  assert.equal(parseDurationToMin(""), null);
  assert.equal(parseDurationToMin("abc"), null);
  assert.equal(parseDurationToMin("2 weeks"), null);
});

test("parseDurationToMin permits long unit-driven durations", () => {
  // The HH:MM form caps hours at 99 (\\d{1,2}), but unit form has no cap beyond the integer parse.
  assert.equal(parseDurationToMin("180 min"), 180);
  assert.equal(parseDurationToMin("25 hours"), 25 * 60);
});
