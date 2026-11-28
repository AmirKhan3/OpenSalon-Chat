import { get, query } from "./db.js";
import { getSettings } from "./settings.js";
import { isValidDate, shopNow } from "./shoptime.js";

/**
 * Payments: money the shop really took. Reports for taxes and proof of income
 * are built from these rows only, never from booked prices.
 *
 * A refund is a row with negative amounts.
 */

export const METHODS = ["card_online", "card_in_person", "cash", "other"] as const;
export type Method = (typeof METHODS)[number];
export type Kind = "payment" | "refund";

export const METHOD_NAMES: Record<Method, string> = {
  card_online: "Card online",
  card_in_person: "Card / tap to pay",
  cash: "Cash",
  other: "Other",
};

export interface PaymentRow {
  id: number; appointment_id: number | null; client_id: number | null; staff_id: number | null; kind: Kind; method: Method;
  amount: number; tip: number; note: string; paid_on: string; stripe_ref: string | null; created_at: string;
}

export interface PaymentInput {
  appointmentId?: number | null;
  clientId?: number | null;
  staffId?: number | null;
  kind?: Kind;
  method: Method;
  /** For the services. Always positive here, also for a refund. */
  amount: number;
  tip?: number;
  note?: string;
  /** Shop-local date. Today when left out. */
  paidOn?: string;
  /** The Stripe id. The same id and kind is recorded once. */
  stripeRef?: string | null;
}

export type PaymentResult = { ok: true; payment: PaymentRow; duplicate: boolean } | { ok: false; error: string };

export const MAX_PAYMENT = 100_000;

export function cents(amount: number): number {
  return Math.round((Number(amount) || 0) * 100) / 100;
}

/** Save one payment or refund. */
export async function recordPayment(input: PaymentInput): Promise<PaymentResult> {
  const kind: Kind = input.kind ?? "payment";
  const amount = cents(input.amount);
  const tip = cents(input.tip ?? 0);
  if (!Number.isFinite(input.amount) || !Number.isFinite(input.tip ?? 0) || amount < 0 || tip < 0) {
    return { ok: false, error: "The amount and the tip cannot be negative." };
  }
  if (amount + tip <= 0) return { ok: false, error: "Enter an amount above zero." };
  if (amount > MAX_PAYMENT || tip > MAX_PAYMENT) return { ok: false, error: "That amount is too high." };
  if (!(METHODS as readonly string[]).includes(input.method)) return { ok: false, error: "Pick how it was paid: card, cash or other." };
  if (input.paidOn !== undefined && !isValidDate(input.paidOn)) return { ok: false, error: "Use a real date, as YYYY-MM-DD." };

  let clientId = input.clientId ?? null;
  let staffId = input.staffId ?? null;
  if (input.appointmentId != null) {
    const apt = await get<{ client_id: number | null; staff_id: number | null }>(
      "SELECT client_id, staff_id FROM appointments WHERE id = ?", [input.appointmentId]);
    if (!apt) return { ok: false, error: "We could not find that booking." };
    clientId = clientId ?? apt.client_id;
    staffId = staffId ?? apt.staff_id;
  }
  const paidOn = input.paidOn ?? shopNow((await getSettings()).timezone).date;
  const sign = kind === "refund" ? -1 : 1;
  const stripeRef = input.stripeRef?.trim() || null;

  const rows = await query<PaymentRow>(
    `INSERT INTO payments (appointment_id, client_id, staff_id, kind, method, amount, tip, note, paid_on, stripe_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stripe_ref, kind) DO NOTHING RETURNING *`,
    [input.appointmentId ?? null, clientId, staffId, kind, input.method, sign * amount, sign * tip, (input.note ?? "").trim().slice(0, 300), paidOn, stripeRef],
  );
  if (rows[0]) return { ok: true, payment: rows[0], duplicate: false };
  const existing = await get<PaymentRow>("SELECT * FROM payments WHERE stripe_ref = ? AND kind = ?", [stripeRef, kind]);
  if (existing) return { ok: true, payment: existing, duplicate: true };
  return { ok: false, error: "The payment was not saved. Try again." };
}

export function paymentsFor(appointmentId: number): Promise<PaymentRow[]> {
  return query<PaymentRow>("SELECT * FROM payments WHERE appointment_id = ? ORDER BY id", [appointmentId]);
}

/** What is still to pay for the services of a booking. Tips do not count. Never below zero. */
export async function amountDue(appointmentId: number): Promise<number> {
  const row = await get<{ price: number; paid: number }>(
    `SELECT a.total_price AS price, COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.appointment_id = a.id), 0) AS paid
     FROM appointments a WHERE a.id = ?`, [appointmentId]);
  if (!row) return 0;
  return Math.max(0, cents(Number(row.price) - Number(row.paid)));
}
