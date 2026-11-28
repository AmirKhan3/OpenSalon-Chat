import { dbGeneration, get, query, run } from "./db.js";
import { ensureDefaultAutomations } from "./automations.js";
import { getSettings, type ShopSettings } from "./settings.js";
import { addDays, daysBetween, minutesToTime, shopNow, timeToMinutes, weekdayOf, type ShopNow } from "./shoptime.js";

/**
 * Sample barbershop data + the appointment counter rows.
 *
 * Sample rows go only into empty tables, so a restart never brings back a row
 * the owner deleted. Set SEED_DEMO_DATA=false to skip the sample rows.
 */

type StaffSeed = [id: number, name: string, email: string, title: string, color: string];
type ServiceSeed = [id: number, name: string, description: string, duration: number, price: number, color: string, category: string];
type ClientSeed = [id: number, name: string, email: string, phone: string];

// One sign-in is one barber for now, so the sample shop has one.
const STAFF: StaffSeed[] = [
  [1, "Marcus", "marcus@example.com", "Owner / Master Barber", "#3a4a5c"],
];

const SERVICES: ServiceSeed[] = [
  [1, "Haircut", "Classic cut with clippers and scissors", 30, 35, "#3a4a5c", "Cuts"],
  [2, "Skin Fade", "Fade down to the skin, with line-up", 45, 40, "#23508f", "Cuts"],
  [3, "Beard Trim", "Shape and trim, with razor edges", 15, 15, "#1e6650", "Beard"],
  [4, "Haircut + Beard", "Haircut and a full beard trim", 45, 45, "#6d2e46", "Cuts"],
  [5, "Kids Cut", "For ages 12 and under", 30, 25, "#c4912f", "Cuts"],
  [6, "Hot Towel Shave", "Straight razor shave with hot towel", 30, 30, "#b3261e", "Shave"],
];

const CLIENTS: ClientSeed[] = [
  [1, "Jamal Carter", "jamal@example.com", "+15555550101"],
  [2, "Tony Russo", "tony@example.com", "+15555550102"],
  [3, "Chris Nguyen", "chris@example.com", "+15555550103"],
];

type ChatLine = [minutesAgo: number, sender: "client" | "agent" | "staff" | "system" | "note", body: string];
interface ChatSeed { clientId: number; name: string; mode: "agent" | "human"; needsYou: boolean; unread: number; lines: ChatLine[] }

/**
 * Example chats for trying the inbox. {name} becomes the assistant's name.
 * They are web chats with no phone number, so a reply never sends a text.
 */
const CHATS: ChatSeed[] = [
  // The assistant answered everything. Nothing for the barber to do.
  {
    clientId: 1, name: "Jamal Carter", mode: "agent", needsYou: false, unread: 0,
    lines: [
      [190, "client", "Hey, how much is a skin fade?"],
      [189, "agent", "A Skin Fade is $40 and takes 45 minutes. Want me to find you a time? - {name}"],
      [185, "client", "Not yet. Do you do kids cuts too?"],
      [184, "agent", "Yes. A Kids Cut is $25, for ages 12 and under. - {name}"],
      [183, "client", "Cool, thanks"],
      [183, "agent", "Any time! - {name}"],
    ],
  },
  // The barber stepped in earlier and still has this chat.
  {
    clientId: 3, name: "Chris Nguyen", mode: "human", needsYou: false, unread: 0,
    lines: [
      [95, "client", "Can I bring my own clippers guard? I have a sensitive scalp."],
      [94, "agent", "Good question. I will check with your barber. - {name}"],
      [94, "note", "A barber took over. The assistant stopped."],
      [80, "staff", "Yes, bring it. I can also use a guard made for sensitive skin."],
      [78, "client", "Perfect, see you soon"],
      [77, "note", "Sensitive scalp. Use the soft guard."],
    ],
  },
  // The assistant could not help, so it gave the chat to the barber.
  {
    clientId: 2, name: "Tony Russo", mode: "human", needsYou: true, unread: 2,
    lines: [
      [14, "client", "Hi, my dad can't leave the house right now. Could you come cut his hair at home?"],
      [13, "agent", "I can't set that up myself, so I am passing this to your barber. - {name}"],
      [13, "note", "The client asks for a home visit. That is not a service the assistant can book."],
      [13, "system", "A barber will reply soon."],
      [6, "client", "Any day next week works for us"],
    ],
  },
];

/** "YYYY-MM-DD HH:MM:SS" in UTC, like utc_now(). */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Add the example chats, only while the inbox has no client chats at all. */
async function seedChats(): Promise<void> {
  const existing = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM chat_threads WHERE kind = 'client'");
  if ((existing?.count ?? 0) > 0) return;
  // Only one caller may add them, even when two first requests arrive together.
  const claim = await query<{ key: string }>(
    "INSERT INTO _meta (key, value) VALUES ('demo_chats_seeded', '1') ON CONFLICT DO NOTHING RETURNING key",
  );
  if (claim.length === 0) return;
  const name =(await getSettings()).agent_name;
  for (const chat of CHATS) {
    // Link the chat to the sample client only if that client is still the same person.
    const client = await get<{ id: number }>("SELECT id FROM clients WHERE id = ? AND name = ?", [chat.clientId, chat.name]);
    const last = Math.min(...chat.lines.map((line) => line[0]));
    const created = await query<{ id: number }>(
      `INSERT INTO chat_threads (kind, channel, client_id, display_name, mode, needs_attention, staff_unread, last_message_at, created_at, updated_at)
       VALUES ('client', 'web', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [client?.id ?? null, chat.name, chat.mode, chat.needsYou ? 1 : 0, chat.unread, minutesAgo(last), minutesAgo(chat.lines[0][0]), minutesAgo(last)],
    );
    for (const [ago, sender, body] of chat.lines) {
      await run(
        "INSERT INTO chat_messages (thread_id, sender, body, created_at) VALUES (?, ?, ?, ?)",
        [created[0].id, sender, body.replaceAll("{name}", name), minutesAgo(ago)],
      );
    }
  }
}

// ── A busy shop, for demos ──────────────────────────────────────────────────
// Sample regulars, six weeks of past visits with payments, a full day today and
// bookings for the days ahead. Only for a test copy of the app.

const BUSY_CLIENTS = [
  "Andre Wallace", "Darius Coleman", "Miguel Santos", "Kevin O'Brien", "Malik Thompson", "Sam Patel",
  "Luis Ortega", "Jordan Brooks", "Terrence Hill", "Omar Haddad", "Nate Fischer", "Isaiah Reed",
  "Victor Chen", "Rashad Greene", "Eli Morgan", "Paulo Silva", "Dwayne Foster", "Hassan Ali",
  "Brandon Kim", "Curtis Bell", "Mateo Rivera", "Xavier Price", "Ben Kowalski", "Tyrone Banks",
  "Leo Marino", "Aiden Shaw", "Jerome Ellis", "Rafael Dominguez", "Marcus Lee", "Devon Parker",
  "Noah Stein", "Calvin Ward", "Emeka Obi", "Ryan Gallagher", "Trey Simmons", "Anthony Vega",
] as const;

/** The marker that lets the seed run once. */
const BUSY_KEY = "demo_busy_seeded";
const BUSY_DAYS_BACK = 42;
const BUSY_DAYS_AHEAD = 10;
const LUNCH = { start: 12 * 60 + 30, end: 13 * 60 };

export interface BusyService { id: number; price: number; duration: number }
export interface BusyVisit {
  date: string; start: number; end: number; service: BusyService; client: number;
  status: "completed" | "no_show" | "cancelled" | "booked" | "confirmed";
  method: string; tip: number;
}

/** A small repeatable random source, so the same day always gets the same plan. */
function randomFrom(seed: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The visits for one day. `busy` holds the minutes already taken, and new
 * visits never overlap them, the lunch break, or each other. `clients` is how
 * many clients there are to pick from; `client` is an index into that list.
 */
export function planBusyDay(
  date: string, hours: ShopSettings["hours"][number], now: ShopNow, services: BusyService[], clients: number,
  busy: { start: number; end: number }[] = [],
): BusyVisit[] {
  if (hours.closed || services.length === 0 || clients === 0) return [];
  const offset = date < now.date ? -1 : date > now.date ? 1 : 0;
  const daysOut = Math.max(0, daysBetween(now.date, date) || 0);
  // Past days and today are nearly full. Later days fill up as they get near.
  const fill = offset <= 0 ? 0.9 : Math.max(0.35, 0.85 - daysOut * 0.06);
  const rand = randomFrom(date);
  const taken = [...busy, LUNCH];
  const seen = new Set<number>();
  const visits: BusyVisit[] = [];
  const close = timeToMinutes(hours.close);
  let cursor = Math.ceil(timeToMinutes(hours.open) / 15) * 15;
  while (cursor < close) {
    const service = services[Math.floor(rand() * services.length)];
    const roll = rand();
    const end = cursor + service.duration;
    if (end > close) { cursor += 15; continue; }
    const clash = taken.find((t) => cursor < t.end && end > t.start);
    if (clash) { cursor = Math.max(cursor + 15, Math.ceil(clash.end / 15) * 15); continue; }
    if (roll >= fill) { cursor += 15; continue; }
    // Regulars come more often: low numbers are picked more.
    let client = Math.floor(rand() * rand() * clients);
    for (let tries = 0; seen.has(client) && tries < clients; tries++) client = (client + 1) % clients;
    if (seen.has(client)) break;
    seen.add(client);
    const fate = rand();
    const past = offset < 0 || (offset === 0 && end <= now.minutes);
    const status = past
      ? (offset < 0 && fate < 0.04 ? "no_show" : offset < 0 && fate < 0.08 ? "cancelled" : "completed")
      : (fate < 0.4 ? "confirmed" : "booked");
    const pay = rand();
    const method = pay < 0.55 ? "card_in_person" : pay < 0.85 ? "cash" : pay < 0.95 ? "card_online" : "other";
    const tipRoll = rand();
    const tip = tipRoll < 0.2 ? 0 : Math.max(2, Math.round(service.price * (0.1 + tipRoll * 0.15)));
    visits.push({ date, start: cursor, end, service, client, status, method, tip });
    // A cancelled visit frees the chair, but the demo keeps the gap.
    cursor = end;
  }
  return visits;
}

/** Insert many rows in a few statements. Returns the rows the statement gives back. */
async function insertMany<T>(head: string, width: number, rows: unknown[][], tail = ""): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    const values = part.map(() => `(${Array(width).fill("?").join(", ")})`).join(", ");
    out.push(...await query<T>(`${head} VALUES ${values}${tail}`, part.flat()));
  }
  return out;
}

export async function seedBusyShop(): Promise<void> {
  const claimed = await query<{ key: string }>(
    "INSERT INTO _meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING RETURNING key", [BUSY_KEY]);
  if (claimed.length === 0) return;
  // Booking numbers written by this run. A run that fails takes them out again.
  let numbers: string[] = [];
  let done = false;
  try {
    const barber = await get<{ id: number }>("SELECT id FROM staff ORDER BY id LIMIT 1");
    const services = (await query<{ id: number; price: number; duration: number }>(
      "SELECT id, price, duration FROM services WHERE active = 1 AND duration > 0 ORDER BY id LIMIT 12"))
      .map((s) => ({ id: s.id, price: Number(s.price), duration: Number(s.duration) }));
    if (!barber || services.length === 0) return;

    // Sample clients. A client who is already there (same number) is used as is.
    const wanted = BUSY_CLIENTS.map((name, i) => ({
      name, phone: `+1555555${String(200 + i).padStart(4, "0")}`,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
    }));
    const have = await query<{ id: number; phone: string }>(
      `SELECT id, phone FROM clients WHERE phone IN (${wanted.map(() => "?").join(", ")}) ORDER BY id`, wanted.map((w) => w.phone));
    const idByPhone = new Map(have.map((c) => [c.phone, c.id]));
    const settings = await getSettings();
    const now = shopNow(settings.timezone);
    const missing = wanted.filter((w) => !idByPhone.has(w.phone));
    const firstSeen = `${addDays(now.date, -BUSY_DAYS_BACK - 30)} 15:00:00`;
    const added = await insertMany<{ id: number; phone: string }>(
      "INSERT INTO clients (name, email, phone, created_at, updated_at)", 5,
      missing.map((w) => [w.name, w.email, w.phone, firstSeen, firstSeen]), " RETURNING id, phone");
    for (const c of added) idByPhone.set(c.phone, c.id);
    const clientIds = wanted.map((w) => idByPhone.get(w.phone)!);

    // Plan every day around what is already on the calendar.
    const from = addDays(now.date, -BUSY_DAYS_BACK);
    const to = addDays(now.date, BUSY_DAYS_AHEAD);
    const taken = await query<{ scheduled_date: string; start_time: string; end_time: string }>(
      `SELECT scheduled_date, start_time, end_time FROM appointments
       WHERE staff_id = ? AND status != 'cancelled' AND scheduled_date >= ? AND scheduled_date <= ?
       UNION ALL SELECT blocked_date, start_time, end_time FROM blocked_slots
       WHERE staff_id = ? AND blocked_date >= ? AND blocked_date <= ?`,
      [barber.id, from, to, barber.id, from, to]);
    const visits: BusyVisit[] = [];
    for (let day = -BUSY_DAYS_BACK; day <= BUSY_DAYS_AHEAD; day++) {
      const date = addDays(now.date, day);
      const busy = taken.filter((t) => t.scheduled_date === date)
        .map((t) => ({ start: timeToMinutes(t.start_time), end: timeToMinutes(t.end_time) }));
      visits.push(...planBusyDay(date, settings.hours[weekdayOf(date)], now, services, clientIds.length, busy));
    }
    if (visits.length === 0) return;

    // Take a block of booking numbers in one step, so no number is used twice.
    const prefix = (await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'appointment_prefix'"))?.value || "APT";
    const counter = await query<{ value: string }>(
      `INSERT INTO _meta (key, value) VALUES ('appointment_counter', ?)
       ON CONFLICT (key) DO UPDATE SET value = (COALESCE(NULLIF(regexp_replace(_meta.value, '\\D', '', 'g'), ''), '0')::bigint + ?)::text
       RETURNING value`, [String(visits.length), visits.length]);
    const firstNumber = Number(counter[0].value) - visits.length + 1;
    numbers = visits.map((_, i) => `${prefix}-${firstNumber + i}`);

    const saved = await insertMany<{ id: number; identifier: string }>(
      "INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, created_at, updated_at)", 10,
      visits.map((v, i) => {
        // Booked a few days before the visit, never in the future.
        const booked = `${addDays(v.date, -3) < now.date ? addDays(v.date, -3) : addDays(now.date, -1)} 16:00:00`;
        return [numbers[i], clientIds[v.client], barber.id, v.status, v.date,
          minutesToTime(v.start), minutesToTime(v.end), v.service.price, booked, booked];
      }), " RETURNING id, identifier");
    const idByNumber = new Map(saved.map((a) => [a.identifier, a.id]));
    const idOf = (i: number) => idByNumber.get(numbers[i])!;

    await insertMany("INSERT INTO appointment_services (appointment_id, service_id, price, duration)", 4,
      visits.map((v, i) => [idOf(i), v.service.id, v.service.price, v.service.duration]));
    const paid = visits.map((v, i) => ({ v, i })).filter(({ v }) => v.status === "completed");
    await insertMany("INSERT INTO payments (appointment_id, client_id, staff_id, kind, method, amount, tip, note, paid_on, created_at)", 10,
      paid.map(({ v, i }) => [idOf(i), clientIds[v.client], barber.id, "payment", v.method, v.service.price, v.tip, "", v.date,
        `${v.date} ${minutesToTime(v.end)}:00`]));
    done = true;
  } finally {
    // Nothing added (no barber or service yet) or a failed run: undo it and let a later start try again.
    if (!done) await undoBusyShop(numbers).catch((err) => console.error("[seed] could not undo the busy shop:", err instanceof Error ? err.message : err));
  }
}

/** Take out the bookings of a run that did not finish, with their services and payments, and free the claim. */
async function undoBusyShop(numbers: string[]): Promise<void> {
  for (let i = 0; i < numbers.length; i += 200) {
    const part = numbers.slice(i, i + 200);
    const marks = part.map(() => "?").join(", ");
    await run(`DELETE FROM payments WHERE appointment_id IN (SELECT id FROM appointments WHERE identifier IN (${marks}))`, part);
    await run(`DELETE FROM appointments WHERE identifier IN (${marks})`, part);
  }
  await run("DELETE FROM _meta WHERE key = ?", [BUSY_KEY]);
}

let seededGeneration = -1;
/** The database on which the busy shop failed. One try per start, so a broken seed does not run on every request. */
let busyFailedGeneration = -1;

/** Insert `rows` into `table` only while it is still empty. */
async function seedIfEmpty(table: string, columns: string[], rows: readonly unknown[][]): Promise<void> {
  const existing = await get<{ count: number }>(`SELECT COUNT(*)::int as count FROM ${table}`);
  if ((existing?.count ?? 0) > 0) return;
  const placeholders = rows.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
  await run(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    rows.flat(),
  );
  // The rows carry their own ids. Move the id sequence past them.
  await query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`);
}

/**
 * Idempotent. The _meta rows use ON CONFLICT DO NOTHING, so an existing
 * counter is never reset.
 */
export async function ensureSeeded(): Promise<void> {
  if (seededGeneration === dbGeneration()) return;
  try {
    await run("INSERT INTO _meta (key, value) VALUES ('appointment_counter', '0') ON CONFLICT DO NOTHING");
    await run("INSERT INTO _meta (key, value) VALUES ('appointment_prefix', 'APT') ON CONFLICT DO NOTHING");
    if (process.env.SEED_DEMO_DATA !== "false") {
      await seedIfEmpty("staff", ["id", "name", "email", "title", "color"], STAFF);
      await seedIfEmpty("services", ["id", "name", "description", "duration", "price", "color", "category"], SERVICES);
      await seedIfEmpty("clients", ["id", "name", "email", "phone"], CLIENTS);
      // Example chats are for trying the app only. They need their own switch.
      if (process.env.SEED_DEMO_CHATS === "true") await seedChats();
      // A busy shop is for demos only. It has its own switch too.
      if (process.env.SEED_DEMO_BUSY === "true" && busyFailedGeneration !== dbGeneration()) {
        await seedBusyShop().catch((err) => {
          busyFailedGeneration = dbGeneration();
          console.error("[seed] busy shop failed:", err instanceof Error ? err.message : err);
        });
      }
    }
    await ensureDefaultAutomations();
    seededGeneration = dbGeneration();
  } catch (err) {
    // Sample data must never fail a request. Try again on the next one.
    console.error("[seed] failed:", err instanceof Error ? err.message : err);
  }
}
