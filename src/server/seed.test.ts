import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";

const db = await import("./db.js");
const { ensureSeeded, planBusyDay, seedBusyShop } = await import("./seed.js");
const { setShopClock, timeToMinutes } = await import("./shoptime.js");
const { incomeReport, bookingReport } = await import("./reports.js");
const { defaultSettings } = await import("./settings.js");

after(() => { setShopClock(); return db.closeDB(); });

// Wednesday 11 March 2026, 14:00 in New York.
const NOW = { date: "2026-03-11", time: "14:00", minutes: 14 * 60 };
const atNow = () => new Date("2026-03-11T18:00:00Z");
const SERVICES = [{ id: 1, price: 35, duration: 30 }, { id: 2, price: 40, duration: 45 }, { id: 3, price: 15, duration: 15 }];
const OPEN = { closed: false, open: "09:00", close: "18:00" };

function overlaps(list: { start: number; end: number }[]): boolean {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  return sorted.some((v, i) => i > 0 && v.start < sorted[i - 1].end);
}

test("a busy day is full, stays inside opening hours, and keeps lunch and taken times free", () => {
  const taken = [{ start: 10 * 60, end: 11 * 60 }];
  const day = planBusyDay("2026-03-10", OPEN, NOW, SERVICES, 30, taken);
  assert.ok(day.length >= 8, `only ${day.length} visits`);
  assert.ok(day.every((v) => v.start >= 9 * 60 && v.end <= 18 * 60 && v.end - v.start === v.service.duration));
  assert.equal(overlaps([...day, ...taken, { start: 12 * 60 + 30, end: 13 * 60 }]), false);
  // One client comes once a day.
  assert.equal(new Set(day.map((v) => v.client)).size, day.length);
  // A past day has no open bookings.
  assert.ok(day.every((v) => ["completed", "no_show", "cancelled"].includes(v.status)));
  // The same day always gets the same plan.
  assert.deepEqual(planBusyDay("2026-03-10", OPEN, NOW, SERVICES, 30, taken), day);
});

test("today splits at the current time, later days are still open, closed days are empty", () => {
  const today = planBusyDay(NOW.date, OPEN, NOW, SERVICES, 30);
  assert.ok(today.some((v) => v.status === "completed") && today.some((v) => v.status !== "completed"));
  for (const v of today) {
    if (v.end <= NOW.minutes) assert.equal(v.status, "completed");
    else assert.ok(v.status === "booked" || v.status === "confirmed");
  }
  const later = planBusyDay("2026-03-13", OPEN, NOW, SERVICES, 30);
  assert.ok(later.length > 0 && later.every((v) => v.status === "booked" || v.status === "confirmed"));
  assert.deepEqual(planBusyDay("2026-03-10", { ...OPEN, closed: true }, NOW, SERVICES, 30), []);
  assert.deepEqual(planBusyDay("2026-03-10", OPEN, NOW, [], 30), []);
  assert.deepEqual(planBusyDay("2026-03-10", OPEN, NOW, SERVICES, 0), []);
  // Few clients: the day stops when everyone has come once.
  assert.ok(planBusyDay("2026-03-10", OPEN, NOW, SERVICES, 2).length <= 2);
});

test("the busy shop is added only when asked for", async () => {
  try {
    process.env.SEED_DEMO_DATA = "true";
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM appointments"))?.count, 0);
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 3);

    // The switch does nothing without the sample data switch.
    process.env.SEED_DEMO_DATA = "false";
    process.env.SEED_DEMO_BUSY = "true";
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 0);
  } finally {
    process.env.SEED_DEMO_DATA = "false";
    delete process.env.SEED_DEMO_BUSY;
  }
});

test("the busy shop fills the calendar and the reports, once, around what is already there", async () => {
  try {
    setShopClock(atNow);
    process.env.SEED_DEMO_DATA = "true";
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    // A shop that is already in use: a booking today and the counter at 7.
    await db.run("UPDATE _meta SET value = '7' WHERE key = 'appointment_counter'");
    await db.run(
      `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price)
       VALUES ('APT-7', 1, 1, 'booked', ?, '15:00', '16:00', 35)`, [NOW.date]);
    await db.run("INSERT INTO clients (name, phone) VALUES ('Andre W.', '+15555550200')");

    await seedBusyShop();
    const count = async (sql: string, params: unknown[] = []) => Number((await db.get(`SELECT COUNT(*)::int AS count FROM ${sql}`, params))?.count);
    const total = await count("appointments");
    assert.ok(total > 300, `only ${total} bookings`);
    // 3 sample clients + 36 regulars. The one already there (same number) is kept, not added twice.
    assert.equal(await count("clients"), 39);
    assert.equal((await db.get("SELECT name FROM clients WHERE phone = '+15555550200'"))?.name, "Andre W.");

    // Booking numbers go on from the counter, with no repeats.
    assert.equal(await count("(SELECT DISTINCT identifier FROM appointments) x"), total);
    assert.equal((await db.get("SELECT value FROM _meta WHERE key = 'appointment_counter'"))?.value, String(7 + total - 1));
    assert.equal(await count("appointments WHERE identifier = 'APT-8'"), 1);

    // Closed days (Sunday) stay empty, and nothing is outside the range.
    const days = await db.query<{ scheduled_date: string }>("SELECT DISTINCT scheduled_date FROM appointments ORDER BY 1");
    assert.ok(days.every((d) => new Date(`${d.scheduled_date}T00:00:00Z`).getUTCDay() !== 0));
    assert.equal(days[0].scheduled_date >= "2026-01-28" && days[days.length - 1].scheduled_date <= "2026-03-21", true);

    // No double bookings on any day, the earlier booking included.
    const rows = await db.query<{ scheduled_date: string; start_time: string; end_time: string }>(
      "SELECT scheduled_date, start_time, end_time FROM appointments WHERE status != 'cancelled'");
    const byDay = new Map<string, { start: number; end: number }[]>();
    for (const r of rows) byDay.set(r.scheduled_date, [...(byDay.get(r.scheduled_date) ?? []), { start: timeToMinutes(r.start_time), end: timeToMinutes(r.end_time) }]);
    for (const [day, list] of byDay) assert.equal(overlaps(list), false, `double booking on ${day}`);

    // Each booking has its service. Each finished one has one payment in full. No money for the rest.
    assert.equal(await count("appointment_services"), total - 1);
    const done = await count("appointments WHERE status = 'completed'");
    assert.equal(await count("payments"), done);
    assert.equal(await count("payments p JOIN appointments a ON a.id = p.appointment_id WHERE a.status != 'completed' OR p.amount != a.total_price OR p.paid_on != a.scheduled_date"), 0);
    assert.equal(await count("appointments WHERE scheduled_date > ? AND status NOT IN ('booked', 'confirmed')", [NOW.date]), 0);
    assert.equal(await count("appointments WHERE scheduled_date < ? AND status IN ('booked', 'confirmed')", [NOW.date]), 0);
    assert.ok(await count("appointments WHERE scheduled_date = ?", [NOW.date]) >= 8);

    // The reports have something to show.
    const income = await incomeReport("2026-01-28", NOW.date);
    assert.ok(income.ok && income.income > 5000 && income.tips > 0 && income.payments === done && income.by_method.length >= 3);
    const bookings = await bookingReport("2026-01-28", "2026-03-21");
    assert.ok(bookings.ok && bookings.completed === done && bookings.no_shows > 0 && bookings.cancelled > 0);

    // A second run adds nothing.
    await seedBusyShop();
    assert.equal(await count("appointments"), total);
    assert.equal(await count("clients"), 39);
  } finally {
    setShopClock();
    process.env.SEED_DEMO_DATA = "false";
  }
});

test("a run that fails leaves nothing behind, and the next run fills the shop", async () => {
  try {
    setShopClock(atNow);
    process.env.SEED_DEMO_DATA = "true";
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    const count = async (table: string) => Number((await db.get(`SELECT COUNT(*)::int AS count FROM ${table}`))?.count);
    // Payments cannot be saved: the run stops after the bookings are in.
    await db.exec("ALTER TABLE payments ADD CONSTRAINT no_pay CHECK (amount < 0)");
    await assert.rejects(seedBusyShop());
    assert.equal(await count("appointments"), 0);
    assert.equal(await count("appointment_services"), 0);
    assert.equal(await count("payments"), 0);
    assert.equal(await db.get("SELECT 1 AS x FROM _meta WHERE key = 'demo_busy_seeded'"), undefined);

    // A failed seed never fails the app.
    process.env.SEED_DEMO_BUSY = "true";
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    assert.equal(await count("staff"), 1);

    await db.exec("ALTER TABLE payments DROP CONSTRAINT IF EXISTS no_pay");
    await seedBusyShop();
    assert.ok(await count("appointments") > 300);
    assert.equal(await count("appointment_services"), await count("appointments"));
  } finally {
    setShopClock();
    process.env.SEED_DEMO_DATA = "false";
    delete process.env.SEED_DEMO_BUSY;
  }
});

test("the busy shop does nothing without a barber or a service", async () => {
  await db.resetDB("pglite:memory");
  await ensureSeeded();
  await seedBusyShop();
  assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM appointments"))?.count, 0);
  assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 0);
  // The claim is free again, so a later start can fill the shop.
  assert.equal(await db.get("SELECT 1 AS x FROM _meta WHERE key = 'demo_busy_seeded'"), undefined);
  assert.equal(defaultSettings().hours[0].closed, true);
});
