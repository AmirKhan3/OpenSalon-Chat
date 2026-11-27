import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
delete process.env.STAFF_PASSWORD;

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { setShopClock } = await import("./shoptime.js");
const { candidateStarts } = await import("./availability.js");
const { defaultSettings } = await import("./settings.js");

after(() => db.closeDB());

// Monday 2 March 2026, 10:00 in New York.
const NOW = "2026-03-02T15:00:00Z";
const MON = "2026-03-02";
const TUE = "2026-03-03";
const SUN = "2026-03-08";

beforeEach(async () => {
  delete process.env.STAFF_PASSWORD;
  setShopClock(() => new Date(NOW));
  await db.resetDB("pglite:memory");
  await db.exec(`
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111'), ('Dre', 'Barber', '#222222');
    INSERT INTO staff (name, title, color, active) VALUES ('Gone', 'Barber', '#333333', 0);
    INSERT INTO services (name, duration, price, category) VALUES ('Haircut', 30, 35, 'Cuts'), ('Beard Trim', 15, 15, 'Beard');
    INSERT INTO services (name, duration, price, category, active) VALUES ('Old Service', 30, 10, 'Cuts', 0);
    INSERT INTO clients (name, email, phone) VALUES ('Jamie Rivera', 'jamie@example.com', '+15555550101');
  `);
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

const book = (patch: object = {}) => call("POST", "/api/public/bookings", {
  name: "Sam Lee", phone: "(555) 555-0199", date: TUE, time: "10:00", service_ids: [1], ...patch,
});
const slots = async (query: string) => (await call("GET", `/api/public/availability?${query}`)).body.slots as { time: string; staff_ids: number[] }[];
const tokenOf = (r: { body: any }) => String(r.body.manage_path).split("/").pop()!;

test("shop details: name, hours, services, barbers, and today in shop time", async () => {
  const r = await call("GET", "/api/public/shop");
  assert.equal(r.status, 200);
  assert.equal(r.body.today, MON);
  assert.equal(r.body.shop.timezone, "America/New_York");
  assert.equal(r.body.shop.hours.length, 7);
  assert.deepEqual(r.body.services.map((s: any) => s.name).sort(), ["Beard Trim", "Haircut"]);
  assert.equal(r.body.prepay.mode, "none");
  assert.deepEqual(r.body.barbers.map((b: any) => b.name), ["Dre", "Marcus"]);
  // Late evening in New York is still the same day there, though UTC has moved on.
  setShopClock(() => new Date("2026-03-03T03:30:00Z"));
  assert.equal((await call("GET", "/api/public/shop")).body.today, MON);
});

test("availability follows hours, slot step, and the visit length", async () => {
  const open = await slots(`date=${TUE}&service_ids=1`);
  assert.equal(open[0].time, "09:00");
  assert.equal(open[1].time, "09:30");
  assert.equal(open.at(-1)!.time, "17:30");
  assert.deepEqual(open[0].staff_ids, [1, 2]);
  // 45 minutes must end by 18:00.
  const longer = await slots(`date=${TUE}&service_ids=1,2`);
  assert.equal(longer.at(-1)!.time, "17:00");
  const r = await call("GET", `/api/public/availability?date=${TUE}&service_ids=1,2`);
  assert.equal(r.body.duration, 45);
});

test("availability respects minimum notice and the booking window", async () => {
  // It is 10:00. With 60 minutes notice the first time today is 11:00.
  assert.equal((await slots(`date=${MON}&service_ids=1`))[0].time, "11:00");
  await call("PUT", "/api/settings", { min_notice: 0 });
  assert.equal((await slots(`date=${MON}&service_ids=1`))[0].time, "10:00");
  // Notice can reach into tomorrow.
  await call("PUT", "/api/settings", { min_notice: 24 * 60 });
  assert.equal((await slots(`date=${TUE}&service_ids=1`))[0].time, "10:00");
  // Past days and days beyond the window are empty.
  assert.deepEqual(await slots("date=2026-03-01&service_ids=1"), []);
  assert.deepEqual(await slots("date=2026-02-27&service_ids=1"), []);
  await call("PUT", "/api/settings", { booking_window_days: 3, min_notice: 0 });
  assert.ok((await slots("date=2026-03-05&service_ids=1")).length > 0);
  assert.deepEqual(await slots("date=2026-03-06&service_ids=1"), []);
});

test("closed days have no times", async () => {
  assert.deepEqual(await slots(`date=${SUN}&service_ids=1`), []);
  assert.equal((await book({ date: SUN })).status, 400);
  // Close Tuesday too.
  const hours = defaultSettings().hours;
  hours[2] = { closed: true, open: "09:00", close: "18:00" };
  assert.equal((await call("PUT", "/api/settings", { hours })).status, 200);
  assert.deepEqual(await slots(`date=${TUE}&service_ids=1`), []);
});

test("booked and blocked time is not offered, and shows no client details", async () => {
  await db.exec(`
    INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price)
      VALUES ('APT-1', 1, 1, 'booked', '${TUE}', '10:00', '11:00', 35), ('APT-2', 1, 2, 'cancelled', '${TUE}', '10:00', '11:00', 35);
    INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (2, '${TUE}', '12:00', '13:00', 'Lunch');
  `);
  const r = await call("GET", `/api/public/availability?date=${TUE}&service_ids=1`);
  const at = (time: string) => r.body.slots.find((s: any) => s.time === time)?.staff_ids;
  assert.deepEqual(at("09:30"), [1, 2]);
  assert.deepEqual(at("10:00"), [2]); // the cancelled booking does not count
  assert.deepEqual(at("10:30"), [2]);
  assert.deepEqual(at("11:00"), [1, 2]);
  assert.deepEqual(at("12:00"), [1]);
  assert.deepEqual(at("12:30"), [1]);
  // One barber only.
  const marcus = await slots(`date=${TUE}&service_ids=1&staff_id=1`);
  assert.equal(marcus.some((s) => s.time === "10:00"), false);
  assert.ok(marcus.every((s) => s.staff_ids.length === 1 && s.staff_ids[0] === 1));
  // Nothing about who is booked.
  const text = JSON.stringify(r.body);
  for (const secret of ["Jamie", "Rivera", "5555550101", "jamie@", "APT-", "Lunch"]) assert.equal(text.includes(secret), false, secret);
});

test("availability input rules", async () => {
  for (const q of [
    "date=tomorrow&service_ids=1", "date=2026-02-30&service_ids=1", `date=${TUE}&service_ids=`, `date=${TUE}&service_ids=abc`,
    `date=${TUE}&service_ids=99`, `date=${TUE}&service_ids=3`, `date=${TUE}&service_ids=1,1`,
    `date=${TUE}&service_ids=1&staff_id=3`, `date=${TUE}&service_ids=1&staff_id=x`, `date=${TUE}`,
  ]) {
    const r = await call("GET", `/api/public/availability?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(typeof r.body.error, "string", q);
  }
});

test("a booking is confirmed, gets a secret link, and makes a new client", async () => {
  const r = await book({ service_ids: [1, 2], staff_id: 2, email: "sam@example.com" });
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.status, "confirmed");
  assert.equal(r.body.booking.date, TUE);
  assert.equal(r.body.booking.start_time, "10:00");
  assert.equal(r.body.booking.end_time, "10:45");
  assert.equal(r.body.booking.barber, "Dre");
  assert.equal(r.body.booking.total_price, 50);
  assert.equal(r.body.booking.services.length, 2);
  assert.equal(r.body.booking.can_cancel, true);
  assert.match(tokenOf(r), /^[A-Za-z0-9_-]{32}$/);
  // The reply holds no contact details.
  const text = JSON.stringify(r.body);
  for (const secret of ["Sam", "0199", "sam@"]) assert.equal(text.includes(secret), false, secret);

  const row = await db.get<any>("SELECT a.*, c.name, c.phone, c.email FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.public_token = ?", [tokenOf(r)]);
  assert.equal(row.source, "online");
  assert.equal(row.name, "Sam Lee");
  assert.equal(row.phone, "+15555550199");
  assert.equal(row.email, "sam@example.com");
  // Staff see it in the dashboard.
  const list = await call("GET", "/api/appointments");
  assert.equal(JSON.stringify(list.body).includes("Sam Lee"), true);
});

test("the client is found by phone only, and a public booking never changes a saved client", async () => {
  const byPhone = await book({ name: "Someone Else", phone: "555-555-0101", email: "other@example.com" });
  assert.equal(byPhone.status, 201);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM clients"))?.n, 1);
  // The saved name, phone, and email stay as they were, and the reply does not show them.
  const client = await db.get<any>("SELECT name, phone, email FROM clients WHERE id = 1");
  assert.deepEqual([client.name, client.phone, client.email], ["Jamie Rivera", "+15555550101", "jamie@example.com"]);
  assert.equal(JSON.stringify(byPhone.body).includes("Jamie"), false);
  // Staff get a note about the different name.
  const notes = await db.query<any>("SELECT content FROM appointment_notes ORDER BY id");
  assert.equal(notes.some((n: any) => /Name given online: Someone Else/.test(n.content)), true);

  // A saved email with another phone is a new client. It cannot take over the saved one.
  await db.exec("INSERT INTO clients (name, email, phone) VALUES ('No Phone', 'nophone@example.com', '')");
  const byEmail = await book({ name: "J", phone: "555 555 0177", email: "NOPHONE@example.com", time: "11:00" });
  assert.equal(byEmail.status, 201);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM clients"))?.n, 3);
  assert.equal((await db.get<any>("SELECT phone FROM clients WHERE id = 2"))?.phone, "");
});

test("double booking: the second request for the same time gets 409", async () => {
  assert.equal((await book({ staff_id: 1 })).status, 201);
  const again = await book({ staff_id: 1, name: "Other", phone: "5555550123" });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /just taken/);
  // An overlap that starts at another time is refused too.
  assert.equal((await book({ staff_id: 1, time: "09:30", service_ids: [1, 2], phone: "5555550124" })).status, 409);
  // Right after is fine.
  assert.equal((await book({ staff_id: 1, time: "10:30", phone: "5555550125" })).status, 201);
  // Blocked time counts too.
  await db.exec(`INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (1, '${TUE}', '14:00', '15:00', 'Off')`);
  assert.equal((await book({ staff_id: 1, time: "14:30", phone: "5555550126" })).status, 409);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM appointments"))?.n, 2);
});

test("double booking: many requests at once make one booking per barber", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => book({ phone: `555555020${i}`, name: `Client ${i}` })),
  );
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 201, 409, 409, 409, 409]);
  const rows = await db.query<any>("SELECT staff_id FROM appointments ORDER BY staff_id");
  assert.deepEqual(rows.map((r) => r.staff_id), [1, 2]);
});

test("a booking that slips past the first check is taken back", async () => {
  // An earlier row that the availability check cannot see as busy in time:
  // we add it between the check and the insert by making it with a lower id.
  await db.exec(`INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price)
    VALUES ('APT-9', 1, 1, 'booked', '${TUE}', '10:00', '10:30', 35)`);
  const r = await book({ staff_id: 1 });
  assert.equal(r.status, 409);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM appointments"))?.n, 1);
});

test("any barber spreads bookings: the free barber with the fewest that day", async () => {
  const barber = async (time: string, i: number) => (await book({ time, phone: `555555030${i}` })).body.booking.barber;
  assert.equal(await barber("10:00", 0), "Marcus"); // tie: lowest id
  assert.equal(await barber("11:00", 1), "Dre");    // Dre has fewer
  assert.equal(await barber("12:00", 2), "Marcus"); // tie again
  assert.equal(await barber("12:00", 3), "Dre");    // Marcus is busy at 12:00
  assert.equal(await barber("13:00", 4), "Marcus"); // 2 each: lowest id
  assert.equal(await barber("13:00", 5), "Dre");
  assert.equal((await book({ time: "13:00", phone: "5555550399" })).status, 409);
  // Cancelled bookings do not count toward the load.
  await db.exec("UPDATE appointments SET status = 'cancelled' WHERE staff_id = 2");
  assert.equal(await barber("15:00", 6), "Dre");
});

test("booking input rules", async () => {
  const bad: object[] = [
    { name: "" }, { name: "   " }, { name: "x".repeat(101) },
    { phone: "" }, { phone: "555-0101" }, { phone: "call me" }, { phone: "1".repeat(16) }, { phone: "5555550199<script>" },
    { email: "not-an-email" },
    { date: "2026-13-01" }, { date: "next week" }, { date: "2026-03-01" }, { date: "2027-03-02" },
    { time: "25:00" }, { time: "10" }, { time: "10:10" }, { time: "08:00" }, { time: "17:45" },
    { service_ids: [] }, { service_ids: [99] }, { service_ids: [3] }, { service_ids: [1, 1] }, { service_ids: "1" },
    { staff_id: 3 }, { staff_id: 99 }, { staff_id: "1" },
    { date: MON, time: "10:30" }, // inside the minimum notice
  ];
  for (const patch of bad) {
    const r = await book(patch);
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(typeof r.body.error, "string");
  }
  const noBody = await app.request("/api/public/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(noBody.status, 400);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM appointments"))?.n, 0);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM clients"))?.n, 1);
});

test("the manage link shows the booking, and a wrong token shows nothing", async () => {
  const made = await book();
  const token = tokenOf(made);
  const r = await call("GET", `/api/public/bookings/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.reference, made.body.booking.reference);
  assert.equal(r.body.shop.name, "Our Barbershop");
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const wrong of [flipped, "abc", "1", "x".repeat(32), "%27%20OR%201=1", token + "x"]) {
    for (const [method, path] of [["GET", `/api/public/bookings/${wrong}`], ["POST", `/api/public/bookings/${wrong}/cancel`]]) {
      const miss = await call(method, path);
      assert.equal(miss.status, 404, path);
      assert.deepEqual(miss.body, { error: "We could not find that booking." });
    }
  }
  // Staff-made bookings have no token, and an empty token never matches one.
  await db.exec(`INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price)
    VALUES ('APT-77', 1, 1, 'booked', '${TUE}', '15:00', '15:30', 35)`);
  assert.equal((await call("GET", "/api/public/bookings/null")).status, 404);
});

test("a client can cancel with the link, and the time opens again", async () => {
  const made = await book({ staff_id: 1 });
  const token = tokenOf(made);
  const cancelled = await call("POST", `/api/public/bookings/${token}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.booking.status, "cancelled");
  assert.equal(cancelled.body.booking.can_cancel, false);
  // Again is fine.
  assert.equal((await call("POST", `/api/public/bookings/${token}/cancel`)).status, 200);
  assert.equal((await db.get<any>("SELECT COUNT(*)::int AS n FROM appointment_notes WHERE content LIKE 'Cancelled%'"))?.n, 1);
  assert.equal((await book({ staff_id: 1, phone: "5555550400" })).status, 201);
});

test("a visit that started or finished cannot be cancelled online", async () => {
  const made = await book({ staff_id: 1 });
  const token = tokenOf(made);
  setShopClock(() => new Date("2026-03-03T15:00:00Z")); // Tuesday 10:00, the start time
  const late = await call("POST", `/api/public/bookings/${token}/cancel`);
  assert.equal(late.status, 409);
  assert.equal((await call("GET", `/api/public/bookings/${token}`)).body.booking.can_cancel, false);
  setShopClock(() => new Date(NOW));
  await db.exec("UPDATE appointments SET status = 'completed'");
  assert.equal((await call("POST", `/api/public/bookings/${token}/cancel`)).status, 409);
  assert.equal((await db.get<any>("SELECT status FROM appointments"))?.status, "completed");
});

test("settings: defaults, saving, and input rules", async () => {
  const first = await call("GET", "/api/settings");
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.slot_step, 30);
  assert.equal(first.body.settings.hours[0].closed, true);

  const saved = await call("PUT", "/api/settings", { shop_name: "Fade Lab", timezone: "America/Chicago", address: "12 Main St", slot_step: 15 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.shop_name, "Fade Lab");
  assert.equal(saved.body.settings.booking_window_days, 30); // untouched
  const shop = await call("GET", "/api/public/shop");
  assert.equal(shop.body.shop.name, "Fade Lab");
  assert.equal(shop.body.shop.address, "12 Main St");
  // 15:00 UTC is 09:00 in Chicago.
  assert.equal((await slots(`date=${MON}&service_ids=1`))[0].time, "10:00");
  assert.equal((await slots(`date=${TUE}&service_ids=1`))[1].time, "09:15");

  const hours = defaultSettings().hours;
  const badHours = hours.map((h, i) => (i === 1 ? { closed: false, open: "18:00", close: "09:00" } : h));
  for (const patch of [
    { shop_name: "" }, { timezone: "Mars/Olympus" }, { slot_step: 0 }, { slot_step: 2.5 }, { min_notice: -1 },
    { booking_window_days: 0 }, { hours: hours.slice(0, 6) }, { hours: badHours },
    { hours: hours.map((h) => ({ ...h, open: "9am" })) },
  ]) {
    assert.equal((await call("PUT", "/api/settings", patch)).status, 400, JSON.stringify(patch));
  }
  assert.equal((await call("GET", "/api/settings")).body.settings.shop_name, "Fade Lab");
});

test("settings need a staff login, the public routes do not", async () => {
  process.env.STAFF_PASSWORD = "pw";
  assert.equal((await call("GET", "/api/settings")).status, 401);
  assert.equal((await call("PUT", "/api/settings", { shop_name: "Hacked" })).status, 401);
  assert.equal((await call("GET", "/api/public/shop")).status, 200);
  assert.equal((await call("GET", `/api/public/availability?date=${TUE}&service_ids=1`)).status, 200);
  assert.equal((await book()).status, 201);
  delete process.env.STAFF_PASSWORD;
  assert.equal((await call("GET", "/api/settings")).body.settings.shop_name, "Our Barbershop");
});

test("candidate start times: the pure rules", () => {
  const rules = { ...defaultSettings(), slot_step: 20, min_notice: 30, booking_window_days: 2 };
  const now = { date: MON, time: "10:00", minutes: 600 };
  assert.deepEqual(candidateStarts(rules, MON, 60, now).slice(0, 2), [640, 660]);
  assert.equal(candidateStarts(rules, MON, 60, now).at(-1), 1020);
  assert.equal(candidateStarts(rules, TUE, 60, now)[0], 540);
  assert.deepEqual(candidateStarts(rules, "2026-03-05", 60, now), []);
  assert.deepEqual(candidateStarts(rules, "bad", 60, now), []);
  assert.deepEqual(candidateStarts(rules, TUE, 0, now), []);
  assert.deepEqual(candidateStarts(rules, TUE, 600, now), []); // longer than the day
});
