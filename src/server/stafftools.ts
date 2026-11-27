import { tool } from "ai";
import { z } from "zod";
import { get, query, run } from "./db.js";
import { getSettings } from "./settings.js";
import { TIME, isValidDate, minutesToTime, shopNow, timeToMinutes, utcStamp, weekdayOf } from "./shoptime.js";
import { money, releaseExpiredHolds, settlePrepayOnStaffChange } from "./prepay.js";
import { activeBarbers, activeServices } from "./clientbooking.js";
import { availabilityFor, DAYS } from "./clienttools.js";
import { busyFor } from "./booking.js";
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
  };

  // Inside an automation run, Tolly must not create or change automations.
  return automationRun ? { ...read, ...act } : { ...read, ...act, ...manage };
}
