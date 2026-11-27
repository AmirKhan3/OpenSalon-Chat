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
const prepay = await import("./prepay.js");
const { saveSettings } = await import("./settings.js");

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

/** The automations, by their built-in key. The first call also makes the defaults. */
async function builtins(): Promise<Record<string, any>> {
  const list = await call("GET", "/api/automations");
  assert.equal(list.status, 200);
  return Object.fromEntries(list.body.automations.filter((a: any) => a.builtin_key).map((a: any) => [a.builtin_key, a]));
}

/** Turn every routine off, so a test sees only its own. */
async function allOff() {
  await builtins();
  await db.run("UPDATE automations SET enabled = 0");
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

const textRoutine = (patch: object = {}) => ({
  name: "Test routine", trigger: "booking_created", trigger_config: {}, action: "text_client",
  action_config: { message: "Hi {client_first_name}, see you {day} at {time}." }, filters: {}, ...patch,
});

async function make(patch: object = {}) {
  const made = await call("POST", "/api/automations", textRoutine(patch));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.automation;
}

const runsOf = async (id: number) => (await call("GET", `/api/automations/${id}/runs`)).body.runs as any[];

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

// ── Defaults ───────────────────────────────────────────────────────

test("the starter routines are made once, and a deleted one stays deleted", async () => {
  const first = await builtins();
  assert.deepEqual(Object.keys(first).sort(), ["booking_confirmation", "day_before", "morning_of", "prepay_link", "prepay_received", "thank_you"]);
  assert.equal(first.morning_of.enabled, true);
  assert.equal(first.day_before.enabled, false);
  assert.equal(first.thank_you.enabled, false);
  assert.equal(first.morning_of.created_by, "system");
  assert.match(first.morning_of.summary, /^Every day at 8:00 AM, text each client with a visit that day\.$/);
  assert.match(first.day_before.summary, /^1 day before a visit, text the client\.$/);
  assert.match(first.booking_confirmation.summary, /Only for: visits booked online or in the web chat; status booked or confirmed\./);

  assert.equal((await call("DELETE", `/api/automations/${first.day_before.id}`)).status, 200);
  await auto.ensureDefaultAutomations();
  const again = await builtins();
  assert.equal(Object.keys(again).length, 5);
  assert.equal(again.day_before, undefined);
});

// ── Daily ──────────────────────────────────────────────────────────

test("the morning-of text goes out once, at its time, to each client with a visit that day", async () => {
  await builtins();
  await saveSettings({ access_instructions: "Ring the bell at the side door." });
  await visit({ client: 1, date: TUE, start: "14:00" });
  await visit({ client: 2, date: TUE, start: "16:00", end: "16:30", staff: 2 });
  await visit({ client: 2, date: "2026-03-04", start: "10:00", end: "10:30" });
  await visit({ client: 1, date: TUE, start: "17:00", end: "17:30", status: "cancelled" });

  clock(TUE, "07:59");
  await auto.tick();
  assert.equal(sent.length, 0);

  clock(TUE, "08:00");
  await auto.tick();
  assert.equal(sent.length, 2);
  const jamie = sent.find((s) => s.to === JAMIE)!;
  assert.equal(jamie.body, "Good morning Jamie! See you today at 2:00 PM at Our Barbershop. Ring the bell at the side door.\n- Tolly");
  assert.ok(sent.some((s) => s.to === SAM && s.body.includes("4:00 PM")));

  // The text is in the client's thread, where the barber reads it.
  const thread = await smsThreads.smsThreadForPhone(JAMIE);
  const inbox = await call("GET", `/api/chat/threads/${thread!.id}`);
  assert.equal(inbox.body.messages.at(-1).body, jamie.body);
  assert.equal(inbox.body.messages.at(-1).delivery_status, "sent");

  clock(TUE, "08:01");
  await auto.tick();
  await auto.tick();
  assert.equal(sent.length, 2);
});

test("two ticks at the same moment send one text", async () => {
  await builtins();
  await visit();
  clock(TUE, "08:00");
  await Promise.all([auto.tick(), auto.tick(), auto.tick()]);
  assert.equal(sent.length, 1);
});

test("a routine never fires for a moment before it was made or turned back on", async () => {
  const all = await builtins();
  await visit();

  // Turned off before 08:00 and on again after: no morning text today.
  clock(TUE, "07:00");
  await call("PUT", `/api/automations/${all.morning_of.id}`, { enabled: false });
  clock(TUE, "08:30");
  await call("PUT", `/api/automations/${all.morning_of.id}`, { enabled: true });
  await auto.tick();
  assert.equal(sent.length, 0);

  // Made at 09:00 for 08:30: that moment is gone.
  clock(TUE, "09:00");
  const late = await make({ trigger: "daily", trigger_config: { time: "08:30", days: [0, 1, 2, 3, 4, 5, 6], scope: "today" } });
  await auto.tick();
  assert.equal((await runsOf(late.id)).length, 0);
  assert.equal(sent.length, 0);
  await call("DELETE", `/api/automations/${late.id}`);

  // The next day it works again.
  await visit({ date: "2026-03-04" });
  clock("2026-03-04", "08:02");
  await auto.tick();
  assert.equal(sent.length, 1);
});

test("a visit booked after the morning text went out gets none, and so does one that already started", async () => {
  await builtins();
  await visit({ client: 1, date: TUE, start: "15:00", end: "15:30", created: "2026-03-03 13:10:00" }); // booked 08:10 New York
  await visit({ client: 2, date: TUE, start: "08:15", end: "08:45" });
  clock(TUE, "08:20");
  await auto.tick();
  assert.equal(sent.length, 0);
});

test("a daily routine runs only on its days, and can text tomorrow's clients", async () => {
  await allOff();
  await visit({ date: TUE });
  const routine = await make({
    trigger: "daily", trigger_config: { time: "18:00", days: [1], scope: "tomorrow" },
    action_config: { message: "See you tomorrow, {day}, at {time}." },
  });
  assert.match(routine.summary, /^Every Mon at 6:00 PM, text each client with a visit the next day\.$/);
  clock(MON, "18:00");
  await auto.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "See you tomorrow, Tuesday, at 2:00 PM.\n- Tolly");

  await visit({ date: "2026-03-04", client: 2 });
  clock(TUE, "18:00"); // Tuesday is not one of its days
  await auto.tick();
  assert.equal(sent.length, 1);
});

// ── Before and after a visit ───────────────────────────────────────

test("a day-before reminder goes out once, 24 hours before", async () => {
  const all = await builtins();
  await db.run("UPDATE automations SET enabled = 0");
  await call("PUT", `/api/automations/${all.day_before.id}`, { enabled: true });
  await visit({ date: TUE, start: "14:00" });
  // Booked on Monday at 15:00 for Tuesday 14:30: less than a day ahead, so no reminder.
  await visit({ client: 2, date: TUE, start: "14:30", end: "15:00", created: "2026-03-02 20:00:00" });

  clock(MON, "13:59");
  await auto.tick();
  assert.equal(sent.length, 0);

  clock(MON, "14:00");
  await auto.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JAMIE);
  assert.match(sent[0].body, /^Hi Jamie! Reminder: Haircut tomorrow at 2:00 PM with Marcus\. Need to change it\? https:\/\/shop\.test\/book\/manage\/[\w-]{20,}\n- Tolly$/);

  clock(MON, "14:31");
  await auto.tick();
  assert.equal(sent.length, 1);
  const runs = await runsOf(all.day_before.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "sent");
  assert.equal(runs[0].client_name, "Jamie Rivera");
});

test("a moved visit gets a new reminder for its new time", async () => {
  await allOff();
  const routine = await make({ trigger: "before_appointment", trigger_config: { minutes: 60 } });
  const id = await visit({ date: MON, start: "12:00", end: "12:30" });
  clock(MON, "11:00");
  await auto.tick();
  assert.equal(sent.length, 1);
  await db.run("UPDATE appointments SET start_time = '15:00', end_time = '15:30' WHERE id = ?", [id]);
  clock(MON, "14:00");
  await auto.tick();
  assert.equal(sent.length, 2);
  assert.equal((await runsOf(routine.id)).length, 2);
});

test("no reminder in the last 10 minutes before a visit, and none shorter than 15 minutes can be made", async () => {
  await allOff();
  await make({ trigger: "before_appointment", trigger_config: { minutes: 15 } });
  await visit({ date: MON, start: "12:00", end: "12:30" });
  clock(MON, "11:51"); // the server was down at 11:45
  await auto.tick();
  assert.equal(sent.length, 0);

  const tooShort = await call("POST", "/api/automations", textRoutine({ trigger: "before_appointment", trigger_config: { minutes: 5 } }));
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.body.error, /at least 15 minutes/);
});

test("a short reminder goes out early when the timer runs rarely, and only once", async () => {
  await allOff();
  await make({ trigger: "before_appointment", trigger_config: { minutes: 15 } });
  await visit({ date: MON, start: "12:05", end: "12:35" });
  process.env.TICK_GAP_MINUTES = "30";
  try {
    // The reminder can be sent from 11:50 to 11:55. Runs at 11:45 and 12:00 both miss that.
    clock(MON, "11:19");
    await auto.tick();
    assert.equal(sent.length, 0); // more than one wait early: a later run still comes in time
    clock(MON, "11:45");
    await auto.tick();
    assert.equal(sent.length, 1);
    clock(MON, "11:52");
    await auto.tick();
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.TICK_GAP_MINUTES;
  }
});

test("a reminder is on time when the timer runs every minute, and a long one is never early", async () => {
  await allOff();
  await make({ trigger: "before_appointment", trigger_config: { minutes: 15 } });
  await visit({ date: MON, start: "12:05", end: "12:35" });
  clock(MON, "11:45");
  await auto.tick();
  assert.equal(sent.length, 0);
  clock(MON, "11:50");
  await auto.tick();
  assert.equal(sent.length, 1);

  assert.equal(auto.tickGap(), 60);
  assert.equal(auto.earlyBy(15 * 60, 60), 0);
  assert.equal(auto.earlyBy(15 * 60, 30 * 60), 25 * 60);
  assert.equal(auto.earlyBy(40 * 60, 30 * 60), 0);
  assert.equal(auto.earlyBy(24 * 3600, 30 * 60), 0);
  process.env.VERCEL = "1";
  try {
    assert.equal(auto.tickGap(), 30 * 60);
    process.env.TICK_GAP_MINUTES = "1";
    assert.equal(auto.tickGap(), 60);
    process.env.TICK_GAP_MINUTES = "nonsense";
    assert.equal(auto.tickGap(), 30 * 60);
  } finally {
    delete process.env.VERCEL;
    delete process.env.TICK_GAP_MINUTES;
  }
});

test("the thank-you text waits for the visit to be completed", async () => {
  const all = await builtins();
  await db.run("UPDATE automations SET enabled = 0");
  await call("PUT", `/api/automations/${all.thank_you.id}`, { enabled: true });
  const id = await visit({ date: MON, start: "10:30", end: "11:00" });
  await visit({ client: 2, date: MON, start: "10:30", end: "11:00", staff: 2, status: "no_show" });

  clock(MON, "12:59");
  await auto.tick();
  clock(MON, "13:00");
  await auto.tick(); // not completed yet
  assert.equal(sent.length, 0);

  await db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", [id]);
  clock(MON, "13:20");
  await auto.tick();
  await auto.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Thanks for coming in, Jamie! Text us here when you want your next visit.\n- Tolly");

  // A visit that ended before the routine was turned on gets nothing.
  await visit({ client: 2, date: MON, start: "07:00", end: "07:30", status: "completed" });
  clock(MON, "13:21");
  await auto.tick();
  assert.equal(sent.length, 1);
});

// ── Events ─────────────────────────────────────────────────────────

test("an online booking gets a confirmation with a calendar link; a booking made by staff gets none", async () => {
  await builtins();
  const booked = await call("POST", "/api/public/bookings", { name: "Jamie Rivera", phone: JAMIE, date: TUE, time: "14:00", service_ids: [1], staff_id: 1 });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JAMIE);
  assert.match(sent[0].body, /^Hi Jamie! You are booked: Haircut on Tuesday, March 3 at 2:00 PM with Marcus\. Add it to your calendar: https:\/\/shop\.test\/book\/manage\/[\w-]{20,}\?calendar=1\n- Tolly$/);

  const byStaff = await call("POST", "/api/appointments", { client_id: 2, staff_id: 2, scheduled_date: TUE, start_time: "15:00", service_ids: [1] });
  assert.equal(byStaff.status, 201, JSON.stringify(byStaff.body));
  assert.equal(sent.length, 1);
});

test("cancel and move events fire once each", async () => {
  await allOff();
  const cancelled = await make({ name: "Cancelled", trigger: "booking_cancelled", action_config: { message: "Your visit on {date} is cancelled." } });
  const moved = await make({ name: "Moved", trigger: "booking_moved", action_config: { message: "Your visit is now {day} at {time}." } });
  const made = await call("POST", "/api/appointments", { client_id: 1, staff_id: 1, scheduled_date: TUE, start_time: "14:00", service_ids: [1] });
  const id = made.body.appointment.id;

  // A note is not a move.
  await call("PUT", `/api/appointments/${id}`, { notes: "Likes a low fade." });
  assert.equal(sent.length, 0);

  const move = await call("PUT", `/api/appointments/${id}`, { scheduled_date: "2026-03-04", start_time: "11:00" });
  assert.equal(move.status, 200, JSON.stringify(move.body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Your visit is now Wednesday at 11:00 AM.\n- Tolly");

  await call("PUT", `/api/appointments/${id}`, { status: "cancelled" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, "Your visit on Wednesday, March 4 is cancelled.\n- Tolly");
  await call("PUT", `/api/appointments/${id}`, { status: "cancelled" });
  assert.equal(sent.length, 2);
  assert.equal((await runsOf(cancelled.id)).length, 1);
  assert.equal((await runsOf(moved.id)).length, 1);
});

test("the pre-pay text goes out once, even if the payment is reported twice", async () => {
  await builtins();
  const id = await visit({ status: "pending", source: "online" });
  await db.run("UPDATE appointments SET prepay_amount = 10, prepay_status = 'due', stripe_session_id = 'cs_test_1' WHERE id = ?", [id]);
  assert.equal(await prepay.markPaid("cs_test_1", "pi_1"), "confirmed");
  assert.equal(await prepay.markPaid("cs_test_1", "pi_1"), "already");
  await auto.fireEvent("prepay_paid", id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /^Thanks Jamie! We got your pre-pay of \$10\.00\. You are confirmed for Tuesday, March 3 at 2:00 PM\. Change or cancel here: https:\/\/shop\.test\/book\/manage\//);
});

test("the pre-pay link text goes to a booking that waits for its pre-pay, not the confirmation", async () => {
  await builtins();
  const id = await visit({ status: "pending", source: "online" });
  await db.run("UPDATE appointments SET prepay_amount = 10, prepay_status = 'due', stripe_checkout_url = 'https://pay.test/c/1' WHERE id = ?", [id]);
  await auto.fireEvent("booking_created", id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Hi Jamie! We are holding 2:00 PM on Tuesday, March 3 for you. Pre-pay $10.00 here to confirm: https://pay.test/c/1\n- Tolly");
});

// ── Filters ────────────────────────────────────────────────────────

test("filters pick the visits: barber, service, source, status, first visit", async () => {
  await allOff();
  const fire = async (filters: object, v: Visit) => {
    const routine = await make({ filters });
    const id = await visit(v);
    await auto.fireEvent("booking_created", id);
    const count = (await runsOf(routine.id)).length;
    await call("DELETE", `/api/automations/${routine.id}`);
    return count;
  };
  assert.equal(await fire({ staff_ids: [2] }, { staff: 1 }), 0);
  assert.equal(await fire({ staff_ids: [2] }, { staff: 2 }), 1);
  assert.equal(await fire({ service_ids: [2] }, { service: 1 }), 0);
  assert.equal(await fire({ service_ids: [2] }, { service: 2 }), 1);
  assert.equal(await fire({ sources: ["sms", "chat"] }, { source: "online" }), 0);
  assert.equal(await fire({ sources: ["sms", "chat"] }, { source: "sms" }), 1);
  assert.equal(await fire({ statuses: ["confirmed"] }, { status: "booked" }), 0);
  assert.equal(await fire({ statuses: ["confirmed"] }, { status: "confirmed" }), 1);

  // Sam has an earlier visit by now (client 2 was not used above), Jamie has many.
  await db.run("DELETE FROM appointments");
  assert.equal(await fire({ first_visit: true }, { client: 2, date: TUE }), 1);
  assert.equal(await fire({ first_visit: true }, { client: 2, date: "2026-03-10" }), 0);
  assert.equal(await fire({ first_visit: false }, { client: 2, date: "2026-03-17" }), 1);
  assert.equal(await fire({ first_visit: false }, { client: 1, date: TUE }), 0);

  const bad = await call("POST", "/api/automations", textRoutine({ filters: { colour: "red" } }));
  assert.equal(bad.status, 400);
});

// ── The text helper ────────────────────────────────────────────────

test("a client who opted out gets no text, and the run says why", async () => {
  await allOff();
  const routine = await make();
  const thread = await smsThreads.smsThreadForPhone(JAMIE);
  await db.run("UPDATE chat_threads SET opted_out = 1 WHERE id = ?", [thread!.id]);
  await auto.fireEvent("booking_created", await visit());
  assert.equal(sent.length, 0);
  const runs = await runsOf(routine.id);
  assert.equal(runs[0].status, "skipped");
  assert.equal(runs[0].detail, "The client opted out of texts.");
  // Nothing was added to the thread either.
  assert.equal((await call("GET", `/api/chat/threads/${thread!.id}`)).body.messages.length, 0);
});

test("no mobile number, no provider, and a failed send are recorded", async () => {
  await allOff();
  const routine = await make();
  await db.run("INSERT INTO clients (name, email, phone) VALUES ('No Phone', '', '')");
  await auto.fireEvent("booking_created", await visit({ client: 3 }));
  fail = "the carrier refused it";
  await auto.fireEvent("booking_created", await visit({ client: 1 }));
  sms.setSmsProvider(null);
  await auto.fireEvent("booking_created", await visit({ client: 2 }));
  const runs = await runsOf(routine.id);
  assert.deepEqual(runs.map((r) => [r.status, r.detail]).reverse(), [
    ["skipped", "The client has no mobile number."],
    ["failed", "the carrier refused it"],
    ["skipped", "Texts are not set up."],
  ]);
  assert.equal(sent.length, 0);
});

test("the signature follows the settings", async () => {
  await allOff();
  await make({ action_config: { message: "Hello from {agent_name} at {shop_name}." } });
  await saveSettings({ agent_name: "Remy", shop_name: "Fade Lab" });
  await auto.fireEvent("booking_created", await visit());
  assert.equal(sent[0].body, "Hello from Remy at Fade Lab.\n- Remy");
});

// ── Placeholders and preview ───────────────────────────────────────

test("every placeholder is filled in, and empty ones leave no gap", async () => {
  await allOff();
  await saveSettings({ shop_name: "Fade Lab", address: "12 Main St", access_instructions: "" });
  const message = auto.PLACEHOLDERS.map((p) => `${p}={${p}}`).join("\n");
  const id = await visit();
  const preview = await auto.previewText(message, id);
  assert.ok(preview.ok);
  const text = preview.value.text;
  assert.doesNotMatch(text, /\{[a-z_]+\}/);
  for (const line of [
    "client_first_name=Jamie", "client_name=Jamie Rivera", "date=Tuesday, March 3", "day=Tuesday", "time=2:00 PM", "end_time=2:30 PM",
    "barber=Marcus", "services=Haircut", "price=$35.00", "shop_name=Fade Lab", "shop_address=12 Main St", "agent_name=Tolly",
  ]) assert.ok(text.includes(line), `${line} in ${text}`);
  assert.match(text, /manage_link=https:\/\/shop\.test\/book\/manage\/[\w-]{20,}\n/);
  assert.match(text, /calendar_link=https:\/\/shop\.test\/book\/manage\/[\w-]{20,}\?calendar=1\n/);

  assert.equal(auto.render("See you at {time}. {access_instructions}", { time: "2:00 PM", access_instructions: "" }), "See you at 2:00 PM.");
  assert.equal(auto.render("A\n\n{x}\n\n\nB  C", { x: "" }), "A\n\nB C");
});

test("an unknown placeholder is refused on save", async () => {
  await builtins();
  const bad = await call("POST", "/api/automations", textRoutine({ action_config: { message: "Hi {first_name}, your code is {code}." } }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /We do not know \{first_name\}, \{code\}\. You can use: \{client_first_name\}/);

  const good = await make();
  const changed = await call("PUT", `/api/automations/${good.id}`, { action_config: { message: "Hi {nope}" } });
  assert.equal(changed.status, 400);
  assert.equal((await call("GET", "/api/automations")).body.automations.find((a: any) => a.id === good.id).action_config.message, textRoutine().action_config.message);

  assert.deepEqual(auto.unknownPlaceholders("{time} {Time} {} {client name}"), ["{Time}", "{}", "{client name}"]);
});

test("a preview uses a real visit and sends nothing", async () => {
  await builtins();
  const empty = await call("POST", "/api/automations/preview", { message: "Hi {client_first_name}, {time} with {barber}." });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.sample, true);
  assert.equal(empty.body.text, "Hi Alex, 2:30 PM with Marcus.\n- Tolly");

  const id = await visit({ client: 2, staff: 2, start: "09:30", end: "10:00" });
  const real = await call("POST", "/api/automations/preview", { message: "Hi {client_first_name}, {time} with {barber}." });
  assert.equal(real.body.sample, false);
  assert.equal(real.body.text, "Hi Sam, 9:30 AM with Dre.\n- Tolly");
  assert.equal(real.body.appointment.client_name, "Sam Lee");
  assert.equal((await call("POST", "/api/automations/preview", { message: "{time}", appointment_id: id })).body.text, "9:30 AM\n- Tolly");

  assert.equal((await call("POST", "/api/automations/preview", { message: "Hi {nope}" })).status, 400);
  assert.equal((await call("POST", "/api/automations/preview", { message: "Hi", appointment_id: 999 })).status, 400);

  assert.equal(sent.length, 0);
  assert.equal((await db.query("SELECT id FROM chat_messages")).length, 0);
  assert.equal((await db.query("SELECT id FROM automation_runs")).length, 0);
});

// ── Assistant tasks ────────────────────────────────────────────────

test("an assistant task runs at its time and reports in the owner's chat", async () => {
  await allOff();
  await visit({ date: MON, start: "14:00" });
  const routine = (await call("POST", "/api/automations", {
    name: "Evening summary", trigger: "daily", trigger_config: { time: "18:00", days: [1, 2, 3, 4, 5], scope: "today" },
    action: "agent_task", action_config: { instructions: "Tell me how many visits are on the schedule today." },
  })).body.automation;
  assert.match(routine.summary, /^Every Mon, Tue, Wed, Thu, Fri at 6:00 PM, the assistant does a task\.$/);

  const seen = script([{ tool: "get_schedule", input: { date: MON } }, "One visit today: Jamie at 2:00 PM."]);
  clock(MON, "18:00");
  await auto.tick();
  await auto.tick();
  await auto.automationsIdle();

  assert.equal(seen.calls, 2);
  assert.match(seen.prompts[0], /Tell me how many visits are on the schedule today\./);
  assert.match(seen.prompts[0], /You must not create, change or delete automations in this run\./);
  const chat = await call("GET", "/api/assistant");
  assert.equal(chat.body.messages.length, 1);
  assert.equal(chat.body.messages[0].body, 'Automation "Evening summary": One visit today: Jamie at 2:00 PM.');
  const runs = await runsOf(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(sent.length, 0);
});

test("run now works for assistant tasks only", async () => {
  await allOff();
  const task = (await call("POST", "/api/automations", {
    name: "Check", trigger: "daily", trigger_config: { time: "18:00", days: [1], scope: "today" },
    action: "agent_task", action_config: { instructions: "Say hello." },
  })).body.automation;

  const off = await call("POST", `/api/automations/${task.id}/run`);
  assert.equal(off.status, 400);
  assert.match(off.body.error, /no AI key/);

  script(["Hello."]);
  const started = await call("POST", `/api/automations/${task.id}/run`);
  assert.equal(started.status, 200);
  await auto.automationsIdle();
  const runs = await runsOf(task.id);
  assert.equal(runs[0].id, started.body.run_id);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].detail, "Hello.");

  const text = await make();
  const refused = await call("POST", `/api/automations/${text.id}/run`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Only assistant tasks can run now/);
  assert.equal((await call("POST", "/api/automations/999/run")).status, 404);
});

// ── API ────────────────────────────────────────────────────────────

test("the API makes, changes, lists and deletes automations", async () => {
  await builtins();
  const made = await make({ name: "  My routine  ", trigger: "before_appointment", trigger_config: { minutes: 120 }, filters: { first_visit: true } });
  assert.equal(made.name, "My routine");
  assert.equal(made.enabled, true);
  assert.equal(made.created_by, "staff");
  assert.equal(made.last_run, null);
  assert.equal(made.summary, "2 hours before a visit, text the client. Only for: first visits.");

  const off = await call("PUT", `/api/automations/${made.id}`, { enabled: false });
  assert.equal(off.body.automation.enabled, false);
  assert.deepEqual(off.body.automation.trigger_config, { minutes: 120 });

  // A new "when" needs its own settings.
  assert.equal((await call("PUT", `/api/automations/${made.id}`, { trigger: "daily" })).status, 400);
  const daily = await call("PUT", `/api/automations/${made.id}`, { trigger: "daily", trigger_config: { time: "09:15", days: [6, 6, 0], scope: "today" } });
  assert.deepEqual(daily.body.automation.trigger_config, { time: "09:15", days: [0, 6], scope: "today" });

  for (const bad of [
    { name: "" }, { trigger: "weekly" }, { action: "email" }, { trigger: "daily", trigger_config: { time: "25:00", days: [1], scope: "today" } },
    { trigger: "daily", trigger_config: { time: "08:00", days: [], scope: "today" } }, { action_config: { message: "" } },
    { trigger_config: { minutes: 5 } }, { filters: { statuses: ["done"] } },
  ]) {
    const res = await call("POST", "/api/automations", textRoutine(bad));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(typeof res.body.error, "string");
  }

  const list = await call("GET", "/api/automations");
  assert.equal(list.body.automations.length, 7);
  assert.ok(list.body.placeholders.includes("calendar_link"));
  assert.equal(list.body.texts_ready, true);
  assert.equal(list.body.assistant_ready, false);

  assert.equal((await call("PUT", "/api/automations/999", { enabled: false })).status, 404);
  assert.equal((await call("GET", "/api/automations/999/runs")).status, 404);
  assert.equal((await call("DELETE", `/api/automations/${made.id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/automations/${made.id}`)).status, 404);
});

test("deleting an automation removes its history, and deleting a visit keeps the run", async () => {
  await allOff();
  const routine = await make();
  const id = await visit();
  await auto.fireEvent("booking_created", id);
  await db.run("DELETE FROM appointments WHERE id = ?", [id]);
  const runs = await runsOf(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].reference, null);
  await call("DELETE", `/api/automations/${routine.id}`);
  assert.equal((await db.query("SELECT id FROM automation_runs")).length, 0);
});

test("a visit moved to a nearer time gets no reminder for a moment that already passed", async () => {
  await allOff();
  await make({ trigger: "before_appointment", trigger_config: { minutes: 60 } });
  const id = await visit({ date: MON, start: "16:00", end: "16:30" });
  clock(MON, "14:50");
  // The dashboard moves it to 15:30. The one-hour moment (14:30) is already past.
  const moved = await call("PUT", `/api/appointments/${id}`, { start_time: "15:30" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await auto.tick();
  assert.equal(sent.length, 0);
});

test("a text that needs the pay link is skipped when there is no link", async () => {
  await allOff();
  const routine = await make({ trigger: "booking_created", action_config: { message: "Pay here to confirm: {prepay_link}" }, filters: { statuses: ["pending", "booked"] } });
  const id = await visit({ date: TUE });
  await auto.fireEvent("booking_created", id);
  assert.equal(sent.length, 0);
  const runs = await runsOf(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "skipped");
});
