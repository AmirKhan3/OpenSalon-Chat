import type { OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { clientByPhone } from "./clientbooking.js";
import { addMessage, getThread, type Thread } from "./chatstore.js";
import { kickAgent } from "./agent.js";
import { publicBaseUrl } from "./public.js";
import { getSmsProvider, maskPhone, toE164, verifyTelnyx, verifyTwilio } from "./smsprovider.js";

/**
 * Texts with clients.
 *
 * One thread per phone number. The number a text comes from is who the client
 * is: Tolly never asks for it, and the booking tools use only that number.
 *
 * STOP turns texts off for a number. START turns them on again.
 */

// The phone companies and the providers treat all of these as "stop", and block our texts after.
// So "CANCEL" alone must count too, even when the client meant a visit. The barber gets a note.
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_WORDS = new Set(["START", "UNSTOP"]);

/** "Stop." and " stop " are the keyword STOP. "Stop by at 5?" is not. */
function keyword(body: string): string {
  return body.trim().replace(/[.!\s]+$/g, "").toUpperCase();
}

/** The text thread of a phone number. Made on first use and linked to the client with that number. */
export async function smsThreadForPhone(phone: string): Promise<Thread | null> {
  const e164 = toE164(phone);
  if (!e164) return null;
  const found = await get<Thread>(
    "SELECT * FROM chat_threads WHERE kind = 'client' AND channel = 'sms' AND phone = ? ORDER BY id LIMIT 1", [e164],
  );
  if (found) {
    if (found.client_id === null) {
      const client = await clientByPhone(e164);
      if (client) {
        await run("UPDATE chat_threads SET client_id = ?, display_name = ? WHERE id = ?", [client.id, client.name.slice(0, 100), found.id]);
        return getThread(found.id);
      }
    }
    return found;
  }
  const client = await clientByPhone(e164);
  const rows = await query<Thread>(
    "INSERT INTO chat_threads (kind, channel, phone, client_id, display_name) VALUES ('client', 'sms', ?, ?, ?) RETURNING *",
    [e164, client?.id ?? null, (client?.name ?? "").slice(0, 100)],
  );
  return rows[0];
}

/** True when this number texted STOP. We must not text it. */
export async function isOptedOut(phone: string): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  const row = await get<{ id: number }>(
    "SELECT id FROM chat_threads WHERE kind = 'client' AND channel = 'sms' AND phone = ? AND opted_out = 1 LIMIT 1", [e164],
  );
  return row !== undefined && row !== null;
}

// Texts are handled one after the other, so the same text is never saved twice.
let line: Promise<unknown> = Promise.resolve();

export interface IncomingText { from: string; body: string; ref: string }

/**
 * A client texted the shop. Saves the text and returns at once.
 * The assistant answers after, in the background.
 */
export function receiveText(incoming: IncomingText, baseUrl: string): Promise<"saved" | "duplicate" | "ignored"> {
  const next = line.then(() => handleText(incoming, baseUrl));
  line = next.catch(() => undefined);
  return next;
}

async function handleText(incoming: IncomingText, baseUrl: string): Promise<"saved" | "duplicate" | "ignored"> {
  const body = incoming.body.trim();
  const thread = await smsThreadForPhone(incoming.from);
  if (!thread || !body) return "ignored";
  const ref = incoming.ref.slice(0, 100) || null;
  // Providers send a webhook again when they are not sure we got it.
  if (ref && (await get("SELECT id FROM chat_messages WHERE provider_ref = ? AND sender = 'client' LIMIT 1", [ref]))) return "duplicate";

  await addMessage(thread.id, "client", body, ref);
  const word = keyword(body);

  if (STOP_WORDS.has(word)) {
    await run("UPDATE chat_threads SET opted_out = 1, updated_at = utc_now() WHERE id = ?", [thread.id]);
    if (thread.opted_out !== 1) {
      const maybeVisit = word === "CANCEL" || word === "END" || word === "QUIT"
        ? " They may have meant a visit. Call them if you are not sure." : "";
      await addMessage(thread.id, "note", `The client texted ${word}. We send this number no more texts until they text START.${maybeVisit}`);
      // The assistant cannot answer any more, so a barber should look.
      await run("UPDATE chat_threads SET needs_attention = 1 WHERE id = ?", [thread.id]);
    }
    return "saved";
  }
  if (START_WORDS.has(word)) {
    await run("UPDATE chat_threads SET opted_out = 0, updated_at = utc_now() WHERE id = ?", [thread.id]);
    if (thread.opted_out === 1) await addMessage(thread.id, "note", `The client texted ${word}. Texts to this number are on again.`);
    return "saved";
  }
  // The provider answers HELP itself.
  if (word === "HELP") return "saved";
  // We cannot answer a number that opted out. A barber sees the text in the inbox.
  if (thread.opted_out === 1) return "saved";

  kickAgent(thread.id, baseUrl);
  return "saved";
}

/** The provider told us later that a text did not arrive. */
async function markFailed(ref: string, reason: string): Promise<void> {
  if (!ref) return;
  const rows = await query<{ thread_id: number }>(
    "UPDATE chat_messages SET delivery_status = ? WHERE provider_ref = ? AND sender != 'client' RETURNING thread_id",
    [`failed: ${reason}`.slice(0, 200), ref],
  );
  for (const row of rows) await run("UPDATE chat_threads SET needs_attention = 1 WHERE id = ?", [row.thread_id]);
}

const clean = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

export function registerSmsRoutes(app: OpenAPIHono): void {
  /** Telnyx: JSON, signed with Ed25519. */
  app.post("/api/sms/telnyx", async (c) => {
    const rawBody = await c.req.text();
    const ok = verifyTelnyx({
      rawBody,
      signature: c.req.header("telnyx-signature-ed25519") ?? "",
      timestamp: c.req.header("telnyx-timestamp") ?? "",
      publicKey: (process.env.TELNYX_PUBLIC_KEY ?? "").trim(),
    });
    if (!ok) return c.json({ error: "Bad signature." }, 403);

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return c.json({ error: "Bad request." }, 400); }
    const type = String(event?.data?.event_type ?? "");
    const payload = event?.data?.payload ?? {};

    if (type === "message.received") {
      const from = String(payload?.from?.phone_number ?? "");
      // Our own number must never start a chat with itself.
      if (toE164(from) && toE164(from) !== getSmsProvider()?.from) {
        const result = await receiveText({ from, body: String(payload?.text ?? ""), ref: String(payload?.id ?? "") }, publicBaseUrl(c.req.url));
        if (result === "saved") console.log(`Text received from ${maskPhone(from)}.`);
      }
    } else if (type === "message.finalized") {
      const status = String(payload?.to?.[0]?.status ?? "");
      if (/fail|undeliver|reject|expired/i.test(status)) {
        await markFailed(String(payload?.id ?? ""), clean(payload?.errors?.[0]?.detail ?? payload?.errors?.[0]?.title ?? "not delivered"));
      }
    }
    return c.json({ ok: true }, 200);
  });

  /** Twilio: a form, signed with HMAC-SHA1. Twilio wants TwiML back; an empty one sends nothing. */
  app.post("/api/sms/twilio", async (c) => {
    const rawBody = await c.req.text();
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(rawBody)) params[key] = value;
    const url = new URL(c.req.url);
    const ok = verifyTwilio({
      url: `${publicBaseUrl(c.req.url)}${url.pathname}${url.search}`,
      params,
      signature: c.req.header("x-twilio-signature") ?? "",
      authToken: (process.env.TWILIO_AUTH_TOKEN ?? "").trim(),
    });
    if (!ok) return c.json({ error: "Bad signature." }, 403);

    const status = params.MessageStatus ?? "";
    if (status && status !== "received" && status !== "receiving") {
      // A delivery report for a text we sent.
      if (status === "failed" || status === "undelivered") {
        await markFailed(params.MessageSid ?? "", params.ErrorCode ? `Twilio error ${clean(params.ErrorCode)}` : "not delivered");
      }
    } else if (params.From && toE164(params.From) !== getSmsProvider()?.from) {
      const result = await receiveText({ from: params.From, body: params.Body ?? "", ref: params.MessageSid ?? "" }, publicBaseUrl(c.req.url));
      if (result === "saved") console.log(`Text received from ${maskPhone(params.From)}.`);
    }
    return c.body("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", 200, { "Content-Type": "text/xml" });
  });
}
