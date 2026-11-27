import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
delete process.env.STAFF_PASSWORD;
delete process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
process.env.PUBLIC_URL = "https://shop.example";

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { setShopClock } = await import("./shoptime.js");
const { setStripeClient, signWebhook, verifyWebhook } = await import("./stripe.js");
const { prepayFor, releaseExpiredHolds } = await import("./prepay.js");
const { defaultSettings } = await import("./settings.js");

after(() => { setStripeClient(); return db.closeDB(); });

// Monday 2 March 2026, 10:00 in New York.
const NOW = "2026-03-02T15:00:00Z";
const TUE = "2026-03-03";
const WED = "2026-03-04";
let now = new Date(NOW);
const minutesLater = (m: number) => { now = new Date(now.getTime() + m * 60_000); };

/** A fake Stripe. It records what the app asked for. */
const fake = {
  sessions: [] as { id: string; url: string; amountCents: number; expiresAt: number; appointmentId: number; successUrl: string }[],
  expired: [] as string[],
  refunds: [] as { intent: string; appointmentId: number }[],
  failCheckout: false,
  failRefund: false,
  reset() { this.sessions = []; this.expired = []; this.refunds = []; this.failCheckout = false; this.failRefund = false; },
};

beforeEach(async () => {
  delete process.env.STAFF_PASSWORD;
  now = new Date(NOW);
  setShopClock(() => now);
  fake.reset();
  setStripeClient({
    async createCheckoutSession(input) {
      if (fake.failCheckout) throw new Error("Stripe is down");
      const id = `cs_test_${fake.sessions.length + 1}`;
      const session = { id, url: `https://stripe.test/pay/${id}`, amountCents: input.amountCents, expiresAt: input.expiresAt, appointmentId: input.appointmentId, successUrl: input.successUrl };
      fake.sessions.push(session);
      return { id, url: session.url };
    },
    async expireCheckoutSession(id) { fake.expired.push(id); },
    async refund(intent, appointmentId) {
      if (fake.failRefund) throw new Error("Stripe is down");
      fake.refunds.push({ intent, appointmentId });
      return { id: `re_test_${fake.refunds.length}` };
    },
  });
  await db.resetDB("pglite:memory");
  await db.exec(`
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111');
    INSERT INTO services (name, duration, price, category) VALUES ('Haircut', 30, 35, 'Cuts');
  `);
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

const usePrepay = (patch: object = { prepay_mode: "fixed", prepay_amount: 10 }) => call("PUT", "/api/settings", patch);
const book = (patch: object = {}) => call("POST", "/api/public/bookings", {
  name: "Sam Lee", phone: "(555) 555-0199", date: TUE, time: "10:00", service_ids: [1], ...patch,
});
const tokenOf = (r: { body: any }) => String(r.body.manage_path).split("/").pop()!;
const view = async (token: string) => (await call("GET", `/api/public/bookings/${token}`)).body.booking;
const times = async (date = TUE) =>
  ((await call("GET", `/api/public/availability?date=${date}&service_ids=1`)).body.slots as { time: string }[]).map((s) => s.time);
const row = () => db.get<any>("SELECT * FROM appointments ORDER BY id DESC LIMIT 1");
const notes = async () => (await db.query<{ content: string }>("SELECT content FROM appointment_notes ORDER BY id")).map((n) => n.content).join("\n");

async function webhook(type: string, object: object, options: { signature?: string; secret?: string; at?: number } = {}) {
  const payload = JSON.stringify({ id: "evt_test", type, data: { object } });
  const at = options.at ?? Math.floor(now.getTime() / 1000);
  const signature = options.signature ?? signWebhook(payload, options.secret ?? "whsec_test_only", at);
  const res = await app.request("/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload });
  return { status: res.status, body: await res.json() as any };
}
const paid = (sessionId = "cs_test_1", intent = "pi_test_1") =>
  webhook("checkout.session.completed", { id: sessionId, payment_status: "paid", payment_intent: intent });

test("pre-pay amount: none, fixed, percent, full, and the 50 cent minimum", () => {
  const base = defaultSettings();
  assert.equal(prepayFor({ ...base, prepay_mode: "none" }, 35), 0);
  assert.equal(prepayFor({ ...base, prepay_mode: "fixed", prepay_amount: 10 }, 35), 10);
  assert.equal(prepayFor({ ...base, prepay_mode: "fixed", prepay_amount: 50 }, 35), 35);
  assert.equal(prepayFor({ ...base, prepay_mode: "percent", prepay_percent: 50 }, 35), 17.5);
  assert.equal(prepayFor({ ...base, prepay_mode: "percent", prepay_percent: 33 }, 35), 11.55);
  assert.equal(prepayFor({ ...base, prepay_mode: "full" }, 35), 35);
  assert.equal(prepayFor({ ...base, prepay_mode: "percent", prepay_percent: 1 }, 35), 0);
  setStripeClient();
  assert.equal(prepayFor({ ...base, prepay_mode: "full" }, 35), 0);
});

test("settings: the hold time must be at least 30 minutes", async () => {
  const bad = await usePrepay({ hold_minutes: 20 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /at least 30 minutes/);
  const good = await usePrepay({ prepay_mode: "percent", prepay_percent: 25, hold_minutes: 45, refund_window_hours: 12 });
  assert.equal(good.status, 200);
  assert.equal(good.body.settings.hold_minutes, 45);
  assert.equal(good.body.stripe_connected, true);
});

test("without Stripe there is no pre-pay and the booking is confirmed at once", async () => {
  await usePrepay({ prepay_mode: "full" });
  setStripeClient();
  assert.equal((await call("GET", "/api/settings")).body.stripe_connected, false);
  assert.equal((await call("GET", "/api/public/shop")).body.prepay.mode, "none");
  const r = await book();
  assert.equal(r.status, 201);
  assert.equal(r.body.checkout_url, undefined);
  assert.equal(r.body.booking.status, "confirmed");
  assert.equal(r.body.booking.prepay.status, "none");
});

test("a booking with pre-pay is pending, holds the time, and returns the Stripe link", async () => {
  await usePrepay();
  assert.equal((await call("GET", `/api/public/availability?date=${TUE}&service_ids=1`)).body.prepay_amount, 10);
  const r = await book({ email: "sam@example.com" });
  assert.equal(r.status, 201);
  assert.equal(r.body.checkout_url, "https://stripe.test/pay/cs_test_1");
  assert.equal(r.body.booking.status, "pending");
  assert.deepEqual(
    { amount: r.body.booking.prepay.amount, status: r.body.booking.prepay.status, pay_url: r.body.booking.prepay.pay_url },
    { amount: 10, status: "due", pay_url: "https://stripe.test/pay/cs_test_1" },
  );
  // Stripe got the amount, the appointment id, and an end time of the hold (30 minutes + 1).
  const session = fake.sessions[0];
  const saved = await row();
  assert.equal(session.amountCents, 1000);
  assert.equal(session.appointmentId, saved.id);
  assert.equal(session.expiresAt, Math.floor(now.getTime() / 1000) + 31 * 60);
  assert.equal(session.successUrl, `https://shop.example/book/manage/${tokenOf(r)}?paid=1`);
  assert.equal(saved.stripe_session_id, "cs_test_1");
  assert.equal(saved.hold_expires_at, new Date(now.getTime() + 31 * 60_000).toISOString());
  // The time is held: nobody else can take it.
  assert.ok(!(await times()).includes("10:00"));
  assert.equal((await book({ name: "Other Person", phone: "555-555-0142" })).status, 409);
});

test("webhook: a bad signature is refused", async () => {
  await usePrepay();
  const r = await book();
  const object = { id: "cs_test_1", payment_status: "paid", payment_intent: "pi_test_1" };
  assert.equal((await webhook("checkout.session.completed", object, { signature: "t=1,v1=nope" })).status, 400);
  assert.equal((await webhook("checkout.session.completed", object, { secret: "whsec_wrong" })).status, 400);
  // A good signature that is too old.
  assert.equal((await webhook("checkout.session.completed", object, { at: Math.floor(now.getTime() / 1000) - 600 })).status, 400);
  const res = await app.request("/api/stripe/webhook", { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
  assert.equal((await view(tokenOf(r))).status, "pending");
  // With no secret set, nothing is accepted.
  assert.equal(verifyWebhook("{}", signWebhook("{}", "", 100), "", 100), false);
});

test("webhook: a good signature confirms the booking, and a second copy changes nothing", async () => {
  await usePrepay();
  const r = await book();
  const first = await paid();
  assert.deepEqual(first, { status: 200, body: { received: true } });
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.prepay.status, "paid");
  assert.equal(booking.prepay.pay_url, null);
  assert.equal((await row()).stripe_payment_intent, "pi_test_1");
  const before = await notes();
  assert.match(before, /Pre-pay of \$10\.00 received/);
  assert.equal((await paid()).status, 200);
  assert.equal(await notes(), before);
  // The hold no longer ends: the booking stays after the hold time.
  minutesLater(120);
  await releaseExpiredHolds();
  assert.equal((await view(tokenOf(r))).status, "confirmed");
});

test("webhook: an unpaid 'completed' waits for async_payment_succeeded", async () => {
  await usePrepay();
  const r = await book();
  await webhook("checkout.session.completed", { id: "cs_test_1", payment_status: "unpaid", payment_intent: "pi_test_1" });
  assert.equal((await view(tokenOf(r))).status, "pending");
  await webhook("checkout.session.async_payment_succeeded", { id: "cs_test_1", payment_status: "paid", payment_intent: "pi_test_1" });
  assert.equal((await view(tokenOf(r))).status, "confirmed");
  // An event for a session we do not know is accepted and ignored.
  assert.equal((await paid("cs_unknown")).status, 200);
});

test("hold expiry: an unpaid booking is released before availability is calculated", async () => {
  await usePrepay();
  const r = await book();
  minutesLater(30);
  assert.ok(!(await times()).includes("10:00"), "still held at 30 minutes");
  minutesLater(2);
  assert.ok((await times()).includes("10:00"), "open again after the hold");
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "expired");
  assert.equal(booking.prepay.pay_url, null);
  assert.match(await notes(), /not paid in time/);
  // Someone else can take the time now.
  assert.equal((await book({ name: "Other Person", phone: "555-555-0142" })).status, 201);
});

test("hold expiry: booking the same time works right after the hold ends", async () => {
  await usePrepay();
  await book();
  minutesLater(32);
  // No availability call in between: the booking route releases the hold itself.
  assert.equal((await book({ name: "Other Person", phone: "555-555-0142" })).status, 201);
});

test("webhook: checkout.session.expired releases the time", async () => {
  await usePrepay();
  const r = await book();
  assert.equal((await webhook("checkout.session.expired", { id: "cs_test_1", payment_status: "unpaid" })).status, 200);
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "expired");
  assert.ok((await times()).includes("10:00"));
  // The expired event for a paid booking does nothing.
  const second = await book({ time: "11:00" });
  await paid("cs_test_2", "pi_test_2");
  await webhook("checkout.session.expired", { id: "cs_test_2" });
  assert.equal((await view(tokenOf(second))).status, "confirmed");
});

test("paid after the hold ended: confirmed when the time is still free", async () => {
  await usePrepay();
  const r = await book();
  minutesLater(40);
  await releaseExpiredHolds();
  assert.equal((await view(tokenOf(r))).status, "cancelled");
  await paid();
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.prepay.status, "paid");
  assert.match(await notes(), /after the hold ended/);
  assert.ok(!(await times()).includes("10:00"));
});

test("paid after the hold ended: a note to refund when the time was taken", async () => {
  await usePrepay();
  const r = await book();
  minutesLater(40);
  const other = await book({ name: "Other Person", phone: "555-555-0142" });
  assert.equal(other.status, 201);
  await paid("cs_test_1", "pi_late");
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "refund_due");
  assert.match(await notes(), /Please refund it in Stripe/);
  // The other client keeps the time.
  assert.equal((await view(tokenOf(other))).status, "pending");
  // A second copy of the event adds no second note.
  const before = await notes();
  await paid("cs_test_1", "pi_late");
  assert.equal(await notes(), before);
});

test("cancel inside the refund window: the pre-pay is refunded automatically", async () => {
  await usePrepay({ prepay_mode: "fixed", prepay_amount: 10, refund_window_hours: 24 });
  // Wednesday 10:00 is 48 hours away.
  const r = await book({ date: WED });
  await paid();
  const token = tokenOf(r);
  assert.equal((await view(token)).prepay.refund_on_cancel, true);
  const cancelled = await call("POST", `/api/public/bookings/${token}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(fake.refunds, [{ intent: "pi_test_1", appointmentId: (await row()).id }]);
  const booking = await view(token);
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "refunded");
  assert.equal((await row()).stripe_refund_id, "re_test_1");
  assert.match(await notes(), /refunded to the client/);
});

test("cancel too late: no refund", async () => {
  await usePrepay({ prepay_mode: "fixed", prepay_amount: 10, refund_window_hours: 24 });
  // Tuesday 10:00 is exactly 24 hours away. One minute later it is too late.
  const r = await book();
  await paid();
  minutesLater(1);
  const token = tokenOf(r);
  assert.equal((await view(token)).prepay.refund_on_cancel, false);
  assert.equal((await call("POST", `/api/public/bookings/${token}/cancel`)).status, 200);
  assert.deepEqual(fake.refunds, []);
  const booking = await view(token);
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "paid");
  assert.match(await notes(), /was not refunded/);
});

test("cancel exactly at the refund window still refunds", async () => {
  await usePrepay({ prepay_mode: "fixed", prepay_amount: 10, refund_window_hours: 24 });
  const r = await book();
  await paid();
  await call("POST", `/api/public/bookings/${tokenOf(r)}/cancel`);
  assert.equal(fake.refunds.length, 1);
});

test("a refund that fails leaves a note for staff", async () => {
  await usePrepay();
  const r = await book({ date: WED });
  await paid();
  fake.failRefund = true;
  assert.equal((await call("POST", `/api/public/bookings/${tokenOf(r)}/cancel`)).status, 200);
  assert.equal((await view(tokenOf(r))).prepay.status, "refund_due");
  assert.match(await notes(), /could not be refunded automatically/);
});

test("cancel before paying: the payment page is stopped, and a late payment asks for a refund", async () => {
  await usePrepay();
  const r = await book();
  const token = tokenOf(r);
  assert.equal((await call("POST", `/api/public/bookings/${token}/cancel`)).status, 200);
  assert.deepEqual(fake.expired, ["cs_test_1"]);
  assert.deepEqual(fake.refunds, []);
  assert.equal((await view(token)).prepay.status, "void");
  assert.ok((await times()).includes("10:00"));
  await paid();
  const booking = await view(token);
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.prepay.status, "refund_due");
});

test("when Stripe fails, no booking is left behind", async () => {
  await usePrepay();
  fake.failCheckout = true;
  const r = await book();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /could not start the payment/);
  assert.equal((await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM appointments"))!.n, 0);
  assert.ok((await times()).includes("10:00"));
});

test("the public booking never shows Stripe ids", async () => {
  await usePrepay();
  const r = await book();
  await paid();
  const text = JSON.stringify((await call("GET", `/api/public/bookings/${tokenOf(r)}`)).body);
  assert.ok(!text.includes("cs_test_1"));
  assert.ok(!text.includes("pi_test_1"));
});

const staffSet = async (status: string) => call("PUT", `/api/appointments/${(await row()).id}`, { status });

test("staff cannot set 'waiting for pre-pay' by hand", async () => {
  const r = await book();
  assert.equal(r.body.booking.status, "confirmed");
  const bad = await staffSet("pending");
  assert.equal(bad.status, 400);
  assert.equal((await view(tokenOf(r))).status, "confirmed");
});

test("staff cancel a paid booking: no automatic refund, and a note says so", async () => {
  await usePrepay();
  const r = await book({ date: WED });
  await paid();
  assert.equal((await staffSet("cancelled")).status, 200);
  assert.deepEqual(fake.refunds, []);
  assert.equal((await view(tokenOf(r))).prepay.status, "paid");
  assert.match(await notes(), /Cancelled by the shop.*not refunded/);
});

test("staff confirm or cancel a booking that waits for pre-pay: the payment page is stopped", async () => {
  await usePrepay();
  const r = await book();
  assert.equal((await staffSet("confirmed")).status, 200);
  assert.deepEqual(fake.expired, ["cs_test_1"]);
  let booking = await view(tokenOf(r));
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.prepay.status, "void");
  assert.equal(booking.prepay.pay_url, null);
  // It no longer ends with the hold.
  minutesLater(60);
  await releaseExpiredHolds();
  assert.equal((await view(tokenOf(r))).status, "confirmed");

  const second = await book({ time: "11:00", name: "Other Person", phone: "555-555-0142" });
  assert.equal((await staffSet("cancelled")).status, 200);
  booking = await view(tokenOf(second));
  assert.equal(booking.prepay.status, "void");
  assert.deepEqual(fake.expired, ["cs_test_1", "cs_test_2"]);
});

test("staff bring back a booking whose hold ended: the pre-pay is dropped with a note", async () => {
  await usePrepay();
  const r = await book();
  minutesLater(40);
  await releaseExpiredHolds();
  assert.equal((await staffSet("confirmed")).status, 200);
  const booking = await view(tokenOf(r));
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.prepay.status, "void");
  assert.match(await notes(), /brought this booking back/);
});

test("a payment page that could not be saved is stopped", async () => {
  await usePrepay();
  const { startCheckout } = await import("./prepay.js");
  // Appointment 999 does not exist, but the update still runs. Force a failure with a duplicate session id instead.
  await book();
  const second = await book({ time: "11:00", name: "Other Person", phone: "555-555-0142" });
  assert.equal(second.status, 201);
  fake.sessions.length = 0; // the fake now hands out cs_test_1 again: a duplicate
  const result = await startCheckout({
    appointmentId: (await row()).id, reference: "X", amount: 10, shopName: "Shop",
    expires: new Date(now.getTime() + 31 * 60_000), manageUrl: "https://shop.example/book/manage/x",
  });
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(fake.expired, ["cs_test_1"]);
});
