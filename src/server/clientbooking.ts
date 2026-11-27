import { randomBytes } from "node:crypto";
import { get, query, run } from "./db.js";
import { nextIdentifier } from "./booking.js";
import { toMinutes } from "./scheduling.js";
import { getSettings } from "./settings.js";
import { candidateStarts, isFree, loadDay, pickBarber } from "./availability.js";
import { minutesToTime, shopNow, timeToMinutes, utcStamp } from "./shoptime.js";
import { emitBookingEvent } from "./events.js";
import { holdEnd, prepayFor, releaseExpiredHolds, settlePrepayOnCancel, startCheckout } from "./prepay.js";

/**
 * What a client can do with bookings: book, move, cancel, list their own.
 * Used by the booking page (public.ts) and by Tolly's tools (agent.ts).
 *
 * The functions that write (createBooking, moveBooking, cancelBooking) check
 * for overlaps and then save. Call them inside the write queue (oneAtATime),
 * or from a route that the queue already covers. Never both: the queue is not
 * reentrant.
 */

// ── Services and barbers ───────────────────────────────────────────

export interface ServiceRow { id: number; name: string; description: string; duration: number; price: number; category: string }
export interface BarberRow { id: number; name: string; title: string; color: string }

export function activeServices(): Promise<ServiceRow[]> {
  return query<ServiceRow>(
    "SELECT id, name, COALESCE(description, '') AS description, duration, price, COALESCE(category, '') AS category FROM services WHERE active = 1 ORDER BY category, name",
  );
}

export function activeBarbers(): Promise<BarberRow[]> {
  return query<BarberRow>("SELECT id, name, COALESCE(title, '') AS title, color FROM staff WHERE active = 1 ORDER BY name");
}

/** The chosen services, or null when any id is unknown or not offered. */
export async function pickServices(ids: number[]): Promise<ServiceRow[] | null> {
  const all = await activeServices();
  const picked = ids.map((id) => all.find((s) => s.id === id));
  return picked.every(Boolean) ? (picked as ServiceRow[]) : null;
}

// ── Phone, client ──────────────────────────────────────────────────

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** "+15555550101" for a US number, else "+<digits>". */
export function normalizePhone(phone: string): string {
  const digits = phoneDigits(phone);
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** True for a phone number with the area code: 10 to 15 digits and the usual signs. */
export function isPhone(phone: string): boolean {
  const digits = phoneDigits(phone);
  return /^[\d\s().+-]*$/.test(phone) && digits.length >= 10 && digits.length <= 15;
}

/** SQL: the last 10 digits of a phone column. */
const last10Of = (column: string): string => `RIGHT(regexp_replace(COALESCE(${column}, ''), '\\D', '', 'g'), 10)`;

/** The saved client with this phone number (last 10 digits), if any. */
export async function clientByPhone(phone: string): Promise<{ id: number; name: string } | null> {
  const last10 = phoneDigits(phone).slice(-10);
  if (last10.length < 10) return null;
  const row = await get<{ id: number; name: string }>(
    `SELECT id, name FROM clients WHERE ${last10Of("phone")} = ? ORDER BY id LIMIT 1`, [last10],
  );
  return row ?? null;
}

/**
 * Find the client by the last 10 digits of the phone, or make a new one.
 *
 * Anyone can call the public API, so a booking never changes a saved client:
 * not the name, the phone, or the email. It also never matches by email alone.
 * Otherwise a stranger could point a client's texts or emails at themselves.
 */
async function findOrCreateClient(name: string, phone: string, email: string): Promise<{ id: number; known: boolean; savedName: string }> {
  const byPhone = await clientByPhone(phone);
  if (byPhone) return { id: byPhone.id, known: true, savedName: byPhone.name };
  const created = await run("INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)", [name, normalizePhone(phone), email]);
  return { id: Number(created.lastInsertRowid), known: false, savedName: name };
}

// ── Booking rows ───────────────────────────────────────────────────

export interface BookingRow {
  id: number; identifier: string; status: string; scheduled_date: string;
  start_time: string; end_time: string; total_price: number; barber: string | null; staff_id: number | null;
  prepay_amount: number; prepay_status: string; hold_expires_at: string | null;
  stripe_session_id: string | null; stripe_checkout_url: string | null; stripe_payment_intent: string | null;
  public_token: string | null;
}

const BOOKING_COLUMNS = `a.id, a.identifier, a.status, a.scheduled_date, a.start_time, a.end_time, a.total_price, s.name AS barber, a.staff_id,
  a.prepay_amount, a.prepay_status, a.hold_expires_at, a.stripe_session_id, a.stripe_checkout_url, a.stripe_payment_intent, a.public_token`;

export const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function bookingByToken(token: string): Promise<BookingRow | null> {
  if (!TOKEN.test(token)) return Promise.resolve(null);
  return get<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.public_token = ?`, [token],
  ).then((row) => row ?? null);
}

/** The secret of the booking's manage link. Bookings made by staff get one the first time it is needed. */
export async function ensureToken(row: { id: number; public_token: string | null }): Promise<string> {
  if (row.public_token) return row.public_token;
  const token = newToken();
  await run("UPDATE appointments SET public_token = ? WHERE id = ? AND public_token IS NULL", [token, row.id]);
  const saved = await get<{ public_token: string }>("SELECT public_token FROM appointments WHERE id = ?", [row.id]);
  return saved?.public_token ?? token;
}

export function servicesOf(appointmentId: number): Promise<{ name: string; duration: number; price: number }[]> {
  return query(
    `SELECT s.name, aps.duration, aps.price FROM appointment_services aps
     JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id = ? ORDER BY aps.id`,
    [appointmentId],
  );
}

/** A client can cancel or move a booking that is still ahead and not finished. */
export function canCancel(row: { status: string; scheduled_date: string; start_time: string }, now: { date: string; minutes: number }): boolean {
  if (!["booked", "confirmed", "pending"].includes(row.status)) return false;
  if (row.scheduled_date !== now.date) return row.scheduled_date > now.date;
  return (toMinutes(row.start_time) ?? 0) > now.minutes;
}

/**
 * True when client records with different names share this phone number (a family, for example).
 * PRIVACY: a text from that number could be any of them, so the assistant shows no bookings. A barber helps.
 */
export async function phoneIsShared(phone: string): Promise<boolean> {
  const last10 = phoneDigits(phone).slice(-10);
  if (last10.length < 10) return false;
  const row = await get<{ names: number }>(
    `SELECT COUNT(DISTINCT LOWER(TRIM(name))) AS names FROM clients WHERE ${last10Of("phone")} = ?`, [last10],
  );
  return Number(row?.names ?? 0) > 1;
}

/**
 * The coming bookings of the client with this phone number.
 * PRIVACY: call it only with a number we know belongs to the person asking
 * (the number a text came from). Never with a number someone typed.
 */
export async function upcomingBookingsForPhone(phone: string): Promise<BookingRow[]> {
  const last10 = phoneDigits(phone).slice(-10);
  if (last10.length < 10) return [];
  const settings = await getSettings();
  const now = shopNow(settings.timezone);
  const rows = await query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM appointments a
     JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     WHERE ${last10Of("cl.phone")} = ? AND a.status IN ('pending', 'booked', 'confirmed') AND a.scheduled_date >= ?
     ORDER BY a.scheduled_date, a.start_time LIMIT 20`,
    [last10, now.date],
  );
  return rows.filter((row) => canCancel(row, now));
}

/** One coming booking of that phone number, by its reference ("APT-12"). */
export async function bookingForPhone(phone: string, reference: string): Promise<BookingRow | null> {
  const wanted = reference.trim().toUpperCase();
  return (await upcomingBookingsForPhone(phone)).find((row) => row.identifier.toUpperCase() === wanted) ?? null;
}

// ── Book ───────────────────────────────────────────────────────────

export const TAKEN = "That time was just taken. Please pick another time.";

export type BookingSource = "online" | "chat" | "sms";

export interface BookingInput {
  name: string; phone: string; email?: string;
  date: string; time: string; service_ids: number[]; staff_id?: number | null;
  source: BookingSource;
  /** Where clients reach this app, for the links in the payment page. */
  baseUrl: string;
}

export type BookingResult =
  | { ok: true; id: number; token: string; reference: string; clientId: number; checkoutUrl?: string }
  | { ok: false; status: 400 | 409 | 502; error: string };

const BOOKED_NOTE: Record<BookingSource, string> = {
  online: "Booked online by the client.",
  chat: "Booked in the web chat.",
  sms: "Booked by text.",
};

/** Book a visit for a client. The caller has checked the shape of the input. Run inside the write queue. */
export async function createBooking(input: BookingInput): Promise<BookingResult> {
  const services = await pickServices(input.service_ids);
  if (!services) return { ok: false, status: 400, error: "Pick a service from the list." };

  const barberIds = (await activeBarbers()).map((b) => b.id);
  if (input.staff_id != null && !barberIds.includes(input.staff_id)) {
    return { ok: false, status: 400, error: "Pick a barber from the list." };
  }
  if (barberIds.length === 0) return { ok: false, status: 400, error: "Online booking is not open yet. Please contact the shop." };

  const settings = await getSettings();
  const now = shopNow(settings.timezone);
  const duration = services.reduce((sum, s) => sum + s.duration, 0);
  const price = services.reduce((sum, s) => sum + s.price, 0);
  const start = timeToMinutes(input.time);
  const end = start + duration;

  // Shop rules first: hours, slot step, minimum notice, booking window.
  if (!candidateStarts(settings, input.date, duration, now).includes(start)) {
    return { ok: false, status: 400, error: "That time is not open for booking. Please pick another time." };
  }

  await releaseExpiredHolds();
  const load = await loadDay(input.date);
  const wanted = input.staff_id != null ? [input.staff_id] : barberIds;
  const staffId = pickBarber(load, wanted.filter((id) => isFree(load, id, start, end)));
  if (staffId === null) return { ok: false, status: 409, error: TAKEN };

  const email = input.email ?? "";
  const client = await findOrCreateClient(input.name, input.phone, email);
  const token = newToken();
  // With pre-pay the booking waits as "pending" and holds its time until the hold ends.
  const prepay = prepayFor(settings, price);
  const hold = prepay > 0 ? holdEnd(settings.hold_minutes) : null;
  const reference = await nextIdentifier();
  const created = await run(
    `INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, source, public_token,
       prepay_amount, prepay_status, hold_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reference, client.id, staffId, hold ? "pending" : "confirmed", input.date, minutesToTime(start), minutesToTime(end), price, input.source, token,
      prepay, hold ? "due" : "none", hold ? hold.toISOString() : null],
  );
  const id = Number(created.lastInsertRowid);

  // Double-booking guard. If an earlier booking overlaps (another request won
  // the race, maybe on another server), take this one back.
  if (await overlapsEarlier(id, staffId, input.date, start, end)) {
    await run("DELETE FROM appointments WHERE id = ?", [id]);
    return { ok: false, status: 409, error: TAKEN };
  }

  for (const s of services) {
    await run("INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, ?, ?, ?)", [id, s.id, s.price, s.duration]);
  }
  await note(id, BOOKED_NOTE[input.source]);
  if (client.known && client.savedName.trim().toLowerCase() !== input.name.trim().toLowerCase()) {
    // Staff-only note. The phone matched a saved client, but the name is different.
    await note(id, `Name given by the client: ${input.name}. The phone number matches ${client.savedName}.`);
  }

  let checkoutUrl: string | undefined;
  if (hold) {
    const checkout = await startCheckout({
      appointmentId: id, reference, amount: prepay, shopName: settings.shop_name, expires: hold,
      manageUrl: `${input.baseUrl}/book/manage/${token}`,
      ...(email ? { email } : {}),
    });
    if (!checkout.ok) {
      // No payment page, so no booking. The time is open again.
      await run("DELETE FROM appointment_notes WHERE appointment_id = ?", [id]);
      await run("DELETE FROM appointment_services WHERE appointment_id = ?", [id]);
      await run("DELETE FROM appointments WHERE id = ?", [id]);
      return { ok: false, status: 502, error: "We could not start the payment. Please try again." };
    }
    checkoutUrl = checkout.url;
    await note(id, "Waiting for the pre-pay. The time is held until it is paid or the hold ends.");
  }

  await emitBookingEvent("booking_created", id);
  return { ok: true, id, token, reference, clientId: client.id, ...(checkoutUrl ? { checkoutUrl } : {}) };
}

function note(appointmentId: number, content: string): Promise<unknown> {
  return run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [appointmentId, content]);
}

/** True when a booking of this barber made before `id` overlaps the span. */
async function overlapsEarlier(id: number, staffId: number, date: string, start: number, end: number): Promise<boolean> {
  const others = await query<{ start_time: string; end_time: string }>(
    "SELECT start_time, end_time FROM appointments WHERE staff_id = ? AND scheduled_date = ? AND status != 'cancelled' AND id < ?",
    [staffId, date, id],
  );
  return others.some((o) => {
    const s = toMinutes(o.start_time);
    const e = toMinutes(o.end_time);
    return s !== null && e !== null && start < e && s < end;
  });
}

// ── Cancel ─────────────────────────────────────────────────────────

export type ChangeResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

/** The client cancels. `how` goes in the staff note, for example "online" or "by text". Run inside the write queue. */
export async function cancelBooking(row: BookingRow, how: string): Promise<ChangeResult> {
  if (row.status === "cancelled") return { ok: true };
  const settings = await getSettings();
  if (!canCancel(row, shopNow(settings.timezone))) {
    return { ok: false, status: 409, error: "This booking can no longer be cancelled online. Please contact the shop." };
  }
  await run("UPDATE appointments SET status = 'cancelled', updated_at = utc_now() WHERE id = ?", [row.id]);
  await note(row.id, `Cancelled ${how} by the client.`);
  await settlePrepayOnCancel(row, settings);
  await emitBookingEvent("booking_cancelled", row.id);
  return { ok: true };
}

// ── Move ───────────────────────────────────────────────────────────

/**
 * The client moves a booking to another time. Same services, same price.
 * Keeps the barber when they are free, unless `staffId` names another one.
 * Run inside the write queue.
 */
export async function moveBooking(row: BookingRow, date: string, time: string, how: string, staffId?: number | null): Promise<ChangeResult> {
  const settings = await getSettings();
  const now = shopNow(settings.timezone);
  if (row.status === "pending") {
    return { ok: false, status: 409, error: "This booking waits for the pre-pay. Pay first, or cancel it and book a new time." };
  }
  if (!canCancel(row, now)) {
    return { ok: false, status: 409, error: "This booking can no longer be changed. Please contact the shop." };
  }
  const from = toMinutes(row.start_time);
  const to = toMinutes(row.end_time);
  if (from === null || to === null || to <= from) return { ok: false, status: 409, error: "This booking cannot be moved. Please contact the shop." };
  const duration = to - from;
  const start = timeToMinutes(time);
  const end = start + duration;
  if (!candidateStarts(settings, date, duration, now).includes(start)) {
    return { ok: false, status: 400, error: "That time is not open for booking. Please pick another time." };
  }

  const barberIds = (await activeBarbers()).map((b) => b.id);
  if (staffId != null && !barberIds.includes(staffId)) return { ok: false, status: 400, error: "Pick a barber from the list." };

  await releaseExpiredHolds();
  const load = await loadDay(date);
  // The booking's own time does not block its move.
  if (row.staff_id !== null && row.scheduled_date === date) {
    const own = load.busy.get(row.staff_id) ?? [];
    const at = own.findIndex(([s, e]) => s === from && e === to);
    if (at >= 0) {
      load.busy.set(row.staff_id, own.filter((_, i) => i !== at));
      load.bookings.set(row.staff_id, Math.max(0, (load.bookings.get(row.staff_id) ?? 1) - 1));
    }
  }
  const free = (id: number): boolean => isFree(load, id, start, end);
  let barber: number | null;
  if (staffId != null) barber = free(staffId) ? staffId : null;
  else if (row.staff_id !== null && barberIds.includes(row.staff_id) && free(row.staff_id)) barber = row.staff_id;
  else barber = pickBarber(load, barberIds.filter(free));
  if (barber === null) return { ok: false, status: 409, error: TAKEN };

  await run(
    "UPDATE appointments SET scheduled_date = ?, start_time = ?, end_time = ?, staff_id = ?, moved_at = ?, updated_at = utc_now() WHERE id = ?",
    [date, minutesToTime(start), minutesToTime(end), barber, utcStamp(), row.id],
  );
  await note(row.id, `Moved ${how} by the client, from ${row.scheduled_date} ${row.start_time} to ${date} ${minutesToTime(start)}.`);
  await emitBookingEvent("booking_moved", row.id);
  return { ok: true };
}
