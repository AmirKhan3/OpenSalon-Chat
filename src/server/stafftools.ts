import { tool } from "ai";
import { z } from "zod";
import { get, query, run } from "./db.js";
import { SettingsSchema, getSettings, saveSettings } from "./settings.js";
import { TIME, isValidDate, minutesToTime, shopNow, timeToMinutes, utcStamp, weekdayOf } from "./shoptime.js";
import { money, releaseExpiredHolds, settlePrepayOnStaffChange } from "./prepay.js";
import { activeBarbers, activeServices, clientByPhone, isPhone, normalizePhone, pickServices } from "./clientbooking.js";
import { availabilityFor, DAYS } from "./clienttools.js";
import { busyFor, nextIdentifier } from "./booking.js";
import { findConflicts } from "./scheduling.js";
import { oneAtATime } from "./lock.js";
import { emitBookingEvent } from "./events.js";
import { addMessage } from "./chatstore.js";
import { isOptedOut, smsThreadForPhone } from "./sms.js";
import { getSmsProvider, toE164 } from "./smsprovider.js";
import { sign } from "./agent.js";
import { METHODS, METHOD_NAMES, amountDue, recordPayment } from "./payments.js";
import { bookingReport, incomeReport } from "./reports.js";
import {
  ACTIONS, TRIGGERS, createAutomation, deleteAutomation, getAutomation, listAutomations, previewText, runHistory, runNow, updateAutomation,
  type AutomationView,
} from "./automations.js";

/** Texts Tolly may send for one request in the chat, and in one automation run. */
export const MAX_TEXTS_PER_REQUEST = 30;
export const MAX_TEXTS_PER_RUN = 50;

interface Apt {
  id: number; identifier: string; client_id: number; staff_id: number | null; status: string; scheduled_date: string;
  start_time: string; end_time: string; total_price: number; prepay_amount: number; prepay_status: string;
  client: string; phone: string | null; barber: string | null;
}

/** Find a booking by its reference, for example "APT-0007". */
async function byReference(reference: string): Promise<Apt | null> {
  const ref = reference.trim().replace(/^#/, "");
  if (!ref) return null;
  return (await get<Apt>(
    `SELECT a.id, a.identifier, a.client_id, a.staff_id, a.status, a.scheduled_date, a.start_time, a.end_time, a.total_price,
            a.prepay_amount, a.prepay_status, c.name AS client, c.phone, s.name AS barber
     FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id
     WHERE upper(a.identifier) = upper(?)`, [ref])) ?? null;
}

const NOT_FOUND = "There is no booking with that reference. Use get_schedule or find_client to get the reference.";

async function note(appointmentId: number, content: string): Promise<void> {
  await run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [appointmentId, content]);
}

function brief(a: AutomationView) {
  return {
    id: a.id, name: a.name, on: a.enabled, summary: a.summary, trigger: a.trigger, trigger_config: a.trigger_config,
    action: a.action, action_config: a.action_config, filters: a.filters, made_by: a.created_by, last_run: a.last_run,
  };
}

/** Short text from the owner. Trimmed. */
const words = (max: number) => z.string().trim().max(max);
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("A color like #3a4a5c");
const DOLLARS = z.number().min(0).max(100_000).describe("Dollars");

/** "a = ?, b = ?" for the fields that were sent. The column names come from our own code, never from the model. */
function changes(patch: Record<string, unknown>): { sql: string; values: unknown[] } | null {
  const sent = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (sent.length === 0) return null;
  return { sql: sent.map(([column]) => `${column} = ?`).join(", "), values: sent.map(([, value]) => value) };
}

const NOTHING = "Nothing to change. Send at least one field.";
const onOff = (on: boolean | undefined) => (on === undefined ? undefined : on ? 1 : 0);

/** A phone number as we save it, or an error when it is not a phone number. "" stays "". */
function cleanPhone(phone: string | undefined): { phone?: string; error?: string } {
  if (phone === undefined) return {};
  if (phone.trim() === "") return { phone: "" };
  if (!isPhone(phone)) return { error: "That is not a phone number. Use 10 digits, or + and the country code." };
  return { phone: normalizePhone(phone) };
}

const HOURS_HELP = "hours: only the days that change. day 0 is Sunday. Example: [{\"day\":1,\"closed\":true}] or [{\"day\":6,\"open\":\"10:00\",\"close\":\"16:00\"}].";

const AUTOMATION_HELP = [
  "trigger and trigger_config:",
  '- daily: {"time":"HH:MM","days":[0-6, 0 = Sunday],"scope":"today"|"tomorrow"}. With text_client it texts each client with a visit on that day.',
  '- before_appointment: {"minutes": 15 or more}. after_appointment: {"minutes": 0 or more}.',
  "- booking_created, prepay_paid, booking_cancelled, booking_moved: {}.",
  "action and action_config:",
  '- text_client: {"message": "..."} (600 characters at most). Placeholders: {client_first_name} {date} {day} {time} {barber} {services} {price} {shop_name} {manage_link} {calendar_link} {prepay_link} {agent_name}.',
  '- agent_task: {"instructions": "..."}: you do the task yourself at that time and report to the owner. Use it with the daily trigger.',
  'filters (optional): {"statuses":[...],"sources":[...],"staff_ids":[...],"service_ids":[...],"first_visit":true|false}.',
].join("\n");

/**
 * The tools Tolly has in the barber's private chat.
 * Only staff reach this chat, so these tools may show the whole schedule.
 */

export function staffTools(options: { automationRun?: boolean } = {}) {
  const automationRun = options.automationRun === true;
  const textLimit = automationRun ? MAX_TEXTS_PER_RUN : MAX_TEXTS_PER_REQUEST;
  let texts = 0;

  const read = {
    list_services_and_barbers: tool({
      description: "The shop's services (price, length) and barbers.",
      inputSchema: z.object({}),
      execute: async () => ({
        services: (await activeServices()).map((s) => ({ id: s.id, name: s.name, minutes: s.duration, price: money(s.price) })),
        barbers: (await activeBarbers()).map((b) => ({ id: b.id, name: b.name })),
      }),
    }),

    check_availability: tool({
      description: "Open start times on one day for the chosen services. Leave staff_id out for any barber.",
      inputSchema: z.object({
        date: z.string().describe("YYYY-MM-DD"),
        service_ids: z.array(z.number().int()).min(1).max(10),
        staff_id: z.number().int().optional(),
      }),
      execute: async (input) => availabilityFor(await getSettings(), input),
    }),

    get_schedule: tool({
      description: "All bookings and blocked time on one day.",
      inputSchema: z.object({ date: z.string().describe("YYYY-MM-DD") }),
      execute: async ({ date }) => {
        if (!isValidDate(date)) return { error: "Use a real date, as YYYY-MM-DD." };
        const bookings = await query<{
          identifier: string; status: string; start_time: string; end_time: string; total_price: number;
          client: string; barber: string | null; services: string | null;
        }>(
          `SELECT a.identifier, a.status, a.start_time, a.end_time, a.total_price, c.name AS client, s.name AS barber,
                  (SELECT string_agg(sv.name, ', ') FROM appointment_services x JOIN services sv ON sv.id = x.service_id WHERE x.appointment_id = a.id) AS services
           FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id
           WHERE a.scheduled_date = ? AND a.status != 'cancelled' ORDER BY a.start_time, a.id`,
          [date],
        );
        const blocked = await query<{ start_time: string; end_time: string; reason: string; barber: string }>(
          `SELECT b.start_time, b.end_time, b.reason, s.name AS barber FROM blocked_slots b JOIN staff s ON s.id = b.staff_id
           WHERE b.blocked_date = ? ORDER BY b.start_time`,
          [date],
        );
        return {
          date, day: DAYS[weekdayOf(date)],
          bookings: bookings.map((b) => ({
            reference: b.identifier, time: `${b.start_time}-${b.end_time}`, client: b.client, barber: b.barber ?? "",
            services: b.services ?? "", price: money(b.total_price), status: b.status,
          })),
          blocked,
        };
      },
    }),

    find_client: tool({
      description: "Find clients by a part of their name or phone number. Gives their id, phone, last visit and coming bookings.",
      inputSchema: z.object({ search: z.string().min(1).max(80) }),
      execute: async ({ search }) => {
        const text = search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const digits = search.replace(/\D/g, "");
        const clients = await query<{ id: number; name: string; phone: string | null; notes: string | null }>(
          `SELECT id, name, phone, notes FROM clients
           WHERE name ILIKE ? ${digits.length >= 3 ? "OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?" : ""}
           ORDER BY name LIMIT 10`,
          digits.length >= 3 ? [`%${text}%`, `%${digits}%`] : [`%${text}%`],
        );
        const today = shopNow((await getSettings()).timezone).date;
        const out = [];
        for (const c of clients) {
          const last = await get<{ scheduled_date: string }>(
            "SELECT scheduled_date FROM appointments WHERE client_id = ? AND scheduled_date < ? AND status NOT IN ('cancelled', 'no_show') ORDER BY scheduled_date DESC LIMIT 1",
            [c.id, today]);
          const coming = await query<{ identifier: string; scheduled_date: string; start_time: string; status: string }>(
            "SELECT identifier, scheduled_date, start_time, status FROM appointments WHERE client_id = ? AND scheduled_date >= ? AND status NOT IN ('cancelled', 'no_show', 'completed') ORDER BY scheduled_date, start_time LIMIT 5",
            [c.id, today]);
          out.push({
            client_id: c.id, name: c.name, phone: c.phone ?? "", staff_notes: c.notes ?? "", last_visit: last?.scheduled_date ?? "",
            coming_bookings: coming.map((b) => ({ reference: b.identifier, date: b.scheduled_date, time: b.start_time, status: b.status })),
          });
        }
        return { clients: out };
      },
    }),

    chats_needing_reply: tool({
      description: "Client chats that wait for the barber: handed over by you, or with unread messages.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await query<{ id: number; channel: string; display_name: string | null; phone: string | null; staff_unread: number; needs_attention: number; mode: string; last: string | null; last_sender: string | null }>(
          `SELECT t.id, t.channel, t.display_name, t.phone, t.staff_unread, t.needs_attention, t.mode,
                  (SELECT m.body FROM chat_messages m WHERE m.thread_id = t.id AND m.sender != 'note' ORDER BY m.id DESC LIMIT 1) AS last,
                  (SELECT m.sender FROM chat_messages m WHERE m.thread_id = t.id AND m.sender != 'note' ORDER BY m.id DESC LIMIT 1) AS last_sender
           FROM chat_threads t WHERE t.kind = 'client' AND (t.needs_attention = 1 OR (t.mode = 'human' AND t.staff_unread > 0))
           ORDER BY t.last_message_at DESC NULLS LAST LIMIT 25`);
        return {
          chats: rows.map((t) => ({
            name: t.display_name || (t.channel === "sms" ? t.phone ?? "Unknown" : "Website visitor"), channel: t.channel === "sms" ? "text" : "website chat",
            unread: t.staff_unread, last_message: (t.last ?? "").slice(0, 200), last_from: t.last_sender ?? "",
          })),
        };
      },
    }),

    income_report: tool({
      description: "Money really taken from start to end (both included): income, services, tips, refunds, by month, by method, by barber. Use this for every question about money.",
      inputSchema: z.object({ start: z.string().describe("YYYY-MM-DD"), end: z.string().describe("YYYY-MM-DD") }),
      execute: async ({ start, end }) => {
        const report = await incomeReport(start, end);
        if (!report.ok) return { error: report.error };
        return { ...report, note: "Income is services plus tips, minus refunds. Card fees are not subtracted." };
      },
    }),

    get_report: tool({
      description: "Bookings from start to end (both included): how many, completed, cancelled, no-shows, new clients, by barber, top services. The values are booked prices, not money taken.",
      inputSchema: z.object({ start: z.string().describe("YYYY-MM-DD"), end: z.string().describe("YYYY-MM-DD") }),
      execute: async ({ start, end }) => {
        const report = await bookingReport(start, end);
        return report.ok ? report : { error: report.error };
      },
    }),

    list_automations: tool({
      description: "The shop's automations (routines), with their id and whether they are on.",
      inputSchema: z.object({}),
      execute: async () => ({ automations: (await listAutomations()).map(brief) }),
    }),

    preview_automation: tool({
      description: "Show a text routine's message as a client would get it. Sends nothing. Give a booking reference to use a real visit.",
      inputSchema: z.object({ message: z.string().min(1).max(600), reference: z.string().optional() }),
      execute: async ({ message, reference }) => {
        let id: number | undefined;
        if (reference) {
          const apt = await byReference(reference);
          if (!apt) return { error: NOT_FOUND };
          id = apt.id;
        }
        const result = await previewText(message, id);
        return result.ok ? result.value : { error: result.error };
      },
    }),

    automation_history: tool({
      description: "The latest runs of one automation: sent, skipped or failed, and why.",
      inputSchema: z.object({ id: z.number().int(), limit: z.number().int().min(1).max(50).optional() }),
      execute: async ({ id, limit }) => {
        const automation = await getAutomation(id);
        if (!automation) return { error: "There is no automation with that id." };
        return { name: automation.name, runs: await runHistory(id, limit ?? 20) };
      },
    }),

    list_appointments: tool({
      description: "Bookings between two dates, past or coming. Can be for one client or one status. For one day with blocked time, use get_schedule.",
      inputSchema: z.object({
        from: z.string().describe("YYYY-MM-DD"),
        to: z.string().describe("YYYY-MM-DD"),
        client_id: z.number().int().optional(),
        status: z.string().max(20).optional().describe("For example booked, confirmed, completed, cancelled, no_show."),
      }),
      execute: async ({ from, to, client_id, status }) => {
        if (!isValidDate(from) || !isValidDate(to)) return { error: "Use real dates, as YYYY-MM-DD." };
        if (to < from) return { error: "The end date is before the start date." };
        const where = ["a.scheduled_date >= ?", "a.scheduled_date <= ?"];
        const values: unknown[] = [from, to];
        if (client_id !== undefined) { where.push("a.client_id = ?"); values.push(client_id); }
        if (status) { where.push("a.status = ?"); values.push(status.trim().toLowerCase()); }
        const rows = await query<{
          identifier: string; status: string; scheduled_date: string; start_time: string; end_time: string; total_price: number;
          client: string; barber: string | null; services: string | null;
        }>(
          `SELECT a.identifier, a.status, a.scheduled_date, a.start_time, a.end_time, a.total_price, c.name AS client, s.name AS barber,
                  (SELECT string_agg(sv.name, ', ') FROM appointment_services x JOIN services sv ON sv.id = x.service_id WHERE x.appointment_id = a.id) AS services
           FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id
           WHERE ${where.join(" AND ")} ORDER BY a.scheduled_date, a.start_time, a.id LIMIT 101`,
          values,
        );
        return {
          bookings: rows.slice(0, 100).map((b) => ({
            reference: b.identifier, date: b.scheduled_date, time: `${b.start_time}-${b.end_time}`, client: b.client, barber: b.barber ?? "",
            services: b.services ?? "", price: money(b.total_price), status: b.status,
          })),
          ...(rows.length > 100 ? { note: "Only the first 100 are shown. Ask for fewer days." } : {}),
        };
      },
    }),

    list_staff: tool({
      description: "Every barber, with phone, email, title, and whether they are on (can be booked) or off.",
      inputSchema: z.object({}),
      execute: async () => ({
        staff: (await query<{ id: number; name: string; email: string | null; phone: string | null; title: string | null; color: string; active: number }>(
          "SELECT id, name, email, phone, title, color, active FROM staff ORDER BY name, id",
        )).map((s) => ({ id: s.id, name: s.name, title: s.title ?? "", phone: s.phone ?? "", email: s.email ?? "", color: s.color, on: s.active === 1 })),
      }),
    }),

    list_services: tool({
      description: "Every service, also the ones that are off, with price, length, category and description.",
      inputSchema: z.object({}),
      execute: async () => ({
        services: (await query<{ id: number; name: string; description: string | null; duration: number; price: number; category: string | null; active: number }>(
          "SELECT id, name, description, duration, price, category, active FROM services ORDER BY category, name, id",
        )).map((s) => ({ id: s.id, name: s.name, description: s.description ?? "", minutes: s.duration, price: money(s.price), category: s.category ?? "", on: s.active === 1 })),
      }),
    }),

    list_products: tool({
      description: "Products the shop sells, with price, cost and stock. Search by a part of the name, brand or SKU, or ask for low stock only.",
      inputSchema: z.object({ search: z.string().max(80).optional(), low_stock_only: z.boolean().optional() }),
      execute: async ({ search, low_stock_only }) => {
        const where: string[] = [];
        const values: unknown[] = [];
        const text = (search ?? "").trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
        if (text) { where.push("(name ILIKE ? OR brand ILIKE ? OR sku ILIKE ?)"); values.push(`%${text}%`, `%${text}%`, `%${text}%`); }
        if (low_stock_only) where.push("stock <= low_stock_alert");
        const rows = await query<{ id: number; name: string; brand: string | null; category: string | null; sku: string | null; price: number; cost: number; stock: number; low_stock_alert: number }>(
          `SELECT id, name, brand, category, sku, price, cost, stock, low_stock_alert FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name, id LIMIT 100`,
          values,
        );
        return {
          products: rows.map((p) => ({
            id: p.id, name: p.name, brand: p.brand ?? "", category: p.category ?? "", sku: p.sku ?? "", price: money(p.price), cost: money(p.cost),
            stock: p.stock, low_stock_alert: p.low_stock_alert, low: p.stock <= p.low_stock_alert,
          })),
        };
      },
    }),

    get_settings: tool({
      description: "The shop's settings: name, address, time zone, opening hours, booking rules, pre-pay, and the assistant's name and instructions.",
      inputSchema: z.object({}),
      execute: async () => {
        const { hours, ...rest } = await getSettings();
        return { ...rest, hours: hours.map((h, day) => ({ day, name: DAYS[day], ...(h.closed ? { closed: true } : { closed: false, open: h.open, close: h.close }) })) };
      },
    }),
  };

  const act = {
    text_client: tool({
      description: `Send one text to one client, from the shop's number. Give a booking reference or a client_id. At most ${textLimit} texts ${automationRun ? "in this run" : "for one request"}.`,
      inputSchema: z.object({
        reference: z.string().optional().describe("A booking reference. The text goes to that booking's client."),
        client_id: z.number().int().optional(),
        message: z.string().min(1).max(600),
      }),
      execute: async ({ reference, client_id, message }) => {
        let client: { name: string; phone: string | null } | null = null;
        if (reference) {
          const apt = await byReference(reference);
          if (!apt) return { error: NOT_FOUND };
          client = { name: apt.client, phone: apt.phone };
        } else if (client_id !== undefined) {
          client = (await get<{ name: string; phone: string | null }>("SELECT name, phone FROM clients WHERE id = ?", [client_id])) ?? null;
          if (!client) return { error: "There is no client with that id. Use find_client." };
        } else {
          return { error: "Give a booking reference or a client_id." };
        }
        const phone = toE164(client.phone ?? "");
        if (!phone) return { error: `${client.name} has no mobile number we can text.` };
        if (!getSmsProvider()) return { error: "Texts are not set up for this shop. Nothing was sent." };
        if (await isOptedOut(phone)) return { error: `${client.name} opted out of texts. Nothing was sent.` };
        if (texts >= textLimit) {
          return { error: `The limit is ${textLimit} texts ${automationRun ? "per automation run" : "per request"}. Nothing more was sent. Tell the owner how many went out and who is left.` };
        }
        const thread = await smsThreadForPhone(phone);
        if (!thread) return { error: `${client.name} has no mobile number we can text.` };
        texts++;
        const sentMessage = await addMessage(thread.id, "agent", sign(message.trim(), await getSettings()));
        if (sentMessage.delivery_status !== "sent") {
          return { error: `The text to ${client.name} was not sent (${(sentMessage.delivery_status ?? "failed").replace(/^failed: /, "")}).` };
        }
        return { ok: true, sent_to: client.name, texts_sent: texts, texts_left: textLimit - texts };
      },
    }),

    move_appointment: tool({
      description: "Move a booking to another date, time or barber. The length and the price stay the same. Refuses when the barber is busy then.",
      inputSchema: z.object({
        reference: z.string(),
        date: z.string().describe("YYYY-MM-DD"),
        time: z.string().describe("New start time, HH:MM in 24-hour time"),
        staff_id: z.number().int().optional().describe("Leave out to keep the same barber."),
      }),
      execute: ({ reference, date, time, staff_id }) => oneAtATime(async () => {
        const apt = await byReference(reference);
        if (!apt) return { error: NOT_FOUND };
        if (["cancelled", "completed", "no_show"].includes(apt.status)) return { error: `This booking is ${apt.status.replace("_", " ")}. It cannot be moved.` };
        if (!isValidDate(date)) return { error: "Use a real date, as YYYY-MM-DD." };
        if (!TIME.test(time)) return { error: "Use a time as HH:MM, in 24-hour time." };
        const length = timeToMinutes(apt.end_time) - timeToMinutes(apt.start_time);
        const start = timeToMinutes(time);
        const end = start + length;
        if (!(length > 0)) return { error: "This booking has no length. Fix it in the calendar." };
        if (end >= 24 * 60) return { error: "That is too late: the visit would end after midnight." };
        const barbers = await activeBarbers();
        const barberId = staff_id ?? apt.staff_id;
        const barber = barbers.find((b) => b.id === barberId);
        if (!barber) return { error: staff_id !== undefined ? "There is no barber with that id. Use list_services_and_barbers." : "This booking has no barber. Give a staff_id." };
        const from = minutesToTime(start);
        const to = minutesToTime(end);
        if (apt.scheduled_date === date && apt.start_time === from && apt.staff_id === barber.id) return { error: "The booking is already at that time." };
        await releaseExpiredHolds();
        const conflicts = findConflicts(from, to, await busyFor(barber.id, date, apt.id));
        if (conflicts.length > 0) {
          return {
            error: `${barber.name} is busy then. Nothing was changed.`,
            busy: conflicts.map((c) => ({ time: `${c.start_time}-${c.end_time}`, what: c.kind === "blocked" ? `Blocked: ${c.label}` : c.label })),
          };
        }
        const moved = apt.scheduled_date !== date || apt.start_time !== from;
        await run(
          `UPDATE appointments SET scheduled_date = ?, start_time = ?, end_time = ?, staff_id = ?${moved ? ", moved_at = ?" : ""}, updated_at = utc_now() WHERE id = ?`,
          moved ? [date, from, to, barber.id, utcStamp(), apt.id] : [date, from, to, barber.id, apt.id],
        );
        await note(apt.id, `Moved by the assistant for the shop, from ${apt.scheduled_date} ${apt.start_time}${apt.barber ? ` (${apt.barber})` : ""} to ${date} ${from} (${barber.name}).`);
        if (moved) await emitBookingEvent("booking_moved", apt.id);
        const now = shopNow((await getSettings()).timezone);
        return {
          ok: true, reference: apt.identifier, client: apt.client, date, day: DAYS[weekdayOf(date)], time: `${from}-${to}`, barber: barber.name,
          ...(date < now.date || (date === now.date && start < now.minutes) ? { warning: "The new time is in the past." } : {}),
          note: "The client only gets a text about it if the shop has a routine for moved bookings, or if you text them.",
        };
      }),
    }),

    cancel_appointment: tool({
      description: "Cancel a booking for the shop. A pre-pay is never refunded automatically.",
      inputSchema: z.object({ reference: z.string(), reason: z.string().max(300).describe("Why. Saved as a staff note.") }),
      execute: ({ reference, reason }) => oneAtATime(async () => {
        const apt = await byReference(reference);
        if (!apt) return { error: NOT_FOUND };
        if (apt.status === "cancelled") return { error: "This booking is already cancelled." };
        if (apt.status === "completed") return { error: "This visit is completed. It cannot be cancelled." };
        await run("UPDATE appointments SET status = 'cancelled', updated_at = utc_now() WHERE id = ?", [apt.id]);
        await note(apt.id, `Cancelled by the assistant for the shop.${reason.trim() ? ` Reason: ${reason.trim()}` : ""}`);
        await settlePrepayOnStaffChange(apt.id, apt.status, "cancelled");
        await emitBookingEvent("booking_cancelled", apt.id);
        const paid = apt.prepay_status === "paid" && Number(apt.prepay_amount) > 0;
        return {
          ok: true, reference: apt.identifier, client: apt.client, date: apt.scheduled_date, time: apt.start_time,
          refund: paid
            ? `No refund was made. The client pre-paid ${money(apt.prepay_amount)}. Tell the owner: refund it in Stripe if they want to give it back.`
            : "There was no pre-pay to refund.",
          note: "The client only gets a text about it if the shop has a routine for cancelled bookings, or if you text them.",
        };
      }),
    }),

    block_time: tool({
      description: "Block time for one barber so nobody can book it (lunch, day off). Refuses when bookings overlap, and lists them.",
      inputSchema: z.object({
        staff_id: z.number().int(),
        date: z.string().describe("YYYY-MM-DD"),
        start: z.string().describe("HH:MM"),
        end: z.string().describe("HH:MM. Use 23:59 for the end of the day."),
        reason: z.string().max(200),
      }),
      execute: ({ staff_id, date, start, end, reason }) => oneAtATime(async () => {
        if (!isValidDate(date)) return { error: "Use a real date, as YYYY-MM-DD." };
        if (!TIME.test(start) || !TIME.test(end)) return { error: "Use times as HH:MM, in 24-hour time." };
        if (timeToMinutes(end) <= timeToMinutes(start)) return { error: "The end must be after the start, on the same day." };
        const barber = (await activeBarbers()).find((b) => b.id === staff_id);
        if (!barber) return { error: "There is no barber with that id. Use list_services_and_barbers." };
        await releaseExpiredHolds();
        const overlapping = await query<{ identifier: string; start_time: string; end_time: string; client: string }>(
          `SELECT a.identifier, a.start_time, a.end_time, c.name AS client FROM appointments a JOIN clients c ON c.id = a.client_id
           WHERE a.staff_id = ? AND a.scheduled_date = ? AND a.status != 'cancelled' AND a.start_time < ? AND a.end_time > ?
           ORDER BY a.start_time`, [staff_id, date, end, start]);
        if (overlapping.length > 0) {
          return {
            error: `${barber.name} has bookings in that time. Nothing was blocked. Move or cancel them first, or block another time.`,
            bookings: overlapping.map((b) => ({ reference: b.identifier, time: `${b.start_time}-${b.end_time}`, client: b.client })),
          };
        }
        await run("INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?)",
          [staff_id, date, start, end, reason.trim()]);
        return { ok: true, barber: barber.name, date, day: DAYS[weekdayOf(date)], time: `${start}-${end}` };
      }),
    }),

    record_payment: tool({
      description: "Record money the shop took for a booking, in person. For the books: it charges nobody.",
      inputSchema: z.object({
        reference: z.string(),
        amount: z.number().min(0).describe("For the services, without the tip."),
        tip: z.number().min(0).optional(),
        method: z.enum(METHODS).describe("card_in_person is a card or tap to pay at the shop."),
      }),
      execute: async ({ reference, amount, tip, method }) => {
        const apt = await byReference(reference);
        if (!apt) return { error: NOT_FOUND };
        // A second record of the same payment would count the money twice.
        const due = await amountDue(apt.id);
        if (amount > 0 && amount > due + 0.005) {
          return { error: due > 0
            ? `Only ${money(due)} is still due for this booking. Nothing was recorded. Put extra money in the tip.`
            : "This booking is already paid in full. Nothing was recorded. If this is a new payment, the owner can add it on the booking's page." };
        }
        const result = await recordPayment({ appointmentId: apt.id, amount, tip: tip ?? 0, method, note: "Recorded by the assistant." });
        if (!result.ok) return { error: result.error };
        return {
          ok: true, reference: apt.identifier, client: apt.client, amount: money(result.payment.amount), tip: money(result.payment.tip),
          method: METHOD_NAMES[method], paid_on: result.payment.paid_on, still_due: money(await amountDue(apt.id)),
        };
      },
    }),
  };

  const manage = {
    create_automation: tool({
      description: `Create an automation (a routine). For a text routine, show the owner a preview first (preview_automation).\n${AUTOMATION_HELP}`,
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        enabled: z.boolean().optional(),
        trigger: z.enum(TRIGGERS),
        trigger_config: z.record(z.string(), z.unknown()).optional(),
        action: z.enum(ACTIONS),
        action_config: z.record(z.string(), z.unknown()),
        filters: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const result = await createAutomation({
          name: input.name, enabled: input.enabled ?? true, trigger: input.trigger, trigger_config: input.trigger_config ?? {},
          action: input.action, action_config: input.action_config, filters: input.filters ?? {},
        }, "agent");
        return result.ok ? { ok: true, automation: brief(result.value) } : { error: result.error };
      },
    }),

    update_automation: tool({
      description: `Change an automation, or turn it on or off. Send only what changes.\n${AUTOMATION_HELP}`,
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        trigger: z.enum(TRIGGERS).optional(),
        trigger_config: z.record(z.string(), z.unknown()).optional(),
        action: z.enum(ACTIONS).optional(),
        action_config: z.record(z.string(), z.unknown()).optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ id, ...patch }) => {
        const result = await updateAutomation(id, patch);
        if (!result) return { error: "There is no automation with that id." };
        return result.ok ? { ok: true, automation: brief(result.value) } : { error: result.error };
      },
    }),

    delete_automation: tool({
      description: "Delete an automation for good. Ask the owner first.",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => ((await deleteAutomation(id)) ? { ok: true } : { error: "There is no automation with that id." }),
    }),

    run_automation_now: tool({
      description: "Run an assistant-task automation now. Text routines cannot be run by hand.",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const result = await runNow(id);
        if (!result) return { error: "There is no automation with that id." };
        return result.ok ? { ok: true, note: "It is running. The report comes in this chat." } : { error: result.error };
      },
    }),

    create_appointment: tool({
      description: "Book a visit for a client, for the shop. Needs a client_id (find_client, or add_client for a new person). Refuses when the barber is busy then. No pre-pay is asked.",
      inputSchema: z.object({
        client_id: z.number().int(),
        date: z.string().describe("YYYY-MM-DD"),
        time: z.string().describe("Start time, HH:MM in 24-hour time"),
        service_ids: z.array(z.number().int()).min(1).max(10),
        staff_id: z.number().int().optional().describe("Leave out when the shop has one barber."),
        notes: words(500).optional().describe("A staff note. The client never sees it."),
      }),
      execute: ({ client_id, date, time, service_ids, staff_id, notes }) => oneAtATime(async () => {
        if (!isValidDate(date)) return { error: "Use a real date, as YYYY-MM-DD." };
        if (!TIME.test(time)) return { error: "Use a time as HH:MM, in 24-hour time." };
        const client = await get<{ id: number; name: string }>("SELECT id, name FROM clients WHERE id = ?", [client_id]);
        if (!client) return { error: "There is no client with that id. Use find_client, or add_client for a new person." };
        const services = await pickServices([...new Set(service_ids)]);
        if (!services) return { error: "One of the services is not offered. Use list_services_and_barbers." };
        const barbers = await activeBarbers();
        const barber = staff_id !== undefined ? barbers.find((b) => b.id === staff_id) : barbers.length === 1 ? barbers[0] : undefined;
        if (!barber) return { error: staff_id !== undefined ? "There is no barber with that id. Use list_services_and_barbers." : barbers.length === 0 ? "No barber is on. Turn one on with update_staff first." : "Say which barber. Give a staff_id." };
        const length = services.reduce((sum, s) => sum + s.duration, 0);
        const start = timeToMinutes(time);
        if (!(length > 0)) return { error: "These services have no length. Fix the service first." };
        if (start + length >= 24 * 60) return { error: "That is too late: the visit would end after midnight." };
        const end = minutesToTime(start + length);
        await releaseExpiredHolds();
        const conflicts = findConflicts(time, end, await busyFor(barber.id, date));
        if (conflicts.length > 0) {
          return {
            error: `${barber.name} is busy then. Nothing was booked.`,
            busy: conflicts.map((c) => ({ time: `${c.start_time}-${c.end_time}`, what: c.kind === "blocked" ? `Blocked: ${c.label}` : c.label })),
          };
        }
        const price = services.reduce((sum, s) => sum + s.price, 0);
        const reference = await nextIdentifier();
        const made = await run(
          "INSERT INTO appointments (identifier, client_id, staff_id, scheduled_date, start_time, end_time, total_price, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [reference, client.id, barber.id, date, time, end, price, notes ?? ""],
        );
        const id = Number(made.lastInsertRowid);
        for (const s of services) {
          await run("INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, ?, ?, ?)", [id, s.id, s.price, s.duration]);
        }
        await note(id, "Booked by the assistant for the shop.");
        await emitBookingEvent("booking_created", id);
        const now = shopNow((await getSettings()).timezone);
        return {
          ok: true, reference, client: client.name, date, day: DAYS[weekdayOf(date)], time: `${time}-${end}`, barber: barber.name,
          services: services.map((s) => s.name).join(", "), price: money(price),
          ...(date < now.date || (date === now.date && start < now.minutes) ? { warning: "This time is in the past." } : {}),
          note: "The client only gets a text about it if the shop has a routine for new bookings, or if you text them.",
        };
      }),
    }),

    delete_appointment: tool({
      description: "Delete a booking for good, as if it was never made. Ask the owner first. For a real booking that will not happen, use cancel_appointment. Refuses when the booking has a payment or a pre-pay.",
      inputSchema: z.object({ reference: z.string() }),
      execute: ({ reference }) => oneAtATime(async () => {
        const apt = await byReference(reference);
        if (!apt) return { error: NOT_FOUND };
        const paid = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM payments WHERE appointment_id = ?", [apt.id]);
        if ((paid?.count ?? 0) > 0 || ["due", "paid", "refund_due", "expired"].includes(apt.prepay_status)) {
          return { error: "This booking has a payment or a pre-pay. Cancel it instead of deleting it." };
        }
        if (apt.status === "completed") return { error: "This visit is finished. It stays in the records." };
        await run("DELETE FROM appointments WHERE id = ?", [apt.id]);
        return { ok: true, deleted: apt.identifier, client: apt.client, date: apt.scheduled_date, time: apt.start_time };
      }),
    }),

    add_client: tool({
      description: "Add a new client. Check with find_client first, so nobody is added twice.",
      inputSchema: z.object({
        name: words(100).min(1),
        phone: z.string().max(30).optional(),
        email: z.string().trim().email().max(200).optional(),
        notes: words(1000).optional().describe("Staff notes. The client never sees them."),
      }),
      execute: async ({ name, phone, email, notes }) => {
        const clean = cleanPhone(phone);
        if (clean.error) return { error: clean.error };
        if (clean.phone) {
          const same = await clientByPhone(clean.phone);
          if (same) return { error: `${same.name} already has this phone number (client_id ${same.id}). Nothing was added.` };
        }
        const made = await run("INSERT INTO clients (name, email, phone, notes) VALUES (?, ?, ?, ?)", [name, email ?? "", clean.phone ?? "", notes ?? ""]);
        return { ok: true, client_id: Number(made.lastInsertRowid), name, phone: clean.phone ?? "" };
      },
    }),

    update_client: tool({
      description: "Change a client's name, phone, email or staff notes. Send only what changes.",
      inputSchema: z.object({
        client_id: z.number().int(),
        name: words(100).min(1).optional(),
        phone: z.string().max(30).optional(),
        email: z.union([z.string().trim().email().max(200), z.literal("")]).optional(),
        notes: words(1000).optional().describe("Replaces the staff notes."),
      }),
      execute: async ({ client_id, name, phone, email, notes }) => {
        const clean = cleanPhone(phone);
        if (clean.error) return { error: clean.error };
        const set = changes({ name, phone: clean.phone, email, notes });
        if (!set) return { error: NOTHING };
        if (clean.phone) {
          const same = await clientByPhone(clean.phone);
          if (same && same.id !== client_id) return { error: `${same.name} already has this phone number (client_id ${same.id}). Nothing was changed.` };
        }
        const rows = await query<{ id: number; name: string; phone: string | null; email: string | null }>(
          `UPDATE clients SET ${set.sql}, updated_at = utc_now() WHERE id = ? RETURNING id, name, phone, email`, [...set.values, client_id]);
        if (rows.length === 0) return { error: "There is no client with that id. Use find_client." };
        return { ok: true, client_id, name: rows[0].name, phone: rows[0].phone ?? "", email: rows[0].email ?? "" };
      },
    }),

    delete_client: tool({
      description: "Delete a client for good. Ask the owner first. Refuses when the client has bookings, so no history is lost.",
      inputSchema: z.object({ client_id: z.number().int() }),
      execute: ({ client_id }) => oneAtATime(async () => {
        const client = await get<{ id: number; name: string }>("SELECT id, name FROM clients WHERE id = ?", [client_id]);
        if (!client) return { error: "There is no client with that id. Use find_client." };
        const used = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM appointments WHERE client_id = ?", [client_id]);
        if ((used?.count ?? 0) > 0) {
          return { error: `${client.name} has ${used!.count} booking${used!.count === 1 ? "" : "s"}. Deleting the client would delete them too. The owner can do that on the Clients page.` };
        }
        await run("DELETE FROM clients WHERE id = ?", [client_id]);
        return { ok: true, deleted: client.name };
      }),
    }),

    create_staff: tool({
      description: "Add a barber. They can be booked at once.",
      inputSchema: z.object({
        name: words(100).min(1),
        title: words(100).optional(),
        phone: z.string().max(30).optional(),
        email: z.string().trim().email().max(200).optional(),
        color: COLOR.optional(),
      }),
      execute: async ({ name, title, phone, email, color }) => {
        const clean = cleanPhone(phone);
        if (clean.error) return { error: clean.error };
        const made = await run("INSERT INTO staff (name, email, phone, title, color) VALUES (?, ?, ?, ?, ?)", [name, email ?? "", clean.phone ?? "", title ?? "", color ?? "#3a4a5c"]);
        return { ok: true, staff_id: Number(made.lastInsertRowid), name };
      },
    }),

    update_staff: tool({
      description: "Change a barber's name, title, phone, email or color, or turn them on or off. A barber who is off cannot be booked. Send only what changes.",
      inputSchema: z.object({
        staff_id: z.number().int(),
        name: words(100).min(1).optional(),
        title: words(100).optional(),
        phone: z.string().max(30).optional(),
        email: z.union([z.string().trim().email().max(200), z.literal("")]).optional(),
        color: COLOR.optional(),
        on: z.boolean().optional(),
      }),
      execute: ({ staff_id, name, title, phone, email, color, on }) => oneAtATime(async () => {
        const clean = cleanPhone(phone);
        if (clean.error) return { error: clean.error };
        const set = changes({ name, title, phone: clean.phone, email, color, active: onOff(on) });
        if (!set) return { error: NOTHING };
        if (on === false) {
          const others = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM staff WHERE active = 1 AND id != ?", [staff_id]);
          if ((others?.count ?? 0) === 0) return { error: "This is the only barber who is on. With nobody on, clients cannot book. Nothing was changed." };
        }
        const rows = await query<{ id: number; name: string; active: number }>(`UPDATE staff SET ${set.sql} WHERE id = ? RETURNING id, name, active`, [...set.values, staff_id]);
        if (rows.length === 0) return { error: "There is no barber with that id. Use list_staff." };
        return { ok: true, staff_id, name: rows[0].name, on: rows[0].active === 1 };
      }),
    }),

    delete_staff: tool({
      description: "Delete a barber for good. Ask the owner first. Refuses when the barber has bookings or is the last barber: turn them off with update_staff instead.",
      inputSchema: z.object({ staff_id: z.number().int() }),
      execute: ({ staff_id }) => oneAtATime(async () => {
        const barber = await get<{ id: number; name: string }>("SELECT id, name FROM staff WHERE id = ?", [staff_id]);
        if (!barber) return { error: "There is no barber with that id. Use list_staff." };
        const others = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM staff WHERE active = 1 AND id != ?", [staff_id]);
        if ((others?.count ?? 0) === 0) return { error: "The shop needs at least one barber who is on. Nothing was deleted." };
        const used = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM appointments WHERE staff_id = ?", [staff_id]);
        if ((used?.count ?? 0) > 0) return { error: `${barber.name} has bookings. Turn them off with update_staff instead, so the history stays.` };
        await run("DELETE FROM staff WHERE id = ?", [staff_id]);
        return { ok: true, deleted: barber.name };
      }),
    }),

    create_service: tool({
      description: "Add a service clients can book.",
      inputSchema: z.object({
        name: words(100).min(1),
        minutes: z.number().int().min(5).max(480),
        price: DOLLARS,
        description: words(300).optional(),
        category: words(60).optional(),
        color: COLOR.optional(),
      }),
      execute: async ({ name, minutes, price, description, category, color }) => {
        const made = await run("INSERT INTO services (name, description, duration, price, color, category) VALUES (?, ?, ?, ?, ?, ?)",
          [name, description ?? "", minutes, price, color ?? "#6f665c", category ?? ""]);
        return { ok: true, service_id: Number(made.lastInsertRowid), name, minutes, price: money(price) };
      },
    }),

    update_service: tool({
      description: "Change a service's name, length, price, description, category or color, or turn it on or off. A service that is off cannot be booked. Bookings already made keep their price and length. Send only what changes.",
      inputSchema: z.object({
        service_id: z.number().int(),
        name: words(100).min(1).optional(),
        minutes: z.number().int().min(5).max(480).optional(),
        price: DOLLARS.optional(),
        description: words(300).optional(),
        category: words(60).optional(),
        color: COLOR.optional(),
        on: z.boolean().optional(),
      }),
      execute: async ({ service_id, name, minutes, price, description, category, color, on }) => {
        const set = changes({ name, duration: minutes, price, description, category, color, active: onOff(on) });
        if (!set) return { error: NOTHING };
        const rows = await query<{ name: string; duration: number; price: number; active: number }>(
          `UPDATE services SET ${set.sql} WHERE id = ? RETURNING name, duration, price, active`, [...set.values, service_id]);
        if (rows.length === 0) return { error: "There is no service with that id. Use list_services." };
        return { ok: true, service_id, name: rows[0].name, minutes: rows[0].duration, price: money(rows[0].price), on: rows[0].active === 1 };
      },
    }),

    delete_service: tool({
      description: "Remove a service. Ask the owner first. A service that was never booked is deleted for good. One with bookings is only turned off, so past visits keep it.",
      inputSchema: z.object({ service_id: z.number().int() }),
      execute: ({ service_id }) => oneAtATime(async () => {
        const service = await get<{ id: number; name: string }>("SELECT id, name FROM services WHERE id = ?", [service_id]);
        if (!service) return { error: "There is no service with that id. Use list_services." };
        const used = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM appointment_services WHERE service_id = ?", [service_id]);
        if ((used?.count ?? 0) > 0) {
          await run("UPDATE services SET active = 0 WHERE id = ?", [service_id]);
          return { ok: true, turned_off: service.name, note: "It has bookings, so it was turned off and not deleted. Clients cannot book it any more." };
        }
        await run("DELETE FROM services WHERE id = ?", [service_id]);
        return { ok: true, deleted: service.name };
      }),
    }),

    create_product: tool({
      description: "Add a product the shop sells.",
      inputSchema: z.object({
        name: words(100).min(1),
        price: DOLLARS.optional(),
        cost: DOLLARS.optional().describe("What the shop pays for one, in dollars."),
        stock: z.number().int().min(0).max(100_000).optional(),
        low_stock_alert: z.number().int().min(0).max(100_000).optional(),
        brand: words(100).optional(),
        category: words(60).optional(),
        sku: words(60).optional(),
      }),
      execute: async ({ name, price, cost, stock, low_stock_alert, brand, category, sku }) => {
        const made = await run("INSERT INTO products (name, brand, category, sku, price, cost, stock, low_stock_alert) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [name, brand ?? "", category ?? "", sku ?? "", price ?? 0, cost ?? 0, stock ?? 0, low_stock_alert ?? 5]);
        return { ok: true, product_id: Number(made.lastInsertRowid), name, price: money(price ?? 0), stock: stock ?? 0 };
      },
    }),

    update_product: tool({
      description: "Change a product, or its stock. Give stock for a new count, or stock_change to add (5) or take away (-1). Send only what changes.",
      inputSchema: z.object({
        product_id: z.number().int(),
        name: words(100).min(1).optional(),
        price: DOLLARS.optional(),
        cost: DOLLARS.optional(),
        stock: z.number().int().min(0).max(100_000).optional(),
        stock_change: z.number().int().min(-100_000).max(100_000).optional(),
        low_stock_alert: z.number().int().min(0).max(100_000).optional(),
        brand: words(100).optional(),
        category: words(60).optional(),
        sku: words(60).optional(),
      }),
      execute: ({ product_id, name, price, cost, stock, stock_change, low_stock_alert, brand, category, sku }) => oneAtATime(async () => {
        if (stock !== undefined && stock_change !== undefined) return { error: "Give stock or stock_change, not both." };
        const product = await get<{ stock: number }>("SELECT stock FROM products WHERE id = ?", [product_id]);
        if (!product) return { error: "There is no product with that id. Use list_products." };
        const count = stock_change !== undefined ? product.stock + stock_change : stock;
        if (count !== undefined && count < 0) return { error: `There are only ${product.stock} in stock. Nothing was changed.` };
        const set = changes({ name, price, cost, stock: count, low_stock_alert, brand, category, sku });
        if (!set) return { error: NOTHING };
        const rows = await query<{ name: string; price: number; stock: number; low_stock_alert: number }>(
          `UPDATE products SET ${set.sql}, updated_at = utc_now() WHERE id = ? RETURNING name, price, stock, low_stock_alert`, [...set.values, product_id]);
        const p = rows[0];
        return { ok: true, product_id, name: p.name, price: money(p.price), stock: p.stock, low: p.stock <= p.low_stock_alert };
      }),
    }),

    delete_product: tool({
      description: "Delete a product for good. Ask the owner first.",
      inputSchema: z.object({ product_id: z.number().int() }),
      execute: async ({ product_id }) => {
        const rows = await query<{ name: string }>("DELETE FROM products WHERE id = ? RETURNING name", [product_id]);
        return rows.length > 0 ? { ok: true, deleted: rows[0].name } : { error: "There is no product with that id. Use list_products." };
      },
    }),

    update_settings: tool({
      description: `Change the shop's settings. Send only what changes. Times are HH:MM in 24-hour time. Money is in dollars. Pre-pay needs Stripe.\n${HOURS_HELP}`,
      inputSchema: z.object({
        shop_name: z.string().optional(),
        timezone: z.string().optional().describe("For example America/New_York"),
        address: z.string().optional(),
        access_instructions: z.string().optional().describe("How to get in: parking, door code, floor."),
        hours: z.array(z.object({
          day: z.number().int().min(0).max(6), closed: z.boolean().optional(), open: z.string().optional(), close: z.string().optional(),
        })).max(7).optional(),
        slot_step: z.number().optional().describe("Minutes between start times."),
        min_notice: z.number().optional().describe("Minutes. Clients cannot book sooner than this."),
        booking_window_days: z.number().optional().describe("How many days ahead clients can book."),
        prepay_mode: z.enum(["none", "fixed", "percent", "full"]).optional(),
        prepay_amount: z.number().optional(),
        prepay_percent: z.number().optional(),
        refund_window_hours: z.number().optional(),
        hold_minutes: z.number().optional(),
        agent_name: z.string().optional().describe("Your own name. You sign texts to clients with it."),
        sign_messages: z.boolean().optional(),
        agent_instructions: z.string().optional().describe("The owner's extra instructions for you. This replaces the old text."),
      }),
      execute: ({ hours, ...rest }) => oneAtATime(async () => {
        const patch: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
        if (hours && hours.length > 0) {
          const week = (await getSettings()).hours.map((h) => ({ ...h }));
          for (const { day, closed, open, close } of hours) {
            // New times for a day open it, unless the owner says it is closed.
            week[day] = { closed: closed ?? (open !== undefined || close !== undefined ? false : week[day].closed), open: open ?? week[day].open, close: close ?? week[day].close };
          }
          patch.hours = week;
        }
        if (Object.keys(patch).length === 0) return { error: NOTHING };
        const checked = SettingsSchema.partial().safeParse(patch);
        if (!checked.success) return { error: `Nothing was changed. ${checked.error.issues[0]?.message ?? "A value is not allowed."}` };
        await saveSettings(checked.data);
        return { ok: true, changed: Object.keys(checked.data) };
      }),
    }),
  };

  // Inside an automation run, Tolly must not create or change automations, or the shop's setup.
  return automationRun ? { ...read, ...act } : { ...read, ...act, ...manage };
}
