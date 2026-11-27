import { query } from "./db.js";
import { METHODS, METHOD_NAMES, cents, type Method } from "./payments.js";
import { daysBetween, isValidDate } from "./shoptime.js";

/**
 * Reports.
 * - Income: money really taken (the payments table). For taxes and proof of income.
 * - Bookings: what was on the calendar.
 */

export type RangeError = { ok: false; error: string };

export function checkRange(start: string, end: string): RangeError | null {
  if (!isValidDate(start) || !isValidDate(end)) return { ok: false, error: "Use real dates, as YYYY-MM-DD." };
  if (end < start) return { ok: false, error: "The end date is before the start date." };
  if (daysBetween(start, end) > 366 * 5) return { ok: false, error: "Pick a range of five years or less." };
  return null;
}

export interface IncomeTotals { income: number; services: number; tips: number; refunds: number }

export interface IncomeReport extends IncomeTotals {
  ok: true;
  start: string;
  end: string;
  /** How many payments (refunds not counted). */
  payments: number;
  by_month: ({ month: string } & IncomeTotals)[];
  by_method: { method: Method; name: string; total: number }[];
  by_barber: { staff_id: number | null; barber: string; total: number; tips: number }[];
}

interface PayRow { kind: string; method: string; amount: number; tip: number; paid_on: string; staff_id: number | null; barber: string | null }

function emptyTotals(): IncomeTotals {
  return { income: 0, services: 0, tips: 0, refunds: 0 };
}

function add(t: IncomeTotals, row: PayRow): void {
  const amount = Number(row.amount);
  const tip = Number(row.tip);
  if (row.kind === "refund") t.refunds += -(amount + tip);
  else { t.services += amount; t.tips += tip; }
  t.income += amount + tip;
}

function rounded<T extends IncomeTotals>(t: T): T {
  return { ...t, income: cents(t.income), services: cents(t.services), tips: cents(t.tips), refunds: cents(t.refunds) };
}

/**
 * Money taken from `start` to `end` (shop-local dates, both included).
 * income = services + tips - refunds. Card fees are not subtracted.
 */
export async function incomeReport(start: string, end: string): Promise<IncomeReport | RangeError> {
  const bad = checkRange(start, end);
  if (bad) return bad;
  const rows = await query<PayRow>(
    `SELECT p.kind, p.method, p.amount, p.tip, p.paid_on, p.staff_id, s.name AS barber
     FROM payments p LEFT JOIN staff s ON s.id = p.staff_id WHERE p.paid_on >= ? AND p.paid_on <= ? ORDER BY p.paid_on, p.id`,
    [start, end],
  );
  const total = emptyTotals();
  const months = new Map<string, IncomeTotals>();
  const methods = new Map<string, number>();
  const barbers = new Map<number | null, { barber: string; total: number; tips: number }>();
  let payments = 0;
  for (const row of rows) {
    add(total, row);
    if (row.kind !== "refund") payments++;
    const month = row.paid_on.slice(0, 7);
    if (!months.has(month)) months.set(month, emptyTotals());
    add(months.get(month)!, row);
    const sum = Number(row.amount) + Number(row.tip);
    methods.set(row.method, (methods.get(row.method) ?? 0) + sum);
    const who = barbers.get(row.staff_id) ?? { barber: row.staff_id === null ? "No barber, or a removed barber" : row.barber ?? "Former barber", total: 0, tips: 0 };
    who.total += sum;
    who.tips += Number(row.tip);
    barbers.set(row.staff_id, who);
  }
  return {
    ok: true, start, end, payments, ...rounded(total),
    by_month: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, t]) => rounded({ month, ...t })),
    by_method: METHODS.filter((m) => methods.has(m)).map((m) => ({ method: m, name: METHOD_NAMES[m], total: cents(methods.get(m)!) })),
    by_barber: [...barbers.entries()].map(([staff_id, b]) => ({ staff_id, barber: b.barber, total: cents(b.total), tips: cents(b.tips) }))
      .sort((a, b) => b.total - a.total),
  };
}

export interface BookingReport {
  ok: true;
  start: string;
  end: string;
  /** Bookings on the calendar, cancelled ones left out. */
  bookings: number;
  completed: number;
  cancelled: number;
  no_shows: number;
  /** Price of the bookings that were not cancelled and not a no-show. Not money taken. */
  booked_value: number;
  completed_value: number;
  /** Clients whose first booking ever is in this range. */
  new_clients: number;
  by_barber: { barber: string; bookings: number; booked_value: number }[];
  top_services: { service: string; bookings: number }[];
}

/** What was on the calendar from `start` to `end`. Prices here are booked prices, not money taken. */
export async function bookingReport(start: string, end: string): Promise<BookingReport | RangeError> {
  const bad = checkRange(start, end);
  if (bad) return bad;
  const rows = await query<{ status: string; total_price: number; barber: string | null }>(
    `SELECT a.status, a.total_price, s.name AS barber FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.scheduled_date >= ? AND a.scheduled_date <= ?`, [start, end]);
  const report: BookingReport = {
    ok: true, start, end, bookings: 0, completed: 0, cancelled: 0, no_shows: 0, booked_value: 0, completed_value: 0, new_clients: 0,
    by_barber: [], top_services: [],
  };
  const barbers = new Map<string, { bookings: number; booked_value: number }>();
  for (const row of rows) {
    if (row.status === "cancelled") { report.cancelled++; continue; }
    report.bookings++;
    if (row.status === "no_show") { report.no_shows++; continue; }
    const price = Number(row.total_price);
    report.booked_value += price;
    if (row.status === "completed") { report.completed++; report.completed_value += price; }
    const who = barbers.get(row.barber ?? "No barber") ?? { bookings: 0, booked_value: 0 };
    who.bookings++;
    who.booked_value += price;
    barbers.set(row.barber ?? "No barber", who);
  }
  report.booked_value = cents(report.booked_value);
  report.completed_value = cents(report.completed_value);
  report.by_barber = [...barbers.entries()].map(([barber, b]) => ({ barber, bookings: b.bookings, booked_value: cents(b.booked_value) }))
    .sort((a, b) => b.bookings - a.bookings);
  report.top_services = (await query<{ service: string; bookings: number }>(
    `SELECT sv.name AS service, COUNT(*)::int AS bookings FROM appointment_services x
     JOIN appointments a ON a.id = x.appointment_id JOIN services sv ON sv.id = x.service_id
     WHERE a.scheduled_date >= ? AND a.scheduled_date <= ? AND a.status NOT IN ('cancelled', 'no_show')
     GROUP BY sv.name ORDER BY bookings DESC, sv.name LIMIT 10`, [start, end]));
  const fresh = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT client_id, MIN(scheduled_date) AS first FROM appointments WHERE status != 'cancelled' GROUP BY client_id
     ) f WHERE f.first >= ? AND f.first <= ?`, [start, end]);
  report.new_clients = fresh[0]?.n ?? 0;
  return report;
}
