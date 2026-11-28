import assert from "node:assert/strict";
import { test } from "node:test";
import { agendaDays, CALENDAR_VIEWS, parseView, rangeLabel, SCHEDULE_DAYS, viewDays, viewStep } from "./calendar-views.ts";

test("the calendar offers schedule, day, 3 days and week", () => {
  assert.deepEqual(CALENDAR_VIEWS.map((v) => v.label), ["Schedule", "Day", "3 days", "Week"]);
});

test("a saved view is used, and anything else falls back to day", () => {
  assert.equal(parseView("week"), "week");
  assert.equal(parseView("3day"), "3day");
  assert.equal(parseView("month"), "day");
  assert.equal(parseView(null), "day");
  assert.equal(parseView(undefined), "day");
});

test("day shows one day and 3 days starts on the picked day", () => {
  assert.deepEqual(viewDays("day", "2026-11-27"), ["2026-11-27"]);
  assert.deepEqual(viewDays("3day", "2026-11-29"), ["2026-11-29", "2026-11-30", "2026-12-01"]);
});

test("week shows Sunday to Saturday around the picked day", () => {
  const days = viewDays("week", "2026-11-27"); // a Friday
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-11-22");
  assert.equal(days[6], "2026-11-28");
});

test("schedule looks ahead from the picked day, across a year end", () => {
  const days = viewDays("schedule", "2026-12-20");
  assert.equal(days.length, SCHEDULE_DAYS);
  assert.equal(days[0], "2026-12-20");
  assert.equal(days[SCHEDULE_DAYS - 1], "2027-01-18");
});

test("previous and next move by the size of the view", () => {
  assert.equal(viewStep("day"), 1);
  assert.equal(viewStep("3day"), 3);
  assert.equal(viewStep("week"), 7);
  assert.equal(viewStep("schedule"), 7);
});

test("a run of days gets a short name", () => {
  assert.equal(rangeLabel(["2026-11-22", "2026-11-28"]), "Nov 22 – 28, 2026");
  assert.equal(rangeLabel(["2026-11-29", "2026-11-30", "2026-12-01"]), "Nov 29 – Dec 1, 2026");
  assert.equal(rangeLabel(["2026-12-30", "2027-01-01"]), "Dec 30, 2026 – Jan 1, 2027");
});

test("the schedule list groups by day, in time order, and skips empty days", () => {
  const days = ["2026-11-27", "2026-11-28", "2026-11-29"];
  const bookings = [
    { id: 1, scheduled_date: "2026-11-29", start_time: "14:00" },
    { id: 2, scheduled_date: "2026-11-27", start_time: "15:00" },
    { id: 3, scheduled_date: "2026-11-27", start_time: "09:00" },
    { id: 4, scheduled_date: "2026-12-05", start_time: "09:00" }, // outside the days shown
  ];
  const blocks = [{ id: 9, blocked_date: "2026-11-27", start_time: "12:00" }];
  const list = agendaDays(days, bookings, blocks);
  assert.deepEqual(list.map((d) => d.date), ["2026-11-27", "2026-11-29"]);
  assert.deepEqual(
    list[0].items.map((i) => (i.kind === "booking" ? `a${i.booking.id}` : `b${i.block.id}`)),
    ["a3", "b9", "a2"],
  );
  assert.deepEqual(list[0].items[0], { kind: "booking", booking: bookings[2] });
});

test("the schedule list is empty when nothing is booked", () => {
  assert.deepEqual(agendaDays(["2026-11-27"], [], []), []);
});
