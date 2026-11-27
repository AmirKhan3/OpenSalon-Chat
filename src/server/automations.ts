import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { getSettings, type ShopSettings } from "./settings.js";
import { addDays, isValidTimeZone, TIME, wallClock, weekdayOf } from "./shoptime.js";
import { ensureToken, servicesOf } from "./clientbooking.js";
import { manageLink } from "./clienttools.js";
import { money } from "./prepay.js";
import { agentConfigured, runStaffTask, sign } from "./agent.js";
import { addMessage } from "./chatstore.js";
import { isOptedOut, smsThreadForPhone } from "./sms.js";
import { getSmsProvider, toE164 } from "./smsprovider.js";
import { onBookingEvent, type BookingEvent } from "./events.js";

/**
 * Automations: routines the owner (or the assistant, when asked) sets up once.
 * The server runs them. Every automatic text to a client goes through here.
 *
 * Rules that keep them safe:
 * - A run claims its key in `automation_runs` BEFORE it acts. The key is unique,
 *   so a reminder is never sent twice, even if two ticks overlap.
 * - The scheduler looks ahead only. A routine never fires for a moment before it
 *   was made or turned back on, and a booking never gets a reminder for a moment
 *   before the booking was made.
 * - A "before" reminder is never sent in the last 10 minutes before the visit.
 * - Texts go through one helper: it adds the signature, skips clients who opted
 *   out, saves the text in the client's thread, and records the result.
 *
 * All times here are shop-local seconds (the shop's wall clock, counted as if it were UTC).
 */

// ── Shapes ─────────────────────────────────────────────────────────

export const TRIGGERS = [
  "daily", "before_appointment", "after_appointment", "booking_created", "prepay_paid", "booking_cancelled", "booking_moved",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const ACTIONS = ["text_client", "agent_task"] as const;
export type Action = (typeof ACTIONS)[number];

const STATUSES = ["pending", "booked", "confirmed", "in_progress", "completed", "cancelled", "no_show"] as const;
const SOURCES = ["staff", "online", "chat", "sms"] as const;

export const PLACEHOLDERS = [
  "client_first_name", "client_name", "date", "day", "time", "end_time", "barber", "services", "price", "prepay_amount",
  "prepay_link", "shop_name", "shop_address", "access_instructions", "manage_link", "calendar_link", "agent_name",
] as const;

const MAX_BEFORE_AFTER = 60 * 24 * 30;
/** A "before" reminder is not sent this close to the visit. */
const QUIET_BEFORE_START = 10 * 60;
/** How late a routine may still act after its moment, when the server was busy or down. */
const GRACE = { daily: 2 * 3600, before: 3600, after: 12 * 3600 };

const DailySchema = z.object({
  time: z.string().regex(TIME, "Use a time like 08:00."),
  days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day.").max(7),
  scope: z.enum(["today", "tomorrow"]),
}).strict();
const BeforeSchema = z.object({
  minutes: z.number().int().min(15, "A reminder must be at least 15 minutes before the visit.").max(MAX_BEFORE_AFTER),
}).strict();
const AfterSchema = z.object({ minutes: z.number().int().min(0).max(MAX_BEFORE_AFTER) }).strict();
const NoConfigSchema = z.object({}).strict();

const TextSchema = z.object({
  message: z.string().trim().min(1, "Write the text to send.").max(600, "That text is too long. Keep it under 600 characters."),
}).strict();
const TaskSchema = z.object({
  instructions: z.string().trim().min(1, "Write what the assistant should do.").max(2000),
}).strict();

const ids = z.array(z.number().int().positive()).max(100);
const FiltersSchema = z.object({
  statuses: z.array(z.enum(STATUSES)).max(STATUSES.length).optional(),
  sources: z.array(z.enum(SOURCES)).max(SOURCES.length).optional(),
  staff_ids: ids.optional(),
  service_ids: ids.optional(),
  first_visit: z.boolean().optional(),
}).strict();
export type Filters = z.infer<typeof FiltersSchema>;

export interface AutomationInput {
  name: string;
  enabled: boolean;
  trigger: Trigger;
  trigger_config: Record<string, unknown>;
  action: Action;
  action_config: Record<string, unknown>;
  filters: Filters;
}

interface Row {
  id: number; name: string; enabled: number; trigger: Trigger; trigger_config: string; action: Action; action_config: string;
  filters: string; created_by: string; builtin_key: string | null; armed_at: string; created_at: string; updated_at: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const filtersOf = (row: Row): Filters => {
  const parsed = FiltersSchema.safeParse(parseJson(row.filters));
  return parsed.success ? parsed.data : {};
};

/** Placeholders in a template that we do not know. */
export function unknownPlaceholders(template: string): string[] {
  const bad = new Set<string>();
  for (const match of template.matchAll(/\{([^{}\n]*)\}/g)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(match[1])) bad.add(`{${match[1]}}`);
  }
  return [...bad];
}

function placeholderError(template: string): string | null {
  const bad = unknownPlaceholders(template);
  if (bad.length === 0) return null;
  return `We do not know ${bad.join(", ")}. You can use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}`;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Check the values.";
  if (issue.code === "unrecognized_keys") return `Unknown field: ${(issue as { keys?: string[] }).keys?.join(", ") ?? ""}.`;
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/** Check a whole automation. Returns the cleaned values or a plain error. */
export function validateAutomation(input: unknown): Result<AutomationInput> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Give the automation a name." };
  if (name.length > 80) return { ok: false, error: "The name is too long." };
  if (!(TRIGGERS as readonly unknown[]).includes(raw.trigger)) return { ok: false, error: `Unknown "when". Use one of: ${TRIGGERS.join(", ")}.` };
  if (!(ACTIONS as readonly unknown[]).includes(raw.action)) return { ok: false, error: `Unknown "do". Use one of: ${ACTIONS.join(", ")}.` };
  const trigger = raw.trigger as Trigger;
  const action = raw.action as Action;

  let triggerConfig: Record<string, unknown>;
  if (trigger === "daily") {
    const parsed = DailySchema.safeParse(raw.trigger_config ?? {});
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    triggerConfig = { ...parsed.data, days: [...new Set(parsed.data.days)].sort((a, b) => a - b) };
  } else {
    const schema = trigger === "before_appointment" ? BeforeSchema : trigger === "after_appointment" ? AfterSchema : NoConfigSchema;
    const parsed = schema.safeParse(raw.trigger_config ?? {});
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    triggerConfig = parsed.data;
  }

  let actionConfig: Record<string, unknown>;
  if (action === "text_client") {
    const parsed = TextSchema.safeParse(raw.action_config ?? {});
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    const bad = placeholderError(parsed.data.message);
    if (bad) return { ok: false, error: bad };
    actionConfig = parsed.data;
  } else {
    const parsed = TaskSchema.safeParse(raw.action_config ?? {});
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    actionConfig = parsed.data;
  }

  const filters = FiltersSchema.safeParse(raw.filters ?? {});
  if (!filters.success) return { ok: false, error: firstIssue(filters.error) };

  return {
    ok: true,
    value: {
      name, enabled: raw.enabled === undefined ? true : raw.enabled === true || raw.enabled === 1,
      trigger, trigger_config: triggerConfig, action, action_config: actionConfig, filters: filters.data,
    },
  };
}

// ── Time ───────────────────────────────────────────────────────────

/** A real moment as shop-local seconds. */
function localSeconds(moment: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timezone) ? timezone : "UTC",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(moment);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) / 1000;
}

/** A shop date and time ("2026-03-03", "14:30") as shop-local seconds. */
function at(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h || 0, mi || 0) / 1000;
}

const dateOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** A saved UTC time ("2026-03-02 15:00:00" or ISO) as shop-local seconds. Unknown counts as long ago. */
function savedMoment(text: string | null, timezone: string): number {
  if (!text) return -Infinity;
  const date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? -Infinity : localSeconds(date, timezone);
}

function niceTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const niceDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(at(date, "00:00") * 1000));

const dayName = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(at(date, "00:00") * 1000));

// ── Appointments ───────────────────────────────────────────────────

interface Apt {
  id: number; identifier: string; client_id: number | null; staff_id: number | null; status: string; scheduled_date: string;
  start_time: string; end_time: string; total_price: number; source: string; public_token: string | null; prepay_amount: number | null;
  prepay_status: string | null; stripe_checkout_url: string | null; created_at: string | null;
  client_name: string | null; client_phone: string | null; barber: string | null;
}

const APT_SELECT = `SELECT a.id, a.identifier, a.client_id, a.staff_id, a.status, a.scheduled_date, a.start_time, a.end_time, a.total_price,
  a.source, a.public_token, a.prepay_amount, a.prepay_status, a.stripe_checkout_url, a.created_at,
  cl.name AS client_name, cl.phone AS client_phone, s.name AS barber
  FROM appointments a LEFT JOIN clients cl ON cl.id = a.client_id LEFT JOIN staff s ON s.id = a.staff_id`;

async function loadApt(id: number): Promise<Apt | null> {
  return (await get<Apt>(`${APT_SELECT} WHERE a.id = ?`, [id])) ?? null;
}

function aptsBetween(from: string, to: string): Promise<Apt[]> {
  return query<Apt>(`${APT_SELECT} WHERE a.scheduled_date >= ? AND a.scheduled_date <= ? ORDER BY a.scheduled_date, a.start_time, a.id`, [from, to]);
}

/** Statuses a timed routine skips unless its filter names them. */
const QUIET_STATUSES = ["cancelled", "no_show", "pending"];

async function matches(filters: Filters, apt: Apt, timed: boolean): Promise<boolean> {
  if (filters.statuses && filters.statuses.length > 0) {
    if (!(filters.statuses as string[]).includes(apt.status)) return false;
  } else if (timed && QUIET_STATUSES.includes(apt.status)) return false;
  if (filters.sources && filters.sources.length > 0 && !(filters.sources as string[]).includes(apt.source)) return false;
  if (filters.staff_ids && filters.staff_ids.length > 0 && (apt.staff_id === null || !filters.staff_ids.includes(apt.staff_id))) return false;
  if (filters.service_ids && filters.service_ids.length > 0) {
    const rows = await query<{ service_id: number }>("SELECT service_id FROM appointment_services WHERE appointment_id = ?", [apt.id]);
    if (!rows.some((r) => filters.service_ids!.includes(r.service_id))) return false;
  }
  if (filters.first_visit !== undefined) {
    const earlier = apt.client_id === null ? null : await get<{ id: number }>(
      `SELECT id FROM appointments WHERE client_id = ? AND id != ? AND status NOT IN ('cancelled', 'no_show')
       AND (scheduled_date < ? OR (scheduled_date = ? AND start_time < ?)) LIMIT 1`,
      [apt.client_id, apt.id, apt.scheduled_date, apt.scheduled_date, apt.start_time],
    );
    if ((earlier === undefined || earlier === null) !== filters.first_visit) return false;
  }
  return true;
}

// ── Templates ──────────────────────────────────────────────────────

/** The address in links we send. Never taken from a request: a text must not carry a link someone else chose. */
function baseUrl(): string {
  return (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || `http://localhost:${Number(process.env.PORT) || 8787}`;
}

type Values = Record<(typeof PLACEHOLDERS)[number], string>;

async function valuesFor(apt: Apt, settings: ShopSettings): Promise<Values> {
  const name = (apt.client_name ?? "").trim();
  const link = manageLink(baseUrl(), await ensureToken(apt));
  const services = (await servicesOf(apt.id)).map((s) => s.name);
  const prepay = Number(apt.prepay_amount ?? 0);
  return {
    client_first_name: name.split(/\s+/)[0] || "there",
    client_name: name || "there",
    date: niceDate(apt.scheduled_date),
    day: dayName(apt.scheduled_date),
    time: niceTime(apt.start_time),
    end_time: niceTime(apt.end_time),
    barber: apt.barber || "your barber",
    services: services.join(", ") || "your visit",
    price: money(Number(apt.total_price ?? 0)),
    prepay_amount: prepay > 0 ? money(prepay) : "",
    // The pay link works only while the booking waits for its pre-pay.
    prepay_link: apt.status === "pending" && apt.stripe_checkout_url ? apt.stripe_checkout_url : "",
    shop_name: settings.shop_name,
    shop_address: settings.address,
    access_instructions: settings.access_instructions,
    manage_link: link,
    calendar_link: `${link}?calendar=1`,
    agent_name: settings.agent_name,
  };
}

function sampleValues(settings: ShopSettings): Values {
  const link = manageLink(baseUrl(), "example");
  return {
    client_first_name: "Alex", client_name: "Alex Smith", date: "Tuesday, March 3", day: "Tuesday", time: "2:30 PM", end_time: "3:00 PM",
    barber: "Marcus", services: "Haircut", price: money(35), prepay_amount: money(10), prepay_link: `${baseUrl()}/pay/example`,
    shop_name: settings.shop_name, shop_address: settings.address, access_instructions: settings.access_instructions,
    manage_link: link, calendar_link: `${link}?calendar=1`, agent_name: settings.agent_name,
  };
}

/** Fill the placeholders. An empty value leaves no double space or empty line behind. */
export function render(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? values[key] : whole))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Runs ───────────────────────────────────────────────────────────

/** Take the key. Returns the run id, or null when this run already happened. */
async function claim(automationId: number, appointmentId: number | null, key: string): Promise<number | null> {
  const rows = await query<{ id: number }>(
    `INSERT INTO automation_runs (automation_id, appointment_id, run_key, status) VALUES (?, ?, ?, 'running')
     ON CONFLICT (run_key) DO NOTHING RETURNING id`,
    [automationId, appointmentId, key],
  );
  return rows[0]?.id ?? null;
}

async function finish(runId: number, status: "sent" | "done" | "skipped" | "failed", detail: string): Promise<void> {
  await run("UPDATE automation_runs SET status = ?, detail = ? WHERE id = ?", [status, detail.slice(0, 500), runId]);
}

/**
 * The one way an automation texts a client.
 * Adds the signature, skips clients who opted out, saves the text in the client's thread, records the result.
 */
async function sendText(runId: number, template: string, apt: Apt, settings: ShopSettings): Promise<void> {
  const phone = toE164(apt.client_phone ?? "");
  if (!phone) return finish(runId, "skipped", "The client has no mobile number.");
  if (await isOptedOut(phone)) return finish(runId, "skipped", "The client opted out of texts.");
  if (!getSmsProvider()) return finish(runId, "skipped", "Texts are not set up.");
  const body = render(template, await valuesFor(apt, settings));
  if (!body) return finish(runId, "skipped", "The text was empty.");
  const thread = await smsThreadForPhone(phone);
  if (!thread) return finish(runId, "skipped", "The client has no mobile number.");
  const message = await addMessage(thread.id, "agent", sign(body, settings));
  if (message.delivery_status === "sent") return finish(runId, "sent", message.body);
  return finish(runId, "failed", message.delivery_status.replace(/^failed: /, "") || "The text was not sent.");
}

const background = new Set<Promise<void>>();

/** For tests: wait until no automation task runs in the background. */
export async function automationsIdle(): Promise<void> {
  while (background.size > 0) await Promise.all([...background]);
}

/** Let the assistant do the task. Runs after we return, so a booking never waits for the AI. */
function startTask(runId: number, row: Row, apt: Apt | null): void {
  const instructions = String(parseJson(row.action_config).instructions ?? "");
  const about = apt
    ? `\n\nThis run is about one visit: reference ${apt.identifier}, client ${apt.client_name ?? "unknown"}, ${niceDate(apt.scheduled_date)} at ${niceTime(apt.start_time)}.`
    : "";
  const task: Promise<void> = (async () => {
    try {
      const result = await runStaffTask(row.name, `${instructions}${about}`);
      await finish(runId, result.ok ? "done" : "failed", result.text);
    } catch (err) {
      console.error(`Automation task failed: ${err instanceof Error ? err.message : "unknown error"}`);
      await finish(runId, "failed", "The assistant had an error.").catch(() => undefined);
    }
  })().finally(() => { background.delete(task); });
  background.add(task);
}

async function act(row: Row, apt: Apt, key: string, settings: ShopSettings): Promise<void> {
  const runId = await claim(row.id, apt.id, key);
  if (runId === null) return;
  if (row.action === "agent_task") return startTask(runId, row, apt);
  try {
    await sendText(runId, String(parseJson(row.action_config).message ?? ""), apt, settings);
  } catch (err) {
    console.error(`Automation text failed: ${err instanceof Error ? err.message : "unknown error"}`);
    await finish(runId, "failed", "The text was not sent.");
  }
}

// ── Scheduler ──────────────────────────────────────────────────────

async function runDaily(row: Row, settings: ShopSettings, now: number): Promise<void> {
  const config = DailySchema.safeParse(parseJson(row.trigger_config));
  if (!config.success) return;
  const today = dateOf(now);
  if (!config.data.days.includes(weekdayOf(today))) return;
  const moment = at(today, config.data.time);
  if (now < moment || now - moment > GRACE.daily) return;
  if (savedMoment(row.armed_at, settings.timezone) > moment) return;

  if (row.action === "agent_task") {
    const runId = await claim(row.id, null, `a${row.id}:${today}T${config.data.time}`);
    if (runId !== null) startTask(runId, row, null);
    return;
  }
  const day = config.data.scope === "tomorrow" ? addDays(today, 1) : today;
  const filters = filtersOf(row);
  for (const apt of await aptsBetween(day, day)) {
    // A visit that already started needs no "see you today".
    if (at(apt.scheduled_date, apt.start_time) <= now) continue;
    // Booked after the routine's moment: it gets no text for it.
    if (savedMoment(apt.created_at, settings.timezone) > moment) continue;
    if (!(await matches(filters, apt, true))) continue;
    await act(row, apt, `a${row.id}:apt${apt.id}:${today}`, settings);
  }
}

async function runAround(row: Row, settings: ShopSettings, now: number): Promise<void> {
  const before = row.trigger === "before_appointment";
  const config = (before ? BeforeSchema : AfterSchema).safeParse(parseJson(row.trigger_config));
  if (!config.success) return;
  const offset = config.data.minutes * 60;
  const today = dateOf(now);
  const span = Math.ceil(config.data.minutes / 1440) + 1;
  const armed = savedMoment(row.armed_at, settings.timezone);
  const filters = filtersOf(row);
  const apts = before ? await aptsBetween(today, addDays(today, span)) : await aptsBetween(addDays(today, -span - 1), today);

  for (const apt of apts) {
    const start = at(apt.scheduled_date, apt.start_time);
    const moment = before ? start - offset : Math.max(at(apt.scheduled_date, apt.end_time), start) + offset;
    if (now < moment || now - moment > (before ? GRACE.before : GRACE.after)) continue;
    if (armed > moment) continue;
    if (before) {
      if (now > start - QUIET_BEFORE_START) continue;
      // Booked less than the lead time before the visit: the moment was before the booking.
      if (savedMoment(apt.created_at, settings.timezone) > moment) continue;
    }
    // Check the filters first: a visit marked "completed" a little late still gets its text.
    if (!(await matches(filters, apt, true))) continue;
    await act(row, apt, `a${row.id}:apt${apt.id}:${apt.scheduled_date}T${apt.start_time}`, settings);
  }
}

let ticking = false;

/** Run every routine whose moment came. The server calls this every minute. */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const settings = await getSettings();
    const now = localSeconds(wallClock(), settings.timezone);
    const rows = await query<Row>(
      "SELECT * FROM automations WHERE enabled = 1 AND trigger IN ('daily', 'before_appointment', 'after_appointment') ORDER BY id",
    );
    for (const row of rows) {
      try {
        if (row.trigger === "daily") await runDaily(row, settings, now);
        else await runAround(row, settings, now);
      } catch (err) {
        console.error(`Automation ${row.id} failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  } finally {
    ticking = false;
  }
}

// ── Events ─────────────────────────────────────────────────────────

/**
 * Something happened to a booking. Runs inside the booking write queue,
 * so nothing here may use that queue.
 */
export async function fireEvent(event: BookingEvent, appointmentId: number): Promise<void> {
  const rows = await query<Row>("SELECT * FROM automations WHERE enabled = 1 AND trigger = ? ORDER BY id", [event]);
  if (rows.length === 0) return;
  const apt = await loadApt(appointmentId);
  if (!apt) return;
  const settings = await getSettings();
  const when = `${apt.scheduled_date}T${apt.start_time}`;
  const minute = wallClock().toISOString().slice(0, 16);
  const suffix = event === "booking_created" ? "created" : event === "prepay_paid" ? "paid"
    : event === "booking_cancelled" ? `cancelled:${when}` : `moved:${when}@${minute}`;
  for (const row of rows) {
    if (!(await matches(filtersOf(row), apt, false))) continue;
    await act(row, apt, `a${row.id}:apt${apt.id}:${suffix}`, settings);
  }
}

onBookingEvent(fireEvent);

// ── Store ──────────────────────────────────────────────────────────

export interface AutomationView {
  id: number; name: string; enabled: boolean; trigger: string; trigger_config: Record<string, any>; action: string;
  action_config: Record<string, any>; filters: Record<string, any>; created_by: string; builtin_key: string | null;
  summary: string; last_run: { status: string; detail: string; created_at: string } | null; created_at: string; updated_at: string;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function span(minutes: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes > 0 && minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes > 0 && minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

const or = (words: string[]): string => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`);

interface Names { staff: Map<number, string>; services: Map<number, string> }

async function loadNames(): Promise<Names> {
  const staff = await query<{ id: number; name: string }>("SELECT id, name FROM staff");
  const services = await query<{ id: number; name: string }>("SELECT id, name FROM services");
  return { staff: new Map(staff.map((s) => [s.id, s.name])), services: new Map(services.map((s) => [s.id, s.name])) };
}

/** The routine in plain English, for the card on the dashboard. */
function summarize(trigger: string, config: Record<string, any>, action: string, filters: Filters, names: Names): string {
  const text = action === "text_client";
  let when: string;
  let what = text ? "text the client" : "the assistant does a task";
  if (trigger === "daily") {
    const days: number[] = Array.isArray(config.days) ? config.days : [];
    const which = days.length === 7 ? "Every day" : `Every ${days.map((d) => SHORT_DAYS[d]).join(", ")}`;
    when = `${which} at ${niceTime(String(config.time ?? "08:00"))}`;
    if (text) what = `text each client with a visit ${config.scope === "tomorrow" ? "the next day" : "that day"}`;
  } else if (trigger === "before_appointment") when = `${span(Number(config.minutes ?? 0))} before a visit`;
  else if (trigger === "after_appointment") when = Number(config.minutes ?? 0) === 0 ? "When a visit ends" : `${span(Number(config.minutes))} after a visit`;
  else if (trigger === "booking_created") when = "When a visit is booked";
  else if (trigger === "prepay_paid") when = "When a client pays the pre-pay";
  else if (trigger === "booking_cancelled") when = "When a visit is cancelled";
  else when = "When a visit is moved";

  const only: string[] = [];
  if (filters.sources?.length) {
    const label: Record<string, string> = { staff: "by staff", online: "online", chat: "in the web chat", sms: "by text" };
    only.push(`visits booked ${or(filters.sources.map((s) => label[s]))}`);
  }
  if (filters.statuses?.length) only.push(`status ${or(filters.statuses.map((s) => s.replace("_", " ")))}`);
  if (filters.staff_ids?.length) only.push(`with ${or(filters.staff_ids.map((id) => names.staff.get(id) ?? `barber #${id}`))}`);
  if (filters.service_ids?.length) only.push(`service ${or(filters.service_ids.map((id) => names.services.get(id) ?? `#${id}`))}`);
  if (filters.first_visit === true) only.push("first visits");
  if (filters.first_visit === false) only.push("returning clients");
  return `${when}, ${what}.${only.length > 0 ? ` Only for: ${only.join("; ")}.` : ""}`;
}

async function toView(row: Row, names: Names): Promise<AutomationView> {
  const config = parseJson(row.trigger_config);
  const filters = filtersOf(row);
  const last = await get<{ status: string; detail: string; created_at: string }>(
    "SELECT status, detail, created_at FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1", [row.id],
  );
  return {
    id: row.id, name: row.name, enabled: row.enabled === 1, trigger: row.trigger, trigger_config: config, action: row.action,
    action_config: parseJson(row.action_config), filters, created_by: row.created_by, builtin_key: row.builtin_key,
    summary: summarize(row.trigger, config, row.action, filters, names),
    last_run: last ? { status: last.status, detail: last.detail, created_at: last.created_at } : null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export async function listAutomations(): Promise<AutomationView[]> {
  const rows = await query<Row>("SELECT * FROM automations ORDER BY id");
  const names = await loadNames();
  const views: AutomationView[] = [];
  for (const row of rows) views.push(await toView(row, names));
  return views;
}

async function rowById(id: number): Promise<Row | null> {
  return (await get<Row>("SELECT * FROM automations WHERE id = ?", [id])) ?? null;
}

export async function getAutomation(id: number): Promise<AutomationView | null> {
  const row = await rowById(id);
  return row ? toView(row, await loadNames()) : null;
}

const MAX_AUTOMATIONS = 100;

async function insert(value: AutomationInput, createdBy: "system" | "staff" | "agent", builtinKey: string | null): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO automations (name, enabled, trigger, trigger_config, action, action_config, filters, created_by, builtin_key, armed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [value.name, value.enabled ? 1 : 0, value.trigger, JSON.stringify(value.trigger_config), value.action,
      JSON.stringify(value.action_config), JSON.stringify(value.filters), createdBy, builtinKey, wallClock().toISOString()],
  );
  return rows[0].id;
}

export async function createAutomation(input: unknown, createdBy: "staff" | "agent"): Promise<Result<AutomationView>> {
  const checked = validateAutomation(input);
  if (!checked.ok) return checked;
  const count = await get<{ count: number }>("SELECT COUNT(*)::int AS count FROM automations");
  if ((count?.count ?? 0) >= MAX_AUTOMATIONS) return { ok: false, error: "There are too many automations. Delete one first." };
  const id = await insert(checked.value, createdBy, null);
  return { ok: true, value: (await getAutomation(id))! };
}

/** Change some fields. Turning it on, or changing when it runs, starts it fresh: it looks ahead only. */
export async function updateAutomation(id: number, patch: unknown): Promise<Result<AutomationView> | null> {
  const row = await rowById(id);
  if (!row) return null;
  const changes = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const trigger = changes.trigger ?? row.trigger;
  const action = changes.action ?? row.action;
  const checked = validateAutomation({
    name: changes.name ?? row.name,
    enabled: changes.enabled ?? row.enabled === 1,
    trigger,
    // A new "when" or "do" needs its own settings: the old ones do not fit.
    trigger_config: changes.trigger_config ?? (trigger === row.trigger ? parseJson(row.trigger_config) : {}),
    action,
    action_config: changes.action_config ?? (action === row.action ? parseJson(row.action_config) : {}),
    filters: changes.filters ?? parseJson(row.filters),
  });
  if (!checked.ok) return checked;
  const value = checked.value;
  const triggerConfig = JSON.stringify(value.trigger_config);
  const rearm = (value.enabled && row.enabled !== 1) || value.trigger !== row.trigger
    || triggerConfig !== JSON.stringify(parseJson(row.trigger_config));
  await run(
    `UPDATE automations SET name = ?, enabled = ?, trigger = ?, trigger_config = ?, action = ?, action_config = ?, filters = ?,
       armed_at = ?, updated_at = utc_now() WHERE id = ?`,
    [value.name, value.enabled ? 1 : 0, value.trigger, triggerConfig, value.action, JSON.stringify(value.action_config),
      JSON.stringify(value.filters), rearm ? wallClock().toISOString() : row.armed_at, id],
  );
  return { ok: true, value: (await getAutomation(id))! };
}

export async function deleteAutomation(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>("DELETE FROM automations WHERE id = ? RETURNING id", [id]);
  return rows.length > 0;
}

export interface Preview {
  text: string;
  /** True when no real visit was found and the text uses made-up values. */
  sample: boolean;
  appointment: { reference: string; client_name: string; date: string; time: string } | null;
}

/** Show the text as a client would get it. Sends nothing and saves nothing in a chat. */
export async function previewText(message: string, appointmentId?: number): Promise<Result<Preview>> {
  const template = String(message ?? "").trim();
  if (!template) return { ok: false, error: "Write the text to send." };
  const bad = placeholderError(template);
  if (bad) return { ok: false, error: bad };
  const settings = await getSettings();
  let apt: Apt | null = null;
  if (appointmentId !== undefined) {
    apt = await loadApt(appointmentId);
    if (!apt) return { ok: false, error: "We could not find that visit." };
  } else {
    const today = dateOf(localSeconds(wallClock(), settings.timezone));
    apt = (await get<Apt>(`${APT_SELECT} WHERE a.status != 'cancelled' AND a.scheduled_date >= ? ORDER BY a.scheduled_date, a.start_time LIMIT 1`, [today]))
      ?? (await get<Apt>(`${APT_SELECT} WHERE a.status != 'cancelled' ORDER BY a.scheduled_date DESC, a.start_time DESC LIMIT 1`))
      ?? null;
  }
  const values = apt ? await valuesFor(apt, settings) : sampleValues(settings);
  return {
    ok: true,
    value: {
      text: sign(render(template, values), settings),
      sample: apt === null,
      appointment: apt ? { reference: apt.identifier, client_name: apt.client_name ?? "", date: niceDate(apt.scheduled_date), time: niceTime(apt.start_time) } : null,
    },
  };
}

/** Run an assistant task now. The report arrives in the assistant chat a moment later. */
export async function runNow(id: number): Promise<Result<{ run_id: number }> | null> {
  const row = await rowById(id);
  if (!row) return null;
  if (row.action !== "agent_task") {
    return { ok: false, error: "Only assistant tasks can run now. A text routine runs when its moment comes. Use the preview to see the text." };
  }
  if (!agentConfigured()) return { ok: false, error: "The assistant is off: no AI key is set." };
  const runId = await claim(row.id, null, `a${row.id}:manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
  if (runId === null) return { ok: false, error: "Try again." };
  startTask(runId, row, null);
  return { ok: true, value: { run_id: runId } };
}

export interface RunView { id: number; status: string; detail: string; created_at: string; reference: string | null; client_name: string | null }

export function runHistory(id: number, limit = 50): Promise<RunView[]> {
  return query<RunView>(
    `SELECT r.id, r.status, r.detail, r.created_at, a.identifier AS reference, cl.name AS client_name
     FROM automation_runs r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN clients cl ON cl.id = a.client_id
     WHERE r.automation_id = ? ORDER BY r.id DESC LIMIT ?`,
    [id, Math.min(Math.max(limit, 1), 200)],
  );
}

// ── Defaults ───────────────────────────────────────────────────────

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const DEFAULTS: { key: string; value: AutomationInput }[] = [
  {
    key: "booking_confirmation",
    value: {
      name: "Booking confirmation", enabled: true, trigger: "booking_created", trigger_config: {}, action: "text_client",
      action_config: { message: "Hi {client_first_name}! You are booked: {services} on {date} at {time} with {barber}. Add it to your calendar: {calendar_link}" },
      filters: { sources: ["online", "chat"], statuses: ["booked", "confirmed"] },
    },
  },
  {
    key: "prepay_link",
    value: {
      name: "Pre-pay link", enabled: true, trigger: "booking_created", trigger_config: {}, action: "text_client",
      action_config: { message: "Hi {client_first_name}! We are holding {time} on {date} for you. Pre-pay {prepay_amount} here to confirm: {prepay_link}" },
      filters: { sources: ["online", "chat"], statuses: ["pending"] },
    },
  },
  {
    key: "prepay_received",
    value: {
      name: "Pre-pay received", enabled: true, trigger: "prepay_paid", trigger_config: {}, action: "text_client",
      action_config: { message: "Thanks {client_first_name}! We got your pre-pay of {prepay_amount}. You are confirmed for {date} at {time}. Change or cancel here: {manage_link}" },
      filters: {},
    },
  },
  {
    key: "morning_of",
    value: {
      name: "Morning-of text", enabled: true, trigger: "daily", trigger_config: { time: "08:00", days: EVERY_DAY, scope: "today" }, action: "text_client",
      action_config: { message: "Good morning {client_first_name}! See you today at {time} at {shop_name}. {access_instructions}" },
      filters: {},
    },
  },
  {
    key: "day_before",
    value: {
      name: "Day-before reminder", enabled: false, trigger: "before_appointment", trigger_config: { minutes: 1440 }, action: "text_client",
      action_config: { message: "Hi {client_first_name}! Reminder: {services} tomorrow at {time} with {barber}. Need to change it? {manage_link}" },
      filters: {},
    },
  },
  {
    key: "thank_you",
    value: {
      name: "Thank you + rebook", enabled: false, trigger: "after_appointment", trigger_config: { minutes: 120 }, action: "text_client",
      action_config: { message: "Thanks for coming in, {client_first_name}! Text us here when you want your next visit." },
      filters: { statuses: ["completed"] },
    },
  },
];

/** Make the starter routines, once. A routine the owner deleted does not come back. */
export async function ensureDefaultAutomations(): Promise<void> {
  const first = await query<{ key: string }>(
    "INSERT INTO _meta (key, value) VALUES ('default_automations', '1') ON CONFLICT DO NOTHING RETURNING key",
  );
  if (first.length === 0) return;
  for (const item of DEFAULTS) await insert(item.value, "system", item.key);
}

// ── Routes ─────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } } });
const errors = {
  400: { description: "Bad request", ...json(ErrorSchema) },
  404: { description: "Not found", ...json(ErrorSchema) },
};
const IdParam = z.object({ id: z.coerce.number().int().positive() });
const Config = z.record(z.string(), z.any());

const AutomationSchema = z.object({
  id: z.number(), name: z.string(), enabled: z.boolean(), trigger: z.string(), trigger_config: Config, action: z.string(),
  action_config: Config, filters: Config, created_by: z.string(), builtin_key: z.string().nullable(), summary: z.string(),
  last_run: z.object({ status: z.string(), detail: z.string(), created_at: z.string() }).nullable(),
  created_at: z.string(), updated_at: z.string(),
}).openapi("Automation");

const BodySchema = z.object({
  name: z.string(), enabled: z.boolean().optional(), trigger: z.string(), trigger_config: Config.optional(),
  action: z.string(), action_config: Config.optional(), filters: Config.optional(),
}).openapi("AutomationInput");

const listRoute = createRoute({
  method: "get", path: "/api/automations", tags: ["Automations"], summary: "All automations.",
  responses: {
    200: {
      description: "Automations",
      ...json(z.object({
        automations: z.array(AutomationSchema), placeholders: z.array(z.string()),
        assistant_ready: z.boolean(), texts_ready: z.boolean(),
      })),
    },
  },
});

const createRouteDef = createRoute({
  method: "post", path: "/api/automations", tags: ["Automations"], summary: "Make an automation.",
  request: { body: json(BodySchema) },
  responses: { 201: { description: "Made", ...json(z.object({ automation: AutomationSchema })) }, 400: errors[400] },
});

const updateRoute = createRoute({
  method: "put", path: "/api/automations/{id}", tags: ["Automations"], summary: "Change an automation, or turn it on or off.",
  request: { params: IdParam, body: json(BodySchema.partial()) },
  responses: { 200: { description: "Saved", ...json(z.object({ automation: AutomationSchema })) }, 400: errors[400], 404: errors[404] },
});

const deleteRoute = createRoute({
  method: "delete", path: "/api/automations/{id}", tags: ["Automations"], summary: "Delete an automation.",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", ...json(z.object({ ok: z.boolean() })) }, 404: errors[404] },
});

const previewRoute = createRoute({
  method: "post", path: "/api/automations/preview", tags: ["Automations"],
  summary: "Show a text with a real visit filled in. Sends nothing.",
  request: { body: json(z.object({ message: z.string().max(2000), appointment_id: z.number().int().positive().optional() })) },
  responses: {
    200: {
      description: "Preview",
      ...json(z.object({
        text: z.string(), sample: z.boolean(),
        appointment: z.object({ reference: z.string(), client_name: z.string(), date: z.string(), time: z.string() }).nullable(),
      })),
    },
    400: errors[400],
  },
});

const runRoute = createRoute({
  method: "post", path: "/api/automations/{id}/run", tags: ["Automations"], summary: "Run an assistant task now.",
  request: { params: IdParam },
  responses: { 200: { description: "Started", ...json(z.object({ ok: z.boolean(), run_id: z.number() })) }, 400: errors[400], 404: errors[404] },
});

const runsRoute = createRoute({
  method: "get", path: "/api/automations/{id}/runs", tags: ["Automations"], summary: "What an automation did, newest first.",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Runs",
      ...json(z.object({
        runs: z.array(z.object({
          id: z.number(), status: z.string(), detail: z.string(), created_at: z.string(),
          reference: z.string().nullable(), client_name: z.string().nullable(),
        })),
      })),
    },
    404: errors[404],
  },
});

const NOT_FOUND = "Automation not found.";

export function registerAutomationRoutes(app: OpenAPIHono): void {
  app.openapi(listRoute, async (c) => c.json({
    automations: await listAutomations(), placeholders: [...PLACEHOLDERS],
    assistant_ready: agentConfigured(), texts_ready: getSmsProvider() !== null,
  }, 200));

  app.openapi(createRouteDef, async (c) => {
    const made = await createAutomation(c.req.valid("json"), "staff");
    return made.ok ? c.json({ automation: made.value }, 201) : c.json({ error: made.error }, 400);
  });

  app.openapi(previewRoute, async (c) => {
    const { message, appointment_id } = c.req.valid("json");
    const preview = await previewText(message, appointment_id);
    return preview.ok ? c.json(preview.value, 200) : c.json({ error: preview.error }, 400);
  });

  app.openapi(updateRoute, async (c) => {
    const saved = await updateAutomation(c.req.valid("param").id, c.req.valid("json"));
    if (!saved) return c.json({ error: NOT_FOUND }, 404);
    return saved.ok ? c.json({ automation: saved.value }, 200) : c.json({ error: saved.error }, 400);
  });

  app.openapi(deleteRoute, async (c) => {
    return (await deleteAutomation(c.req.valid("param").id)) ? c.json({ ok: true }, 200) : c.json({ error: NOT_FOUND }, 404);
  });

  app.openapi(runRoute, async (c) => {
    const started = await runNow(c.req.valid("param").id);
    if (!started) return c.json({ error: NOT_FOUND }, 404);
    return started.ok ? c.json({ ok: true, run_id: started.value.run_id }, 200) : c.json({ error: started.error }, 400);
  });

  app.openapi(runsRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await rowById(id))) return c.json({ error: NOT_FOUND }, 404);
    return c.json({ runs: await runHistory(id) }, 200);
  });
}
