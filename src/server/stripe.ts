import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe, through its HTTP API. Only what pre-pay needs: make a Checkout
 * session, expire one, refund a payment, and check a webhook signature.
 *
 * Tests install a fake with setStripeClient(), so they never use the network.
 */

export interface CheckoutInput {
  appointmentId: number;
  /** Shown to the client on the Stripe page. */
  description: string;
  amountCents: number;
  /** Unix seconds. Stripe wants 30 minutes to 24 hours from now. */
  expiresAt: number;
  successUrl: string;
  cancelUrl: string;
  email?: string;
}

export interface CheckoutSession { id: string; url: string }

export interface StripeClient {
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession>;
  /** Stop a session, so it can no longer be paid. */
  expireCheckoutSession(sessionId: string): Promise<void>;
  /** Refund a payment in full. Returns the refund id. */
  refund(paymentIntentId: string, appointmentId: number): Promise<{ id: string }>;
}

let override: StripeClient | null = null;
/** Tests only: use a fake Stripe. Pass nothing to remove it. */
export function setStripeClient(client?: StripeClient | null): void {
  override = client ?? null;
}

function secretKey(): string {
  return (process.env.STRIPE_SECRET_KEY ?? "").trim();
}

/** True when pre-pay can work. */
export function stripeConnected(): boolean {
  return override !== null || secretKey() !== "";
}

export function stripeCurrency(): string {
  const c = (process.env.STRIPE_CURRENCY ?? "").trim().toLowerCase();
  return /^[a-z]{3}$/.test(c) ? c : "usd";
}

export function getStripe(): StripeClient | null {
  if (override) return override;
  return secretKey() ? httpClient : null;
}

async function stripePost(path: string, params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    throw new Error(`Stripe answered ${res.status}: ${data?.error?.message ?? "unknown error"}`);
  }
  return data;
}

const httpClient: StripeClient = {
  async createCheckoutSession(input) {
    const id = String(input.appointmentId);
    const params: Record<string, string> = {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": stripeCurrency(),
      "line_items[0][price_data][unit_amount]": String(input.amountCents),
      "line_items[0][price_data][product_data][name]": input.description,
      expires_at: String(input.expiresAt),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: id,
      "metadata[appointment_id]": id,
      "payment_intent_data[metadata][appointment_id]": id,
    };
    if (input.email) params.customer_email = input.email;
    const session = await stripePost("checkout/sessions", params, `tolly-checkout-${id}-${input.expiresAt}`);
    if (!session?.id || !session?.url) throw new Error("Stripe did not return a checkout link.");
    return { id: session.id, url: session.url };
  },
  async expireCheckoutSession(sessionId) {
    await stripePost(`checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
  },
  async refund(paymentIntentId, appointmentId) {
    const refund = await stripePost("refunds", { payment_intent: paymentIntentId }, `tolly-refund-${appointmentId}`);
    return { id: String(refund.id) };
  },
};

// ── Webhook signature ──────────────────────────────────────────────

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The Stripe-Signature header for a payload. Used by tests too. */
export function signWebhook(payload: string, secret: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/**
 * True when the header is a good Stripe signature for this exact payload:
 * HMAC-SHA256 of "<t>.<payload>" with the webhook secret, not older than 5 minutes.
 */
export function verifyWebhook(payload: string, header: string | undefined, secret: string, nowSeconds: number): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex"));
  return signatures.some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
