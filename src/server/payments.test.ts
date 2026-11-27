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
const { csvCell, csvLine } = await import("./paymentroutes.js");

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
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111'), ('Dre', 'Barber', '#222222');
    INSERT INTO clients (name, email, phone) VALUES ('Jamie Rivera', '', '+15555550101');
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

const payments = () => db.query<any>("SELECT * FROM payments ORDER BY id");
let seq = 0;
/** A booking made by staff, straight in the database. */
async function visit(v: { staff?: number; price?: number; date?: string; status?: string } = {}): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, source)
     VALUES (?, 1, ?, ?, ?, '14:00', '14:30', ?, 'staff') RETURNING id`,
    [`P-${++seq}`, v.staff ?? 1, v.status ?? "booked", v.date ?? TUE, v.price ?? 35]);
  return rows[0].id;
}
const pay = (id: number, body: object) => call("POST", `/api/appointments/${id}/payments`, body);
async function text(path: string) {
  const res = await app.request(path);
  return { status: res.status, type: res.headers.get("content-type") ?? "", disposition: res.headers.get("content-disposition") ?? "", text: await res.text() };
}

// ── Stripe pre-pay ─────────────────────────────────────────────────

test("a Stripe pre-pay is recorded once, even when the webhook is sent twice", async () => {
  await usePrepay();
  await book();
  await paid();
  await paid();
  await webhook("checkout.session.async_payment_succeeded", { id: "cs_test_1", payment_status: "paid", payment_intent: "pi_test_1" });
  const rows = await payments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "payment");
  assert.equal(rows[0].method, "card_online");
  assert.equal(Number(rows[0].amount), 10);
  assert.equal(Number(rows[0].tip), 0);
  assert.equal(rows[0].paid_on, "2026-03-02");
  assert.equal(rows[0].stripe_ref, "cs_test_1");
  assert.equal(rows[0].appointment_id, (await row()).id);
  assert.equal(rows[0].staff_id, 1);

  // The pre-pay counts toward the visit: $25 of $35 is still due.
  const list = await call("GET", `/api/appointments/${rows[0].appointment_id}/payments`);
  assert.equal(list.body.due, 25);
  assert.equal(list.body.paid, 10);
  assert.equal(list.body.payments[0].method_name, "Card online");
});

test("an unpaid checkout records nothing", async () => {
  await usePrepay();
  await book();
  await webhook("checkout.session.completed", { id: "cs_test_1", payment_status: "unpaid", payment_intent: "pi_test_1" });
  await webhook("checkout.session.expired", { id: "cs_test_1" });
  assert.equal((await payments()).length, 0);
});

test("an automatic refund is recorded as a negative row, once", async () => {
  await usePrepay({ prepay_mode: "fixed", prepay_amount: 10, refund_window_hours: 24 });
  const r = await book({ date: WED });
  await paid();
  minutesLater(60 * 24);
  await call("POST", `/api/public/bookings/${tokenOf(r)}/cancel`);
  let rows = await payments();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, "refund");
  assert.equal(rows[1].method, "card_online");
  assert.equal(Number(rows[1].amount), -10);
  assert.equal(rows[1].stripe_ref, "re_test_1");
  // The refund is on the day it happened, not the day of the payment.
  assert.equal(rows[1].paid_on, "2026-03-03");

  // Stripe also tells us about our own refund. It is not counted twice.
  await webhook("charge.refunded", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 1000 });
  await webhook("charge.refunded", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 1000 });
  rows = await payments();
  assert.equal(rows.length, 2);

  const report = (await call("GET", "/api/reports/income?start=2026-03-01&end=2026-03-31")).body;
  assert.equal(report.income, 0);
  assert.equal(report.services, 10);
  assert.equal(report.refunds, 10);
});

test("a late cancel keeps the pre-pay: no refund row", async () => {
  await usePrepay({ prepay_mode: "fixed", prepay_amount: 10, refund_window_hours: 24 });
  const r = await book();
  await paid();
  minutesLater(60 * 12);
  await call("POST", `/api/public/bookings/${tokenOf(r)}/cancel`);
  const rows = await payments();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 10);
});

test("a refund made in the Stripe Dashboard is recorded from the webhook", async () => {
  await usePrepay();
  await book();
  await paid();
  const id = (await row()).id;
  // The shop cancels. Staff changes never refund by themselves.
  await call("PUT", `/api/appointments/${id}`, { status: "cancelled" });
  assert.equal((await payments()).length, 1);

  // A part first, then the rest. Stripe sends the total refunded so far.
  assert.equal((await webhook("charge.refunded", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 400 })).status, 200);
  assert.equal((await row()).prepay_status, "paid");
  await webhook("charge.refunded", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 400 });
  await webhook("charge.refunded", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 1000 });
  const rows = await payments();
  assert.deepEqual(rows.map((p: any) => Number(p.amount)), [10, -4, -6]);
  assert.equal((await row()).prepay_status, "refunded");
  assert.match(await notes(), /\$6\.00 was refunded in Stripe/);

  // A charge we do not know changes nothing.
  await webhook("charge.refunded", { id: "ch_other", payment_intent: "pi_other", amount_refunded: 5000 });
  await webhook("charge.refunded", { id: "ch_other", amount_refunded: 5000 });
  assert.equal((await payments()).length, 3);
});

test("a pre-pay paid after the booking was cancelled is still recorded as money taken", async () => {
  await usePrepay();
  const r = await book();
  await call("POST", `/api/public/bookings/${tokenOf(r)}/cancel`);
  await paid();
  assert.equal((await row()).prepay_status, "refund_due");
  const rows = await payments();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 10);
});

// ── Recording by hand ──────────────────────────────────────────────

test("record a payment: amount, tip, method, and mark the visit completed", async () => {
  const id = await visit();
  assert.equal((await call("GET", `/api/appointments/${id}/payments`)).body.due, 35);
  const saved = await pay(id, { amount: 35, tip: 7, method: "card_in_person", note: "Tap to pay", complete: true });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.completed, true);
  assert.equal(saved.body.due, 0);
  assert.equal(saved.body.paid, 35);
  assert.equal(saved.body.tips, 7);
  assert.equal(saved.body.payments[0].method_name, "Card / tap to pay");
  assert.equal(saved.body.payments[0].paid_on, "2026-03-02");
  assert.equal((await row()).status, "completed");
  assert.equal((await call("GET", "/api/appointments/999/payments")).status, 404);
  assert.equal((await pay(999, { amount: 5, method: "cash" })).status, 404);
});

test("record a payment: bad input is refused", async () => {
  const id = await visit();
  assert.equal((await pay(id, { amount: 36, method: "cash" })).status, 400);
  assert.match((await pay(id, { amount: 36, method: "cash" })).body.error, /Only \$35\.00 is still due/);
  assert.equal((await pay(id, { amount: 0, method: "cash" })).status, 400);
  assert.equal((await pay(id, { amount: -5, method: "cash" })).status, 400);
  assert.equal((await pay(id, { amount: 5, method: "bitcoin" })).status, 400);
  assert.equal((await pay(id, { amount: 5, method: "cash", paid_on: "2026-02-30" })).status, 400);
  assert.equal((await payments()).length, 0);

  // Two parts are fine. A tip alone is fine once the visit is paid.
  assert.equal((await pay(id, { amount: 20, method: "cash" })).status, 201);
  assert.equal((await pay(id, { amount: 15, method: "card_in_person" })).body.due, 0);
  assert.match((await pay(id, { amount: 1, method: "cash" })).body.error, /already paid in full/);
  assert.equal((await pay(id, { amount: 0, tip: 5, method: "cash" })).status, 201);
  // Not asked to complete, so the status did not change.
  assert.equal((await row()).status, "booked");
  // A cancelled visit is not completed by a payment.
  const gone = await visit({ status: "cancelled" });
  assert.equal((await pay(gone, { amount: 35, method: "cash", complete: true })).body.completed, false);
});

test("a refund by hand cannot be more than was taken, and a hand-made row can be removed", async () => {
  const id = await visit();
  await pay(id, { amount: 35, tip: 5, method: "cash" });
  assert.equal((await pay(id, { kind: "refund", amount: 40, method: "cash" })).status, 400);
  assert.equal((await pay(id, { kind: "refund", amount: 10, tip: 6, method: "cash" })).status, 400);
  const back = await pay(id, { kind: "refund", amount: 10, method: "cash", complete: true });
  assert.equal(back.status, 201);
  assert.equal(back.body.completed, false);
  assert.equal(Number(back.body.payment.amount), -10);
  assert.equal(back.body.due, 10);

  const removed = await call("DELETE", `/api/appointments/${id}/payments/${back.body.payment.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.due, 0);
  assert.equal((await call("DELETE", `/api/appointments/${id}/payments/${back.body.payment.id}`)).status, 404);
  // Not through another booking.
  const other = await visit();
  const first = (await payments())[0].id;
  assert.equal((await call("DELETE", `/api/appointments/${other}/payments/${first}`)).status, 404);
  assert.equal((await payments()).length, 1);
});

test("a payment from Stripe cannot be removed by hand", async () => {
  await usePrepay();
  await book();
  await paid();
  const p = (await payments())[0];
  const res = await call("DELETE", `/api/appointments/${p.appointment_id}/payments/${p.id}`);
  assert.equal(res.status, 400);
  assert.equal((await payments()).length, 1);
});

test("a booking with money on it cannot be deleted", async () => {
  const empty = await visit();
  assert.equal((await call("DELETE", `/api/appointments/${empty}`)).status, 200);

  const id = await visit();
  await pay(id, { amount: 35, method: "cash" });
  const res = await call("DELETE", `/api/appointments/${id}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Cancel it instead/);
  assert.equal((await payments())[0].appointment_id, id);

  // A pre-pay that Stripe may still report keeps the booking too.
  await usePrepay();
  await book();
  const held = await db.get<{ id: number }>("SELECT id FROM appointments WHERE prepay_status = 'due'");
  assert.equal((await call("DELETE", `/api/appointments/${held!.id}`)).status, 400);
});

// ── Reports ────────────────────────────────────────────────────────

async function yearOfMoney() {
  const a = await visit({ price: 100 });
  const b = await visit({ price: 50, staff: 2 });
  await pay(a, { amount: 60, tip: 10, method: "cash", paid_on: "2026-01-15" });
  await pay(a, { amount: 40, method: "card_in_person", paid_on: "2026-02-03" });
  await pay(b, { amount: 50, tip: 5, method: "card_in_person", paid_on: "2026-02-20" });
  await pay(b, { kind: "refund", amount: 20, method: "card_in_person", paid_on: "2026-04-02" });
  // Outside the year.
  const c = await visit({ price: 30 });
  await pay(c, { amount: 30, method: "other", paid_on: "2025-12-31" });
  return { a, b, c };
}

test("income report: totals, refunds, months, methods and barbers", async () => {
  await yearOfMoney();
  const year = await call("GET", "/api/reports/income?start=2026-01-01&end=2026-12-31");
  assert.equal(year.status, 200);
  const r = year.body;
  assert.equal(r.services, 150);
  assert.equal(r.tips, 15);
  assert.equal(r.refunds, 20);
  assert.equal(r.income, 145);
  assert.equal(r.payments, 3);
  assert.deepEqual(r.by_month, [
    { month: "2026-01", income: 70, services: 60, tips: 10, refunds: 0 },
    { month: "2026-02", income: 95, services: 90, tips: 5, refunds: 0 },
    { month: "2026-04", income: -20, services: 0, tips: 0, refunds: 20 },
  ]);
  assert.deepEqual(r.by_method.map((m: any) => [m.name, m.total]), [["Card / tap to pay", 75], ["Cash", 70]]);
  assert.deepEqual(r.by_barber.map((b: any) => [b.barber, b.total, b.tips]), [["Marcus", 110, 10], ["Dre", 35, 5]]);

  // A quarter. The edges are included.
  const q1 = (await call("GET", "/api/reports/income?start=2026-01-01&end=2026-03-31")).body;
  assert.equal(q1.income, 165);
  assert.equal(q1.refunds, 0);
  const q2 = (await call("GET", "/api/reports/income?start=2026-04-01&end=2026-06-30")).body;
  assert.equal(q2.income, -20);
  const last = (await call("GET", "/api/reports/income?start=2025-12-31&end=2025-12-31")).body;
  assert.equal(last.income, 30);
  const empty = (await call("GET", "/api/reports/income?start=2027-01-01&end=2027-12-31")).body;
  assert.equal(empty.income, 0);
  assert.deepEqual(empty.by_month, []);
});

test("reports refuse bad dates", async () => {
  for (const path of ["/api/reports/income", "/api/reports/bookings", "/api/reports/income.csv"]) {
    assert.equal((await text(`${path}?start=2026-02-30&end=2026-03-01`)).status, 400, path);
    assert.equal((await text(`${path}?start=2026-03-02&end=2026-03-01`)).status, 400, path);
    assert.equal((await text(`${path}?start=2026-03-02`)).status, 400, path);
  }
});

test("bookings report counts what was on the calendar", async () => {
  await visit({ status: "completed" });
  await visit({ status: "cancelled" });
  await visit({ status: "no_show", staff: 2 });
  await visit({ date: "2026-04-01" });
  const r = (await call("GET", "/api/reports/bookings?start=2026-03-01&end=2026-03-31")).body;
  assert.equal(r.bookings, 2);
  assert.equal(r.completed, 1);
  assert.equal(r.cancelled, 1);
  assert.equal(r.no_shows, 1);
  assert.equal(r.completed_value, 35);
});

test("CSV cells: commas, quotes, new lines and spreadsheet formulas", () => {
  assert.equal(csvCell("Jamie"), "Jamie");
  assert.equal(csvCell("Rivera, Jamie"), '"Rivera, Jamie"');
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("+1 555 0100"), "'+1 555 0100");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("  =1+1"), "'  =1+1");
  assert.equal(csvCell("\t=1+1"), "'\t=1+1");
  assert.equal(csvCell('=HYPERLINK("http://x","y"),z'), '"\'=HYPERLINK(""http://x"",""y""),z"');
  // Numbers are money. A refund keeps its minus sign.
  assert.equal(csvCell(-20), "-20.00");
  assert.equal(csvCell(35), "35.00");
  assert.equal(csvCell(null), "");
  assert.equal(csvLine(["a", "b,c", 1]), 'a,"b,c",1.00');
});

test("income CSV: one row per payment, and names cannot run as formulas", async () => {
  const { a } = await yearOfMoney();
  const booking = (await db.get<{ identifier: string }>("SELECT identifier FROM appointments WHERE id = ?", [a]))!.identifier;
  await db.run("UPDATE clients SET name = ? WHERE id = 1", ['=cmd|"/c calc"!A1, Jamie']);
  await pay(a, { amount: 0, tip: 2, method: "cash", note: "+thanks, \"great\" cut", paid_on: "2026-05-01" });

  const res = await text("/api/reports/income.csv?start=2026-01-01&end=2026-12-31");
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/csv/);
  assert.match(res.disposition, /attachment; filename="income-2026-01-01-to-2026-12-31\.csv"/);
  const lines = res.text.replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.equal(lines[0], "Date,Type,Method,Services,Tip,Total,Client,Barber,Booking,Note,Stripe reference");
  assert.equal(lines.length, 1 + 5);
  assert.equal(lines[1], `2026-01-15,Payment,Cash,60.00,10.00,70.00,"'=cmd|""/c calc""!A1, Jamie",Marcus,${booking},,`);
  assert.match(lines[4], /^2026-04-02,Refund,Card \/ tap to pay,-20\.00,0\.00,-20\.00,/);
  assert.match(lines[5], /,"'\+thanks, ""great"" cut",$/);
  // No cell starts a formula.
  for (const line of lines.slice(1)) assert.ok(!/(^|,)"?[=+@]/.test(line), line);
  // The rows add up to the report.
  const total = lines.slice(1).reduce((sum, line) => sum + Number(line.split(",")[5]), 0);
  assert.equal(total, (await call("GET", "/api/reports/income?start=2026-01-01&end=2026-12-31")).body.income);
});

test("payments and reports need a login when the shop has a password", async () => {
  const id = await visit();
  process.env.STAFF_PASSWORD = "test-only-password";
  try {
    for (const path of [`/api/appointments/${id}/payments`, "/api/reports/income?start=2026-01-01&end=2026-12-31",
      "/api/reports/bookings?start=2026-01-01&end=2026-12-31", "/api/reports/income.csv?start=2026-01-01&end=2026-12-31"]) {
      assert.equal((await text(path)).status, 401, path);
    }
    assert.equal((await pay(id, { amount: 5, method: "cash" })).status, 401);
  } finally {
    delete process.env.STAFF_PASSWORD;
  }
});
