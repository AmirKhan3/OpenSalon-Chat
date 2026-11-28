import { query } from "./db.js";
import { toMinutes } from "./scheduling.js";
import type { ShopSettings } from "./settings.js";
import { daysBetween, isValidDate, minutesToTime, timeToMinutes, weekdayOf, type ShopNow } from "./shoptime.js";

/**
 * Open times for clients.
 *
 * Nothing here returns who holds a booking. Clients see only start times and
 * which barbers are free.
 */

export type Rules = Pick<ShopSettings, "hours" | "slot_step" | "min_notice" | "booking_window_days">;

/**
 * Start times (minutes from midnight) that the shop rules allow on `date`,
 * before looking at who is busy: opening hours, slot step, minimum notice,
 * and the booking window.
 */
export function candidateStarts(rules: Rules, date: string, duration: number, now: ShopNow): number[] {
  if (!isValidDate(date) || duration <= 0) return [];
  const ahead = daysBetween(now.date, date);
  if (!(ahead >= 0) || ahead > rules.booking_window_days) return [];
  const day = rules.hours[weekdayOf(date)];
  if (!day || day.closed) return [];
  const open = timeToMinutes(day.open);
  const close = timeToMinutes(day.close);
  // The earliest start allowed, in minutes from this date's midnight.
  const earliest = now.minutes + rules.min_notice - ahead * 1440;
  const starts: number[] = [];
  for (let t = open; t + duration <= close; t += rules.slot_step) {
    if (t >= earliest) starts.push(t);
  }
  return starts;
}

type Span = [start: number, end: number];

export interface DayLoad {
  /** Busy spans per barber. */
  busy: Map<number, Span[]>;
  /** Bookings per barber that day (cancelled ones do not count). */
  bookings: Map<number, number>;
}

/** What is taken on `date`: bookings (not cancelled) and blocked time. */
export async function loadDay(date: string): Promise<DayLoad> {
  const busy = new Map<number, Span[]>();
  const bookings = new Map<number, number>();
  const add = (staffId: number, start: string, end: string): void => {
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s === null || e === null) return;
    busy.set(staffId, [...(busy.get(staffId) ?? []), [s, e]]);
  };
  const appts = await query<{ staff_id: number; start_time: string; end_time: string }>(
    "SELECT staff_id, start_time, end_time FROM appointments WHERE scheduled_date = ? AND status != 'cancelled' AND staff_id IS NOT NULL",
    [date],
  );
  for (const a of appts) {
    add(a.staff_id, a.start_time, a.end_time);
    bookings.set(a.staff_id, (bookings.get(a.staff_id) ?? 0) + 1);
  }
  const blocks = await query<{ staff_id: number; start_time: string; end_time: string }>(
    "SELECT staff_id, start_time, end_time FROM blocked_slots WHERE blocked_date = ?",
    [date],
  );
  for (const b of blocks) add(b.staff_id, b.start_time, b.end_time);
  return { busy, bookings };
}

export function isFree(load: DayLoad, staffId: number, start: number, end: number): boolean {
  return !(load.busy.get(staffId) ?? []).some(([s, e]) => start < e && s < end);
}

export interface Slot { time: string; staff_ids: number[] }

/** Open start times on `date` for a visit of `duration` minutes, with the barbers who are free. */
export async function openSlots(
  rules: Rules, date: string, duration: number, staffIds: number[], now: ShopNow,
): Promise<Slot[]> {
  const starts = candidateStarts(rules, date, duration, now);
  if (starts.length === 0 || staffIds.length === 0) return [];
  const load = await loadDay(date);
  const slots: Slot[] = [];
  for (const start of starts) {
    const free = [...staffIds].sort((a, b) => a - b).filter((id) => isFree(load, id, start, start + duration));
    if (free.length > 0) slots.push({ time: minutesToTime(start), staff_ids: free });
  }
  return slots;
}

/** For "Any barber": the free barber with the fewest bookings that day. Ties go to the lowest id. */
export function pickBarber(load: DayLoad, freeStaffIds: number[]): number | null {
  let best: number | null = null;
  for (const id of [...freeStaffIds].sort((a, b) => a - b)) {
    if (best === null || (load.bookings.get(id) ?? 0) < (load.bookings.get(best) ?? 0)) best = id;
  }
  return best;
}
