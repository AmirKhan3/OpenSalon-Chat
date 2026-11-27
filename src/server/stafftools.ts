import { tool } from "ai";
import { z } from "zod";
import { query } from "./db.js";
import { getSettings } from "./settings.js";
import { isValidDate, weekdayOf } from "./shoptime.js";
import { money } from "./prepay.js";
import { activeBarbers, activeServices } from "./clientbooking.js";
import { availabilityFor, DAYS } from "./clienttools.js";

/**
 * The tools Tolly has in the barber's private chat.
 * Only staff reach this chat, so these tools may show the whole schedule.
 */

export function staffTools() {
  return {
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
  };
}
