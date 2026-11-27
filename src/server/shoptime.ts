/**
 * Shop-local time. All booking dates and times are stored as the wall-clock
 * time in the shop ("2026-03-02", "14:30"), never as UTC.
 */

let clock: () => Date = () => new Date();
/** Tests only: replace the clock. Pass nothing to restore it. */
export function setShopClock(fn?: () => Date): void {
  clock = fn ?? (() => new Date());
}

/** The real moment now (UTC inside). Tests can move it with setShopClock. */
export function wallClock(): Date {
  return clock();
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ShopNow {
  /** "YYYY-MM-DD" in the shop. */
  date: string;
  /** "HH:MM" in the shop. */
  time: string;
  /** Minutes since midnight in the shop. */
  minutes: number;
}

/** The date and time in the shop right now. */
export function shopNow(timezone: string): ShopNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timezone) ? timezone : "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(clock());
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = Number(part("hour")) % 24;
  const minute = Number(part("minute"));
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
  };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcMs(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject dates like 2026-02-31, which Date would roll over.
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

/** True for a real calendar date written as "YYYY-MM-DD". */
export function isValidDate(date: string): boolean {
  return utcMs(date) !== null;
}

export function addDays(date: string, days: number): string {
  const ms = utcMs(date);
  if (ms === null) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: string): number {
  const ms = utcMs(date);
  return ms === null ? 0 : new Date(ms).getUTCDay();
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = utcMs(from);
  const b = utcMs(to);
  if (a === null || b === null) return NaN;
  return Math.round((b - a) / 86_400_000);
}

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
