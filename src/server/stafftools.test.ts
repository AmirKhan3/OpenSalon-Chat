import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";

process.env.SEED_DEMO_DATA = "false";
delete process.env.STAFF_PASSWORD;
delete process.env.STRIPE_SECRET_KEY;
for (const name of ["SMS_PROVIDER", "TELNYX_API_KEY", "TELNYX_FROM_NUMBER", "TWILIO_ACCOUNT_SID", "TWILIO_FROM_NUMBER"]) delete process.env[name];
process.env.PUBLIC_URL = "https://shop.test";

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { setShopClock } = await import("./shoptime.js");
const agent = await import("./agent.js");
const sms = await import("./smsprovider.js");
const smsThreads = await import("./sms.js");
const auto = await import("./automations.js");
const tools = await import("./stafftools.js");

after(async () => {
  await auto.automationsIdle();
  await agent.agentIdle();
  agent.setAgentModel();
  sms.setSmsProvider();
  setShopClock();
  await db.closeDB();
});

// New York is on winter time (UTC-5) in the first week of March 2026.
const NOW = "2026-03-02T15:00:00Z"; // Monday, 10:00 in New York
const MON = "2026-03-02";
const TUE = "2026-03-03";
const LONG_AGO = "2026-02-20 12:00:00";
const SHOP = "+15555550000";
const JAMIE = "+15555550101";
const SAM = "+15555550199";

const sent: { to: string; body: string }[] = [];
let fail = "";
let nextId = 0;

/** Set the shop's clock: a New York date and time. */
function clock(date: string, time: string) {
  const [h, m] = time.split(":").map(Number);
  const utc = new Date(`${date}T00:00:00Z`).getTime() + ((h + 5) * 60 + m) * 60_000;
  setShopClock(() => new Date(utc));
}

beforeEach(async () => {
  await auto.automationsIdle();
  await agent.agentIdle();
  agent.setAgentModel(null);
  setShopClock(() => new Date(NOW));
  sent.length = 0;
  fail = "";
  sms.setSmsProvider({
    name: "fake", from: SHOP,
    send: async (to, body) => {
      if (fail) return { ok: false, reason: fail };
      sent.push({ to, body });
      return { ok: true, id: `out-${++nextId}` };
    },
  });
  await db.resetDB("pglite:memory");
  await db.exec(`
    INSERT INTO staff (name, title, color) VALUES ('Marcus', 'Owner', '#111111'), ('Dre', 'Barber', '#222222');
    INSERT INTO services (name, duration, price, category) VALUES ('Haircut', 30, 35, 'Cuts'), ('Beard Trim', 15, 15, 'Beard');
    INSERT INTO clients (name, email, phone) VALUES ('Jamie Rivera', 'jamie@example.com', '(555) 555-0101'), ('Sam Lee', '', '${SAM}');
  `);
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

let seq = 0;
interface Visit { client?: number; staff?: number; date?: string; start?: string; end?: string; status?: string; source?: string; created?: string; service?: number }
/** Put a visit straight in the database, made long ago unless told otherwise. */
async function visit(v: Visit = {}): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 35, ?, ?) RETURNING id`,
    [`T-${++seq}`, v.client ?? 1, v.staff ?? 1, v.status ?? "booked", v.date ?? TUE, v.start ?? "14:00", v.end ?? "14:30",
      v.source ?? "staff", v.created ?? LONG_AGO],
  );
  await db.run("INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, ?, 35, 30)", [rows[0].id, v.service ?? 1]);
  return rows[0].id;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
type Step = string | { tool: string; input?: object };
function script(steps: Step[]) {
  const queue = [...steps];
  const seen = { calls: 0, prompts: [] as string[] };
  agent.setAgentModel(new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      seen.calls++;
      seen.prompts.push(JSON.stringify(options.prompt));
      const step = queue.shift() ?? "OK.";
      if (typeof step === "string") {
        return { content: [{ type: "text", text: step }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `call-${seen.calls}`, toolName: step.tool, input: JSON.stringify(step.input ?? {}) }],
        finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [],
      };
    },
  } as any) as any);
  return seen;
}


/** Ask Tolly in the barber's private chat and wait for the answer. */
async function ask(text: string): Promise<string> {
  const res = await call("POST", "/api/assistant/messages", { body: text });
  assert.equal(res.status, 200);
  await agent.agentIdle();
  await auto.automationsIdle();
  const chat = await call("GET", "/api/assistant");
  return chat.body.messages[chat.body.messages.length - 1].body as string;
}

/** Call one tool directly. */
async function use(name: string, input: object, options: { automationRun?: boolean } = {}, set?: Record<string, any>): Promise<any> {
  const all = (set ?? tools.staffTools(options)) as Record<string, any>;
  assert.ok(all[name], `no tool ${name}`);
  return all[name].execute(input, { toolCallId: "t", messages: [] });
}

const apt = (id: number) => db.get<any>("SELECT * FROM appointments WHERE id = ?", [id]);
const notesOf = async (id: number) => (await db.query<{ content: string }>("SELECT content FROM appointment_notes WHERE appointment_id = ? ORDER BY id", [id])).map((n) => n.content);

// ── Moving and cancelling ──────────────────────────────────────────

test("Tolly moves a booking when the barber asks", async () => {
  await auto.ensureDefaultAutomations();
  await db.run("UPDATE automations SET enabled = 0");
  const id = await visit({ date: TUE, start: "14:00", end: "14:30" });
  const seen = script([
    { tool: "get_schedule", input: { date: TUE } },
    { tool: "move_appointment", input: { reference: `T-${seq}`, date: "2026-03-04", time: "15:30" } },
    "Done. Jamie is now on Wednesday at 3:30 PM.",
  ]);
  const answer = await ask("Move Jamie's cut tomorrow to Wednesday 3:30");
  assert.equal(answer, "Done. Jamie is now on Wednesday at 3:30 PM.");
  const row = await apt(id);
  assert.equal(row.scheduled_date, "2026-03-04");
  assert.equal(row.start_time, "15:30");
  assert.equal(row.end_time, "16:00");
  assert.equal(row.staff_id, 1);
  assert.ok(row.moved_at);
  assert.match((await notesOf(id))[0], /^Moved by the assistant for the shop, from 2026-03-03 14:00 \(Marcus\) to 2026-03-04 15:30 \(Marcus\)\.$/);
  // The model saw the schedule with the client's name: this chat is staff only.
  assert.match(seen.prompts[1], /Jamie Rivera/);
  assert.match(seen.prompts[2], /Wednesday/);
});

test("a move is refused when the barber is busy, and nothing changes", async () => {
  const id = await visit({ date: TUE, start: "14:00", end: "14:30" });
  const ref = `T-${seq}`;
  await visit({ client: 2, date: TUE, start: "15:00", end: "15:30" });
  await db.run("INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (2, ?, '12:00', '13:00', 'Lunch')", [TUE]);

  const busy = await use("move_appointment", { reference: ref, date: TUE, time: "15:15" });
  assert.match(busy.error, /Marcus is busy then\. Nothing was changed\./);
  assert.deepEqual(busy.busy, [{ time: "15:00-15:30", what: "Sam Lee" }]);
  const blocked = await use("move_appointment", { reference: ref, date: TUE, time: "12:30", staff_id: 2 });
  assert.deepEqual(blocked.busy, [{ time: "12:00-13:00", what: "Blocked: Lunch" }]);
  assert.equal((await apt(id)).start_time, "14:00");

  // Its own time does not block it. Another barber works.
  const shifted = await use("move_appointment", { reference: ref.toLowerCase(), date: TUE, time: "14:15" });
  assert.equal(shifted.ok, true);
  const other = await use("move_appointment", { reference: ref, date: TUE, time: "14:15", staff_id: 2 });
  assert.equal(other.barber, "Dre");
  assert.equal((await apt(id)).staff_id, 2);

  assert.match((await use("move_appointment", { reference: "NOPE", date: TUE, time: "10:00" })).error, /no booking with that reference/);
  assert.match((await use("move_appointment", { reference: ref, date: "2026-02-30", time: "10:00" })).error, /real date/);
  assert.match((await use("move_appointment", { reference: ref, date: TUE, time: "25:00" })).error, /HH:MM/);
  assert.match((await use("move_appointment", { reference: ref, date: TUE, time: "23:45" })).error, /after midnight/);
  // A 30 minute visit at 23:30 would end at 24:00, which is not a time we can store.
  assert.match((await use("move_appointment", { reference: ref, date: TUE, time: "23:30" })).error, /after midnight/);
  assert.match((await use("move_appointment", { reference: ref, date: TUE, time: "10:00", staff_id: 99 })).error, /no barber with that id/);
  await db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", [id]);
  assert.match((await use("move_appointment", { reference: ref, date: TUE, time: "10:00" })).error, /completed/);
});

test("a move by Tolly fires the 'moved' routine", async () => {
  await auto.ensureDefaultAutomations();
  await db.run("UPDATE automations SET enabled = 0");
  const made = await call("POST", "/api/automations", {
    name: "Moved", trigger: "booking_moved", trigger_config: {}, action: "text_client",
    action_config: { message: "Your visit moved to {day} at {time}." }, filters: {},
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await visit({ date: TUE, start: "14:00", end: "14:30" });
  await use("move_appointment", { reference: `T-${seq}`, date: "2026-03-04", time: "09:00" });
  await auto.automationsIdle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JAMIE);
  assert.match(sent[0].body, /moved to Wednesday at 9:00 AM/);
});

test("Tolly cancels a booking and says that the pre-pay was not refunded", async () => {
  const id = await visit({ date: TUE });
  await db.run("UPDATE appointments SET prepay_amount = 10, prepay_status = 'paid' WHERE id = ?", [id]);
  const done = await use("cancel_appointment", { reference: `T-${seq}`, reason: "Marcus is sick" });
  assert.equal(done.ok, true);
  assert.match(done.refund, /No refund was made\. The client pre-paid \$10\.00\./);
  const row = await apt(id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.prepay_status, "paid");
  const notes = await notesOf(id);
  assert.match(notes[0], /Cancelled by the assistant for the shop\. Reason: Marcus is sick/);
  assert.match(notes[1], /was not refunded/);
  assert.match((await use("cancel_appointment", { reference: `T-${seq}`, reason: "" })).error, /already cancelled/);

  const plain = await visit({ date: TUE, start: "16:00", end: "16:30" });
  assert.equal((await use("cancel_appointment", { reference: `T-${seq}`, reason: "" })).refund, "There was no pre-pay to refund.");
  assert.equal((await apt(plain)).status, "cancelled");
});

// ── Blocking time ──────────────────────────────────────────────────

test("Tolly blocks time, and refuses when bookings overlap", async () => {
  await visit({ client: 2, date: TUE, start: "12:30", end: "13:00" });
  const ref = `T-${seq}`;
  const seen = script([
    { tool: "block_time", input: { staff_id: 1, date: TUE, start: "12:00", end: "13:00", reason: "Dentist" } },
    { tool: "block_time", input: { staff_id: 1, date: TUE, start: "11:00", end: "12:30", reason: "Dentist" } },
    "Sam Lee is booked at 12:30, so I blocked 11:00 to 12:30.",
  ]);
  await ask("Block tomorrow 12 to 1 for my dentist");
  // The refusal lists the booking in the way.
  assert.match(seen.prompts[1], /Nothing was blocked/);
  assert.ok(seen.prompts[1].includes(ref));
  assert.match(seen.prompts[1], /Sam Lee/);
  const blocks = await db.query<any>("SELECT * FROM blocked_slots");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start_time, "11:00");
  assert.equal(blocks[0].end_time, "12:30");
  assert.equal(blocks[0].reason, "Dentist");

  // A cancelled booking is not in the way. Another barber's booking is not either.
  await db.run("UPDATE appointments SET status = 'cancelled'");
  assert.equal((await use("block_time", { staff_id: 1, date: TUE, start: "12:30", end: "13:00", reason: "" })).ok, true);
  assert.match((await use("block_time", { staff_id: 1, date: TUE, start: "13:00", end: "13:00", reason: "" })).error, /end must be after the start/);
  assert.match((await use("block_time", { staff_id: 9, date: TUE, start: "13:00", end: "14:00", reason: "" })).error, /no barber/);
  // The blocked time now stops online booking.
  const open = await use("check_availability", { date: TUE, service_ids: [1], staff_id: 1 });
  assert.ok(!JSON.stringify(open).includes("11:30"));
});

// ── Texts ──────────────────────────────────────────────────────────

test("Tolly texts a client, signed, and it lands in their text thread", async () => {
  await visit({ date: TUE });
  const done = await use("text_client", { reference: `T-${seq}`, message: "Marcus is running 10 minutes late." });
  assert.equal(done.ok, true);
  assert.equal(done.sent_to, "Jamie Rivera");
  assert.deepEqual(sent, [{ to: JAMIE, body: "Marcus is running 10 minutes late.\n- Tolly" }]);
  const thread = await smsThreads.smsThreadForPhone(JAMIE);
  const messages = await db.query<any>("SELECT sender, body, delivery_status FROM chat_messages WHERE thread_id = ?", [thread!.id]);
  assert.deepEqual(messages.map((m) => [m.sender, m.delivery_status]), [["agent", "sent"]]);

  assert.equal((await use("text_client", { client_id: 2, message: "Hi" })).sent_to, "Sam Lee");
  assert.match((await use("text_client", { message: "Hi" })).error, /reference or a client_id/);
  assert.match((await use("text_client", { client_id: 77, message: "Hi" })).error, /no client/);

  // Opted out, no number, provider failure, no provider: nothing goes out and Tolly is told.
  await db.run("UPDATE chat_threads SET opted_out = 1 WHERE phone = ?", [JAMIE]);
  assert.match((await use("text_client", { client_id: 1, message: "Hi" })).error, /opted out/);
  await db.run("INSERT INTO clients (name, phone) VALUES ('No Phone', '')");
  assert.match((await use("text_client", { client_id: 3, message: "Hi" })).error, /no mobile number/);
  fail = "carrier said no";
  assert.match((await use("text_client", { client_id: 2, message: "Hi" })).error, /was not sent \(carrier said no\)/);
  fail = "";
  sms.setSmsProvider(null);
  assert.match((await use("text_client", { client_id: 2, message: "Hi" })).error, /not set up/);
  assert.equal(sent.length, 2);
});

test("at most 30 texts for one request, and 50 in an automation run", async () => {
  const chat = tools.staffTools();
  for (let i = 0; i < 30; i++) assert.equal((await use("text_client", { client_id: 2, message: `Text ${i}` }, {}, chat)).ok, true);
  const over = await use("text_client", { client_id: 2, message: "One more" }, {}, chat);
  assert.match(over.error, /limit is 30 texts per request/);
  assert.equal(sent.length, 30);
  // The next request starts fresh.
  assert.equal((await use("text_client", { client_id: 2, message: "New request" })).texts_left, 29);

  sent.length = 0;
  const runTools = tools.staffTools({ automationRun: true });
  for (let i = 0; i < 50; i++) assert.equal((await use("text_client", { client_id: 2, message: `Run ${i}` }, {}, runTools)).ok, true);
  assert.match((await use("text_client", { client_id: 2, message: "One more" }, {}, runTools)).error, /limit is 50 texts per automation run/);
  assert.equal(sent.length, 50);
});

// ── Automations ────────────────────────────────────────────────────

test("Tolly creates an automation from a request, after a preview", async () => {
  await auto.ensureDefaultAutomations();
  await visit({ date: TUE });
  const message = "Hi {client_first_name}, thanks for coming in! See you next time.";
  const seen = script([
    { tool: "preview_automation", input: { message } },
    "Here is the text: \"Hi Jamie, thanks for coming in! See you next time. - Tolly\". It would go out 2 hours after each visit. OK?",
  ]);
  const first = await ask("Text everyone a thank you two hours after their cut");
  assert.match(first, /OK\?$/);
  assert.match(seen.prompts[1], /thanks for coming in/);
  const before = (await auto.listAutomations()).length;

  script([
    { tool: "create_automation", input: { name: "Thank you, 2 hours after", trigger: "after_appointment", trigger_config: { minutes: 120 }, action: "text_client", action_config: { message } } },
    "Done. It is on.",
  ]);
  assert.equal(await ask("Yes"), "Done. It is on.");
  const list = await auto.listAutomations();
  assert.equal(list.length, before + 1);
  const made = list.find((a) => a.name === "Thank you, 2 hours after")!;
  assert.equal(made.created_by, "agent");
  assert.equal(made.enabled, true);
  assert.equal(made.trigger_config.minutes, 120);

  // A bad one is refused with a reason Tolly can pass on.
  const bad = await use("create_automation", { name: "Bad", trigger: "daily", trigger_config: { time: "8am" }, action: "text_client", action_config: { message: "Hi {nope}" } });
  assert.ok(bad.error);
  assert.equal((await auto.listAutomations()).length, before + 1);

  const off = await use("update_automation", { id: made.id, enabled: false });
  assert.equal(off.automation.on, false);
  assert.equal(off.automation.name, "Thank you, 2 hours after");
  assert.match((await use("update_automation", { id: 9999, enabled: false })).error, /no automation/);
  assert.ok((await use("list_automations", {})).automations.some((a: any) => a.id === made.id && a.on === false));
  assert.deepEqual((await use("automation_history", { id: made.id })).runs, []);
  assert.match((await use("run_automation_now", { id: made.id })).error, /Only assistant tasks/);
  assert.deepEqual(await use("delete_automation", { id: made.id }), { ok: true });
  assert.match((await use("delete_automation", { id: made.id })).error, /no automation/);
});

test("in an automation run, Tolly has no tools that change automations", async () => {
  const names = Object.keys(tools.staffTools({ automationRun: true }));
  for (const name of ["create_automation", "update_automation", "delete_automation", "run_automation_now"]) assert.ok(!names.includes(name), name);
  for (const name of ["get_schedule", "text_client", "income_report", "list_automations", "automation_history"]) assert.ok(names.includes(name), name);
  assert.ok(Object.keys(tools.staffTools()).includes("create_automation"));

  // Even when the model tries, nothing is made.
  await auto.ensureDefaultAutomations();
  const before = (await auto.listAutomations()).length;
  const seen = script([
    { tool: "create_automation", input: { name: "Sneaky", trigger: "booking_created", action: "text_client", action_config: { message: "Hi" } } },
    "Report: nothing to do.",
  ]);
  const result = await agent.runStaffTask("Morning check", "Make a new routine.");
  assert.equal(result.ok, true);
  assert.equal((await auto.listAutomations()).length, before);
  assert.match(seen.prompts[0], /must not create, change or delete automations/);
});

// ── Money ──────────────────────────────────────────────────────────

test("Tolly records a payment and reports income from money really taken", async () => {
  const a = await visit({ date: MON, start: "09:00", end: "09:30" });
  const refA = `T-${seq}`;
  await visit({ client: 2, staff: 2, date: MON, start: "09:30", end: "10:00" });
  const refB = `T-${seq}`;
  await visit({ client: 2, date: TUE }); // Booked, not paid: not income.

  const paid = await use("record_payment", { reference: refA, amount: 35, tip: 5, method: "cash" });
  assert.equal(paid.ok, true);
  assert.equal(paid.still_due, "$0.00");
  assert.equal(paid.paid_on, MON);
  const part = await use("record_payment", { reference: refB, amount: 20, method: "card_in_person" });
  assert.equal(part.still_due, "$15.00");
  assert.equal(part.method, "Card / tap to pay");
  // A repeat of the same payment, or more than is due, is refused.
  assert.match((await use("record_payment", { reference: refA, amount: 35, method: "cash" })).error, /already paid in full/);
  assert.match((await use("record_payment", { reference: refB, amount: 20, method: "cash" })).error, /Only \$15\.00 is still due/);
  assert.match((await use("record_payment", { reference: refA, amount: 0, method: "cash" })).error, /above zero/);
  assert.match((await use("record_payment", { reference: "NOPE", amount: 5, method: "cash" })).error, /no booking/);
  const rows = await db.query<any>("SELECT * FROM payments ORDER BY id");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].appointment_id, rows[0].client_id, rows[0].staff_id, rows[0].kind], [a, 1, 1, "payment"]);

  const seen = script([
    { tool: "income_report", input: { start: "2026-03-01", end: "2026-03-31" } },
    "You took $60.00 in March so far: $55.00 for services and $5.00 in tips.",
  ]);
  const answer = await ask("How much did I make this month?");
  assert.match(answer, /\$60\.00/);
  const result = seen.prompts[1];
  assert.match(result, /\\"income\\":60|"income":60/);
  assert.match(result, /Card fees are not subtracted/);

  const report = await use("income_report", { start: "2026-03-01", end: "2026-03-31" });
  assert.deepEqual([report.income, report.services, report.tips, report.refunds, report.payments], [60, 55, 5, 0, 2]);
  assert.deepEqual(report.by_method, [{ method: "card_in_person", name: "Card / tap to pay", total: 20 }, { method: "cash", name: "Cash", total: 40 }]);
  assert.deepEqual(report.by_barber, [{ staff_id: 1, barber: "Marcus", total: 40, tips: 5 }, { staff_id: 2, barber: "Dre", total: 20, tips: 0 }]);
  assert.deepEqual(report.by_month, [{ month: "2026-03", income: 60, services: 55, tips: 5, refunds: 0 }]);
  assert.equal((await use("income_report", { start: "2026-04-01", end: "2026-04-30" })).income, 0);
  assert.match((await use("income_report", { start: "2026-03-31", end: "2026-03-01" })).error, /before the start/);
  // The prompt tells Tolly where money answers come from.
  assert.match(seen.prompts[0], /use income_report/);
});

test("the booking report counts the calendar, not money", async () => {
  await visit({ date: MON, status: "completed" });
  await visit({ client: 2, staff: 2, date: MON, start: "15:00", end: "15:30" });
  await visit({ client: 2, date: TUE, status: "cancelled" });
  await visit({ client: 1, date: TUE, start: "16:00", end: "16:30", status: "no_show" });
  await visit({ client: 1, date: "2026-02-10", status: "completed" });
  const report = await use("get_report", { start: MON, end: TUE });
  assert.deepEqual(
    [report.bookings, report.completed, report.cancelled, report.no_shows, report.booked_value, report.completed_value, report.new_clients],
    [3, 1, 1, 1, 70, 35, 1],
  );
  assert.deepEqual(report.top_services, [{ service: "Haircut", bookings: 2 }]);
  assert.equal(report.by_barber.length, 2);
  assert.match((await use("get_report", { start: "x", end: TUE })).error, /real dates/);
});

// ── Looking things up ──────────────────────────────────────────────

test("Tolly finds clients and the chats that wait for the barber", async () => {
  await visit({ date: TUE });
  await visit({ date: "2026-02-10", status: "completed" });
  const byName = await use("find_client", { search: "jam" });
  assert.equal(byName.clients.length, 1);
  assert.equal(byName.clients[0].name, "Jamie Rivera");
  assert.equal(byName.clients[0].last_visit, "2026-02-10");
  assert.equal(byName.clients[0].coming_bookings.length, 1);
  assert.equal((await use("find_client", { search: "0199" })).clients[0].name, "Sam Lee");
  assert.deepEqual((await use("find_client", { search: "%" })).clients, []);

  assert.deepEqual((await use("chats_needing_reply", {})).chats, []);
  const thread = await smsThreads.smsThreadForPhone(SAM);
  await db.run("INSERT INTO chat_messages (thread_id, sender, body) VALUES (?, 'client', 'Can I bring my kid?'), (?, 'note', 'Staff only note')", [thread!.id, thread!.id]);
  await db.run("UPDATE chat_threads SET needs_attention = 1, staff_unread = 1, mode = 'human', last_message_at = utc_now() WHERE id = ?", [thread!.id]);
  const waiting = (await use("chats_needing_reply", {})).chats;
  assert.equal(waiting.length, 1);
  assert.deepEqual([waiting[0].name, waiting[0].channel, waiting[0].unread, waiting[0].last_message], ["Sam Lee", "text", 1, "Can I bring my kid?"]);
});

// ── Setting up and changing the shop from the chat ─────────────────

test("Tolly books a visit for the shop, and refuses a busy time", async () => {
  await db.run("UPDATE staff SET active = 0 WHERE id = 2");
  const made = await use("create_appointment", { client_id: 1, date: TUE, time: "10:00", service_ids: [1, 2], notes: "Likes it short" });
  assert.equal(made.ok, true);
  assert.deepEqual([made.client, made.time, made.barber, made.services, made.price], ["Jamie Rivera", "10:00-10:45", "Marcus", "Haircut, Beard Trim", "$50.00"]);
  assert.equal(made.warning, undefined);
  const row = await db.get<any>("SELECT * FROM appointments WHERE identifier = ?", [made.reference]);
  assert.deepEqual([row.client_id, row.staff_id, row.scheduled_date, row.start_time, row.end_time, row.total_price, row.status, row.notes],
    [1, 1, TUE, "10:00", "10:45", 50, "booked", "Likes it short"]);
  assert.equal((await db.query("SELECT 1 FROM appointment_services WHERE appointment_id = ?", [row.id])).length, 2);

  // The same time is taken now.
  const busy = await use("create_appointment", { client_id: 2, date: TUE, time: "10:30", service_ids: [1] });
  assert.match(busy.error, /Marcus is busy then/);
  assert.equal(busy.busy.length, 1);
  assert.equal((await db.query("SELECT 1 FROM appointments")).length, 1);

  assert.match((await use("create_appointment", { client_id: 99, date: TUE, time: "12:00", service_ids: [1] })).error, /no client/);
  assert.match((await use("create_appointment", { client_id: 1, date: "2026-02-30", time: "12:00", service_ids: [1] })).error, /real date/);
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "noon", service_ids: [1] })).error, /HH:MM/);
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "12:00", service_ids: [1, 99] })).error, /not offered/);
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "23:45", service_ids: [1] })).error, /after midnight/);
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "12:00", service_ids: [1], staff_id: 2 })).error, /no barber/);
  // The same service twice counts once.
  const once = await use("create_appointment", { client_id: 2, date: TUE, time: "13:00", service_ids: [2, 2] });
  assert.deepEqual([once.services, once.price, once.time], ["Beard Trim", "$15.00", "13:00-13:15"]);
  // A time before now still books, with a warning.
  assert.match((await use("create_appointment", { client_id: 1, date: MON, time: "08:00", service_ids: [1] })).warning, /in the past/);
});

test("with two barbers, Tolly asks which one", async () => {
  await db.run("UPDATE staff SET active = 0");
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "10:00", service_ids: [1] })).error, /No barber is on/);
  await db.run("UPDATE staff SET active = 1");
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "10:00", service_ids: [1] })).error, /which barber/);
  const made = await use("create_appointment", { client_id: 1, date: TUE, time: "10:00", service_ids: [1], staff_id: 2 });
  assert.equal(made.barber, "Dre");
  // Marcus is still free at that time.
  assert.equal((await use("create_appointment", { client_id: 2, date: TUE, time: "10:00", service_ids: [1], staff_id: 1 })).ok, true);
});

test("Tolly lists bookings between two dates", async () => {
  await visit({ date: MON, start: "09:00", end: "09:30", status: "completed" });
  await visit({ date: TUE, client: 2, staff: 2 });
  await visit({ date: "2026-03-10" });
  const all = (await use("list_appointments", { from: MON, to: TUE })).bookings;
  assert.deepEqual(all.map((b: any) => [b.date, b.client, b.barber, b.services, b.status]),
    [[MON, "Jamie Rivera", "Marcus", "Haircut", "completed"], [TUE, "Sam Lee", "Dre", "Haircut", "booked"]]);
  assert.equal((await use("list_appointments", { from: MON, to: "2026-03-31", client_id: 1 })).bookings.length, 2);
  assert.equal((await use("list_appointments", { from: MON, to: "2026-03-31", status: "Completed" })).bookings.length, 1);
  assert.match((await use("list_appointments", { from: TUE, to: MON })).error, /before the start/);
  assert.match((await use("list_appointments", { from: "soon", to: MON })).error, /real dates/);
});

test("Tolly deletes a booking, but not one with money on it", async () => {
  const plain = await visit();
  const paid = await visit({ start: "15:00", end: "15:30" });
  const prepaid = await visit({ start: "16:00", end: "16:30" });
  await db.run("INSERT INTO payments (appointment_id, client_id, amount, paid_on) VALUES (?, 1, 35, ?)", [paid, TUE]);
  await db.run("UPDATE appointments SET prepay_status = 'paid' WHERE id = ?", [prepaid]);
  const ref = async (id: number) => (await db.get<{ identifier: string }>("SELECT identifier FROM appointments WHERE id = ?", [id]))!.identifier;

  assert.match((await use("delete_appointment", { reference: await ref(paid) })).error, /Cancel it instead/);
  assert.match((await use("delete_appointment", { reference: await ref(prepaid) })).error, /Cancel it instead/);
  const gone = await use("delete_appointment", { reference: await ref(plain) });
  assert.equal(gone.ok, true);
  assert.equal(gone.client, "Jamie Rivera");
  assert.deepEqual((await db.query<{ id: number }>("SELECT id FROM appointments ORDER BY id")).map((r) => r.id), [paid, prepaid]);
  assert.ok((await use("delete_appointment", { reference: "NOPE-1" })).error);
  // A finished visit stays, even with no payment recorded.
  const done = await visit({ start: "17:00", end: "17:30", status: "completed" });
  assert.match((await use("delete_appointment", { reference: await ref(done) })).error, /stays in the records/);
});

test("Tolly adds, changes and deletes clients", async () => {
  const made = await use("add_client", { name: "Alex Kim", phone: "555 555 0142", notes: "Referred by Sam" });
  assert.equal(made.ok, true);
  assert.equal(made.phone, "+15555550142");
  assert.equal((await db.get<any>("SELECT notes FROM clients WHERE id = ?", [made.client_id])).notes, "Referred by Sam");
  // Nobody is added twice, however the number is written.
  const twice = await use("add_client", { name: "Jamie R", phone: "+1 555-555-0101" });
  assert.match(twice.error, /Jamie Rivera already has this phone number/);
  assert.match((await use("add_client", { name: "Bad", phone: "12345" })).error, /not a phone number/);
  assert.equal((await use("add_client", { name: "No Phone" })).ok, true);

  const changed = await use("update_client", { client_id: made.client_id, name: "Alex Kim Jr", email: "alex@example.com" });
  assert.deepEqual([changed.name, changed.phone, changed.email], ["Alex Kim Jr", "+15555550142", "alex@example.com"]);
  assert.equal((await use("update_client", { client_id: made.client_id, phone: "" })).phone, "");
  assert.match((await use("update_client", { client_id: made.client_id })).error, /Nothing to change/);
  assert.match((await use("update_client", { client_id: 999, name: "X" })).error, /no client/);
  assert.match((await use("update_client", { client_id: 1, phone: "abc" })).error, /not a phone number/);
  // Two clients never share a number. Keeping your own number is fine.
  assert.match((await use("update_client", { client_id: 2, phone: "555-555-0101" })).error, /Jamie Rivera already has this phone number/);
  assert.equal((await use("update_client", { client_id: 2, phone: "+15555550199", name: "Sam L" })).ok, true);

  // A client with bookings stays, so no history is lost.
  await visit({ client: 1 });
  assert.match((await use("delete_client", { client_id: 1 })).error, /has 1 booking\./);
  assert.equal((await db.query("SELECT 1 FROM appointments")).length, 1);
  assert.deepEqual(await use("delete_client", { client_id: made.client_id }), { ok: true, deleted: "Alex Kim Jr" });
  assert.match((await use("delete_client", { client_id: made.client_id })).error, /no client/);
});

test("Tolly adds, changes and deletes barbers, and keeps one on", async () => {
  const list = (await use("list_staff", {})).staff;
  assert.deepEqual(list.map((s: any) => [s.name, s.on]), [["Dre", true], ["Marcus", true]]);

  const made = await use("create_staff", { name: "Tasha", title: "Barber", phone: "(555) 555-0177" });
  assert.equal(made.ok, true);
  const row = await db.get<any>("SELECT * FROM staff WHERE id = ?", [made.staff_id]);
  assert.deepEqual([row.name, row.title, row.phone, row.color, row.active], ["Tasha", "Barber", "+15555550177", "#3a4a5c", 1]);

  const off = await use("update_staff", { staff_id: made.staff_id, on: false, title: "Senior Barber" });
  assert.deepEqual([off.name, off.on], ["Tasha", false]);
  assert.equal((await use("update_staff", { staff_id: 2, on: false })).on, false);
  // Marcus is the last one on.
  assert.match((await use("update_staff", { staff_id: 1, on: false })).error, /only barber who is on/);
  assert.equal((await db.get<any>("SELECT active FROM staff WHERE id = 1")).active, 1);
  assert.match((await use("update_staff", { staff_id: 999, name: "X" })).error, /no barber/);
  assert.match((await use("update_staff", { staff_id: 1 })).error, /Nothing to change/);

  await visit({ staff: 2 });
  assert.match((await use("delete_staff", { staff_id: 2 })).error, /has bookings/);
  assert.deepEqual(await use("delete_staff", { staff_id: made.staff_id }), { ok: true, deleted: "Tasha" });
  assert.match((await use("delete_staff", { staff_id: 1 })).error, /at least one barber/);
  assert.match((await use("delete_staff", { staff_id: 999 })).error, /no barber/);
  assert.equal((await db.query("SELECT 1 FROM staff")).length, 2);
});

test("Tolly adds, changes and removes services", async () => {
  const made = await use("create_service", { name: "Line Up", minutes: 15, price: 12.5, category: "Cuts" });
  assert.deepEqual([made.ok, made.minutes, made.price], [true, 15, "$12.50"]);
  const all = (await use("list_services", {})).services;
  assert.equal(all.length, 3);
  assert.ok(all.every((s: any) => s.on));

  const changed = await use("update_service", { service_id: 1, price: 40, minutes: 45, on: false });
  assert.deepEqual([changed.name, changed.price, changed.minutes, changed.on], ["Haircut", "$40.00", 45, false]);
  assert.equal((await use("list_services", {})).services.find((s: any) => s.id === 1).on, false);
  // A service that is off cannot be booked.
  assert.match((await use("create_appointment", { client_id: 1, date: TUE, time: "10:00", service_ids: [1], staff_id: 1 })).error, /not offered/);
  assert.match((await use("update_service", { service_id: 999, price: 1 })).error, /no service/);
  assert.match((await use("update_service", { service_id: 1 })).error, /Nothing to change/);

  // A service with bookings is turned off, so past visits keep it.
  await visit({ service: 2 });
  const kept = await use("delete_service", { service_id: 2 });
  assert.equal(kept.turned_off, "Beard Trim");
  assert.equal((await db.get<any>("SELECT active FROM services WHERE id = 2")).active, 0);
  assert.equal((await db.query("SELECT 1 FROM appointment_services WHERE service_id = 2")).length, 1);
  assert.deepEqual(await use("delete_service", { service_id: made.service_id }), { ok: true, deleted: "Line Up" });
  assert.match((await use("delete_service", { service_id: made.service_id })).error, /no service/);
});

test("Tolly adds, changes and deletes products, and counts stock", async () => {
  const made = await use("create_product", { name: "Matte Clay", brand: "Layrite", price: 18, cost: 9, stock: 6 });
  assert.deepEqual([made.ok, made.price, made.stock], [true, "$18.00", 6]);
  await use("create_product", { name: "Beard Oil", price: 14, stock: 20 });

  assert.equal((await use("list_products", {})).products.length, 2);
  const found = (await use("list_products", { search: "layr" })).products;
  assert.deepEqual([found.length, found[0].name, found[0].low], [1, "Matte Clay", false]);
  assert.deepEqual((await use("list_products", { search: "%" })).products, []);

  const sold = await use("update_product", { product_id: made.product_id, stock_change: -2 });
  assert.deepEqual([sold.stock, sold.low], [4, true]);
  assert.deepEqual((await use("list_products", { low_stock_only: true })).products.map((p: any) => p.name), ["Matte Clay"]);
  assert.match((await use("update_product", { product_id: made.product_id, stock_change: -9 })).error, /only 4 in stock/);
  assert.match((await use("update_product", { product_id: made.product_id, stock: 3, stock_change: 1 })).error, /not both/);
  const set = await use("update_product", { product_id: made.product_id, stock: 12, price: 20 });
  assert.deepEqual([set.stock, set.price, set.low], [12, "$20.00", false]);
  assert.match((await use("update_product", { product_id: made.product_id })).error, /Nothing to change/);
  assert.match((await use("update_product", { product_id: 999, price: 1 })).error, /no product/);

  assert.deepEqual(await use("delete_product", { product_id: made.product_id }), { ok: true, deleted: "Matte Clay" });
  assert.match((await use("delete_product", { product_id: made.product_id })).error, /no product/);
});

test("Tolly reads and changes the shop's settings and hours", async () => {
  const before = await use("get_settings", {});
  assert.equal(before.hours.length, 7);
  assert.equal(before.hours[0].name, "Sunday");

  const changed = await use("update_settings", {
    shop_name: "Fade Factory", prepay_mode: "fixed", prepay_amount: 10,
    hours: [{ day: 0, closed: true }, { day: 6, open: "10:00", close: "16:00" }],
  });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.changed.sort(), ["hours", "prepay_amount", "prepay_mode", "shop_name"]);
  const after = await use("get_settings", {});
  assert.deepEqual([after.shop_name, after.prepay_mode, after.prepay_amount], ["Fade Factory", "fixed", 10]);
  assert.deepEqual(after.hours[0], { day: 0, name: "Sunday", closed: true });
  assert.deepEqual(after.hours[6], { day: 6, name: "Saturday", closed: false, open: "10:00", close: "16:00" });
  // The other days did not change.
  assert.deepEqual(after.hours.slice(1, 6), before.hours.slice(1, 6));

  // A bad value changes nothing.
  for (const bad of [{ hours: [{ day: 2, open: "18:00", close: "09:00" }] }, { slot_step: 1 }, { prepay_percent: 500 }, { timezone: "Mars/Olympus" }]) {
    const res = await use("update_settings", { shop_name: "Oops", ...bad });
    assert.match(res.error, /Nothing was changed/, JSON.stringify(bad));
  }
  assert.equal((await use("get_settings", {})).shop_name, "Fade Factory");
  assert.match((await use("update_settings", {})).error, /Nothing to change/);
});

test("in an automation run, Tolly cannot change the shop's setup", async () => {
  const run = Object.keys(tools.staffTools({ automationRun: true }));
  const change = ["create_appointment", "delete_appointment", "add_client", "update_client", "delete_client", "create_staff", "update_staff", "delete_staff",
    "create_service", "update_service", "delete_service", "create_product", "update_product", "delete_product", "update_settings"];
  const all = Object.keys(tools.staffTools());
  for (const name of change) { assert.ok(!run.includes(name), name); assert.ok(all.includes(name), name); }
  for (const name of ["list_appointments", "list_staff", "list_services", "list_products", "get_settings"]) assert.ok(run.includes(name), name);
});

test("clients never get the tools that change the shop", async () => {
  const { clientTools } = await import("./clienttools.js");
  const names = Object.keys(clientTools({ threadId: 1, clientId: 1, channel: "sms", baseUrl: "http://localhost" } as any));
  // Clients have their own list_services. They get nothing that changes the shop or shows its records.
  const staffOnly = Object.keys(tools.staffTools()).filter((name) => /^(create|update|delete|add)_/.test(name))
    .concat(["list_appointments", "list_staff", "list_products", "get_settings"]);
  assert.ok(staffOnly.length >= 19);
  for (const name of staffOnly) assert.ok(!names.includes(name), name);
});

test("the barber sets up a service in the chat", async () => {
  const seen = script([{ tool: "create_service", input: { name: "Kids Cut", minutes: 30, price: 25 } }, "Done. Kids Cut is $25 for 30 minutes."]);
  assert.equal(await ask("Add a kids cut, 30 minutes, $25"), "Done. Kids Cut is $25 for 30 minutes.");
  const row = await db.get<any>("SELECT duration, price, active FROM services WHERE name = 'Kids Cut'");
  assert.deepEqual([row.duration, row.price, row.active], [30, 25, 1]);
  assert.match(seen.prompts[0], /Before you delete anything/);
});
