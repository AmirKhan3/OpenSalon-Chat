import { get, query, run } from "./db.js";
import { newToken } from "./clientbooking.js";
import { getSmsProvider, maskPhone } from "./smsprovider.js";

/**
 * Chat threads and messages in the database.
 *
 * PRIVACY: messages with sender "note" are for staff only. Use
 * `messagesForClient` for anything a client sees and `messagesForAgent` for
 * anything the AI reads. Both leave notes out.
 */

export type ThreadKind = "client" | "assistant";
export type Channel = "web" | "sms";
export type Mode = "agent" | "human";
export type Sender = "client" | "agent" | "staff" | "system" | "note";

export interface Thread {
  id: number; kind: ThreadKind; channel: Channel; token: string | null; phone: string | null;
  client_id: number | null; display_name: string; mode: Mode; needs_attention: number; staff_unread: number;
  /** 1 when the client texted STOP. */
  opted_out: number;
  last_message_at: string | null; created_at: string; updated_at: string;
}

export interface Message {
  id: number; thread_id: number; sender: Sender; body: string; delivery_status: string; provider_ref: string | null; created_at: string;
}

/** The longest message we save. */
export const MAX_MESSAGE = 2000;

const THREAD_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

export async function getThread(id: number): Promise<Thread | null> {
  return (await get<Thread>("SELECT * FROM chat_threads WHERE id = ?", [id])) ?? null;
}

/** A web chat, by the secret the browser keeps. */
export async function threadByToken(token: string): Promise<Thread | null> {
  if (!THREAD_TOKEN.test(token)) return null;
  return (await get<Thread>("SELECT * FROM chat_threads WHERE token = ? AND kind = 'client'", [token])) ?? null;
}

export async function createWebThread(): Promise<Thread> {
  const created = await run("INSERT INTO chat_threads (kind, channel, token) VALUES ('client', 'web', ?)", [newToken()]);
  return (await getThread(Number(created.lastInsertRowid)))!;
}

/** The barber's private chat with the assistant. There is one. */
export async function assistantThread(): Promise<Thread> {
  const found = await get<Thread>("SELECT * FROM chat_threads WHERE kind = 'assistant' ORDER BY id LIMIT 1");
  if (found) return found;
  const created = await run("INSERT INTO chat_threads (kind, channel, display_name) VALUES ('assistant', 'web', 'Assistant')");
  return (await getThread(Number(created.lastInsertRowid)))!;
}

/**
 * Save a message. Every message goes through here.
 * A message from the client counts as unread for staff.
 *
 * In a text (SMS) thread, a message to the client is also sent as a text, and
 * the result is saved on it: "sent" or "failed: <reason>". Notes are never sent.
 * `providerRef` is the provider's id of a text we received.
 */
export async function addMessage(threadId: number, sender: Sender, body: string, providerRef: string | null = null): Promise<Message> {
  const text = body.slice(0, MAX_MESSAGE);
  const rows = await query<Message>(
    "INSERT INTO chat_messages (thread_id, sender, body, provider_ref) VALUES (?, ?, ?, ?) RETURNING *", [threadId, sender, text, providerRef],
  );
  await run(
    `UPDATE chat_threads SET last_message_at = utc_now(), updated_at = utc_now()${sender === "client" ? ", staff_unread = staff_unread + 1" : ""} WHERE id = ?`,
    [threadId],
  );
  const message = rows[0];
  if (sender === "agent" || sender === "staff" || sender === "system") {
    const thread = await getThread(threadId);
    if (thread && thread.kind === "client" && thread.channel === "sms" && thread.phone) return deliver(thread, message);
  }
  return message;
}

/** Send a saved message as a text and save how it went. */
async function deliver(thread: Thread, message: Message): Promise<Message> {
  let status: string;
  let ref: string | null = null;
  const provider = getSmsProvider();
  if (thread.opted_out === 1) status = "failed: the client opted out of texts";
  else if (!provider) status = "failed: texts are not set up";
  else {
    const result = await provider.send(thread.phone!, message.body).catch(() => ({ ok: false as const, reason: "could not send" }));
    if (result.ok) { status = "sent"; ref = result.id || null; }
    else {
      status = `failed: ${result.reason}`;
      // Never the full number or the text in the logs.
      // The provider's reason can repeat the number: mask any long run of digits.
      console.error(`Text to ${maskPhone(thread.phone!)} failed: ${result.reason.replace(/\+?\d[\d\s().-]{5,}\d/g, (n) => maskPhone(n))}`);
    }
  }
  const rows = await query<Message>(
    "UPDATE chat_messages SET delivery_status = ?, provider_ref = ? WHERE id = ? RETURNING *", [status.slice(0, 200), ref, message.id],
  );
  // The barber should see a text that did not go out.
  if (status !== "sent") await run("UPDATE chat_threads SET needs_attention = 1 WHERE id = ?", [thread.id]);
  return rows[0] ?? message;
}

/** Everything in the thread, notes too. For staff only. */
export function allMessages(threadId: number): Promise<Message[]> {
  return query<Message>("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id", [threadId]);
}

/** What the client may see: no notes. */
export function messagesForClient(threadId: number, afterId = 0): Promise<Message[]> {
  return query<Message>(
    "SELECT * FROM chat_messages WHERE thread_id = ? AND sender != 'note' AND id > ? ORDER BY id", [threadId, afterId],
  );
}

/** What the AI reads: the latest messages, oldest first, no notes. */
export async function messagesForAgent(threadId: number, limit = 30): Promise<Message[]> {
  const rows = await query<Message>(
    "SELECT * FROM chat_messages WHERE thread_id = ? AND sender != 'note' ORDER BY id DESC LIMIT ?", [threadId, limit],
  );
  return rows.reverse();
}

export async function setMode(threadId: number, mode: Mode, needsAttention: boolean): Promise<void> {
  await run(
    "UPDATE chat_threads SET mode = ?, needs_attention = ?, updated_at = utc_now() WHERE id = ?",
    [mode, needsAttention ? 1 : 0, threadId],
  );
}

export async function markRead(threadId: number): Promise<void> {
  await run("UPDATE chat_threads SET staff_unread = 0 WHERE id = ?", [threadId]);
}

/** Link the thread to a client, so staff see who it is. */
export async function linkClient(threadId: number, clientId: number, name: string): Promise<void> {
  await run("UPDATE chat_threads SET client_id = ?, display_name = ?, updated_at = utc_now() WHERE id = ?", [clientId, name.slice(0, 100), threadId]);
}

/**
 * Give the thread to a barber: the AI stops and the inbox shows "needs you".
 * `reason` is a staff-only note. With `tellClient`, the client reads that a barber will reply.
 */
export async function handToBarber(threadId: number, reason: string, tellClient: boolean): Promise<void> {
  await setMode(threadId, "human", true);
  await addMessage(threadId, "note", reason);
  if (tellClient) await addMessage(threadId, "system", "A barber will reply soon.");
}
