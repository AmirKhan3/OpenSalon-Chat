import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { getSettings, type ShopSettings } from "./settings.js";
import { addDays, isValidDate, shopNow, TIME, wallClock } from "./shoptime.js";
import { bookingByToken, ensureToken, newToken, servicesOf, TOKEN, type BookingRow } from "./clientbooking.js";
import { manageLink } from "./clienttools.js";
import { publicBaseUrl } from "./public.js";

/**
 * Calendars.
 *
 * 1. A client adds their own visit to their phone: one .ics file, or a Google Calendar link.
 * 2. A barber subscribes to a feed of their bookings. The feed link holds a secret token.
 *
 * PRIVACY: the client's file holds only that client's visit. The barber's feed holds client
 * names, so its token is long, random, and can be replaced.
 */

// ── Writing .ics text (RFC 5545) ───────────────────────────────────

/** Escape a text value: backslash, semicolon, comma, new line. */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // Other control characters have no place in a calendar file.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const encoder = new TextEncoder();

/** Fold a line so that no line is longer than 75 bytes. A folded line continues with a space. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  // The first line may hold 75 bytes. The next ones start with a space, so 74.
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

function offsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A date and time in the shop ("2026-03-02", "14:30") as the real moment. */
export function shopTimeToUtc(date: string, time: string, timezone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  let tz = timezone;
  try {
    offsetMs(tz, new Date(wall));
  } catch {
    tz = "UTC";
  }
  // Two steps, so that days when the clocks change come out right.
  const first = wall - offsetMs(tz, new Date(wall));
  return new Date(wall - offsetMs(tz, new Date(first)));
}

/** "20260302T193000Z" */
export function icsStamp(at: Date): string {
  return at.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

export interface CalendarEvent {
  uid: string;
  date: string;
  start: string;
  end: string;
  summary: string;
  location?: string;
  description?: string;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}

export function buildCalendar(name: string, events: CalendarEvent[], timezone: string): string {
  const stamp = icsStamp(wallClock());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tolly//Bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
  ];
  for (const event of events) {
    if (!isValidDate(event.date) || !TIME.test(event.start) || !TIME.test(event.end)) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(shopTimeToUtc(event.date, event.start, timezone))}`,
      `DTEND:${icsStamp(shopTimeToUtc(event.date, event.end, timezone))}`,
      `SUMMARY:${icsText(event.summary)}`,
    );
    if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
    if (event.status) lines.push(`STATUS:${event.status}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** What the calendar shows for a booking's status. */
export function eventStatus(status: string, prepayStatus: string): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (status === "cancelled") return "CANCELLED";
  if (status === "pending" && prepayStatus === "due") return "TENTATIVE";
  return "CONFIRMED";
}

// ── The client's own visit ─────────────────────────────────────────

interface ClientEvent { title: string; description: string; location: string; start: Date; end: Date; event: CalendarEvent }

/** The host part of event ids. It must stay the same, or calendar apps show a visit twice. */
function uidHost(): string {
  const fixed = (process.env.PUBLIC_URL ?? "").trim();
  try {
    return /^https?:\/\//.test(fixed) ? new URL(fixed).host : "tolly";
  } catch {
    return "tolly";
  }
}

async function clientEvent(row: BookingRow, settings: ShopSettings, baseUrl: string): Promise<ClientEvent | null> {
  // A broken row gets no calendar file, not a server error.
  if (!isValidDate(row.scheduled_date) || !TIME.test(row.start_time) || !TIME.test(row.end_time)) return null;
  const services = (await servicesOf(row.id)).map((s) => s.name).join(", ") || "Visit";
  const title = `${services} at ${settings.shop_name}`;
  const status = eventStatus(row.status, row.prepay_status);
  const link = manageLink(baseUrl, await ensureToken(row));
  const description = [
    row.barber ? `With ${row.barber}.` : "",
    status === "TENTATIVE" ? "Not booked yet. Pre-pay to keep this time." : "",
    settings.access_instructions,
    `Change or cancel: ${link}`,
  ].filter(Boolean).join("\n");
  return {
    title, description, location: settings.address,
    start: shopTimeToUtc(row.scheduled_date, row.start_time, settings.timezone),
    end: shopTimeToUtc(row.scheduled_date, row.end_time, settings.timezone),
    event: {
      uid: `${row.identifier}@${uidHost()}`,
      date: row.scheduled_date, start: row.start_time, end: row.end_time,
      summary: title, location: settings.address, description, status,
    },
  };
}

// ── The barber's feed ──────────────────────────────────────────────

const FEED_DAYS_BACK = 30;
const FEED_DAYS_AHEAD = 180;

/** The secret of a barber's calendar feed. Made the first time it is needed. */
export async function calendarToken(staffId: number): Promise<string | null> {
  const row = await get<{ calendar_token: string | null }>("SELECT calendar_token FROM staff WHERE id = ?", [staffId]);
  if (!row) return null;
  if (row.calendar_token) return row.calendar_token;
  await run("UPDATE staff SET calendar_token = ? WHERE id = ? AND calendar_token IS NULL", [newToken(), staffId]);
  return (await get<{ calendar_token: string }>("SELECT calendar_token FROM staff WHERE id = ?", [staffId]))?.calendar_token ?? null;
}

/** A new secret. The old link stops working. */
export async function resetCalendarToken(staffId: number): Promise<string | null> {
  const token = newToken();
  const done = await query<{ id: number }>("UPDATE staff SET calendar_token = ? WHERE id = ? RETURNING id", [token, staffId]);
  return done.length > 0 ? token : null;
}

export async function barberFeed(token: string): Promise<string | null> {
  const host = uidHost();
  if (!TOKEN.test(token)) return null;
  const barber = await get<{ id: number; name: string }>("SELECT id, name FROM staff WHERE calendar_token = ? AND active = 1", [token]);
  if (!barber) return null;
  const settings = await getSettings();
  const today = shopNow(settings.timezone).date;
  const from = addDays(today, -FEED_DAYS_BACK);
  const to = addDays(today, FEED_DAYS_AHEAD);

  const bookings = await query<{
    id: number; identifier: string; status: string; prepay_status: string; scheduled_date: string;
    start_time: string; end_time: string; total_price: number; client: string | null;
  }>(
    `SELECT a.id, a.identifier, a.status, a.prepay_status, a.scheduled_date, a.start_time, a.end_time, a.total_price, c.name AS client
     FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.staff_id = ? AND a.scheduled_date >= ? AND a.scheduled_date <= ? AND a.status <> 'cancelled'
     ORDER BY a.scheduled_date, a.start_time, a.id`,
    [barber.id, from, to],
  );
  const names = await query<{ appointment_id: number; name: string }>(
    `SELECT x.appointment_id, s.name FROM appointment_services x JOIN services s ON s.id = x.service_id
     JOIN appointments a ON a.id = x.appointment_id
     WHERE a.staff_id = ? AND a.scheduled_date >= ? AND a.scheduled_date <= ? ORDER BY x.id`,
    [barber.id, from, to],
  );
  const blocks = await query<{ id: number; blocked_date: string; start_time: string; end_time: string; reason: string | null }>(
    "SELECT id, blocked_date, start_time, end_time, reason FROM blocked_slots WHERE staff_id = ? AND blocked_date >= ? AND blocked_date <= ? ORDER BY blocked_date, start_time, id",
    [barber.id, from, to],
  );

  const events: CalendarEvent[] = bookings.map((b) => {
    const services = names.filter((n) => n.appointment_id === b.id).map((n) => n.name).join(", ");
    const waiting = eventStatus(b.status, b.prepay_status) === "TENTATIVE";
    return {
      uid: `${b.identifier}@${host}`,
      date: b.scheduled_date, start: b.start_time, end: b.end_time,
      summary: [b.client || "Client", services].filter(Boolean).join(" - "),
      location: settings.address,
      description: [
        `Booking ${b.identifier}.`,
        `$${b.total_price.toFixed(2)}.`,
        waiting ? "Waiting for the pre-pay." : "",
        b.status === "no_show" ? "The client did not come." : "",
      ].filter(Boolean).join(" "),
      status: waiting ? "TENTATIVE" : "CONFIRMED",
    };
  });
  for (const block of blocks) {
    events.push({
      uid: `blocked-${block.id}@${host}`,
      date: block.blocked_date, start: block.start_time, end: block.end_time,
      summary: block.reason ? `Blocked: ${block.reason}` : "Blocked",
      status: "CONFIRMED",
    });
  }
  return buildCalendar(`${barber.name} - ${settings.shop_name}`, events, settings.timezone);
}

// ── Routes ─────────────────────────────────────────────────────────

const NOT_FOUND = "We could not find that calendar.";
const ICS = { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" };

const LinkSchema = z.object({
  staff_id: z.number(), name: z.string(),
  /** https link, for Google Calendar's "From URL". */
  feed_url: z.string(),
  /** webcal link. Opening it on an iPhone or Mac subscribes. */
  webcal_url: z.string(),
});
const ErrorSchema = z.object({ error: z.string() });

const linksRoute = createRoute({
  method: "get", path: "/api/calendar-links", tags: ["Calendar"], summary: "Each barber's calendar feed link",
  responses: { 200: { description: "Links", content: { "application/json": { schema: z.object({ links: z.array(LinkSchema) }) } } } },
});

const resetRoute = createRoute({
  method: "post", path: "/api/calendar-links/{id}/reset", tags: ["Calendar"], summary: "Make a new feed link. The old one stops working.",
  request: { params: z.object({ id: z.string().regex(/^\d{1,9}$/) }) },
  responses: {
    200: { description: "The new link", content: { "application/json": { schema: z.object({ link: LinkSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function feedLink(base: string, staff: { id: number; name: string }, token: string) {
  const url = `${base}/api/public/calendar/${token}.ics`;
  return { staff_id: staff.id, name: staff.name, feed_url: url, webcal_url: url.replace(/^https?:\/\//, "webcal://") };
}

export function registerCalendarRoutes(app: OpenAPIHono): void {
  // The client's visit as a file. iPhone and Mac open it in Calendar.
  app.get("/api/public/bookings/:token/calendar.ics", async (c) => {
    const row = await bookingByToken(c.req.param("token"));
    if (!row) return c.json({ error: "We could not find that booking." }, 404);
    const settings = await getSettings();
    const made = await clientEvent(row, settings, publicBaseUrl(c.req.url));
    if (!made) return c.json({ error: "We could not find that booking." }, 404);
    return c.body(buildCalendar(settings.shop_name, [made.event], settings.timezone), 200, {
      ...ICS, "Content-Disposition": 'inline; filename="visit.ics"',
    });
  });

  // The same visit as a Google Calendar "new event" page.
  app.get("/api/public/bookings/:token/google-calendar", async (c) => {
    const row = await bookingByToken(c.req.param("token"));
    if (!row) return c.json({ error: "We could not find that booking." }, 404);
    const settings = await getSettings();
    const made = await clientEvent(row, settings, publicBaseUrl(c.req.url));
    if (!made) return c.json({ error: "We could not find that booking." }, 404);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: made.title,
      dates: `${icsStamp(made.start)}/${icsStamp(made.end)}`,
      details: made.description,
    });
    if (made.location) params.set("location", made.location);
    c.header("Cache-Control", "no-store");
    return c.redirect(`https://calendar.google.com/calendar/render?${params.toString()}`, 302);
  });

  // A barber's feed. Calendar apps fetch it again and again.
  app.get("/api/public/calendar/:file", async (c) => {
    const file = c.req.param("file");
    const text = file.endsWith(".ics") ? await barberFeed(file.slice(0, -4)) : null;
    if (text === null) return c.json({ error: NOT_FOUND }, 404);
    return c.body(text, 200, { ...ICS, "Content-Disposition": 'inline; filename="bookings.ics"' });
  });

  app.openapi(linksRoute, async (c) => {
    const base = publicBaseUrl(c.req.url);
    const staff = await query<{ id: number; name: string }>("SELECT id, name FROM staff WHERE active = 1 ORDER BY name");
    const links = [];
    for (const person of staff) {
      const token = await calendarToken(person.id);
      if (token) links.push(feedLink(base, person, token));
    }
    c.header("Cache-Control", "no-store");
    return c.json({ links }, 200);
  });

  app.openapi(resetRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const person = await get<{ id: number; name: string }>("SELECT id, name FROM staff WHERE id = ?", [id]);
    const token = person ? await resetCalendarToken(id) : null;
    if (!person || !token) return c.json({ error: "We could not find that barber." }, 404);
    return c.json({ link: feedLink(publicBaseUrl(c.req.url), person, token) }, 200);
  });
}
