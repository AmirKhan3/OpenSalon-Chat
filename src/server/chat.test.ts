import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";

process.env.SEED_DEMO_DATA = "false";
delete process.env.STAFF_PASSWORD;
delete process.env.STRIPE_SECRET_KEY;

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { setShopClock } = await import("./shoptime.js");
const agent = await import("./agent.js");
const { saveSettings } = await import("./settings.js");
const { chatLimit } = await import("./ratelimit.js");

after(async () => {
  await agent.agentIdle();
  agent.setAgentModel();
  await db.closeDB();
});

// Monday 2 March 2026, 10:00 in New York.
const NOW = "2026-03-02T15:00:00Z";
const TUE = "2026-03-03";
const WED = "2026-03-04";
const JAMIE = "+15555550101";

beforeEach(async () => {
  await agent.agentIdle();
  chatLimit.reset();
  delete process.env.STAFF_PASSWORD;
  setShopClock(() => new Date(NOW));
  await db.resetDB("pglite:memory");
  await db.exec(`
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111'), ('Dre', 'Barber', '#222222');
    INSERT INTO services (name, duration, price, category) VALUES ('Haircut', 30, 35, 'Cuts'), ('Beard Trim', 15, 15, 'Beard');
    INSERT INTO clients (name, email, phone) VALUES ('Jamie Rivera', 'jamie@example.com', '${JAMIE}');
  `);
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

// ── A mock model that plays a script ───────────────────────────────

type Step = string | { tool: string; input?: object } | Error;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Each call to the model plays the next step: a text, a tool call, or an error. */
function script(steps: Step[], delayMs = 0) {
  const queue = [...steps];
  let active = 0;
  const seen = { calls: 0, maxActive: 0, prompts: [] as string[] };
  const model = new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      seen.calls++;
      seen.prompts.push(JSON.stringify(options.prompt));
      active++;
      seen.maxActive = Math.max(seen.maxActive, active);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const step = queue.shift() ?? "OK.";
        if (step instanceof Error) throw step;
        if (typeof step === "string") {
          return { content: [{ type: "text", text: step }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        }
        return {
          content: [{ type: "tool-call", toolCallId: `call-${seen.calls}`, toolName: step.tool, input: JSON.stringify(step.input ?? {}) }],
          finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [],
        };
      } finally {
        active--;
      }
    },
  } as any);
  agent.setAgentModel(model as any);
  return seen;
}

/** Send a client message in the web chat and wait for the assistant. */
async function say(message: string, token?: string) {
  const r = await call("POST", "/api/public/chat/messages", { token, message });
  assert.equal(r.status, 200);
  await agent.agentIdle();
  return r.body.token as string;
}
const clientSees = async (token: string) => (await call("GET", `/api/public/chat/${token}`)).body;
const inbox = async () => (await call("GET", "/api/chat/threads")).body;
const staffSees = async (id: number) => (await call("GET", `/api/chat/threads/${id}`)).body;

async function smsThread(phone: string): Promise<number> {
  const rows = await db.query<{ id: number }>(
    "INSERT INTO chat_threads (kind, channel, phone) VALUES ('client', 'sms', ?) RETURNING id", [phone],
  );
  return rows[0].id;
}
async function text(threadId: number, body: string) {
  const { addMessage } = await import("./chatstore.js");
  await addMessage(threadId, "client", body);
  agent.kickAgent(threadId, "http://shop.test");
  await agent.agentIdle();
}
const book = (patch: object = {}) => call("POST", "/api/public/bookings", {
  name: "Jamie Rivera", phone: JAMIE, date: TUE, time: "10:00", service_ids: [1], ...patch,
});

// ── Tests ──────────────────────────────────────────────────────────

test("the assistant answers in the web chat and signs once", async () => {
  const seen = script(["Hi! We are open 9 to 6.\n- Tolly"]);
  const token = await say("When are you open?");
  const chat = await clientSees(token);
  assert.deepEqual(chat.messages.map((m: any) => m.sender), ["client", "agent"]);
  assert.equal(chat.messages[1].body, "Hi! We are open 9 to 6.\n- Tolly");
  assert.equal(chat.mode, "agent");
  assert.equal(seen.calls, 1);
  // The model reads the shop facts and is told not to sign.
  assert.match(seen.prompts[0], /Our Barbershop/);
  assert.match(seen.prompts[0], /Tomorrow: Tuesday 2026-03-03/);
  assert.match(seen.prompts[0], /Do not sign/);
});

test("the signature follows the settings", async () => {
  await saveSettings({ agent_name: "Max" });
  script(["Sure thing."]);
  const token = await say("Hello");
  assert.equal((await clientSees(token)).messages[1].body, "Sure thing.\n- Max");
  assert.equal((await clientSees(token)).agent_name, "Max");

  await saveSettings({ sign_messages: false });
  script(["No problem. - Max"]);
  await say("Thanks", token);
  assert.equal((await clientSees(token)).messages[3].body, "No problem.");
});

test("booking through the chat makes the booking and links the thread to the client", async () => {
  script([
    { tool: "check_availability", input: { date: TUE, service_ids: [1] } },
    { tool: "book_appointment", input: { name: "Sam Lee", phone: "(555) 555-0199", date: TUE, time: "10:00", service_ids: [1] } },
    "You are booked for Tue, Mar 3 at 10:00 AM.",
  ]);
  const token = await say("Book me a haircut tomorrow at 10. Sam Lee, 555 555 0199. Yes, go ahead.");
  const chat = await clientSees(token);
  assert.match(chat.messages.at(-1).body, /You are booked/);

  const apts = await db.query<any>("SELECT a.*, c.name FROM appointments a JOIN clients c ON c.id = a.client_id");
  assert.equal(apts.length, 1);
  assert.equal(apts[0].source, "chat");
  assert.equal(apts[0].scheduled_date, TUE);
  assert.equal(apts[0].start_time, "10:00");
  assert.equal(apts[0].name, "Sam Lee");

  const list = await inbox();
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].display_name, "Sam Lee");
  assert.equal(list.threads[0].client_id, apts[0].client_id);
  assert.equal(list.threads[0].staff_unread, 1);
});

test("the assistant cannot book without a name and a phone number in the web chat", async () => {
  const seen = script([
    { tool: "book_appointment", input: { date: TUE, time: "10:00", service_ids: [1] } },
    "What is your mobile number?",
  ]);
  await say("Book me tomorrow at 10");
  assert.match(seen.prompts[1], /mobile number/);
  assert.equal((await db.query("SELECT id FROM appointments")).length, 0);
});

test("hand over: the chat goes to a barber and the inbox shows it", async () => {
  script([{ tool: "hand_to_barber", input: { reason: "Wants a wedding party booking." } }, "A barber will reply here soon."]);
  const token = await say("Can you do a wedding party of 8?");
  const chat = await clientSees(token);
  assert.equal(chat.mode, "human");
  assert.equal(chat.messages.at(-1).body, "A barber will reply here soon.\n- Tolly");

  const list = await inbox();
  assert.equal(list.needs_attention, 1);
  assert.equal(list.threads[0].needs_attention, true);
  // Staff see why. The client does not.
  const detail = await staffSees(list.threads[0].id);
  assert.ok(detail.messages.some((m: any) => m.sender === "note" && /wedding party/.test(m.body)));
  assert.ok(!JSON.stringify(chat).includes("wedding party booking"));

  // The assistant stays quiet now.
  const seen = script(["I should not speak."]);
  await say("Hello?", token);
  assert.equal(seen.calls, 0);
});

test("take over and hand back", async () => {
  script(["Hi there."]);
  const token = await say("Hi");
  const id = (await inbox()).threads[0].id;

  assert.equal((await call("POST", `/api/chat/threads/${id}/takeover`)).body.thread.mode, "human");
  let seen = script(["I should not speak."]);
  await say("Are you there?", token);
  assert.equal(seen.calls, 0);
  // The client sees no sign of the takeover.
  assert.deepEqual((await clientSees(token)).messages.map((m: any) => m.sender), ["client", "agent", "client"]);

  // Hand back: the assistant answers the waiting message.
  seen = script(["Yes, I am here."]);
  const back = await call("POST", `/api/chat/threads/${id}/handback`);
  assert.equal(back.body.thread.mode, "agent");
  await agent.agentIdle();
  assert.equal(seen.calls, 1);
  assert.equal((await clientSees(token)).messages.at(-1).body, "Yes, I am here.\n- Tolly");
});

test("when a barber writes, the assistant stops by itself", async () => {
  script(["Hi there."]);
  const token = await say("Hi");
  const id = (await inbox()).threads[0].id;

  const reply = await call("POST", `/api/chat/threads/${id}/messages`, { body: "Hey, it's Marcus. Come by at 3." });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.thread.mode, "human");
  assert.equal(reply.body.thread.staff_unread, 0);
  const chat = await clientSees(token);
  assert.equal(chat.messages.at(-1).sender, "staff");
  assert.equal(chat.messages.at(-1).body, "Hey, it's Marcus. Come by at 3.");

  const seen = script(["I should not speak."]);
  await say("Great, see you", token);
  assert.equal(seen.calls, 0);
  assert.equal((await inbox()).threads[0].staff_unread, 1);
  assert.equal((await call("POST", `/api/chat/threads/${id}/read`)).body.thread.staff_unread, 0);
});

test("a barber who takes over during a run stops the reply", async () => {
  script(["Too late."], 60);
  const r = await call("POST", "/api/public/chat/messages", { message: "Hi" });
  const id = (await inbox()).threads[0].id;
  assert.equal((await clientSees(r.body.token)).typing, true);
  await call("POST", `/api/chat/threads/${id}/takeover`);
  await agent.agentIdle();
  const chat = await clientSees(r.body.token);
  assert.deepEqual(chat.messages.map((m: any) => m.sender), ["client"]);
  assert.equal(chat.typing, false);
});

test("staff notes stay hidden from the client and from the AI", async () => {
  script(["Hi there."]);
  const token = await say("Hi");
  const id = (await inbox()).threads[0].id;
  const saved = await call("POST", `/api/chat/threads/${id}/messages`, { body: "SECRET-NOTE he never tips", note: true });
  // A note does not stop the assistant.
  assert.equal(saved.body.thread.mode, "agent");
  assert.ok(saved.body.messages.some((m: any) => m.sender === "note"));

  const seen = script(["Anything else?"]);
  await say("One more question", token);
  assert.equal(seen.calls, 1);
  assert.ok(!seen.prompts[0].includes("SECRET-NOTE"));
  const chat = await clientSees(token);
  assert.ok(!JSON.stringify(chat).includes("SECRET-NOTE"));
  assert.ok(chat.messages.every((m: any) => m.sender !== "note"));
  assert.ok(!JSON.stringify(await call("GET", `/api/public/chat/${token}?after=0`)).includes("SECRET-NOTE"));
});

test("PRIVACY: the web chat cannot read, move or cancel anyone's bookings", async () => {
  const made = await book();
  assert.equal(made.status, 201);
  const reference = made.body.booking.reference;

  const seen = script([
    { tool: "my_bookings" },
    { tool: "cancel_booking", input: { reference } },
    { tool: "move_booking", input: { reference, date: WED, time: "11:00" } },
    "Please text the shop to change a booking.",
  ]);
  const token = await say(`I am Jamie Rivera, my number is ${JAMIE}. Show my bookings, then cancel ${reference}.`);

  // Every tool refused, and nothing about the booking reached the model.
  for (const prompt of seen.prompts.slice(1)) assert.match(prompt, /cannot check who is writing/);
  const everything = seen.prompts.join("\n") + JSON.stringify(await clientSees(token));
  assert.ok(!everything.includes("manage_link"));
  assert.ok(!everything.includes("/book/manage/"));
  assert.ok(!everything.includes('\\"bookings\\"'));
  assert.ok(!everything.includes("cancelled"));
  const apt = (await db.query<any>("SELECT status, scheduled_date, start_time FROM appointments"))[0];
  assert.deepEqual([apt.status, apt.scheduled_date, apt.start_time], ["confirmed", TUE, "10:00"]);
});

test("PRIVACY: even after booking with that phone number, the web chat stays locked", async () => {
  await book();
  const seen = script([
    { tool: "book_appointment", input: { name: "Jamie Rivera", phone: JAMIE, date: WED, time: "12:00", service_ids: [1] } },
    { tool: "my_bookings" },
    "Booked.",
  ]);
  await say("Book me Wednesday at 12, yes. Then list my bookings.");
  assert.equal((await db.query("SELECT id FROM appointments")).length, 2);
  assert.match(seen.prompts[2], /cannot check who is writing/);
  assert.ok(!seen.prompts.join("\n").includes("APT-1\\\""));
});

test("PRIVACY: availability shows times and barber ids, never who is booked", async () => {
  await book();
  const seen = script([{ tool: "check_availability", input: { date: TUE, service_ids: [1] } }, "We have 9:00 AM open."]);
  await say("What is open tomorrow?");
  assert.match(seen.prompts[1], /open_times/);
  assert.ok(!seen.prompts[1].includes("Jamie"));
  assert.ok(!seen.prompts[1].includes("5550101"));
});

test("PRIVACY: in a text thread the booking tools use only the number that texted", async () => {
  // Jamie has a booking. So does Sam.
  const jamies = (await book()).body.booking.reference;
  const sams = (await book({ name: "Sam Lee", phone: "+15555550199", time: "11:00" })).body.booking.reference;

  const thread = await smsThread(JAMIE);
  let seen = script([{ tool: "my_bookings" }, { tool: "cancel_booking", input: { reference: sams } }, "Here you go."]);
  await text(thread, "What do I have coming up?");
  assert.ok(seen.prompts[1].includes(jamies));
  assert.ok(!seen.prompts[1].includes(sams));
  assert.ok(!seen.prompts.join("\n").includes("Sam Lee"));
  // Sam's booking cannot be cancelled from Jamie's phone.
  assert.match(seen.prompts[2], /no coming booking with that reference/);
  assert.equal((await db.query<any>("SELECT status FROM appointments WHERE identifier = ?", [sams]))[0].status, "confirmed");

  // Booking by text: the model's phone number is ignored, the name comes from the client record.
  seen = script([
    { tool: "book_appointment", input: { phone: "+15555550199", date: WED, time: "09:00", service_ids: [2] } },
    "Booked.",
  ]);
  await text(thread, "Book a beard trim Wednesday at 9. Yes.");
  const made = (await db.query<any>(
    "SELECT a.source, c.phone, c.name FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.scheduled_date = ?", [WED],
  ))[0];
  assert.deepEqual([made.source, made.phone, made.name], ["sms", JAMIE, "Jamie Rivera"]);
  assert.match(seen.prompts[0], /Never ask for it/);

  // Jamie can move and cancel their own.
  script([{ tool: "move_booking", input: { reference: jamies, date: TUE, time: "14:00" } }, { tool: "cancel_booking", input: { reference: jamies } }, "Done."]);
  await text(thread, "Move it to 2pm. Actually cancel it. Yes.");
  const mine = (await db.query<any>("SELECT status, start_time FROM appointments WHERE identifier = ?", [jamies]))[0];
  assert.deepEqual([mine.status, mine.start_time], ["cancelled", "14:00"]);
});

test("no AI key: the chat goes to a barber and the client is told", async () => {
  agent.setAgentModel(null);
  const token = await say("Hi, anyone there?");
  const chat = await clientSees(token);
  assert.equal(chat.mode, "human");
  assert.deepEqual(chat.messages.map((m: any) => [m.sender, m.body]).at(-1), ["system", "A barber will reply soon."]);
  assert.equal((await inbox()).needs_attention, 1);
  // Only one notice, however many messages follow.
  await say("Hello?", token);
  assert.equal((await clientSees(token)).messages.filter((m: any) => m.sender === "system").length, 1);
});

test("the model fails: the chat goes to a barber", async () => {
  script([new Error("boom")]);
  const token = await say("Hi");
  const chat = await clientSees(token);
  assert.equal(chat.mode, "human");
  assert.equal(chat.messages.at(-1).sender, "system");
  assert.equal((await inbox()).threads[0].needs_attention, true);
});

test("only one assistant run per thread at a time", async () => {
  const seen = script(["First answer.", "Second answer."], 40);
  const first = await call("POST", "/api/public/chat/messages", { message: "One" });
  const token = first.body.token;
  await call("POST", "/api/public/chat/messages", { token, message: "Two" });
  await call("POST", "/api/public/chat/messages", { token, message: "Three" });
  await agent.agentIdle();
  assert.equal(seen.maxActive, 1);
  assert.equal(seen.calls, 2);
  const senders = (await clientSees(token)).messages.map((m: any) => m.sender);
  assert.equal(senders.filter((s: string) => s === "agent").length, 2);
  assert.equal(senders.at(-1), "agent");
});

test("web chat tokens: unknown tokens open nothing", async () => {
  script(["Hi."]);
  const token = await say("Hi");
  assert.equal((await call("GET", "/api/public/chat/not-a-real-token-0000000000")).status, 404);
  assert.equal((await call("GET", "/api/public/chat/x")).status, 404);
  // A wrong token starts a fresh chat. It does not join another one.
  const other = await say("Hello", "wrong-token-000000000000000");
  assert.notEqual(other, token);
  assert.equal((await clientSees(other)).messages.length, 2);
  assert.equal((await call("POST", "/api/public/chat/messages", { message: "  " })).status, 400);
  assert.equal((await call("POST", "/api/public/chat/messages", { message: "x".repeat(2001) })).status, 400);
});

test("the barber's assistant chat is private and unsigned", async () => {
  const seen = script([{ tool: "get_schedule", input: { date: TUE } }, "Tomorrow you have Jamie at 10:00."]);
  await book();
  const sent = await call("POST", "/api/assistant/messages", { body: "What do I have tomorrow?" });
  assert.equal(sent.status, 200);
  await agent.agentIdle();
  const chat = (await call("GET", "/api/assistant")).body;
  assert.deepEqual(chat.messages.map((m: any) => m.sender), ["staff", "agent"]);
  assert.equal(chat.messages[1].body, "Tomorrow you have Jamie at 10:00.");
  assert.equal(chat.thinking, false);
  // Staff tools see the whole schedule.
  assert.match(seen.prompts[1], /Jamie Rivera/);
  // It is not in the inbox, and no client route reaches it.
  assert.equal((await inbox()).threads.length, 0);
  assert.equal((await call("GET", "/api/chat/threads/1")).status, 404);

  agent.setAgentModel(null);
  await call("POST", "/api/assistant/messages", { body: "Hello?" });
  await agent.agentIdle();
  const off = (await call("GET", "/api/assistant")).body;
  assert.equal(off.configured, false);
  assert.match(off.messages.at(-1).body, /no AI key/);
});

test("the inbox and the assistant need a staff login; the web chat does not", async () => {
  script(["Hi."]);
  process.env.STAFF_PASSWORD = "test-password-for-chat";
  assert.equal((await call("GET", "/api/chat/threads")).status, 401);
  assert.equal((await call("GET", "/api/assistant")).status, 401);
  assert.equal((await call("POST", "/api/assistant/messages", { body: "Hi" })).status, 401);
  assert.equal((await call("POST", "/api/chat/threads/1/messages", { body: "Hi" })).status, 401);
  const r = await call("POST", "/api/public/chat/messages", { message: "Hi" });
  assert.equal(r.status, 200);
  await agent.agentIdle();
});

test("a barber who takes over during a run stops booking changes", async () => {
  script([{ tool: "book_appointment", input: { name: "Jamie Rivera", phone: JAMIE, date: TUE, time: "10:00", service_ids: [1] } }, "Booked."], 60);
  const r = await call("POST", "/api/public/chat/messages", { message: "Book me Tuesday at 10. Yes." });
  const id = (await inbox()).threads[0].id;
  await call("POST", `/api/chat/threads/${id}/takeover`);
  await agent.agentIdle();
  assert.equal((await db.query("SELECT id FROM appointments")).length, 0);
  assert.deepEqual((await clientSees(r.body.token)).messages.map((m: any) => m.sender), ["client"]);
});

test("the model fails after booking: the client still hears what was booked", async () => {
  script([{ tool: "book_appointment", input: { name: "Jamie Rivera", phone: JAMIE, date: TUE, time: "10:00", service_ids: [1] } }, new Error("boom")]);
  const token = await say("Book me Tuesday at 10. Yes.");
  assert.equal((await db.query("SELECT id FROM appointments")).length, 1);
  const chat = await clientSees(token);
  const receipt = chat.messages.find((m: any) => m.sender === "agent");
  assert.match(receipt.body, /Your visit is booked: Tuesday 2026-03-03 at 10:00 \(APT-\d+\)/);
  assert.match(receipt.body, /\/book\/manage\//);
  assert.equal(chat.mode, "human");
});

test("hand back after a failed run: the assistant answers the waiting client", async () => {
  script([new Error("boom")]);
  const token = await say("Are you open on Sunday?");
  const id = (await inbox()).threads[0].id;
  assert.equal((await clientSees(token)).messages.at(-1).sender, "system");

  const seen = script(["We are closed on Sunday."]);
  await call("POST", `/api/chat/threads/${id}/handback`);
  await agent.agentIdle();
  assert.equal(seen.calls, 1);
  assert.equal((await clientSees(token)).messages.at(-1).body, "We are closed on Sunday.\n- Tolly");
});
