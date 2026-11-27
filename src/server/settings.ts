import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { query } from "./db.js";
import { isValidTimeZone, TIME } from "./shoptime.js";
import { stripeConnected } from "./stripe.js";

/**
 * Shop settings. They live in the `settings` table (one JSON value per key)
 * and are edited on the dashboard's Settings page.
 */

const DayHoursSchema = z.object({
  closed: z.boolean(),
  open: z.string().regex(TIME, "Use a time like 09:00"),
  close: z.string().regex(TIME, "Use a time like 18:00"),
}).refine((d) => d.closed || d.open < d.close, { message: "Closing time must be after opening time." });

export const SettingsSchema = z.object({
  shop_name: z.string().trim().min(1, "Enter the shop name.").max(100),
  timezone: z.string().refine(isValidTimeZone, { message: "Unknown time zone. Use a name like America/New_York." }),
  address: z.string().trim().max(300),
  /** 7 entries. Index 0 is Sunday. */
  hours: z.array(DayHoursSchema).length(7),
  /** Minutes between start times. */
  slot_step: z.number().int().min(5).max(240),
  /** Minutes. A client cannot book a time that starts sooner than this. */
  min_notice: z.number().int().min(0).max(60 * 24 * 14),
  /** How many days ahead a client can book. */
  booking_window_days: z.number().int().min(1).max(365),
  /** What a client pays when they book online. Needs Stripe. */
  prepay_mode: z.enum(["none", "fixed", "percent", "full"]),
  /** Dollars, for the "fixed" mode. */
  prepay_amount: z.number().min(0).max(10_000),
  /** For the "percent" mode. */
  prepay_percent: z.number().int().min(1).max(100),
  /** A client who cancels at least this many hours before the visit gets the pre-pay back. */
  refund_window_hours: z.number().int().min(0).max(24 * 30),
  /** Minutes an unpaid booking holds its time. Stripe allows 30 minutes to 24 hours. */
  hold_minutes: z.number().int().min(30, "The hold time must be at least 30 minutes.").max(23 * 60),
}).openapi("Settings");

export type ShopSettings = z.infer<typeof SettingsSchema>;
export type DayHours = ShopSettings["hours"][number];

const open = (): DayHours => ({ closed: false, open: "09:00", close: "18:00" });

export function defaultSettings(): ShopSettings {
  const tz = (process.env.SHOP_TIMEZONE ?? "").trim();
  return {
    shop_name: "Our Barbershop",
    timezone: isValidTimeZone(tz) ? tz : "America/New_York",
    address: "",
    hours: [{ closed: true, open: "09:00", close: "18:00" }, open(), open(), open(), open(), open(), open()],
    slot_step: 30,
    min_notice: 60,
    booking_window_days: 30,
    prepay_mode: "none",
    prepay_amount: 10,
    prepay_percent: 50,
    refund_window_hours: 24,
    hold_minutes: 30,
  };
}

/** The saved settings, with defaults for anything not saved yet. */
export async function getSettings(): Promise<ShopSettings> {
  const merged: Record<string, unknown> = defaultSettings();
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const shape = SettingsSchema.shape as Record<string, z.ZodTypeAny>;
  for (const row of rows) {
    const field = shape[row.key];
    if (!field) continue;
    try {
      // A bad saved value falls back to the default.
      const parsed = field.safeParse(JSON.parse(row.value));
      if (parsed.success) merged[row.key] = parsed.data;
    } catch { /* keep the default */ }
  }
  return merged as ShopSettings;
}

export async function saveSettings(patch: Partial<ShopSettings>): Promise<ShopSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await query(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = utc_now()
       RETURNING key`,
      [key, JSON.stringify(value)],
    );
  }
  return getSettings();
}

const ErrorSchema = z.object({ error: z.string() });

/** stripe_connected: false means pre-pay is off, whatever the mode says. */
const SettingsResponse = z.object({ settings: SettingsSchema, stripe_connected: z.boolean() });

const getRoute = createRoute({
  method: "get", path: "/api/settings", tags: ["Settings"], summary: "Shop settings",
  responses: { 200: { description: "Settings", content: { "application/json": { schema: SettingsResponse } } } },
});

const putRoute = createRoute({
  method: "put", path: "/api/settings", tags: ["Settings"], summary: "Change shop settings",
  request: { body: { content: { "application/json": { schema: SettingsSchema.partial() } }, required: true } },
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: SettingsResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSettingsRoutes(app: OpenAPIHono): void {
  app.openapi(getRoute, async (c) => c.json({ settings: await getSettings(), stripe_connected: stripeConnected() }, 200));
  app.openapi(putRoute, async (c) => c.json({ settings: await saveSettings(c.req.valid("json")), stripe_connected: stripeConnected() }, 200));
}
