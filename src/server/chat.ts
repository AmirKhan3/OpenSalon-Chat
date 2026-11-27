import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { query } from "./db.js";
import { getSettings } from "./settings.js";
import { publicBaseUrl } from "./public.js";
import { agentConfigured, isAgentRunning, kickAgent } from "./agent.js";
import { clientIp } from "./auth.js";
import { chatLimit } from "./ratelimit.js";
import {
  addMessage, allMessages, assistantThread, createWebThread, getThread, markRead, MAX_MESSAGE, messagesForAgent,
  messagesForClient, setMode, threadByToken, type Message, type Thread,
} from "./chatstore.js";

/**
 * Chat routes.
 *
 * Public (the widget on the booking page): send a message, read the thread.
 * The browser keeps a secret token for its thread. Clients never get notes.
 *
 * Staff (the dashboard): the inbox, and the barber's private chat with the assistant.
 */

const ErrorSchema = z.object({ error: z.string() });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } } });
const errors = {
  400: { description: "Bad request", ...json(ErrorSchema) },
  404: { description: "Not found", ...json(ErrorSchema) },
};

const MessageSchema = z.object({
  id: z.number(), sender: z.string(), body: z.string(), delivery_status: z.string(), created_at: z.string(),
}).openapi("ChatMessage");

const view = (m: Message) => ({ id: m.id, sender: m.sender, body: m.body, delivery_status: m.delivery_status, created_at: m.created_at });
/** What a client gets: no delivery details. */
const clientView = (m: Message) => ({ id: m.id, sender: m.sender, body: m.body, created_at: m.created_at });

const Body = z.string().trim().min(1, "Write a message.").max(MAX_MESSAGE, "That message is too long.");
const IdParam = z.object({ id: z.coerce.number().int().positive() });

// ── Public ─────────────────────────────────────────────────────────

const ClientMessageSchema = MessageSchema.omit({ delivery_status: true }).openapi("PublicChatMessage");
const PublicThreadSchema = z.object({
  token: z.string(),
  agent_name: z.string(),
  /** "agent" while the assistant answers, "human" when a barber has the chat. */
  mode: z.string(),
  typing: z.boolean(),
  messages: z.array(ClientMessageSchema),
}).openapi("PublicChat");

const publicSendRoute = createRoute({
  method: "post", path: "/api/public/chat/messages", tags: ["Public chat"],
  summary: "Send a message in the web chat. Without a token, a new chat starts.",
  request: { body: json(z.object({ token: z.string().max(64).optional(), message: Body })) },
  responses: {
    200: { description: "The chat", ...json(PublicThreadSchema) }, 400: errors[400],
    429: { description: "Too many messages", ...json(ErrorSchema) },
  },
});

const publicReadRoute = createRoute({
  method: "get", path: "/api/public/chat/{token}", tags: ["Public chat"],
  summary: "Read the web chat.",
  request: { params: z.object({ token: z.string() }), query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
  responses: { 200: { description: "The chat", ...json(PublicThreadSchema) }, 404: errors[404] },
});

async function publicThread(thread: Thread, after = 0) {
  const settings = await getSettings();
  return {
    token: thread.token!,
    agent_name: settings.agent_name,
    mode: thread.mode,
    typing: isAgentRunning(thread.id),
    messages: (await messagesForClient(thread.id, after)).map(clientView),
  };
}

// ── Staff ──────────────────────────────────────────────────────────

const ThreadSchema = z.object({
  id: z.number(), channel: z.string(), display_name: z.string(), phone: z.string().nullable(), client_id: z.number().nullable(),
  mode: z.string(), needs_attention: z.boolean(), staff_unread: z.number(), last_message_at: z.string().nullable(),
  preview: z.string(),
}).openapi("ChatThread");

const ThreadDetailSchema = z.object({ thread: ThreadSchema, typing: z.boolean(), messages: z.array(MessageSchema) }).openapi("ChatThreadDetail");

type ThreadRow = Thread & { preview: string | null };

const threadView = (t: ThreadRow) => ({
  id: t.id, channel: t.channel, display_name: t.display_name || (t.phone ?? "") || `Web chat #${t.id}`, phone: t.phone, client_id: t.client_id,
  mode: t.mode, needs_attention: t.needs_attention === 1, staff_unread: t.staff_unread, last_message_at: t.last_message_at,
  preview: (t.preview ?? "").slice(0, 140),
});

const PREVIEW = "(SELECT m.body FROM chat_messages m WHERE m.thread_id = t.id AND m.sender != 'note' ORDER BY m.id DESC LIMIT 1) AS preview";

async function clientThreadRow(id: number): Promise<ThreadRow | null> {
  const rows = await query<ThreadRow>(`SELECT t.*, ${PREVIEW} FROM chat_threads t WHERE t.id = ? AND t.kind = 'client'`, [id]);
  return rows[0] ?? null;
}

async function detail(id: number) {
  const row = await clientThreadRow(id);
  if (!row) return null;
  return { thread: threadView(row), typing: isAgentRunning(id), messages: (await allMessages(id)).map(view) };
}

const listRoute = createRoute({
  method: "get", path: "/api/chat/threads", tags: ["Chat"], summary: "The inbox: chats with clients, newest first.",
  responses: { 200: { description: "Threads", ...json(z.object({ threads: z.array(ThreadSchema), unread: z.number(), needs_attention: z.number() })) } },
});

const threadRoute = createRoute({
  method: "get", path: "/api/chat/threads/{id}", tags: ["Chat"], summary: "One chat, with staff notes.",
  request: { params: IdParam },
  responses: { 200: { description: "Thread", ...json(ThreadDetailSchema) }, 404: errors[404] },
});

const readRoute = createRoute({
  method: "post", path: "/api/chat/threads/{id}/read", tags: ["Chat"], summary: "Mark a chat as read.",
  request: { params: IdParam },
  responses: { 200: { description: "Thread", ...json(ThreadDetailSchema) }, 404: errors[404] },
});

const replyRoute = createRoute({
  method: "post", path: "/api/chat/threads/{id}/messages", tags: ["Chat"],
  summary: "Reply to the client, or save a staff-only note. A reply stops the assistant in this chat.",
  request: { params: IdParam, body: json(z.object({ body: Body, note: z.boolean().optional() })) },
  responses: { 200: { description: "Thread", ...json(ThreadDetailSchema) }, 400: errors[400], 404: errors[404] },
});

const takeoverRoute = createRoute({
  method: "post", path: "/api/chat/threads/{id}/takeover", tags: ["Chat"], summary: "Take over: the assistant stops answering.",
  request: { params: IdParam },
  responses: { 200: { description: "Thread", ...json(ThreadDetailSchema) }, 404: errors[404] },
});

const handbackRoute = createRoute({
  method: "post", path: "/api/chat/threads/{id}/handback", tags: ["Chat"], summary: "Hand the chat back to the assistant.",
  request: { params: IdParam },
  responses: { 200: { description: "Thread", ...json(ThreadDetailSchema) }, 404: errors[404] },
});

const AssistantSchema = z.object({
  agent_name: z.string(), configured: z.boolean(), thinking: z.boolean(), messages: z.array(MessageSchema),
}).openapi("AssistantChat");

const assistantRoute = createRoute({
  method: "get", path: "/api/assistant", tags: ["Assistant"], summary: "The barber's private chat with the assistant.",
  responses: { 200: { description: "Chat", ...json(AssistantSchema) } },
});

const assistantSendRoute = createRoute({
  method: "post", path: "/api/assistant/messages", tags: ["Assistant"], summary: "Ask the assistant. The answer arrives a moment later.",
  request: { body: json(z.object({ body: Body })) },
  responses: { 200: { description: "Chat", ...json(AssistantSchema) }, 400: errors[400] },
});

async function assistantView() {
  const thread = await assistantThread();
  const settings = await getSettings();
  return {
    agent_name: settings.agent_name, configured: agentConfigured(), thinking: isAgentRunning(thread.id),
    messages: (await allMessages(thread.id)).map(view),
  };
}

export function registerChatRoutes(app: OpenAPIHono): void {
  // ── Public ──
  app.openapi(publicSendRoute, async (c) => {
    const { token, message } = c.req.valid("json");
    if (chatLimit.hit(clientIp(c)) > 0) {
      return c.json({ error: "You are sending messages too fast. Wait a minute, then try again." }, 429);
    }
    // An unknown token starts a new chat. It never opens someone else's.
    const thread = (token ? await threadByToken(token) : null) ?? (await createWebThread());
    await addMessage(thread.id, "client", message);
    kickAgent(thread.id, publicBaseUrl(c.req.url));
    return c.json(await publicThread((await getThread(thread.id))!), 200);
  });

  app.openapi(publicReadRoute, async (c) => {
    const thread = await threadByToken(c.req.valid("param").token);
    if (!thread) return c.json({ error: "We could not find that chat." }, 404);
    return c.json(await publicThread(thread, c.req.valid("query").after ?? 0), 200);
  });

  // ── Staff ──
  app.openapi(listRoute, async (c) => {
    const rows = await query<ThreadRow>(
      `SELECT t.*, ${PREVIEW} FROM chat_threads t WHERE t.kind = 'client' AND t.last_message_at IS NOT NULL
       ORDER BY t.last_message_at DESC, t.id DESC LIMIT 200`,
    );
    const threads = rows.map(threadView);
    return c.json({
      threads,
      unread: threads.filter((t) => t.staff_unread > 0).length,
      needs_attention: threads.filter((t) => t.needs_attention).length,
    }, 200);
  });

  app.openapi(threadRoute, async (c) => {
    const found = await detail(c.req.valid("param").id);
    return found ? c.json(found, 200) : c.json({ error: "Chat not found." }, 404);
  });

  app.openapi(readRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await clientThreadRow(id))) return c.json({ error: "Chat not found." }, 404);
    await markRead(id);
    return c.json((await detail(id))!, 200);
  });

  app.openapi(replyRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { body, note } = c.req.valid("json");
    if (!(await clientThreadRow(id))) return c.json({ error: "Chat not found." }, 404);
    if (note) {
      await addMessage(id, "note", body);
    } else {
      // The barber is writing: the assistant stops by itself.
      await setMode(id, "human", false);
      await addMessage(id, "staff", body);
    }
    await markRead(id);
    return c.json((await detail(id))!, 200);
  });

  app.openapi(takeoverRoute, async (c) => {
    const { id } = c.req.valid("param");
    const row = await clientThreadRow(id);
    if (!row) return c.json({ error: "Chat not found." }, 404);
    if (row.mode !== "human") await addMessage(id, "note", "A barber took over. The assistant stopped.");
    await setMode(id, "human", false);
    await markRead(id);
    return c.json((await detail(id))!, 200);
  });

  app.openapi(handbackRoute, async (c) => {
    const { id } = c.req.valid("param");
    const row = await clientThreadRow(id);
    if (!row) return c.json({ error: "Chat not found." }, 404);
    if (row.mode !== "agent") await addMessage(id, "note", "Handed back to the assistant.");
    await setMode(id, "agent", false);
    // If the client is waiting for an answer, the assistant picks it up now.
    // Notices like "A barber will reply soon." do not count as an answer.
    const last = (await messagesForAgent(id)).filter((m) => m.sender !== "system").pop();
    if (last?.sender === "client" && row.opted_out !== 1) kickAgent(id, publicBaseUrl(c.req.url));
    return c.json((await detail(id))!, 200);
  });

  // ── The barber's own assistant ──
  app.openapi(assistantRoute, async (c) => c.json(await assistantView(), 200));

  app.openapi(assistantSendRoute, async (c) => {
    const thread = await assistantThread();
    await addMessage(thread.id, "staff", c.req.valid("json").body);
    kickAgent(thread.id, publicBaseUrl(c.req.url));
    return c.json(await assistantView(), 200);
  });
}
