import type { View } from "../types";

/** The four tabs in the bar at the bottom of a phone. The order is the order on screen. */
export type TabKey = "agent" | "calendar" | "inbox" | "profile";

export const PHONE_TABS: { key: TabKey; path: string; label: string }[] = [
  { key: "agent", path: "/assistant", label: "Assistant" },
  { key: "calendar", path: "/calendar", label: "Calendar" },
  { key: "inbox", path: "/inbox", label: "Inbox" },
  { key: "profile", path: "/profile", label: "Profile" },
];

export interface ProfileItem { view: View; path: string; label: string }

/**
 * The rows on the Profile screen, in groups, like the Settings app on an iPhone.
 * Each row opens its own page. Settings is not here: it has its own button at the top of the screen.
 */
export const PROFILE_GROUPS: ProfileItem[][] = [
  [
    { view: "clients", path: "/clients", label: "Clients" },
    { view: "appointments", path: "/appointments", label: "Appointments" },
    { view: "dashboard", path: "/dashboard", label: "Today" },
  ],
  [
    { view: "services", path: "/services", label: "Services" },
    { view: "staff", path: "/staff", label: "Staff" },
    { view: "products", path: "/products", label: "Products" },
  ],
  [
    { view: "automations", path: "/automations", label: "Automations" },
    { view: "reports", path: "/reports", label: "Reports" },
  ],
];

/**
 * Where the "back" link at the top of a phone screen goes, or null when the screen has none.
 * Pages opened from the Profile screen go back to it. Tab screens and detail pages have no link here.
 */
export function backFor(screen: View, hasId: boolean): { path: string; label: string } | null {
  if (hasId || screen === "profile" || tabFor(screen) !== "profile") return null;
  return { path: "/profile", label: "Profile" };
}

/**
 * The screen to show. On a phone the app opens on the assistant.
 * On a wider screen it opens on the dashboard, as before.
 * `home` is true when the address is "/" with nothing after it.
 */
export function screenFor(view: View, home: boolean, isPhone: boolean): View {
  return isPhone && home && view === "dashboard" ? "assistant" : view;
}

/** The tab to light up for a screen. Screens with no tab of their own belong to "Profile". */
export function tabFor(screen: View): TabKey {
  switch (screen) {
    case "assistant": return "agent";
    case "calendar": return "calendar";
    case "inbox": return "inbox";
    default: return "profile";
  }
}

const MINUTE = 60_000;

/** Server times are UTC text, with or without a "T". Gives NaN when the text is not a time. */
function utcMs(utc: string | null): number {
  if (!utc) return Number.NaN;
  return new Date(utc.includes("T") ? utc : `${utc.replace(" ", "T")}Z`).getTime();
}

/**
 * True when a chat should show the time above this message:
 * the first message, or one that comes 15 minutes or more after the one before.
 */
export function startsNewMoment(previous: string | null | undefined, current: string | null): boolean {
  const now = utcMs(current);
  if (Number.isNaN(now)) return false;
  const before = utcMs(previous ?? null);
  if (Number.isNaN(before)) return true;
  return now - before >= 15 * MINUTE;
}
