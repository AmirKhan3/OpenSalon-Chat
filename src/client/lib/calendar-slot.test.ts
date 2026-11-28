import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarSlotMinutes, formatCalendarTime, inkOn } from "./calendar-slot.ts";

test("calendar clicks round to the nearest 15-minute slot", () => {
  const dayStart = 7 * 60;
  const dayEnd = 21 * 60;
  const height = 14 * 64;
  const tenSeventeenOffset = ((10 * 60 + 17 - dayStart) / (dayEnd - dayStart)) * height;

  assert.equal(calendarSlotMinutes(tenSeventeenOffset, height, dayStart, dayEnd), 10 * 60 + 15);
  assert.equal(formatCalendarTime(10 * 60 + 15), "10:15");
});

test("calendar clicks stay inside the visible booking day", () => {
  const dayStart = 7 * 60;
  const dayEnd = 21 * 60;

  assert.equal(calendarSlotMinutes(-50, 896, dayStart, dayEnd), dayStart);
  assert.equal(calendarSlotMinutes(1000, 896, dayStart, dayEnd), dayEnd - 15);
  assert.equal(formatCalendarTime(dayEnd - 15), "20:45");
});

test("a collapsed calendar safely falls back to opening time", () => {
  assert.equal(calendarSlotMinutes(100, 0, 420, 1260), 420);
});

test("clock times read like a phone calendar", async () => {
  const { formatClock, formatRange } = await import("./calendar-slot.ts");
  assert.equal(formatClock("09:00"), "9 AM");
  assert.equal(formatClock("13:30"), "1:30 PM");
  assert.equal(formatClock("00:05"), "12:05 AM");
  assert.equal(formatClock("12:00"), "12 PM");
  assert.equal(formatClock("09:15", false), "9:15");
  assert.equal(formatClock("soon"), "soon");
  assert.equal(formatRange("09:00", "09:30"), "9 – 9:30 AM");
  assert.equal(formatRange("11:30", "12:15"), "11:30 AM – 12:15 PM");
  assert.equal(formatRange("14:00", "15:00"), "2 – 3 PM");
});

test("text on a colour block stays readable", async () => {
  const { inkOn } = await import("./calendar-slot.ts");
  assert.equal(inkOn("#0b6e99"), "#ffffff");
  assert.equal(inkOn("#000"), "#ffffff");
  assert.equal(inkOn("#fde047"), "#1d1916");
  assert.equal(inkOn("#c4912f"), "#1d1916");
  assert.equal(inkOn("#3a4a5c"), "#ffffff");
  assert.equal(inkOn("#FFFFFF"), "#1d1916");
  assert.equal(inkOn("not a colour"), "#ffffff");
});

test("text on a missing colour is white", () => {
  assert.equal(inkOn(null), "#ffffff");
  assert.equal(inkOn(undefined), "#ffffff");
});
