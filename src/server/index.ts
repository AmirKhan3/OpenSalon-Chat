import { HTTPException } from "hono/http-exception";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { query, get, run } from "./db.js";
import { findConflicts, describeConflicts, toMinutes, type Busy } from "./scheduling.js";
import { ensureSeeded } from "./seed.js";
import { oneAtATime } from "./lock.js";
import { addMinutes, busyFor, nextIdentifier } from "./booking.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerChatRoutes } from "./chat.js";
import { registerSmsRoutes } from "./sms.js";
import { registerAutomationRoutes } from "./automations.js";
import { registerCalendarRoutes } from "./calendar.js";
import { emitBookingEvent } from "./events.js";
import { utcStamp } from "./shoptime.js";
import { registerPublicRoutes } from "./public.js";
import { registerStripeRoutes, settlePrepayOnStaffChange } from "./prepay.js";
import { registerAuthRoutes, requireStaff } from "./auth.js";

const app = new OpenAPIHono({
  // A request that fails validation gets 400 { error }.
  defaultHook: (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
      return c.json({ error: `${where}${issue?.message ?? "Invalid request"}` }, 400);
    }
  },
});

app.onError((err, c) => {
  // Postgres: the row points at something that does not exist / a number is too big.
  // Hono: a body that is not valid JSON, and similar request problems.
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
    return c.json({ error: err.status === 400 ? "The request could not be read. Check the data and try again." : err.message || "Bad request" }, err.status);
  }
  const code = (err as { code?: string }).code;
  if (code === "23503") return c.json({ error: "That client, barber, or service does not exist." }, 400);
  if (code === "22003") return c.json({ error: "A number is too large." }, 400);
  console.error("[api]", c.req.method, c.req.path, err instanceof Error ? err.message : err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

// Staff login. Everything under /api needs it, except the open paths in auth.ts.
app.use("/api/*", requireStaff);
registerAuthRoutes(app);

app.doc("/api/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Tolly",
    version: "1.0.0",
    description: "Booking, scheduling, and shop management for a barbershop.",
  },
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Booking writes check for overlaps and then save. Run them one at a time,
// so two requests at the same moment cannot both take the same slot.
app.use("/api/*", async (c, next) => {
  const write = c.req.method !== "GET" && /^\/api\/(appointments|blocked-slots|public\/bookings|stripe\/webhook)(\/|$)/.test(c.req.path);
  if (write) await oneAtATime(next);
  else await next();
});

// Sample data + the appointment counter rows. Runs once per database.
app.use("/api/*", async (_c, next) => {
  await ensureSeeded();
  await next();
});

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const ConflictSchema = z.object({
  error: z.string(),
  conflicts: z.array(z.object({
    kind: z.enum(["appointment", "blocked"]),
    start_time: z.string(),
    end_time: z.string(),
    label: z.string(),
  })),
}).openapi("Conflict");

const ClientSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  notes: z.string(),
  appointment_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Client");

const StaffSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  title: z.string(),
  color: z.string(),
  active: z.number().int(),
  appointment_count: z.number().int().optional(),
  completed_appointment_count: z.number().int().optional(),
  completed_service_value: z.number().optional().describe("Sum of booked prices for completed appointments; not payments, tips, commission, or take-home pay"),
  created_at: z.string(),
}).openapi("Staff");

const ServiceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  duration: z.number().int(),
  price: z.number(),
  color: z.string(),
  category: z.string(),
  active: z.number().int(),
  created_at: z.string(),
}).openapi("Service");

const AppointmentNoteSchema = z.object({
  id: z.number().int(),
  appointment_id: z.number().int(),
  content: z.string(),
  created_at: z.string(),
}).openapi("AppointmentNote");

const AppointmentServiceSchema = z.object({
  id: z.number().int(),
  appointment_id: z.number().int(),
  service_id: z.number().int(),
  service_name: z.string().optional(),
  price: z.number(),
  duration: z.number().int(),
}).openapi("AppointmentService");

const AppointmentSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  client_id: z.number().int(),
  staff_id: z.number().int().nullable(),
  status: z.string(),
  scheduled_date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  total_price: z.number(),
  notes: z.string(),
  is_recurring: z.number().int(),
  recurrence_interval: z.string(),
  client_name: z.string().optional(),
  client_phone: z.string().optional(),
  staff_name: z.string().nullable().optional(),
  staff_color: z.string().nullable().optional(),
  service_names: z.string().nullable().optional(),
  latest_note: z.string().nullable().optional(),
  appointment_services: z.array(AppointmentServiceSchema).optional(),
  appointment_notes: z.array(AppointmentNoteSchema).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Appointment");

const BlockedSlotSchema = z.object({
  id: z.number().int(),
  staff_id: z.number().int(),
  staff_name: z.string().optional(),
  blocked_date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  reason: z.string(),
  created_at: z.string(),
}).openapi("BlockedSlot");

const ProductSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  brand: z.string(),
  category: z.string(),
  sku: z.string(),
  price: z.number(),
  cost: z.number(),
  stock: z.number().int(),
  low_stock_alert: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Product");

const IdParam = z.object({ id: z.string().regex(/^\d{1,9}$/, "Must be a number").openapi({ description: "Resource ID" }) });

// ── Helpers ────────────────────────────────────────────────────────

/** The staff member's name, for the conflict message. */
async function staffName(staffId: number): Promise<string> {
  const s = await get<{ name: string }>("SELECT name FROM staff WHERE id = ?", [staffId]);
  return s?.name || "";
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        appointments: z.number().int(),
        clients: z.number().int(),
        staff: z.number().int(),
        services: z.number().int(),
        products: z.number().int(),
        today_appointments: z.number().int(),
        upcoming_appointments: z.number().int(),
        completed_appointments: z.number().int(),
        revenue: z.number().describe("Completed booked service value; retained as revenue for API compatibility, not settled payment revenue"),
        low_stock_products: z.number().int(),
      }) } },
    },
  },
});

app.openapi(getStats, async (c) => {
  const today = new Date().toISOString().split("T")[0];
  const appointments = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM appointments");
  const clients = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM clients");
  const staff = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM staff WHERE active = 1");
  const services = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM services WHERE active = 1");
  const products = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM products");
  const todayAppointments = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM appointments WHERE scheduled_date = ?", [today]);
  const upcomingAppointments = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM appointments WHERE status IN ('booked', 'confirmed') AND scheduled_date >= ?", [today]);
  const completedAppointments = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM appointments WHERE status = 'completed'");
  const completedServiceValue = await get<{ total: number }>("SELECT COALESCE(SUM(total_price), 0) as total FROM appointments WHERE status = 'completed'");
  const lowStock = await get<{ count: number }>("SELECT COUNT(*)::int as count FROM products WHERE stock <= low_stock_alert");
  return c.json({
    appointments: appointments?.count || 0,
    clients: clients?.count || 0,
    staff: staff?.count || 0,
    services: services?.count || 0,
    products: products?.count || 0,
    today_appointments: todayAppointments?.count || 0,
    upcoming_appointments: upcomingAppointments?.count || 0,
    completed_appointments: completedAppointments?.count || 0,
    revenue: completedServiceValue?.total || 0,
    low_stock_products: lowStock?.count || 0,
  }, 200);
});

// ── Appointments ───────────────────────────────────────────────────

const listAppointments = createRoute({
  method: "get",
  path: "/api/appointments",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      date: z.string().optional(),
      staff_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated appointment list",
      content: { "application/json": { schema: z.object({ appointments: z.array(AppointmentSchema), total: z.number().int() }) } },
    },
    400: { description: "Bad filter", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listAppointments, async (c) => {
  const q = c.req.valid("query");
  const page = Math.max(parseInt(q.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  const params: unknown[] = [];

  if (q.search) {
    where += " AND (a.identifier ILIKE ? OR cl.name ILIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s);
  }
  if (q.status) { where += " AND a.status = ?"; params.push(q.status); }
  if (q.date) { where += " AND a.scheduled_date = ?"; params.push(q.date); }
  if (q.staff_id) {
    if (!/^\d{1,9}$/.test(q.staff_id)) return c.json({ error: "staff_id: Must be a number" }, 400);
    where += " AND a.staff_id = ?";
    params.push(Number(q.staff_id));
  }

  const total = await get<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM appointments a LEFT JOIN clients cl ON cl.id = a.client_id ${where}`,
    params,
  );

  const appointments = await query<any>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     ${where}
     ORDER BY a.scheduled_date DESC, a.start_time ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ appointments, total: total?.count || 0 }, 200);
});

// Calendar view - appointments for a date range
const getCalendar = createRoute({
  method: "get",
  path: "/api/calendar",
  request: {
    query: z.object({ start: z.string(), end: z.string() }),
  },
  responses: {
    200: {
      description: "Calendar appointments and blocked slots",
      content: { "application/json": { schema: z.object({
        appointments: z.array(AppointmentSchema),
        blocked_slots: z.array(BlockedSlotSchema),
      }) } },
    },
  },
});

app.openapi(getCalendar, async (c) => {
  const { start, end } = c.req.valid("query");
  const appointments = await query<any>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.scheduled_date >= ? AND a.scheduled_date <= ? AND a.status != 'cancelled'
     ORDER BY a.start_time ASC`,
    [start, end],
  );

  // Attach services to each appointment
  for (const apt of appointments) {
    const svcs = await query<any>(
      `SELECT aps.*, sv.name as service_name FROM appointment_services aps
       LEFT JOIN services sv ON sv.id = aps.service_id
       WHERE aps.appointment_id = ?`,
      [apt.id],
    );
    (apt as Record<string, unknown>).appointment_services = svcs;
  }

  const blocked = await query<any>(
    `SELECT b.*, s.name as staff_name FROM blocked_slots b
     LEFT JOIN staff s ON s.id = b.staff_id
     WHERE b.blocked_date >= ? AND b.blocked_date <= ?
     ORDER BY b.start_time ASC`,
    [start, end],
  );

  return c.json({ appointments, blocked_slots: blocked }, 200);
});

// Get single appointment
const getAppointment = createRoute({
  method: "get",
  path: "/api/appointments/{id}",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Appointment detail",
      content: { "application/json": { schema: z.object({ appointment: AppointmentSchema }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getAppointment, async (c) => {
  const id = Number(c.req.valid("param").id);
  const apt = await get<any>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.id = ?`,
    [id],
  );
  if (!apt) return c.json({ error: "Not found" }, 404);

  const svcs = await query<any>(
    `SELECT aps.*, sv.name as service_name FROM appointment_services aps
     LEFT JOIN services sv ON sv.id = aps.service_id
     WHERE aps.appointment_id = ?`,
    [id],
  );
  apt.appointment_services = svcs;

  const notes = await query<any>(
    "SELECT * FROM appointment_notes WHERE appointment_id = ? ORDER BY created_at DESC",
    [id],
  );
  apt.appointment_notes = notes;

  return c.json({ appointment: apt }, 200);
});

// Create appointment
const createAppointment = createRoute({
  method: "post",
  path: "/api/appointments",
  request: {
    body: { content: { "application/json": { schema: z.object({
      client_id: z.number().int(),
      staff_id: z.number().int().nullable().optional(),
      scheduled_date: z.string(),
      start_time: z.string().optional(),
      notes: z.string().optional(),
      is_recurring: z.number().int().optional(),
      recurrence_interval: z.string().optional(),
      service_ids: z.array(z.number().int()).optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Book even though the staff member is already busy then. Salons do deliberately overlap (a colour processes while the next client is cut), so this is allowed, but never by accident.",
      }),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ appointment: AppointmentSchema }) } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member is already busy", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(createAppointment, async (c) => {
  const body = c.req.valid("json");
  const identifier = await nextIdentifier();
  const startTime = body.start_time ?? "09:00";

  // Calculate total duration and price from services
  let totalDuration = 60;
  let totalPrice = 0;
  const serviceIds = body.service_ids || [];

  if (serviceIds.length > 0) {
    const svcs = await query<{ duration: number; price: number }>(
      `SELECT duration, price FROM services WHERE id IN (${serviceIds.map(() => "?").join(",")})`,
      serviceIds,
    );
    totalDuration = svcs.reduce((sum, s) => sum + s.duration, 0);
    totalPrice = svcs.reduce((sum, s) => sum + s.price, 0);
  }

  const start = toMinutes(startTime);
  if (start === null) return c.json({ error: "Times must be HH:MM" }, 400);
  if (totalDuration <= 0) return c.json({ error: "The appointment must have a positive duration" }, 400);
  if (start + totalDuration >= 24 * 60) {
    return c.json({ error: "Appointments must start and end on the same day" }, 400);
  }
  const endTime = addMinutes(startTime, totalDuration);

  // Nothing to contend for when the booking is unassigned.
  if (body.staff_id && !body.allow_conflict) {
    const conflicts = findConflicts(startTime, endTime, await busyFor(body.staff_id, body.scheduled_date));
    if (conflicts.length > 0) {
      return c.json({ error: describeConflicts(await staffName(body.staff_id), conflicts), conflicts }, 409);
    }
  }

  const result = await run(
    `INSERT INTO appointments (identifier, client_id, staff_id, scheduled_date, start_time, end_time, total_price, notes, is_recurring, recurrence_interval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [identifier, body.client_id, body.staff_id ?? null, body.scheduled_date,
    startTime, endTime, totalPrice,
    body.notes || "", body.is_recurring || 0, body.recurrence_interval || ""],
  );

  const aptId = result.lastInsertRowid;

  // Insert appointment services
  for (const svcId of serviceIds) {
    const svc = await get<{ duration: number; price: number }>("SELECT duration, price FROM services WHERE id = ?", [svcId]);
    if (svc) {
      await run(
        "INSERT INTO appointment_services (appointment_id, service_id, price, duration) VALUES (?, ?, ?, ?)",
        [aptId, svcId, svc.price, svc.duration],
      );
    }
  }

  const apt = await get<any>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.id = ?`,
    [aptId],
  );

  await emitBookingEvent("booking_created", Number(aptId));
  return c.json({ appointment: apt }, 201);
});

// Update appointment
const updateAppointment = createRoute({
  method: "put",
  path: "/api/appointments/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      client_id: z.number().int().optional(),
      staff_id: z.number().int().nullable().optional(),
      status: z.string().optional(),
      scheduled_date: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      total_price: z.number().optional(),
      notes: z.string().optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Move the appointment even though the staff member is already busy then.",
      }),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member is already busy", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(updateAppointment, async (c) => {
  const id = Number(c.req.valid("param").id);
  const { allow_conflict, ...body } = c.req.valid("json");

  const existing = await get<{
    staff_id: number | null; scheduled_date: string; start_time: string; end_time: string; status: string;
  }>("SELECT staff_id, scheduled_date, start_time, end_time, status FROM appointments WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  // Where the appointment lands once this patch is applied.
  const staffId = body.staff_id !== undefined ? body.staff_id : existing.staff_id;
  const date = body.scheduled_date ?? existing.scheduled_date;
  const startTime = body.start_time ?? existing.start_time;

  // Moving an appointment keeps its length. Without this, patching start_time
  // alone left the old end_time behind and silently resized the booking.
  let endTime = body.end_time ?? existing.end_time;
  if (body.start_time !== undefined && body.start_time !== existing.start_time && body.end_time === undefined) {
    const was = toMinutes(existing.start_time);
    const wasEnd = toMinutes(existing.end_time);
    const duration = was !== null && wasEnd !== null ? Math.max(wasEnd - was, 0) : 0;
    endTime = addMinutes(startTime, duration);
    body.end_time = endTime;
  }

  const moved = staffId !== existing.staff_id || date !== existing.scheduled_date
    || startTime !== existing.start_time || endTime !== existing.end_time;
  const status = body.status ?? existing.status;
  const restored = existing.status === "cancelled" && status !== "cancelled";
  // "pending" means a client is paying the pre-pay. Staff cannot set it by hand.
  if (status === "pending" && existing.status !== "pending") {
    return c.json({ error: "Only an online booking that waits for its pre-pay can have this status." }, 400);
  }

  // An existing deliberate overlap must not block notes, check-in, completion,
  // or cancellation. Restoring a cancelled booking occupies its slot again.
  if (moved || restored) {
    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    if (start === null || end === null) return c.json({ error: "Times must be HH:MM" }, 400);
    if (end <= start) return c.json({ error: "The appointment must end after it starts on the same day" }, 400);

    if (status !== "cancelled" && staffId && !allow_conflict) {
      const conflicts = findConflicts(startTime, endTime, await busyFor(staffId, date, id));
      if (conflicts.length > 0) {
        return c.json({ error: describeConflicts(await staffName(staffId), conflicts), conflicts }, 409);
      }
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (date !== existing.scheduled_date || startTime !== existing.start_time) { sets.push("moved_at = ?"); params.push(utcStamp()); }
  sets.push("updated_at = utc_now()");
  await run(`UPDATE appointments SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  await settlePrepayOnStaffChange(id, existing.status, status);
  if (status === "cancelled" && existing.status !== "cancelled") await emitBookingEvent("booking_cancelled", id);
  else if (status !== "cancelled" && (date !== existing.scheduled_date || startTime !== existing.start_time)) await emitBookingEvent("booking_moved", id);
  return c.json({ ok: true }, 200);
});

// Delete appointment
const deleteAppointment = createRoute({
  method: "delete",
  path: "/api/appointments/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteAppointment, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM appointments WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// Appointment notes
const addAppointmentNote = createRoute({
  method: "post",
  path: "/api/appointments/{id}/notes",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ content: z.string() }) } } },
  },
  responses: { 201: { description: "Note added", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(addAppointmentNote, async (c) => {
  const id = Number(c.req.valid("param").id);
  const { content } = c.req.valid("json");
  await run("INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [id, content]);
  return c.json({ ok: true }, 201);
});

const deleteNote = createRoute({
  method: "delete",
  path: "/api/notes/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteNote, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM appointment_notes WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Clients ───────────────────────────────────────────────────────

const listClients = createRoute({
  method: "get",
  path: "/api/clients",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated client list",
      content: { "application/json": { schema: z.object({ clients: z.array(ClientSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listClients, async (c) => {
  const q = c.req.valid("query");
  const page = Math.max(parseInt(q.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  const params: unknown[] = [];
  if (q.search) {
    where += " AND (c.name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s);
  }

  const total = await get<{ count: number }>(`SELECT COUNT(*)::int as count FROM clients c ${where}`, params);
  const clients = await query<any>(
    `SELECT c.*, (SELECT COUNT(*)::int FROM appointments WHERE client_id = c.id) as appointment_count
     FROM clients c ${where} ORDER BY c.name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ clients, total: total?.count || 0 }, 200);
});

const getAllClients = createRoute({
  method: "get",
  path: "/api/clients/all",
  responses: {
    200: {
      description: "All clients for lookup",
      content: { "application/json": { schema: z.object({ clients: z.array(z.object({ id: z.number().int(), name: z.string() })) }) } },
    },
  },
});

app.openapi(getAllClients, async (c) => {
  const clients = await query<{ id: number; name: string }>("SELECT id, name FROM clients ORDER BY name ASC");
  return c.json({ clients }, 200);
});

const getClient = createRoute({
  method: "get",
  path: "/api/clients/{id}",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Client detail with appointments",
      content: { "application/json": { schema: z.object({ client: ClientSchema, appointments: z.array(AppointmentSchema) }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getClient, async (c) => {
  const id = Number(c.req.valid("param").id);
  const client = await get<any>("SELECT * FROM clients WHERE id = ?", [id]);
  if (!client) return c.json({ error: "Not found" }, 404);
  const appointments = await query<any>(
    `SELECT a.*, s.name as staff_name, s.color as staff_color,
            (SELECT string_agg(sv.name, ', ' ORDER BY aps.id)
             FROM appointment_services aps
             JOIN services sv ON sv.id = aps.service_id
             WHERE aps.appointment_id = a.id) as service_names,
            (SELECT an.content
             FROM appointment_notes an
             WHERE an.appointment_id = a.id
             ORDER BY an.created_at DESC, an.id DESC
             LIMIT 1) as latest_note
     FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.client_id = ? ORDER BY a.scheduled_date DESC LIMIT 50`,
    [id],
  );
  return c.json({ client, appointments }, 200);
});

const createClient = createRoute({
  method: "post",
  path: "/api/clients",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      notes: z.string().optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ client: ClientSchema }) } } } },
});

app.openapi(createClient, async (c) => {
  const body = c.req.valid("json");
  const result = await run(
    "INSERT INTO clients (name, email, phone, notes) VALUES (?, ?, ?, ?)",
    [body.name, body.email || "", body.phone || "", body.notes || ""],
  );
  const client = await get<any>("SELECT * FROM clients WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ client }, 201);
});

const updateClient = createRoute({
  method: "put",
  path: "/api/clients/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      notes: z.string().optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(updateClient, async (c) => {
  const id = Number(c.req.valid("param").id);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    sets.push("updated_at = utc_now()");
    await run(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteClient = createRoute({
  method: "delete",
  path: "/api/clients/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteClient, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM clients WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Staff ─────────────────────────────────────────────────────────

const listStaff = createRoute({
  method: "get",
  path: "/api/staff",
  responses: {
    200: {
      description: "All staff members",
      content: { "application/json": { schema: z.object({ staff: z.array(StaffSchema) }) } },
    },
  },
});

app.openapi(listStaff, async (c) => {
  const staff = await query<any>(
    `SELECT s.*,
            COUNT(a.id)::int as appointment_count,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END), 0)::int as completed_appointment_count,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN a.total_price ELSE 0 END), 0) as completed_service_value
     FROM staff s
     LEFT JOIN appointments a ON a.staff_id = s.id
     GROUP BY s.id
     ORDER BY s.name ASC`,
  );
  return c.json({ staff }, 200);
});

const getAllStaff = createRoute({
  method: "get",
  path: "/api/staff/all",
  responses: {
    200: {
      description: "All staff for lookup",
      content: { "application/json": { schema: z.object({ staff: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string() })) }) } },
    },
  },
});

app.openapi(getAllStaff, async (c) => {
  const staff = await query<{ id: number; name: string; color: string }>("SELECT id, name, color FROM staff WHERE active = 1 ORDER BY name ASC");
  return c.json({ staff }, 200);
});

const createStaff = createRoute({
  method: "post",
  path: "/api/staff",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      color: z.string().optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ staff: StaffSchema }) } } } },
});

app.openapi(createStaff, async (c) => {
  const body = c.req.valid("json");
  const result = await run(
    "INSERT INTO staff (name, email, phone, title, color) VALUES (?, ?, ?, ?, ?)",
    [body.name, body.email || "", body.phone || "", body.title || "", body.color || "#7c3aed"],
  );
  const staff = await get<any>("SELECT * FROM staff WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ staff }, 201);
});

const updateStaff = createRoute({
  method: "put",
  path: "/api/staff/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      color: z.string().optional(),
      active: z.number().int().optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(updateStaff, async (c) => {
  const id = Number(c.req.valid("param").id);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    await run(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteStaff = createRoute({
  method: "delete",
  path: "/api/staff/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteStaff, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM staff WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Services ──────────────────────────────────────────────────────

const listServices = createRoute({
  method: "get",
  path: "/api/services",
  responses: {
    200: {
      description: "All services",
      content: { "application/json": { schema: z.object({ services: z.array(ServiceSchema) }) } },
    },
  },
});

app.openapi(listServices, async (c) => {
  const services = await query<any>("SELECT * FROM services ORDER BY category ASC, name ASC");
  return c.json({ services }, 200);
});

const createService = createRoute({
  method: "post",
  path: "/api/services",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      duration: z.number().int().optional(),
      price: z.number().optional(),
      color: z.string().optional(),
      category: z.string().optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ service: ServiceSchema }) } } } },
});

app.openapi(createService, async (c) => {
  const body = c.req.valid("json");
  const result = await run(
    "INSERT INTO services (name, description, duration, price, color, category) VALUES (?, ?, ?, ?, ?, ?)",
    [body.name, body.description || "", body.duration || 60, body.price || 0, body.color || "#6b7280", body.category || ""],
  );
  const service = await get<any>("SELECT * FROM services WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ service }, 201);
});

const updateService = createRoute({
  method: "put",
  path: "/api/services/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      duration: z.number().int().optional(),
      price: z.number().optional(),
      color: z.string().optional(),
      category: z.string().optional(),
      active: z.number().int().optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(updateService, async (c) => {
  const id = Number(c.req.valid("param").id);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    await run(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteService = createRoute({
  method: "delete",
  path: "/api/services/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteService, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM services WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Blocked Slots ─────────────────────────────────────────────────

const createBlockedSlot = createRoute({
  method: "post",
  path: "/api/blocked-slots",
  request: {
    body: { content: { "application/json": { schema: z.object({
      staff_id: z.number().int(),
      blocked_date: z.string(),
      start_time: z.string(),
      end_time: z.string(),
      reason: z.string().optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Block the time even though it overlaps an appointment or another blocked slot.",
      }),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member already has an appointment or blocked time", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(createBlockedSlot, async (c) => {
  const { allow_conflict, ...body } = c.req.valid("json");
  const start = toMinutes(body.start_time);
  const end = toMinutes(body.end_time);
  if (start === null || end === null) return c.json({ error: "Times must be HH:MM" }, 400);
  if (end <= start) return c.json({ error: "Blocked time must end after it starts on the same day" }, 400);

  if (!allow_conflict) {
    const conflicts = findConflicts(
      body.start_time,
      body.end_time,
      await busyFor(body.staff_id, body.blocked_date),
    );
    if (conflicts.length > 0) {
      return c.json({ error: describeConflicts(await staffName(body.staff_id), conflicts, "block"), conflicts }, 409);
    }
  }

  await run(
    "INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?)",
    [body.staff_id, body.blocked_date, body.start_time, body.end_time, body.reason || ""],
  );
  return c.json({ ok: true }, 201);
});

const deleteBlockedSlot = createRoute({
  method: "delete",
  path: "/api/blocked-slots/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteBlockedSlot, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM blocked_slots WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Products ──────────────────────────────────────────────────────

const listProducts = createRoute({
  method: "get",
  path: "/api/products",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      category: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated product list",
      content: { "application/json": { schema: z.object({ products: z.array(ProductSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listProducts, async (c) => {
  const q = c.req.valid("query");
  const page = Math.max(parseInt(q.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  const params: unknown[] = [];
  if (q.search) {
    where += " AND (p.name ILIKE ? OR p.brand ILIKE ? OR p.sku ILIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s);
  }
  if (q.category) { where += " AND p.category = ?"; params.push(q.category); }

  const total = await get<{ count: number }>(`SELECT COUNT(*)::int as count FROM products p ${where}`, params);
  const products = await query<any>(
    `SELECT * FROM products p ${where} ORDER BY p.name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ products, total: total?.count || 0 }, 200);
});

const createProduct = createRoute({
  method: "post",
  path: "/api/products",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      brand: z.string().optional(),
      category: z.string().optional(),
      sku: z.string().optional(),
      price: z.number().min(0).optional(),
      cost: z.number().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      low_stock_alert: z.number().int().min(0).optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ product: ProductSchema }) } } } },
});

app.openapi(createProduct, async (c) => {
  const body = c.req.valid("json");
  const result = await run(
    "INSERT INTO products (name, brand, category, sku, price, cost, stock, low_stock_alert) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [body.name, body.brand || "", body.category || "", body.sku || "",
    body.price ?? 0, body.cost ?? 0, body.stock ?? 0, body.low_stock_alert ?? 5],
  );
  const product = await get<any>("SELECT * FROM products WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ product }, 201);
});

const updateProduct = createRoute({
  method: "put",
  path: "/api/products/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      brand: z.string().optional(),
      category: z.string().optional(),
      sku: z.string().optional(),
      price: z.number().min(0).optional(),
      cost: z.number().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      low_stock_alert: z.number().int().min(0).optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(updateProduct, async (c) => {
  const id = Number(c.req.valid("param").id);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    sets.push("updated_at = utc_now()");
    await run(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteProduct = createRoute({
  method: "delete",
  path: "/api/products/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } } },
});

app.openapi(deleteProduct, async (c) => {
  const id = Number(c.req.valid("param").id);
  await run("DELETE FROM products WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

registerSettingsRoutes(app);
registerPublicRoutes(app);
registerStripeRoutes(app);
registerChatRoutes(app);
registerSmsRoutes(app);
registerAutomationRoutes(app);
registerCalendarRoutes(app);

export default app;
