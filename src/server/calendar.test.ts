import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
delete process.env.STAFF_PASSWORD;
delete process.env.STRIPE_SECRET_KEY;
for (const name of ["SMS_PROVIDER", "TELNYX_API_KEY", "TELNYX_FROM_NUMBER", "TWILIO_ACCOUNT_SID", "TWILIO_FROM_NUMBER"]) delete process.env[name];
process.env.PUBLIC_URL = "https://shop.test";

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { setShopClock } = await import("./shoptime.js");
const agent = await import("./agent.js");
const auto = await import("./automations.js");
const cal = await import("./calendar.js");
const { saveSettings } = await import("./settings.js");

after(async () => {
  await auto.automationsIdle();
  await agent.agentIdle();
  setShopClock();
  await db.closeDB();
});

// New York is on winter time (UTC-5) in the first week of March 2026.
const NOW = "2026-03-02T15:00:00Z"; // Monday, 10:00 in New York
const TUE = "2026-03-03";

beforeEach(async () => {
  await auto.automationsIdle();
  await agent.agentIdle();
  setShopClock(() => new Date(NOW));
  await db.resetDB("pglite:memory");
  await db.exec(`
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111'), ('Dre', 'Barber', '#222222');
    INSERT INTO services (name, duration, price, category) VALUES ('Haircut', 30, 35, 'Cuts'), ('Beard Trim', 15, 15, 'Beard');
    INSERT INTO clients (name, email, phone) VALUES ('Jamie Rivera', 'jamie@example.com', '(555) 555-0101'), ('Sam Lee', '', '+15555550199');
  `);
  await saveSettings({
    shop_name: "Marcus Cuts", timezone: "America/New_York",
    address: "12 Main St, Suite 4; Brooklyn", access_instructions: "Ring the bell for studio 4.",
  });
});

let seq = 0;
interface Visit { client?: number; staff?: number; date?: string; start?: string; end?: string; status?: string; prepay?: string; token?: string | null }
async function visit(v: Visit = {}): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, source, prepay_status, public_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, 35, 'staff', ?, ?) RETURNING id`,
    [`T-${++seq}`, v.client ?? 1, v.staff ?? 1, v.status ?? "booked", v.date ?? TUE, v.start ?? "14:00", v.end ?? "14:30", v.prepay ?? "none", v.token ?? null],
  );
  await db.run("INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, 1, 35, 30)", [rows[0].id]);
  return rows[0].id;
}

const TOKEN_A = "tokenAtokenAtokenAtokenA_1234567";

/** Undo line folding, then split into lines. */
function lines(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}
const field = (ics: string, name: string) => lines(ics).find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
const count = (ics: string, line: string) => lines(ics).filter((l) => l === line).length;

/** The basic rules of a calendar file. */
function assertValid(ics: string) {
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
  for (const raw of ics.split("\r\n")) assert.ok(Buffer.byteLength(raw) <= 75, `line too long: ${raw}`);
  const all = lines(ics);
  assert.equal(all[0], "BEGIN:VCALENDAR");
  assert.equal(all.at(-1), "END:VCALENDAR");
  assert.ok(all.includes("VERSION:2.0"));
  assert.ok(all.some((l) => l.startsWith("PRODID:")));
  assert.equal(count(ics, "BEGIN:VEVENT"), count(ics, "END:VEVENT"));
  let inside = false;
  let seen: string[] = [];
  for (const line of all) {
    if (line === "BEGIN:VEVENT") { inside = true; seen = []; }
    else if (line === "END:VEVENT") {
      for (const need of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY"]) assert.ok(seen.includes(need), `event needs ${need}`);
      inside = false;
    } else if (inside) seen.push(line.split(":")[0]);
  }
}

async function fetchText(path: string) {
  const res = await app.request(path);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text(), location: res.headers.get("location") };
}
async function call(method: string, path: string) {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" } });
  return { status: res.status, body: await res.json() as any };
}

test("lines fold at 75 bytes and text is escaped", () => {
  assert.equal(cal.icsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const long = "SUMMARY:" + "é".repeat(100);
  const folded = cal.foldLine(long);
  for (const part of folded.split("\r\n")) assert.ok(Buffer.byteLength(part) <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(cal.foldLine("SHORT:line"), "SHORT:line");
});

test("shop times become UTC, also when the clocks change", () => {
  assert.equal(cal.icsStamp(cal.shopTimeToUtc("2026-03-03", "14:00", "America/New_York")), "20260303T190000Z");
  // Summer time starts on March 8, 2026.
  assert.equal(cal.icsStamp(cal.shopTimeToUtc("2026-03-09", "14:00", "America/New_York")), "20260309T180000Z");
  assert.equal(cal.icsStamp(cal.shopTimeToUtc("2026-03-03", "14:00", "Not/AZone")), "20260303T140000Z");
});

test("status mapping", () => {
  assert.equal(cal.eventStatus("cancelled", "refunded"), "CANCELLED");
  assert.equal(cal.eventStatus("pending", "due"), "TENTATIVE");
  assert.equal(cal.eventStatus("booked", "paid"), "CONFIRMED");
  assert.equal(cal.eventStatus("confirmed", "none"), "CONFIRMED");
});

test("a client gets a valid calendar file with only their own visit", async () => {
  await visit({ token: TOKEN_A });
  await visit({ client: 2, start: "15:00", end: "15:30", token: "tokenBtokenBtokenBtokenB_1234567" });
  const res = await fetchText(`/api/public/bookings/${TOKEN_A}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/calendar/);
  assertValid(res.text);
  assert.equal(count(res.text, "BEGIN:VEVENT"), 1);
  assert.equal(field(res.text, "DTSTART"), "20260303T190000Z");
  assert.equal(field(res.text, "DTEND"), "20260303T193000Z");
  assert.equal(field(res.text, "SUMMARY"), "Haircut at Marcus Cuts");
  assert.equal(field(res.text, "LOCATION"), "12 Main St\\, Suite 4\\; Brooklyn");
  assert.equal(field(res.text, "STATUS"), "CONFIRMED");
  const description = field(res.text, "DESCRIPTION") ?? "";
  assert.match(description, /With Marcus\./);
  assert.match(description, /Ring the bell for studio 4\./);
  assert.ok(description.includes(`Change or cancel: https://shop.test/book/manage/${TOKEN_A}`));
  assert.ok(!res.text.includes("Sam"), "no other client");
  assert.ok(!res.text.includes("Jamie"), "the file does not need the client's name");
});

test("the file says TENTATIVE while pre-pay is pending and CANCELLED after a cancel", async () => {
  const id = await visit({ token: TOKEN_A, status: "pending", prepay: "due" });
  let res = await fetchText(`/api/public/bookings/${TOKEN_A}/calendar.ics`);
  assert.equal(field(res.text, "STATUS"), "TENTATIVE");
  assert.match(field(res.text, "DESCRIPTION") ?? "", /Pre-pay to keep this time/);

  await db.run("UPDATE appointments SET status = 'cancelled', prepay_status = 'void' WHERE id = ?", [id]);
  res = await fetchText(`/api/public/bookings/${TOKEN_A}/calendar.ics`);
  assert.equal(res.status, 200);
  assertValid(res.text);
  assert.equal(field(res.text, "STATUS"), "CANCELLED");
});

test("the Google link opens a new event with the same details", async () => {
  await visit({ token: TOKEN_A });
  const res = await fetchText(`/api/public/bookings/${TOKEN_A}/google-calendar`);
  assert.equal(res.status, 302);
  const url = new URL(res.location!);
  assert.equal(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "Haircut at Marcus Cuts");
  assert.equal(url.searchParams.get("dates"), "20260303T190000Z/20260303T193000Z");
  assert.equal(url.searchParams.get("location"), "12 Main St, Suite 4; Brooklyn");
  assert.match(url.searchParams.get("details") ?? "", /Change or cancel: https:\/\/shop\.test\/book\/manage\//);
});

test("a wrong booking token gets 404 and no details", async () => {
  await visit({ token: TOKEN_A });
  for (const path of [
    "/api/public/bookings/wrongwrongwrongwrongwrongwrong12/calendar.ics",
    "/api/public/bookings/short/calendar.ics",
    "/api/public/bookings/wrongwrongwrongwrongwrongwrong12/google-calendar",
  ]) {
    const res = await fetchText(path);
    assert.equal(res.status, 404, path);
    assert.ok(!/Jamie|Haircut|Marcus/.test(res.text));
  }
});

test("a booking made by staff gets a token on first use", async () => {
  const id = await visit();
  const row = () => db.get<{ public_token: string | null }>("SELECT public_token FROM appointments WHERE id = ?", [id]);
  assert.equal((await row())?.public_token, null);
  // A text with {calendar_link} asks for the token the same way.
  const { ensureToken } = await import("./clientbooking.js");
  const token = await ensureToken({ id, public_token: null });
  assert.match(token, /^[A-Za-z0-9_-]{20,64}$/);
  assert.equal((await row())?.public_token, token);
  const res = await fetchText(`/api/public/bookings/${token}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.equal(count(res.text, "BEGIN:VEVENT"), 1);
});

test("a barber's feed has their bookings and blocked time, in range", async () => {
  await visit({ start: "14:00", end: "14:30" });                                  // Marcus, in range
  await visit({ client: 2, date: "2026-02-10", start: "09:00", end: "09:30" });   // 20 days back
  await visit({ date: "2026-01-20" });                                            // too old
  await visit({ date: "2026-10-01" });                                            // too far ahead
  await visit({ staff: 2, start: "16:00", end: "16:30", client: 2 });             // Dre's
  await visit({ start: "11:00", end: "11:30", status: "cancelled" });             // cancelled
  await visit({ client: 2, start: "17:00", end: "17:30", status: "pending", prepay: "due" });
  await db.run("INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (1, ?, '12:00', '13:00', 'Lunch, long')", [TUE]);
  await db.run("INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (2, ?, '12:00', '13:00', 'Dentist')", [TUE]);

  const links = await call("GET", "/api/calendar-links");
  assert.equal(links.status, 200);
  assert.deepEqual(links.body.links.map((l: any) => l.name), ["Dre", "Marcus"]);
  const marcus = links.body.links.find((l: any) => l.name === "Marcus");
  assert.match(marcus.feed_url, /^https:\/\/shop\.test\/api\/public\/calendar\/[A-Za-z0-9_-]{20,64}\.ics$/);
  assert.equal(marcus.webcal_url, marcus.feed_url.replace("https://", "webcal://"));
  // The link stays the same from one call to the next.
  assert.deepEqual((await call("GET", "/api/calendar-links")).body.links, links.body.links);

  const res = await fetchText(new URL(marcus.feed_url).pathname);
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/calendar/);
  assertValid(res.text);
  assert.equal(count(res.text, "BEGIN:VEVENT"), 4);
  const summaries = lines(res.text).filter((l) => l.startsWith("SUMMARY:")).map((l) => l.slice(8));
  assert.deepEqual(summaries, ["Sam Lee - Haircut", "Jamie Rivera - Haircut", "Sam Lee - Haircut", "Blocked: Lunch\\, long"]);
  assert.equal(count(res.text, "STATUS:TENTATIVE"), 1);
  assert.ok(!res.text.includes("Dentist"));
  assert.ok(res.text.includes("DTSTART:20260303T170000Z"), "blocked time at 12:00 New York");
  assert.equal(field(res.text, "X-WR-CALNAME"), "Marcus - Marcus Cuts");
});

test("a wrong feed token gets 404", async () => {
  await visit();
  await call("GET", "/api/calendar-links");
  for (const path of [
    "/api/public/calendar/wrongwrongwrongwrongwrongwrong12.ics",
    "/api/public/calendar/x.ics",
    "/api/public/calendar/.ics",
    "/api/public/calendar/null.ics",
  ]) {
    const res = await fetchText(path);
    assert.equal(res.status, 404, path);
    assert.ok(!/Jamie|Haircut/.test(res.text));
  }
  // The token alone, without ".ics", is not a feed.
  const token = (await db.get<{ calendar_token: string }>("SELECT calendar_token FROM staff WHERE id = 1"))!.calendar_token;
  assert.equal((await fetchText(`/api/public/calendar/${token}`)).status, 404);
});

test("a new link stops the old one", async () => {
  await visit();
  const before = (await call("GET", "/api/calendar-links")).body.links.find((l: any) => l.staff_id === 1);
  assert.equal((await fetchText(new URL(before.feed_url).pathname)).status, 200);

  const reset = await call("POST", "/api/calendar-links/1/reset");
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.link.feed_url, before.feed_url);
  assert.equal((await fetchText(new URL(before.feed_url).pathname)).status, 404);
  assert.equal((await fetchText(new URL(reset.body.link.feed_url).pathname)).status, 200);
  // The other barber's link did not change.
  const after = (await call("GET", "/api/calendar-links")).body.links;
  assert.equal(after.find((l: any) => l.staff_id === 1).feed_url, reset.body.link.feed_url);
  assert.equal((await call("POST", "/api/calendar-links/99/reset")).status, 404);
});

test("a barber who left has no feed, and a broken row does not break the files", async () => {
  const id = await visit({ token: TOKEN_A });
  const link = (await call("GET", "/api/calendar-links")).body.links.find((l: any) => l.staff_id === 1);
  const path = new URL(link.feed_url).pathname;

  // A row with a bad time is left out. The feed still works.
  const bad = await visit({ token: "b".repeat(TOKEN_A.length) });
  await db.run("UPDATE appointments SET start_time = '' WHERE id = ?", [bad]);
  const feed = await fetchText(path);
  assert.equal(feed.status, 200);
  assert.equal(feed.text.match(/BEGIN:VEVENT/g)?.length, 1);
  assert.equal((await fetchText(`/api/public/bookings/${"b".repeat(TOKEN_A.length)}/calendar.ics`)).status, 404);
  assert.equal((await fetchText(`/api/public/bookings/${"b".repeat(TOKEN_A.length)}/google-calendar`)).status, 404);
  assert.equal((await fetchText(`/api/public/bookings/${TOKEN_A}/calendar.ics`)).status, 200);
  assert.ok(id > 0);

  await db.run("UPDATE staff SET active = 0 WHERE id = 1");
  const gone = await fetchText(path);
  assert.equal(gone.status, 404);
  assert.ok(!/Jamie/.test(gone.text));
});

test("the feed secret never shows in public answers", async () => {
  await visit({ token: TOKEN_A });
  await call("GET", "/api/calendar-links");
  const token = (await db.get<{ calendar_token: string }>("SELECT calendar_token FROM staff WHERE id = 1"))!.calendar_token;
  for (const path of ["/api/public/shop", `/api/public/availability?date=${TUE}&service_ids=1`, `/api/public/bookings/${TOKEN_A}`, `/api/public/bookings/${TOKEN_A}/calendar.ics`]) {
    const res = await fetchText(path);
    assert.ok(!res.text.includes(token), path);
    assert.ok(!res.text.includes("calendar_token"), path);
  }
});
