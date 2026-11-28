import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, bookableDates, formatDuration, formatPrice, formatTime, isPhone, longDate, weekdayOf } from "./dates.js";

test("date helpers do not drift across months, years, or time zones", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(weekdayOf("2026-03-02"), 1);
  assert.equal(weekdayOf("2026-03-08"), 0);
  assert.equal(longDate("2026-03-03"), "Tuesday, March 3");
  assert.deepEqual(bookableDates("2026-03-30", 2), ["2026-03-30", "2026-03-31", "2026-04-01"]);
});

test("times, lengths, and prices read like a person wrote them", () => {
  assert.equal(formatTime("00:00"), "12:00 AM");
  assert.equal(formatTime("09:05"), "9:05 AM");
  assert.equal(formatTime("12:00"), "12:00 PM");
  assert.equal(formatTime("17:30"), "5:30 PM");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(60), "1 hr");
  assert.equal(formatDuration(90), "1 hr 30 min");
  assert.equal(formatPrice(35), "$35");
  assert.equal(formatPrice(12.5), "$12.50");
});

test("phone check matches the server rule", () => {
  assert.equal(isPhone("(555) 555-0199"), true);
  assert.equal(isPhone("+1 555 555 0199"), true);
  assert.equal(isPhone("555-0199"), false);
  assert.equal(isPhone("5555550199x"), false);
  assert.equal(isPhone(""), false);
});
