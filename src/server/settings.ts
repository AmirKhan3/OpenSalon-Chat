import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { query } from "./db.js";
import { isValidTimeZone, TIME } from "./shoptime.js";

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

const getRoute = createRoute({
  method: "get", path: "/api/settings", tags: ["Settings"], summary: "Shop settings",
  responses: { 200: { description: "Settings", content: { "application/json": { schema: z.object({ settings: SettingsSchema }) } } } },
});

const putRoute = createRoute({
  method: "put", path: "/api/settings", tags: ["Settings"], summary: "Change shop settings",
  request: { body: { content: { "application/json": { schema: SettingsSchema.partial() } }, required: true } },
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: z.object({ settings: SettingsSchema }) } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSettingsRoutes(app: OpenAPIHono): void {
  app.openapi(getRoute, async (c) => c.json({ settings: await getSettings() }, 200));
  app.openapi(putRoute, async (c) => c.json({ settings: await saveSettings(c.req.valid("json")) }, 200));
}
