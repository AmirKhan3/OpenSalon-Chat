import { dbGeneration, get, query, run } from "./db.js";
import { ensureDefaultAutomations } from "./automations.js";
import { getSettings } from "./settings.js";

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

let seededGeneration = -1;

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
    }
    await ensureDefaultAutomations();
    seededGeneration = dbGeneration();
  } catch (err) {
    // Sample data must never fail a request. Try again on the next one.
    console.error("[seed] failed:", err instanceof Error ? err.message : err);
  }
}
