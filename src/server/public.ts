import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { getSettings } from "./settings.js";
import { openSlots } from "./availability.js";
import { isValidDate, shopNow, TIME } from "./shoptime.js";
import { oneAtATime } from "./lock.js";
import { getSmsProvider } from "./smsprovider.js";
import { prepayFor, publicPrepayPolicy, refundOnCancel, releaseExpiredHolds } from "./prepay.js";
import {
  activeBarbers, activeServices, bookingByToken, canCancel, cancelBooking, createBooking, isPhone, pickServices,
  servicesOf, TOKEN, type BookingRow,
} from "./clientbooking.js";

/**
 * The public API for clients: /api/public/*. No login.
 *
 * PRIVACY: nothing here may return another client's name, phone, notes, or
 * bookings. Availability shows only times and barber ids. A booking is shown
 * only to someone who holds its secret token, and even then without the
 * client's own contact details.
 */

const ErrorSchema = z.object({ error: z.string() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });

const NOT_FOUND = "We could not find that booking.";

/** "1,2,3" -> [1,2,3]. Null when the list is empty, too long, repeated, or not numbers. */
function parseIds(raw: string): number[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 10 || !parts.every((p) => /^\d{1,9}$/.test(p))) return null;
  const ids = parts.map(Number);
  return new Set(ids).size === ids.length ? ids : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── What a client may see of a booking ─────────────────────────────

const BookingSchema = z.object({
  reference: z.string(),
  status: z.string(),
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  barber: z.string(),
  services: z.array(z.object({ name: z.string(), duration: z.number(), price: z.number() })),
  total_price: z.number(),
  can_cancel: z.boolean(),
  prepay: z.object({
    /** Dollars paid, or to pay, at booking. 0 when there is no pre-pay. */
    amount: z.number(),
    /** none | due | paid | refunded | refund_due | expired | void */
    status: z.string(),
    /** The Stripe payment page. Only while the booking waits for the pre-pay. */
    pay_url: z.string().nullable(),
    /** UTC time. The booking is released if it is not paid by then. */
    hold_expires_at: z.string().nullable(),
    /** True when cancelling now gives the pre-pay back. */
    refund_on_cancel: z.boolean(),
    refund_window_hours: z.number(),
  }),
}).openapi("PublicBooking");

const ShopInfoSchema = z.object({ name: z.string(), address: z.string(), timezone: z.string() });
const BookingResponse = z.object({
  booking: BookingSchema, shop: ShopInfoSchema, manage_path: z.string(),
  /** Set when the client must pay now. Send them there. */
  checkout_url: z.string().optional(),
});

async function bookingView(row: BookingRow, token: string) {
  const settings = await getSettings();
  const services = await servicesOf(row.id);
  const waiting = row.status === "pending" && row.prepay_status === "due";
  return {
    booking: {
      reference: row.identifier,
      status: row.status,
      date: row.scheduled_date,
      start_time: row.start_time,
      end_time: row.end_time,
      barber: row.barber ?? "",
      services,
      total_price: row.total_price,
      can_cancel: canCancel(row, shopNow(settings.timezone)),
      prepay: {
        amount: row.prepay_amount,
        status: row.prepay_status,
        pay_url: waiting ? row.stripe_checkout_url : null,
        hold_expires_at: waiting ? row.hold_expires_at : null,
        refund_on_cancel: refundOnCancel(row, settings),
        refund_window_hours: settings.refund_window_hours,
      },
    },
    shop: { name: settings.shop_name, address: settings.address, timezone: settings.timezone },
    manage_path: `/book/manage/${token}`,
  };
}

/**
 * Where clients reach this app, without a slash at the end.
 * PUBLIC_URL when set (needed behind a proxy), else the address of this request.
 */
export function publicBaseUrl(requestUrl: string): string {
  const fixed = (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s/]+/.test(fixed)) return fixed;
  return new URL(requestUrl).origin;
}

// ── Routes ─────────────────────────────────────────────────────────

const shopRoute = createRoute({
  method: "get", path: "/api/public/shop", tags: ["Public"], summary: "Shop details for the booking page",
  responses: {
    200: json(z.object({
      shop: z.object({
        name: z.string(), address: z.string(), timezone: z.string(),
        hours: z.array(z.object({ closed: z.boolean(), open: z.string(), close: z.string() })),
        booking_window_days: z.number(),
        /** The number clients text to book. Empty when texts are not set up. */
        sms_number: z.string(),
      }),
      today: z.string(),
      services: z.array(z.object({
        id: z.number(), name: z.string(), description: z.string(), duration: z.number(),
        price: z.number(), category: z.string(),
      })),
      /** What a client pays when they book. mode "none": nothing. The amount for a visit comes with the open times. */
      prepay: z.object({
        mode: z.enum(["none", "fixed", "percent", "full"]), amount: z.number(), percent: z.number(), minimum: z.number(),
        refund_window_hours: z.number(), hold_minutes: z.number(),
      }),
      barbers: z.array(z.object({ id: z.number(), name: z.string(), title: z.string(), color: z.string() })),
    }), "Shop details"),
  },
});

const availabilityRoute = createRoute({
  method: "get", path: "/api/public/availability", tags: ["Public"], summary: "Open start times on a date",
  request: {
    query: z.object({
      date: z.string(),
      service_ids: z.string().openapi({ description: "Service ids, separated by commas" }),
      staff_id: z.string().optional().openapi({ description: "A barber id. Leave out for any barber." }),
    }),
  },
  responses: {
    200: json(z.object({
      date: z.string(), duration: z.number(),
      /** The price of the chosen services, and what the client pays now (0: nothing). */
      price: z.number(), prepay_amount: z.number(),
      slots: z.array(z.object({ time: z.string(), staff_ids: z.array(z.number()) })),
    }), "Open times"),
    400: json(ErrorSchema, "Bad request"),
  },
});

const BookingBody = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  phone: z.string().trim().max(30).refine(isPhone, {
    message: "Enter a phone number with the area code.",
  }),
  email: z.string().trim().max(200).refine((e) => e === "" || EMAIL.test(e), { message: "Enter a valid email, or leave it empty." }).optional(),
  date: z.string().refine(isValidDate, { message: "Pick a date." }),
  time: z.string().regex(TIME, "Pick a time."),
  service_ids: z.array(z.number().int().positive().max(999_999_999)).min(1, "Pick a service.").max(10)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Pick each service once." }),
  staff_id: z.number().int().positive().max(999_999_999).nullable().optional(),
});

const createBookingRoute = createRoute({
  method: "post", path: "/api/public/bookings", tags: ["Public"], summary: "Book a visit",
  request: { body: { content: { "application/json": { schema: BookingBody } }, required: true } },
  responses: {
    201: json(BookingResponse, "Booked"),
    400: json(ErrorSchema, "Bad request"),
    409: json(ErrorSchema, "The time is taken"),
    502: json(ErrorSchema, "The payment page could not be made"),
  },
});

const TokenParam = z.object({ token: z.string().max(100) });

const getBookingRoute = createRoute({
  method: "get", path: "/api/public/bookings/{token}", tags: ["Public"], summary: "A booking, by its secret link",
  request: { params: TokenParam },
  responses: { 200: json(BookingResponse, "The booking"), 404: json(ErrorSchema, "Not found") },
});

const cancelBookingRoute = createRoute({
  method: "post", path: "/api/public/bookings/{token}/cancel", tags: ["Public"], summary: "Cancel a booking",
  request: { params: TokenParam },
  responses: {
    200: json(BookingResponse, "Cancelled"),
    404: json(ErrorSchema, "Not found"),
    409: json(ErrorSchema, "Too late to cancel"),
  },
});

export function registerPublicRoutes(app: OpenAPIHono): void {
  app.openapi(shopRoute, async (c) => {
    const settings = await getSettings();
    const services = await activeServices();
    c.header("Cache-Control", "no-store");
    return c.json({
      shop: {
        name: settings.shop_name, address: settings.address, timezone: settings.timezone,
        hours: settings.hours, booking_window_days: settings.booking_window_days,
        sms_number: getSmsProvider()?.from ?? "",
      },
      today: shopNow(settings.timezone).date,
      services,
      prepay: publicPrepayPolicy(settings),
      barbers: await activeBarbers(),
    }, 200);
  });

  app.openapi(availabilityRoute, async (c) => {
    const q = c.req.valid("query");
    if (!isValidDate(q.date)) return c.json({ error: "Pick a date." }, 400);
    const ids = parseIds(q.service_ids);
    const services = ids ? await pickServices(ids) : null;
    if (!services) return c.json({ error: "Pick a service from the list." }, 400);

    const barbers = await activeBarbers();
    let staffIds = barbers.map((b) => b.id);
    if (q.staff_id !== undefined && q.staff_id !== "") {
      const id = /^\d{1,9}$/.test(q.staff_id) ? Number(q.staff_id) : NaN;
      if (!staffIds.includes(id)) return c.json({ error: "Pick a barber from the list." }, 400);
      staffIds = [id];
    }

    const settings = await getSettings();
    const duration = services.reduce((sum, s) => sum + s.duration, 0);
    const price = services.reduce((sum, s) => sum + s.price, 0);
    // Unpaid holds that ran out are open times again.
    await oneAtATime(releaseExpiredHolds);
    const slots = await openSlots(settings, q.date, duration, staffIds, shopNow(settings.timezone));
    c.header("Cache-Control", "no-store");
    return c.json({ date: q.date, duration, price, prepay_amount: prepayFor(settings, price), slots }, 200);
  });

  app.openapi(createBookingRoute, async (c) => {
    const body = c.req.valid("json");
    // This route runs one at a time (see the write queue), so no lock is needed here.
    const made = await createBooking({ ...body, source: "online", baseUrl: publicBaseUrl(c.req.url) });
    if (!made.ok) return c.json({ error: made.error }, made.status);
    const { token, checkoutUrl } = made;
    const row = await bookingByToken(token);
    return c.json({ ...(await bookingView(row!, token)), ...(checkoutUrl ? { checkout_url: checkoutUrl } : {}) }, 201);
  });

  app.openapi(getBookingRoute, async (c) => {
    const { token } = c.req.valid("param");
    if (!TOKEN.test(token)) return c.json({ error: NOT_FOUND }, 404);
    await oneAtATime(releaseExpiredHolds);
    const row = await bookingByToken(token);
    if (!row) return c.json({ error: NOT_FOUND }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(await bookingView(row, token), 200);
  });

  app.openapi(cancelBookingRoute, async (c) => {
    const { token } = c.req.valid("param");
    const row = await bookingByToken(token);
    if (!row) return c.json({ error: NOT_FOUND }, 404);
    const done = await cancelBooking(row, "online");
    if (!done.ok) return c.json({ error: done.error }, 409);
    return c.json(await bookingView((await bookingByToken(token))!, token), 200);
  });
}
