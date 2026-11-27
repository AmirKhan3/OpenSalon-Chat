import { tool } from "ai";
import { z } from "zod";
import { get } from "./db.js";
import { oneAtATime } from "./lock.js";
import { openSlots } from "./availability.js";
import { getSettings, type ShopSettings } from "./settings.js";
import { isValidDate, shopNow, TIME, weekdayOf } from "./shoptime.js";
import { money } from "./prepay.js";
import {
  activeBarbers, activeServices, bookingForPhone, cancelBooking, clientByPhone, createBooking, ensureToken,
  isPhone, moveBooking, pickServices, servicesOf, upcomingBookingsForPhone, type BookingSource,
} from "./clientbooking.js";
import { linkClient, setMode, addMessage } from "./chatstore.js";

/**
 * The tools Tolly has when it talks with a client.
 *
 * PRIVACY (hard rule): a client only ever gets their own bookings.
 * - In a text thread we know the phone number (`verifiedPhone`). The booking
 *   tools use that number and nothing else. They never take a number from the model.
 * - In the web chat nobody checked the phone number, so `verifiedPhone` is null
 *   and looking up, moving and cancelling are refused here, in code.
 * - Open times show times and barber ids only. Never who is booked.
 */

export interface ClientContext {
  threadId: number;
  /** The number the texts come from. Null in the web chat. */
  verifiedPhone: string | null;
  source: BookingSource;
  /** Where clients reach this app, for links. */
  baseUrl: string;
  /** Set when Tolly gave the chat to a barber in this run. */
  handed: boolean;
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NOT_VERIFIED =
  "Not possible in this chat: we cannot check who is writing here. " +
  "Tell the client to text the shop from their phone, or to open the manage link they got when they booked.";

const DateField = z.string().describe("The date, as YYYY-MM-DD");
const TimeField = z.string().describe("The start time, 24-hour, as HH:MM");
const ServiceIds = z.array(z.number().int()).min(1).max(10).describe("Service ids from list_services");

/** Open start times for a visit. Times and barber ids only. Shared with the staff tools. */
export async function availabilityFor(
  settings: ShopSettings, input: { date: string; service_ids: number[]; staff_id?: number | null },
): Promise<Record<string, unknown>> {
  if (!isValidDate(input.date)) return { error: "Use a real date, as YYYY-MM-DD." };
  const services = await pickServices(input.service_ids);
  if (!services) return { error: "Unknown service. Use ids from the service list." };
  const barberIds = (await activeBarbers()).map((b) => b.id);
  if (input.staff_id != null && !barberIds.includes(input.staff_id)) return { error: "Unknown barber. Use an id from the barber list." };
  const duration = services.reduce((sum, s) => sum + s.duration, 0);
  const slots = await openSlots(settings, input.date, duration, input.staff_id != null ? [input.staff_id] : barberIds, shopNow(settings.timezone));
  return {
    date: input.date,
    day: DAYS[weekdayOf(input.date)],
    minutes: duration,
    open_times: slots.map((s) => ({ time: s.time, barber_ids: s.staff_ids })),
    ...(slots.length === 0 ? { note: "No open times on that day." } : {}),
  };
}

export function manageLink(baseUrl: string, token: string): string {
  return `${baseUrl}/book/manage/${token}`;
}

export function clientTools(ctx: ClientContext) {
  return {
    list_services: tool({
      description: "The services the shop offers, with real prices and lengths.",
      inputSchema: z.object({}),
      execute: async () => ({
        services: (await activeServices()).map((s) => ({ id: s.id, name: s.name, minutes: s.duration, price: money(s.price) })),
      }),
    }),

    list_barbers: tool({
      description: "The barbers who take bookings.",
      inputSchema: z.object({}),
      execute: async () => ({ barbers: (await activeBarbers()).map((b) => ({ id: b.id, name: b.name })) }),
    }),

    check_availability: tool({
      description: "Open start times on one day for the chosen services. Leave staff_id out for any barber.",
      inputSchema: z.object({ date: DateField, service_ids: ServiceIds, staff_id: z.number().int().optional() }),
      execute: async (input) => availabilityFor(await getSettings(), input),
    }),

    book_appointment: tool({
      description: ctx.verifiedPhone
        ? "Book a visit for the person texting. Only after they said yes to the exact day, time and service. Their phone number is known. Give a name only if they are new."
        : "Book a visit. Only after the client said yes to the exact day, time and service. Needs their name and mobile number.",
      inputSchema: z.object({
        name: z.string().max(100).optional().describe("The client's name"),
        phone: z.string().max(30).optional().describe("The client's mobile number. Not needed in a text thread."),
        date: DateField, time: TimeField, service_ids: ServiceIds,
        staff_id: z.number().int().optional().describe("Leave out for any barber"),
      }),
      execute: async (input) => {
        // In a text thread the number is the one the texts come from. Never one the model gives.
        const phone = ctx.verifiedPhone ?? (input.phone ?? "").trim();
        if (!isPhone(phone)) return { error: "Ask the client for their mobile number, with area code." };
        let name = (input.name ?? "").trim();
        if (!name && ctx.verifiedPhone) name = (await clientByPhone(phone))?.name ?? "";
        if (!name) return { error: "Ask the client for their name." };
        if (!isValidDate(input.date) || !TIME.test(input.time)) return { error: "Use a date as YYYY-MM-DD and a time as HH:MM." };

        const made = await oneAtATime(() => createBooking({
          name, phone, date: input.date, time: input.time, service_ids: input.service_ids,
          staff_id: input.staff_id ?? null, source: ctx.source, baseUrl: ctx.baseUrl,
        }));
        if (!made.ok) return { error: made.error };

        const saved = await get<{ name: string }>("SELECT name FROM clients WHERE id = ?", [made.clientId]);
        await linkClient(ctx.threadId, made.clientId, saved?.name ?? name);
        return {
          booked: true, reference: made.reference, date: input.date, day: DAYS[weekdayOf(input.date)], time: input.time,
          manage_link: manageLink(ctx.baseUrl, made.token),
          ...(made.checkoutUrl
            ? { pay_link: made.checkoutUrl, note: "The time is held, not final. The client must pay with the pay link to keep it. Give them the link." }
            : {}),
        };
      },
    }),

    my_bookings: tool({
      description: "The coming bookings of the person you are talking with.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.verifiedPhone) return { error: NOT_VERIFIED };
        const rows = await upcomingBookingsForPhone(ctx.verifiedPhone);
        const bookings = [];
        for (const row of rows) {
          bookings.push({
            reference: row.identifier, date: row.scheduled_date, day: DAYS[weekdayOf(row.scheduled_date)], time: row.start_time,
            barber: row.barber ?? "", services: (await servicesOf(row.id)).map((s) => s.name),
            status: row.status === "pending" ? "waiting for payment" : "booked",
            manage_link: manageLink(ctx.baseUrl, await ensureToken(row)),
          });
        }
        return { bookings };
      },
    }),

    move_booking: tool({
      description: "Move one of this person's own bookings to a new day and time. Check availability first. Only after they said yes.",
      inputSchema: z.object({ reference: z.string().max(30).describe("Like APT-12, from my_bookings"), date: DateField, time: TimeField }),
      execute: async (input) => {
        if (!ctx.verifiedPhone) return { error: NOT_VERIFIED };
        if (!isValidDate(input.date) || !TIME.test(input.time)) return { error: "Use a date as YYYY-MM-DD and a time as HH:MM." };
        const phone = ctx.verifiedPhone;
        return oneAtATime(async () => {
          const row = await bookingForPhone(phone, input.reference);
          if (!row) return { error: "This person has no coming booking with that reference." };
          const done = await moveBooking(row, input.date, input.time, "by text");
          return done.ok ? { moved: true, reference: row.identifier, date: input.date, time: input.time } : { error: done.error };
        });
      },
    }),

    cancel_booking: tool({
      description: "Cancel one of this person's own bookings. Only after they said yes.",
      inputSchema: z.object({ reference: z.string().max(30).describe("Like APT-12, from my_bookings") }),
      execute: async (input) => {
        if (!ctx.verifiedPhone) return { error: NOT_VERIFIED };
        const phone = ctx.verifiedPhone;
        return oneAtATime(async () => {
          const row = await bookingForPhone(phone, input.reference);
          if (!row) return { error: "This person has no coming booking with that reference." };
          const done = await cancelBooking(row, "by text");
          return done.ok ? { cancelled: true, reference: row.identifier } : { error: done.error };
        });
      },
    }),

    hand_to_barber: tool({
      description: "Give this chat to a barber. Use it when you cannot help, when the client asks for a person, or when you are not sure.",
      inputSchema: z.object({ reason: z.string().max(300).describe("One short sentence for the barber") }),
      execute: async (input) => {
        ctx.handed = true;
        await setMode(ctx.threadId, "human", true);
        await addMessage(ctx.threadId, "note", `The assistant asked for a barber: ${input.reason.trim() || "no reason given"}`);
        return { done: true, note: "A barber will answer in this chat. Tell the client that in one short sentence." };
      },
    }),
  };
}
