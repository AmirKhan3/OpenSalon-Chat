import { dbGeneration, get, query, run } from "./db.js";

/**
 * Sample barbershop data + the appointment counter rows.
 *
 * Sample rows go only into empty tables, so a restart never brings back a row
 * the owner deleted. Set SEED_DEMO_DATA=false to skip the sample rows.
 */

type StaffSeed = [id: number, name: string, email: string, title: string, color: string];
type ServiceSeed = [id: number, name: string, description: string, duration: number, price: number, color: string, category: string];
type ClientSeed = [id: number, name: string, email: string, phone: string];

const STAFF: StaffSeed[] = [
  [1, "Marcus", "marcus@example.com", "Owner / Master Barber", "#d97706"],
  [2, "Dre", "dre@example.com", "Barber", "#3b82f6"],
  [3, "Luis", "luis@example.com", "Barber", "#10b981"],
];

const SERVICES: ServiceSeed[] = [
  [1, "Haircut", "Classic cut with clippers and scissors", 30, 35, "#d97706", "Cuts"],
  [2, "Skin Fade", "Fade down to the skin, with line-up", 45, 40, "#3b82f6", "Cuts"],
  [3, "Beard Trim", "Shape and trim, with razor edges", 15, 15, "#10b981", "Beard"],
  [4, "Haircut + Beard", "Haircut and a full beard trim", 45, 45, "#8b5cf6", "Cuts"],
  [5, "Kids Cut", "For ages 12 and under", 30, 25, "#f59e0b", "Cuts"],
  [6, "Hot Towel Shave", "Straight razor shave with hot towel", 30, 30, "#ec4899", "Shave"],
];

const CLIENTS: ClientSeed[] = [
  [1, "Jamal Carter", "jamal@example.com", "+15555550101"],
  [2, "Tony Russo", "tony@example.com", "+15555550102"],
  [3, "Chris Nguyen", "chris@example.com", "+15555550103"],
];

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
    }
    seededGeneration = dbGeneration();
  } catch (err) {
    // Sample data must never fail a request. Try again on the next one.
    console.error("[seed] failed:", err instanceof Error ? err.message : err);
  }
}
