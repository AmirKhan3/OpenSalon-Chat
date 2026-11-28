import { get, query } from "./db.js";
import type { Busy } from "./scheduling.js";

/** Helpers shared by the staff API and the public booking API. */

/** The next appointment reference, for example "APT-12". */
export async function nextIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'appointment_prefix'");
  // One statement, so two requests at the same moment never get the same number.
  // It also creates the counter row if it is missing.
  const rows = await query<{ value: string }>(
    `INSERT INTO _meta (key, value) VALUES ('appointment_counter', '1')
     ON CONFLICT (key) DO UPDATE SET value = (COALESCE(NULLIF(regexp_replace(_meta.value, '\\D', '', 'g'), ''), '0')::bigint + 1)::text
     RETURNING value`,
  );
  return `${prefix?.value || "APT"}-${rows[0].value}`;
}

export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * What already occupies `staffId` on `date`: their other appointments, plus any
 * time blocked off for lunch, holiday and the like.
 *
 * Cancelled appointments free the chair, and are the one status left out. That
 * matches what `/api/calendar` draws, so the rule an owner sees is simply
 * "if it is on the calendar, it is taken".
 *
 * The labels hold client names. They are for staff only.
 */
export async function busyFor(staffId: number, date: string, excludeAppointmentId?: number): Promise<Busy[]> {
  const appts = await query<{ start_time: string; end_time: string; client_name: string | null }>(
    `SELECT a.start_time, a.end_time, cl.name as client_name
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     WHERE a.staff_id = ? AND a.scheduled_date = ? AND a.status != 'cancelled'
       ${excludeAppointmentId ? "AND a.id != ?" : ""}`,
    excludeAppointmentId ? [staffId, date, excludeAppointmentId] : [staffId, date],
  );
  const blocks = await query<{ start_time: string; end_time: string; reason: string | null }>(
    "SELECT start_time, end_time, reason FROM blocked_slots WHERE staff_id = ? AND blocked_date = ?",
    [staffId, date],
  );
  return [
    ...appts.map((a): Busy => ({
      kind: "appointment", start_time: a.start_time, end_time: a.end_time,
      label: a.client_name || "another booking",
    })),
    ...blocks.map((b): Busy => ({
      kind: "blocked", start_time: b.start_time, end_time: b.end_time,
      label: b.reason || "blocked",
    })),
  ];
}
