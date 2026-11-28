import { INK, PAPER } from "./palette.ts";
export function calendarSlotMinutes(
  offsetY: number,
  height: number,
  dayStart: number,
  dayEnd: number,
  interval = 15,
): number {
  if (height <= 0 || dayEnd <= dayStart || interval <= 0) return dayStart;

  const ratio = Math.min(1, Math.max(0, offsetY / height));
  const minute = dayStart + ratio * (dayEnd - dayStart);
  const rounded = dayStart + Math.round((minute - dayStart) / interval) * interval;
  return Math.min(dayEnd - interval, Math.max(dayStart, rounded));
}

export function formatCalendarTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** "09:00" becomes "9 AM" and "13:30" becomes "1:30 PM". Without the period: "9" and "1:30". */
export function formatClock(time: string, withPeriod = true): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h)) return time;
  const hour = h % 12 === 0 ? 12 : h % 12;
  const text = m ? `${hour}:${String(m).padStart(2, "0")}` : `${hour}`;
  return withPeriod ? `${text} ${h % 24 < 12 ? "AM" : "PM"}` : text;
}

/** "9 – 9:30 AM", or "11:30 AM – 12:15 PM" when the two times are on different sides of noon. */
export function formatRange(start: string, end: string): string {
  const morning = (time: string) => Number(time.split(":")[0]) % 24 < 12;
  return `${formatClock(start, morning(start) !== morning(end))} – ${formatClock(end)}`;
}

/** The text colour to use on top of a solid colour: white on dark colours, near black on light ones. */
export function inkOn(color: string | null | undefined): typeof PAPER | typeof INK {
  const hex = (color ?? "").trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return PAPER;
  const lum = luminance(full);
  // Pick whichever of the two has the higher WCAG contrast.
  return (lum + 0.05) / (luminance(INK.slice(1)) + 0.05) > 1.05 / (lum + 0.05) ? INK : PAPER;
}

/** WCAG relative luminance of a six-digit hex colour (no #). */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
