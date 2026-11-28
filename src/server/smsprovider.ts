import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/**
 * Text messages (SMS). Telnyx is the default provider. Twilio is optional.
 *
 * This file only talks to the provider: send a text, and check that a webhook
 * really came from the provider. Threads and opt-out live in sms.ts.
 *
 * Tests install a fake with setSmsProvider(), so they never use the network.
 */

export type SendResult = { ok: true; id: string } | { ok: false; reason: string };

export interface SmsProvider {
  name: string;
  /** The shop's number, in E.164 form. */
  from: string;
  send(to: string, body: string): Promise<SendResult>;
}

const env = (name: string): string => (process.env[name] ?? "").trim();

// ── Phone numbers ──────────────────────────────────────────────────

/** "+15555550123" from any way of writing a number. US numbers may come without the 1. Empty when it is not a number. */
export function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

/** For logs: only the last 4 digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

// ── Which provider ─────────────────────────────────────────────────

export type ProviderName = "telnyx" | "twilio";

/** SMS_PROVIDER when set. Else the provider whose keys are set: Telnyx first. */
export function smsProviderName(): ProviderName | null {
  const chosen = env("SMS_PROVIDER").toLowerCase();
  if (chosen === "telnyx" || chosen === "twilio") return chosen;
  if (env("TELNYX_API_KEY")) return "telnyx";
  if (env("TWILIO_ACCOUNT_SID")) return "twilio";
  return null;
}

let override: SmsProvider | null = null;
/** Tests only: use a fake provider. Pass nothing to remove it. */
export function setSmsProvider(provider?: SmsProvider | null): void {
  override = provider ?? null;
}

/** The provider, or null when texts are not set up. */
export function getSmsProvider(): SmsProvider | null {
  if (override) return override;
  const name = smsProviderName();
  if (name === "telnyx") {
    const from = toE164(env("TELNYX_FROM_NUMBER"));
    return env("TELNYX_API_KEY") && from ? { name, from, send: (to, body) => telnyxSend(from, to, body) } : null;
  }
  if (name === "twilio") {
    const from = toE164(env("TWILIO_FROM_NUMBER"));
    return env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && from
      ? { name, from, send: (to, body) => twilioSend(from, to, body) } : null;
  }
  return null;
}

/** What Settings shows. Never a key. */
export function smsStatus(): { provider: string; connected: boolean; from_number: string; webhook_path: string } {
  const provider = smsProviderName();
  const active = getSmsProvider();
  return {
    provider: provider ?? "",
    connected: active !== null,
    from_number: active?.from ?? "",
    webhook_path: provider ? `/api/sms/${provider}` : "/api/sms/telnyx",
  };
}

// ── Sending ────────────────────────────────────────────────────────

const short = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

async function telnyxSend(from: string, to: string, body: string): Promise<SendResult> {
  try {
    const profile = env("TELNYX_MESSAGING_PROFILE_ID");
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, text: body, ...(profile ? { messaging_profile_id: profile } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: short(data?.errors?.[0]?.detail ?? data?.errors?.[0]?.title ?? `Telnyx error ${res.status}`) };
    return { ok: true, id: String(data?.data?.id ?? "") };
  } catch (err) {
    return { ok: false, reason: short(err instanceof Error ? err.message : "could not reach Telnyx") };
  }
}

async function twilioSend(from: string, to: string, body: string): Promise<SendResult> {
  try {
    const sid = env("TWILIO_ACCOUNT_SID");
    const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // With a public address, Twilio tells us later when a text did not arrive.
      body: new URLSearchParams({ To: to, From: from, Body: body, ...(publicUrl ? { StatusCallback: `${publicUrl}/api/sms/twilio` } : {}) }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: short(data?.message ?? `Twilio error ${res.status}`) };
    return { ok: true, id: String(data?.sid ?? "") };
  } catch (err) {
    return { ok: false, reason: short(err instanceof Error ? err.message : "could not reach Twilio") };
  }
}

// ── Webhook signatures ─────────────────────────────────────────────

/** Telnyx refuses nothing itself: we refuse a webhook whose timestamp is older than this. */
export const TELNYX_MAX_AGE_SECONDS = 5 * 60;

// The fixed start of an Ed25519 public key in DER form. The 32 key bytes follow.
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Check a Telnyx webhook: an Ed25519 signature over "<timestamp>|<raw body>",
 * made with the key pair whose public key is in the Telnyx portal.
 */
export function verifyTelnyx(input: {
  rawBody: string; signature: string; timestamp: string; publicKey: string; nowSeconds?: number;
}): boolean {
  const { rawBody, signature, timestamp, publicKey } = input;
  if (!signature || !publicKey || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TELNYX_MAX_AGE_SECONDS) return false;
  try {
    const raw = Buffer.from(publicKey, "base64");
    const sig = Buffer.from(signature, "base64");
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_DER_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** What Twilio signs: the full URL, then each form field name and value, sorted by name. */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

/** Check a Twilio webhook: HMAC-SHA1 in the X-Twilio-Signature header. */
export function verifyTwilio(input: { url: string; params: Record<string, string>; signature: string; authToken: string }): boolean {
  if (!input.signature || !input.authToken) return false;
  const expected = Buffer.from(twilioSignature(input.url, input.params, input.authToken));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
