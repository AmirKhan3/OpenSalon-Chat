import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate, parseDate, shiftDate, today } from "./dates.ts";

/** Run `fn` as if the browser were in `zone`. Node re-reads TZ per call. */
function inZone(zone: string, fn: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    process.env.TZ = previous;
  }
}

const AHEAD_OF_UTC = ["Europe/Rome", "Australia/Sydney", "Asia/Kolkata"];
const BEHIND_UTC = ["America/New_York", "America/Los_Angeles"];

test("shiftDate moves a day in every zone", () => {
  for (const zone of [...AHEAD_OF_UTC, ...BEHIND_UTC, "UTC"]) {
    inZone(zone, () => {
      // The regression in issue #5: this returned "2026-08-29" east of UTC,
      // so the calendar's next-day button silently did nothing.
      assert.equal(shiftDate("2026-08-29", 1), "2026-08-30", zone);
      assert.equal(shiftDate("2026-08-29", -1), "2026-08-28", zone);
    });
  }
});

test("shiftDate crosses month, year and leap-day boundaries", () => {
  assert.equal(shiftDate("2026-08-31", 1), "2026-09-01");
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDate("2028-02-28", 1), "2028-02-29");
});

test("today() is the user's local day, not the UTC day", () => {
  // 21:30 in New York is already tomorrow in UTC. A salon is still open.
  inZone("America/New_York", () => {
    assert.equal(today(new Date("2026-09-04T01:30:00Z")), "2026-09-03");
  });
  // 01:30 in Rome is still yesterday in UTC.
  inZone("Europe/Rome", () => {
    assert.equal(today(new Date("2026-09-03T23:30:00Z")), "2026-09-04");
  });
});

test("shiftDate survives zones that change the clock at midnight", () => {
  // Santiago springs forward at 00:00, so local midnight does not exist that
  // night; a midnight-anchored implementation slips a day here.
  inZone("America/Santiago", () => {
    assert.equal(shiftDate("2026-09-05", 1), "2026-09-06");
    assert.equal(shiftDate("2026-09-06", -1), "2026-09-05");
  });
});

test("parseDate round-trips through formatDate", () => {
  for (const zone of [...AHEAD_OF_UTC, ...BEHIND_UTC]) {
    inZone(zone, () => {
      assert.equal(formatDate(parseDate("2026-08-29")), "2026-08-29", zone);
    });
  }
});

test("a week runs Sunday to Saturday around the date", async () => {
  const { weekOf } = await import("./dates.ts");
  assert.deepEqual(weekOf("2026-11-27"), ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"]);
  assert.equal(weekOf("2026-11-22")[0], "2026-11-22");
  assert.equal(weekOf("2026-11-28")[6], "2026-11-28");
  // A week can cross a month and a year.
  assert.deepEqual(weekOf("2027-01-01").slice(0, 2), ["2026-12-27", "2026-12-28"]);
});

test("months shift to the first day, across years", async () => {
  const { shiftMonth } = await import("./dates.ts");
  assert.equal(shiftMonth("2026-11-27", 0), "2026-11-01");
  assert.equal(shiftMonth("2026-11-27", 2), "2027-01-01");
  assert.equal(shiftMonth("2026-01-31", -1), "2025-12-01");
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-01");
});

test("a month grid holds whole weeks that cover the month", async () => {
  const { monthGrid } = await import("./dates.ts");
  const november = monthGrid("2026-11-27");
  assert.equal(november.length, 5);
  assert.equal(november[0][0], "2026-11-01");
  assert.equal(november[4][6], "2026-12-05");
  // February 2026 starts on a Sunday and fits four weeks.
  assert.equal(monthGrid("2026-02-10").length, 4);
  // August 2026 starts on a Saturday and needs six.
  const august = monthGrid("2026-08-15");
  assert.equal(august.length, 6);
  assert.equal(august[0][6], "2026-08-01");
  assert.ok(august[5].includes("2026-08-31"));
  for (const week of august) assert.equal(week.length, 7);
});

test("a friendly date is short, and shows the year only when it is not this year", async () => {
  const { friendlyDate } = await import("./dates.ts");
  const now = new Date(2026, 10, 27, 9);
  assert.equal(friendlyDate("2026-11-27", now), "Fri, Nov 27");
  assert.equal(friendlyDate("2026-01-05", now), "Mon, Jan 5");
  assert.equal(friendlyDate("2027-01-02", now), "Sat, Jan 2, 2027");
  assert.equal(friendlyDate("2025-12-31", now), "Wed, Dec 31, 2025");
  // Text that is not a date is shown as it is.
  assert.equal(friendlyDate("soon", now), "soon");
});
