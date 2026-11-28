import { parseDate, shiftDate, weekOf } from "./dates";

/** The ways the calendar can show bookings. */
export type CalendarViewKind = "schedule" | "day" | "3day" | "week";

export const CALENDAR_VIEWS: { key: CalendarViewKind; label: string }[] = [
  { key: "schedule", label: "Schedule" },
  { key: "day", label: "Day" },
  { key: "3day", label: "3 days" },
  { key: "week", label: "Week" },
];

/** How many days ahead the schedule list looks. */
export const SCHEDULE_DAYS = 30;

/** A saved view name, or "day" when it is missing or not a view. */
export function parseView(saved: string | null | undefined): CalendarViewKind {
  return CALENDAR_VIEWS.find((v) => v.key === saved)?.key ?? "day";
}

/** The days a view shows when this date is picked, in order. */
export function viewDays(view: CalendarViewKind, date: string): string[] {
  if (view === "week") return weekOf(date);
  const count = view === "day" ? 1 : view === "3day" ? 3 : SCHEDULE_DAYS;
  return Array.from({ length: count }, (_, i) => shiftDate(date, i));
}

/** How many days the "previous" and "next" buttons move in a view. */
export function viewStep(view: CalendarViewKind): number {
  return view === "day" ? 1 : view === "3day" ? 3 : 7;
}

/** A short name for a run of days, like "Nov 22 – 28, 2026" or "Nov 29 – Dec 5, 2026". */
export function rangeLabel(days: string[]): string {
  const first = parseDate(days[0]);
  const last = parseDate(days[days.length - 1]);
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  const sameYear = first.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && first.getMonth() === last.getMonth();
  const start = `${month(first)} ${first.getDate()}${sameYear ? "" : `, ${first.getFullYear()}`}`;
  const end = `${sameMonth ? "" : `${month(last)} `}${last.getDate()}, ${last.getFullYear()}`;
  return `${start} – ${end}`;
}

interface Dated { start_time: string }

/**
 * Group bookings and blocked time by day for the schedule list.
 * Days with nothing on them are left out. Each day's items are in time order.
 */
export function agendaDays<A extends Dated & { scheduled_date: string }, B extends Dated & { blocked_date: string }>(
  days: string[], appointments: A[], blocked: B[],
): { date: string; items: ({ kind: "booking"; booking: A } | { kind: "block"; block: B })[] }[] {
  return days
    .map((date) => ({
      date,
      items: [
        ...appointments.filter((a) => a.scheduled_date === date).map((booking) => ({ kind: "booking" as const, booking, at: booking.start_time })),
        ...blocked.filter((b) => b.blocked_date === date).map((block) => ({ kind: "block" as const, block, at: block.start_time })),
      ].sort((x, y) => x.at.localeCompare(y.at)).map(({ at: _at, ...item }) => item),
    }))
    .filter((day) => day.items.length > 0);
}
