/** Date and time helpers for the booking page. Dates are "YYYY-MM-DD" in shop time. */

function utc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 is Sunday. */
export function weekdayOf(date: string): number {
  return utc(date).getUTCDay();
}

function part(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(utc(date));
}

export const shortWeekday = (date: string) => part(date, { weekday: "short" });
export const dayNumber = (date: string) => String(utc(date).getUTCDate());
export const shortMonth = (date: string) => part(date, { month: "short" });
/** "Tuesday, March 3" */
export const longDate = (date: string) => part(date, { weekday: "long", month: "long", day: "numeric" });

/** "14:30" -> "2:30 PM" */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 45 -> "45 min", 90 -> "1 hr 30 min" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** 35 -> "$35", 12.5 -> "$12.50" */
export function formatPrice(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** The dates a client can pick: today and the days ahead in the booking window. */
export function bookableDates(today: string, windowDays: number): string[] {
  return Array.from({ length: Math.max(0, windowDays) + 1 }, (_, i) => addDays(today, i));
}

/** True when the phone has 10 to 15 digits and only phone characters. */
export function isPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return /^[\d\s().+-]*$/.test(phone) && digits.length >= 10 && digits.length <= 15;
}
