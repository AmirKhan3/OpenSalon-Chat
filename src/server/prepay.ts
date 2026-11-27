import type { OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { isFree, loadDay } from "./availability.js";
import { toMinutes } from "./scheduling.js";
import { getSettings, type ShopSettings } from "./settings.js";
import { daysBetween, shopNow, wallClock } from "./shoptime.js";
import { getStripe, stripeConnected, stripeCurrency, verifyWebhook } from "./stripe.js";

/**
 * Pre-pay: the client pays part or all of the price when they book.
 *
 * A booking that needs pre-pay starts as "pending". Its time is held until
 * hold_expires_at. Stripe tells us about the payment through the webhook.
 *
 * prepay_status on an appointment:
 *   none        no pre-pay asked
 *   due         waiting for the client to pay
 *   paid        paid
 *   refunded    paid, then refunded
 *   refund_due  paid, and the shop must refund it by hand in Stripe
 *   expired     not paid in time; the time was released
 *   void        the client cancelled before paying
 */

/** Stripe does not take card payments smaller than this (in USD). */
export const MIN_PREPAY = 0.5;

export type PrepayRules = Pick<ShopSettings, "prepay_mode" | "prepay_amount" | "prepay_percent">;

const cents = (amount: number): number => Math.round(amount * 100);

/** What the client pays now for a visit that costs `price`. 0 means no pre-pay. */
export function prepayFor(rules: PrepayRules, price: number): number {
  if (!stripeConnected() || !(price > 0)) return 0;
  let amount = 0;
  if (rules.prepay_mode === "fixed") amount = Math.min(rules.prepay_amount, price);
  else if (rules.prepay_mode === "percent") amount = (price * rules.prepay_percent) / 100;
  else if (rules.prepay_mode === "full") amount = price;
  amount = cents(amount) / 100;
  return amount >= MIN_PREPAY ? amount : 0;
}

/** The pre-pay rules as the booking page may see them. "none" when Stripe is not connected. */
export function publicPrepayPolicy(settings: ShopSettings) {
  const on = stripeConnected() && settings.prepay_mode !== "none";
  return {
    mode: on ? settings.prepay_mode : ("none" as const),
    amount: settings.prepay_amount,
    percent: settings.prepay_percent,
    minimum: MIN_PREPAY,
    refund_window_hours: settings.refund_window_hours,
    hold_minutes: settings.hold_minutes,
  };
}

export function money(amount: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: stripeCurrency().toUpperCase() }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function note(appointmentId: number, content: string): Promise<unknown> {
  return run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [appointmentId, content]);
}

// ── Holds ──────────────────────────────────────────────────────────

/** When a hold that starts now ends. The extra minute keeps Stripe's 30-minute minimum safe. */
export function holdEnd(holdMinutes: number): Date {
  return new Date(wallClock().getTime() + (holdMinutes * 60 + 60) * 1000);
}

/**
 * Release holds that were not paid in time, so the time is open again.
 * Returns how many were released. Safe to call often.
 */
export async function releaseExpiredHolds(): Promise<number> {
  const released = await query<{ id: number }>(
    `UPDATE appointments SET status = 'cancelled', prepay_status = 'expired', updated_at = utc_now()
     WHERE status = 'pending' AND prepay_status = 'due' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?
     RETURNING id`,
    [wallClock().toISOString()],
  );
  for (const row of released) {
    await note(row.id, "The pre-pay was not paid in time. The booking was cancelled and the time is open again.");
  }
  return released.length;
}

export interface CheckoutStart { ok: true; url: string }
export interface CheckoutFailed { ok: false }

/**
 * Make the Stripe Checkout session for a pending booking and save it.
 * The caller removes the booking when this fails.
 */
export async function startCheckout(input: {
  appointmentId: number; reference: string; amount: number; shopName: string;
  expires: Date; manageUrl: string; email?: string;
}): Promise<CheckoutStart | CheckoutFailed> {
  const stripe = getStripe();
  if (!stripe) return { ok: false };
  let made: string | null = null;
  try {
    const session = await stripe.createCheckoutSession({
      appointmentId: input.appointmentId,
      description: `Pre-pay for booking ${input.reference} at ${input.shopName}`,
      amountCents: cents(input.amount),
      expiresAt: Math.floor(input.expires.getTime() / 1000),
      successUrl: `${input.manageUrl}?paid=1`,
      cancelUrl: input.manageUrl,
      ...(input.email ? { email: input.email } : {}),
    });
    made = session.id;
    await run("UPDATE appointments SET stripe_session_id = ?, stripe_checkout_url = ? WHERE id = ?", [session.id, session.url, input.appointmentId]);
    return { ok: true, url: session.url };
  } catch (err) {
    console.error("Stripe checkout could not be made:", err instanceof Error ? err.message : err);
    // The page exists but we could not save it. Stop it, so nobody pays for a booking we do not have.
    if (made) await stripe.expireCheckoutSession(made).catch(() => undefined);
    return { ok: false };
  }
}

// ── Payment arrives ────────────────────────────────────────────────

interface PrepayRow {
  id: number; status: string; staff_id: number | null; scheduled_date: string; start_time: string; end_time: string;
  prepay_amount: number; prepay_status: string; stripe_session_id: string | null; stripe_payment_intent: string | null;
}

const PREPAY_COLUMNS =
  "id, status, staff_id, scheduled_date, start_time, end_time, prepay_amount, prepay_status, stripe_session_id, stripe_payment_intent";

function bySession(sessionId: string): Promise<PrepayRow | undefined> {
  return get<PrepayRow>(`SELECT ${PREPAY_COLUMNS} FROM appointments WHERE stripe_session_id = ?`, [sessionId]);
}

/** Minutes from now until the visit starts, in shop time. Negative when it has started. */
function minutesUntil(row: { scheduled_date: string; start_time: string }, timezone: string): number {
  const now = shopNow(timezone);
  return daysBetween(now.date, row.scheduled_date) * 1440 + (toMinutes(row.start_time) ?? 0) - now.minutes;
}

/** True when nothing else took this booking's time while it was released. */
async function timeStillFree(row: PrepayRow, timezone: string): Promise<boolean> {
  if (row.staff_id === null || minutesUntil(row, timezone) <= 0) return false;
  const start = toMinutes(row.start_time);
  const end = toMinutes(row.end_time);
  if (start === null || end === null) return false;
  // The booking itself is cancelled, so loadDay does not count it.
  return isFree(await loadDay(row.scheduled_date), row.staff_id, start, end);
}

/**
 * The client paid. Safe to call twice for the same session.
 * Returns what happened, for the logs and the tests.
 */
export async function markPaid(sessionId: string, paymentIntent: string | null): Promise<"confirmed" | "already" | "refund_due" | "unknown"> {
  const row = await bySession(sessionId);
  if (!row) {
    console.error("Stripe reported a payment for a checkout we do not know. Check it in Stripe.");
    return "unknown";
  }
  if (["paid", "refunded", "refund_due"].includes(row.prepay_status)) return "already";
  const amount = money(row.prepay_amount);

  if (row.status === "cancelled") {
    const settings = await getSettings();
    // Paid after the hold ended. Give the time back only if it is still free.
    if (row.prepay_status === "expired" && await timeStillFree(row, settings.timezone)) {
      await run(
        "UPDATE appointments SET status = 'confirmed', prepay_status = 'paid', stripe_payment_intent = ?, hold_expires_at = NULL, updated_at = utc_now() WHERE id = ?",
        [paymentIntent, row.id],
      );
      await note(row.id, `Pre-pay of ${amount} received after the hold ended. The time was still free, so the booking is confirmed.`);
      return "confirmed";
    }
    await run(
      "UPDATE appointments SET prepay_status = 'refund_due', stripe_payment_intent = ?, updated_at = utc_now() WHERE id = ?",
      [paymentIntent, row.id],
    );
    await note(row.id, `Pre-pay of ${amount} was paid, but the booking was already cancelled. Please refund it in Stripe.`);
    return "refund_due";
  }

  await run(
    `UPDATE appointments SET status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
       prepay_status = 'paid', stripe_payment_intent = ?, hold_expires_at = NULL, updated_at = utc_now() WHERE id = ?`,
    [paymentIntent, row.id],
  );
  await note(row.id, `Pre-pay of ${amount} received. The booking is confirmed.`);
  return "confirmed";
}

/** Stripe says the session ended without payment. Release the time. */
export async function markSessionEnded(sessionId: string): Promise<boolean> {
  const released = await query<{ id: number }>(
    `UPDATE appointments SET status = 'cancelled', prepay_status = 'expired', updated_at = utc_now()
     WHERE stripe_session_id = ? AND status = 'pending' AND prepay_status = 'due' RETURNING id`,
    [sessionId],
  );
  for (const row of released) await note(row.id, "The pre-pay was not paid. The booking was cancelled and the time is open again.");
  return released.length > 0;
}

// ── The client cancels ─────────────────────────────────────────────

/** True when cancelling now gives the pre-pay back. */
export function refundOnCancel(
  row: { status: string; prepay_status: string; scheduled_date: string; start_time: string },
  settings: Pick<ShopSettings, "refund_window_hours" | "timezone">,
): boolean {
  if (row.prepay_status !== "paid" || row.status === "cancelled") return false;
  return minutesUntil(row, settings.timezone) >= settings.refund_window_hours * 60;
}

/**
 * Call right after the client cancelled a booking, with the row as it was before.
 * Refunds the pre-pay when the rules allow it, and leaves a note for staff.
 */
export async function settlePrepayOnCancel(
  before: { id: number; status: string; prepay_amount: number; prepay_status: string; scheduled_date: string; start_time: string;
    stripe_session_id: string | null; stripe_payment_intent: string | null },
  settings: ShopSettings,
): Promise<void> {
  const stripe = getStripe();
  if (before.prepay_status === "due") {
    await run("UPDATE appointments SET prepay_status = 'void', hold_expires_at = NULL WHERE id = ?", [before.id]);
    // Best effort: stop the payment page. If the client still pays, the webhook asks staff to refund.
    if (stripe && before.stripe_session_id) {
      await stripe.expireCheckoutSession(before.stripe_session_id).catch(() => undefined);
    }
    return;
  }
  if (before.prepay_status !== "paid") return;
  const amount = money(before.prepay_amount);
  if (!refundOnCancel(before, settings)) {
    await note(before.id, `Cancelled less than ${settings.refund_window_hours} hours before the visit. The pre-pay of ${amount} was not refunded.`);
    return;
  }
  try {
    if (!stripe || !before.stripe_payment_intent) throw new Error("Stripe is not connected.");
    const refund = await stripe.refund(before.stripe_payment_intent, before.id);
    await run("UPDATE appointments SET prepay_status = 'refunded', stripe_refund_id = ? WHERE id = ?", [refund.id, before.id]);
    await note(before.id, `Pre-pay of ${amount} refunded to the client.`);
  } catch (err) {
    console.error("Stripe refund failed:", err instanceof Error ? err.message : err);
    await run("UPDATE appointments SET prepay_status = 'refund_due' WHERE id = ?", [before.id]);
    await note(before.id, `The pre-pay of ${amount} could not be refunded automatically. Please refund it in Stripe.`);
  }
}

// ── Staff change the status ────────────────────────────────────────

/**
 * Call right after staff changed an appointment's status in the dashboard.
 * Staff changes never refund by themselves: the note tells the shop what to do.
 */
export async function settlePrepayOnStaffChange(id: number, before: string, after: string): Promise<void> {
  if (before === after) return;
  const row = await get<{ prepay_amount: number; prepay_status: string; stripe_session_id: string | null }>(
    "SELECT prepay_amount, prepay_status, stripe_session_id FROM appointments WHERE id = ?", [id]);
  if (!row) return;
  const amount = money(row.prepay_amount);

  if (row.prepay_status === "due") {
    // The shop cancelled it, or confirmed it without the pre-pay. Stop the payment page.
    await run("UPDATE appointments SET prepay_status = 'void', hold_expires_at = NULL WHERE id = ?", [id]);
    const stripe = getStripe();
    if (stripe && row.stripe_session_id) await stripe.expireCheckoutSession(row.stripe_session_id).catch(() => undefined);
    if (after !== "cancelled") await note(id, `The shop changed the booking before the pre-pay of ${amount} was paid. The pre-pay is no longer asked for.`);
    return;
  }
  if (after === "cancelled" && row.prepay_status === "paid") {
    await note(id, `Cancelled by the shop. The pre-pay of ${amount} was not refunded. Refund it in Stripe if you want to give it back.`);
    return;
  }
  if (before === "cancelled" && row.prepay_status === "expired") {
    // Brought back by the shop after the hold ended.
    await run("UPDATE appointments SET prepay_status = 'void', hold_expires_at = NULL WHERE id = ?", [id]);
    await note(id, `The shop brought this booking back. The pre-pay of ${amount} was not paid.`);
  }
}

// ── Stripe webhook ─────────────────────────────────────────────────

export function registerStripeRoutes(app: OpenAPIHono): void {
  /**
   * Stripe calls this. No login: the signature is the proof.
   * In Stripe, send: checkout.session.completed, checkout.session.async_payment_succeeded,
   * checkout.session.async_payment_failed, checkout.session.expired.
   */
  app.post("/api/stripe/webhook", async (c) => {
    const payload = await c.req.text();
    const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    const nowSeconds = Math.floor(wallClock().getTime() / 1000);
    if (!verifyWebhook(payload, c.req.header("stripe-signature"), secret, nowSeconds)) {
      return c.json({ error: "Bad signature." }, 400);
    }
    let event: { type?: unknown; data?: { object?: { id?: unknown; payment_status?: unknown; payment_intent?: unknown } } };
    try {
      event = JSON.parse(payload);
    } catch {
      return c.json({ error: "Bad request." }, 400);
    }
    const session = event?.data?.object;
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (!sessionId) return c.json({ received: true }, 200);
    const intent = typeof session?.payment_intent === "string" ? session.payment_intent : null;

    if (event.type === "checkout.session.completed") {
      // A bank debit can complete before the money arrives. Wait for async_payment_succeeded then.
      if (session?.payment_status === "paid") await markPaid(sessionId, intent);
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      await markPaid(sessionId, intent);
    } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      await markSessionEnded(sessionId);
    }
    return c.json({ received: true }, 200);
  });
}
