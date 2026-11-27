import { randomBytes } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { nextIdentifier } from "./booking.js";
import { toMinutes } from "./scheduling.js";
import { getSettings } from "./settings.js";
import { candidateStarts, isFree, loadDay, openSlots, pickBarber } from "./availability.js";
import { isValidDate, minutesToTime, shopNow, TIME, timeToMinutes } from "./shoptime.js";

/**
 * The public API for clients: /api/public/*. No login.
 *
 * PRIVACY: nothing here may return another client's name, phone, notes, or
 * bookings. Availability shows only times and barber ids. A booking is shown
 * only to someone who holds its secret token, and even then without the
 * client's own contact details.
 */

const ErrorSchema = z.object({ error: z.string() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });

const NOT_FOUND = "We could not find that booking.";

// ── Lookups ────────────────────────────────────────────────────────

interface ServiceRow { id: number; name: string; description: string; duration: number; price: number; category: string }
interface BarberRow { id: number; name: string; title: string; color: string }

function activeServices(): Promise<ServiceRow[]> {
  return query<ServiceRow>(
    "SELECT id, name, COALESCE(description, '') AS description, duration, price, COALESCE(category, '') AS category FROM services WHERE active = 1 ORDER BY category, name",
  );
}

function activeBarbers(): Promise<BarberRow[]> {
  return query<BarberRow>("SELECT id, name, COALESCE(title, '') AS title, color FROM staff WHERE active = 1 ORDER BY name");
}

/** The chosen services, or null when any id is unknown or not offered. */
async function pickServices(ids: number[]): Promise<ServiceRow[] | null> {
  const all = await activeServices();
  const picked = ids.map((id) => all.find((s) => s.id === id));
  return picked.every(Boolean) ? (picked as ServiceRow[]) : null;
}

/** "1,2,3" -> [1,2,3]. Null when the list is empty, too long, repeated, or not numbers. */
function parseIds(raw: string): number[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 10 || !parts.every((p) => /^\d{1,9}$/.test(p))) return null;
  const ids = parts.map(Number);
  return new Set(ids).size === ids.length ? ids : null;
}

// ── Phone, email, client ───────────────────────────────────────────

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** "+15555550101" for a US number, else "+<digits>". */
export function normalizePhone(phone: string): string {
  const digits = phoneDigits(phone);
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Find the client by the last 10 digits of the phone, or make a new one.
 *
 * Anyone can call the public API, so a booking never changes a saved client:
 * not the name, the phone, or the email. It also never matches by email alone.
 * Otherwise a stranger could point a client's texts or emails at themselves.
 */
async function findOrCreateClient(name: string, phone: string, email: string): Promise<{ id: number; known: boolean; savedName: string }> {
  const last10 = phoneDigits(phone).slice(-10);
  const byPhone = await get<{ id: number; name: string }>(
    "SELECT id, name FROM clients WHERE RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ? ORDER BY id LIMIT 1",
    [last10],
  );
  if (byPhone) return { id: byPhone.id, known: true, savedName: byPhone.name };
  const created = await run("INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)", [name, normalizePhone(phone), email]);
  return { id: Number(created.lastInsertRowid), known: false, savedName: name };
}

// ── What a client may see of a booking ─────────────────────────────

const BookingSchema = z.object({
  reference: z.string(),
  status: z.string(),
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  barber: z.string(),
  services: z.array(z.object({ name: z.string(), duration: z.number(), price: z.number() })),
  total_price: z.number(),
  can_cancel: z.boolean(),
}).openapi("PublicBooking");

const ShopInfoSchema = z.object({ name: z.string(), address: z.string(), timezone: z.string() });
const BookingResponse = z.object({ booking: BookingSchema, shop: ShopInfoSchema, manage_path: z.string() });

interface BookingRow {
  id: number; identifier: string; status: string; scheduled_date: string;
  start_time: string; end_time: string; total_price: number; barber: string | null;
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

function bookingByToken(token: string): Promise<BookingRow | null> {
  if (!TOKEN.test(token)) return Promise.resolve(null);
  return get<BookingRow>(
    `SELECT a.id, a.identifier, a.status, a.scheduled_date, a.start_time, a.end_time, a.total_price, s.name AS barber
     FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.public_token = ?`,
    [token],
  ).then((row) => row ?? null);
}

/** A client can cancel a booking that is still ahead and not finished. */
function canCancel(row: BookingRow, now: { date: string; minutes: number }): boolean {
  if (!["booked", "confirmed", "pending"].includes(row.status)) return false;
  if (row.scheduled_date !== now.date) return row.scheduled_date > now.date;
  return (toMinutes(row.start_time) ?? 0) > now.minutes;
}

async function bookingView(row: BookingRow, token: string) {
  const settings = await getSettings();
  const services = await query<{ name: string; duration: number; price: number }>(
    `SELECT s.name, aps.duration, aps.price FROM appointment_services aps
     JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id = ? ORDER BY aps.id`,
    [row.id],
  );
  return {
    booking: {
      reference: row.identifier,
      status: row.status,
      date: row.scheduled_date,
      start_time: row.start_time,
      end_time: row.end_time,
      barber: row.barber ?? "",
      services,
      total_price: row.total_price,
      can_cancel: canCancel(row, shopNow(settings.timezone)),
    },
    shop: { name: settings.shop_name, address: settings.address, timezone: settings.timezone },
    manage_path: `/book/manage/${token}`,
  };
}

// ── Routes ─────────────────────────────────────────────────────────

const shopRoute = createRoute({
  method: "get", path: "/api/public/shop", tags: ["Public"], summary: "Shop details for the booking page",
  responses: {
    200: json(z.object({
      shop: z.object({
        name: z.string(), address: z.string(), timezone: z.string(),
        hours: z.array(z.object({ closed: z.boolean(), open: z.string(), close: z.string() })),
        booking_window_days: z.number(),
      }),
      today: z.string(),
      services: z.array(z.object({
        id: z.number(), name: z.string(), description: z.string(), duration: z.number(),
        price: z.number(), category: z.string(), prepay_amount: z.number(),
      })),
      barbers: z.array(z.object({ id: z.number(), name: z.string(), title: z.string(), color: z.string() })),
    }), "Shop details"),
  },
});

const availabilityRoute = createRoute({
  method: "get", path: "/api/public/availability", tags: ["Public"], summary: "Open start times on a date",
  request: {
    query: z.object({
      date: z.string(),
      service_ids: z.string().openapi({ description: "Service ids, separated by commas" }),
      staff_id: z.string().optional().openapi({ description: "A barber id. Leave out for any barber." }),
    }),
  },
  responses: {
    200: json(z.object({
      date: z.string(), duration: z.number(),
      slots: z.array(z.object({ time: z.string(), staff_ids: z.array(z.number()) })),
    }), "Open times"),
    400: json(ErrorSchema, "Bad request"),
  },
});

const BookingBody = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  phone: z.string().trim().max(30).refine((p) => /^[\d\s().+-]*$/.test(p) && phoneDigits(p).length >= 10 && phoneDigits(p).length <= 15, {
    message: "Enter a phone number with the area code.",
  }),
  email: z.string().trim().max(200).refine((e) => e === "" || EMAIL.test(e), { message: "Enter a valid email, or leave it empty." }).optional(),
  date: z.string().refine(isValidDate, { message: "Pick a date." }),
  time: z.string().regex(TIME, "Pick a time."),
  service_ids: z.array(z.number().int().positive().max(999_999_999)).min(1, "Pick a service.").max(10)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Pick each service once." }),
  staff_id: z.number().int().positive().max(999_999_999).nullable().optional(),
});

const createBookingRoute = createRoute({
  method: "post", path: "/api/public/bookings", tags: ["Public"], summary: "Book a visit",
  request: { body: { content: { "application/json": { schema: BookingBody } }, required: true } },
  responses: {
    201: json(BookingResponse, "Booked"),
    400: json(ErrorSchema, "Bad request"),
    409: json(ErrorSchema, "The time is taken"),
  },
});

const TokenParam = z.object({ token: z.string().max(100) });

const getBookingRoute = createRoute({
  method: "get", path: "/api/public/bookings/{token}", tags: ["Public"], summary: "A booking, by its secret link",
  request: { params: TokenParam },
  responses: { 200: json(BookingResponse, "The booking"), 404: json(ErrorSchema, "Not found") },
});

const cancelBookingRoute = createRoute({
  method: "post", path: "/api/public/bookings/{token}/cancel", tags: ["Public"], summary: "Cancel a booking",
  request: { params: TokenParam },
  responses: {
    200: json(BookingResponse, "Cancelled"),
    404: json(ErrorSchema, "Not found"),
    409: json(ErrorSchema, "Too late to cancel"),
  },
});

const TAKEN = "That time was just taken. Please pick another time.";

export function registerPublicRoutes(app: OpenAPIHono): void {
  app.openapi(shopRoute, async (c) => {
    const settings = await getSettings();
    const services = await activeServices();
    c.header("Cache-Control", "no-store");
    return c.json({
      shop: {
        name: settings.shop_name, address: settings.address, timezone: settings.timezone,
        hours: settings.hours, booking_window_days: settings.booking_window_days,
      },
      today: shopNow(settings.timezone).date,
      // Pre-pay arrives with Stripe. Until then nothing is due at booking.
      services: services.map((s) => ({ ...s, prepay_amount: 0 })),
      barbers: await activeBarbers(),
    }, 200);
  });

  app.openapi(availabilityRoute, async (c) => {
    const q = c.req.valid("query");
    if (!isValidDate(q.date)) return c.json({ error: "Pick a date." }, 400);
    const ids = parseIds(q.service_ids);
    const services = ids ? await pickServices(ids) : null;
    if (!services) return c.json({ error: "Pick a service from the list." }, 400);

    const barbers = await activeBarbers();
    let staffIds = barbers.map((b) => b.id);
    if (q.staff_id !== undefined && q.staff_id !== "") {
      const id = /^\d{1,9}$/.test(q.staff_id) ? Number(q.staff_id) : NaN;
      if (!staffIds.includes(id)) return c.json({ error: "Pick a barber from the list." }, 400);
      staffIds = [id];
    }

    const settings = await getSettings();
    const duration = services.reduce((sum, s) => sum + s.duration, 0);
    const slots = await openSlots(settings, q.date, duration, staffIds, shopNow(settings.timezone));
    c.header("Cache-Control", "no-store");
    return c.json({ date: q.date, duration, slots }, 200);
  });

  app.openapi(createBookingRoute, async (c) => {
    const body = c.req.valid("json");
    const services = await pickServices(body.service_ids);
    if (!services) return c.json({ error: "Pick a service from the list." }, 400);

    const barberIds = (await activeBarbers()).map((b) => b.id);
    if (body.staff_id != null && !barberIds.includes(body.staff_id)) {
      return c.json({ error: "Pick a barber from the list." }, 400);
    }
    if (barberIds.length === 0) return c.json({ error: "Online booking is not open yet. Please contact the shop." }, 400);

    const settings = await getSettings();
    const now = shopNow(settings.timezone);
    const duration = services.reduce((sum, s) => sum + s.duration, 0);
    const price = services.reduce((sum, s) => sum + s.price, 0);
    const start = timeToMinutes(body.time);
    const end = start + duration;

    // Shop rules first: hours, slot step, minimum notice, booking window.
    if (!candidateStarts(settings, body.date, duration, now).includes(start)) {
      return c.json({ error: "That time is not open for booking. Please pick another time." }, 400);
    }

    const load = await loadDay(body.date);
    const wanted = body.staff_id != null ? [body.staff_id] : barberIds;
    const staffId = pickBarber(load, wanted.filter((id) => isFree(load, id, start, end)));
    if (staffId === null) return c.json({ error: TAKEN }, 409);

    const client = await findOrCreateClient(body.name, body.phone, body.email ?? "");
    const clientId = client.id;
    const token = randomBytes(24).toString("base64url");
    const startTime = minutesToTime(start);
    const endTime = minutesToTime(end);
    const created = await run(
      `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, source, public_token)
       VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, 'online', ?)`,
      [await nextIdentifier(), clientId, staffId, body.date, startTime, endTime, price, token],
    );
    const id = Number(created.lastInsertRowid);

    // Double-booking guard. If an earlier booking overlaps (another request won
    // the race, maybe on another server), take this one back.
    const others = await query<{ start_time: string; end_time: string }>(
      "SELECT start_time, end_time FROM appointments WHERE staff_id = ? AND scheduled_date = ? AND status != 'cancelled' AND id < ?",
      [staffId, body.date, id],
    );
    const clash = others.some((o) => {
      const s = toMinutes(o.start_time);
      const e = toMinutes(o.end_time);
      return s !== null && e !== null && start < e && s < end;
    });
    if (clash) {
      await run("DELETE FROM appointments WHERE id = ?", [id]);
      return c.json({ error: TAKEN }, 409);
    }

    for (const s of services) {
      await run("INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, ?, ?, ?)", [id, s.id, s.price, s.duration]);
    }
    await run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [id, "Booked online by the client."]);
    if (client.known && client.savedName.trim().toLowerCase() !== body.name.toLowerCase()) {
      // Staff-only note. The phone matched a saved client, but the name is different.
      await run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [id, `Name given online: ${body.name}. The phone number matches ${client.savedName}.`]);
    }

    const row = await bookingByToken(token);
    return c.json(await bookingView(row!, token), 201);
  });

  app.openapi(getBookingRoute, async (c) => {
    const { token } = c.req.valid("param");
    const row = await bookingByToken(token);
    if (!row) return c.json({ error: NOT_FOUND }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(await bookingView(row, token), 200);
  });

  app.openapi(cancelBookingRoute, async (c) => {
    const { token } = c.req.valid("param");
    const row = await bookingByToken(token);
    if (!row) return c.json({ error: NOT_FOUND }, 404);
    if (row.status !== "cancelled") {
      const settings = await getSettings();
      if (!canCancel(row, shopNow(settings.timezone))) {
        return c.json({ error: "This booking can no longer be cancelled online. Please contact the shop." }, 409);
      }
      await run("UPDATE appointments SET status = 'cancelled', updated_at = utc_now() WHERE id = ?", [row.id]);
      await run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [row.id, "Cancelled online by the client."]);
    }
    return c.json(await bookingView((await bookingByToken(token))!, token), 200);
  });
}
