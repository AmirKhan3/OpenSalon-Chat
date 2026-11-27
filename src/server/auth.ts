import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { countHit, forgetHits, forgetHitsLike } from "./ratelimit.js";

/**
 * Staff login: one shared password (STAFF_PASSWORD) and a signed session cookie.
 *
 * - With no STAFF_PASSWORD (development only), login is off and the dashboard is open.
 * - In production the server refuses to start without STAFF_PASSWORD.
 * - The cookie holds only an expiry time and a signature. Changing the password
 *   or SESSION_SECRET ends every session.
 */

export const SESSION_COOKIE = "tolly_session";
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

export const MAX_LOGIN_TRIES = 5;
export const LOGIN_WAIT_MS = 5 * 60 * 1000;

// Used when SESSION_SECRET is not set: sessions then end when the server restarts.
const processSecret = randomBytes(32).toString("hex");

let now: () => number = () => Date.now();
/** Tests only: replace the clock. Pass nothing to restore it. */
export function setAuthClock(fn?: () => number): void {
  now = fn ?? (() => Date.now());
}

function staffPassword(): string {
  return process.env.STAFF_PASSWORD ?? "";
}

/** True when staff must log in. */
export function loginRequired(): boolean {
  return staffPassword() !== "";
}

/** Call at server start. Throws when the settings are not safe for production. */
export function checkAuthConfig(): string[] {
  const warnings: string[] = [];
  const production = process.env.NODE_ENV === "production";
  if (!loginRequired()) {
    if (production) {
      throw new Error("STAFF_PASSWORD is not set. Set it before you start the server in production.");
    }
    warnings.push("STAFF_PASSWORD is not set. Staff login is OFF. Anyone who can reach this server can use the dashboard.");
  } else if (!process.env.SESSION_SECRET) {
    warnings.push("SESSION_SECRET is not set. Staff must log in again each time the server restarts.");
  }
  return warnings;
}

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET || processSecret;
  return createHash("sha256").update(`${secret}\n${staffPassword()}`).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** A new session value: "v1.<expiry ms>.<signature>". */
export function createSessionValue(): string {
  const payload = `v1.${now() + SESSION_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

export function isValidSession(value: string | undefined | null): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  if (!/^\d{1,16}$/.test(parts[1])) return false;
  if (!safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`))) return false;
  return Number(parts[1]) > now();
}

/** True when this request comes from logged-in staff (or login is off). */
export function isStaff(c: Context): boolean {
  if (!loginRequired()) return true;
  return isValidSession(getCookie(c, SESSION_COOKIE));
}

function isHttps(c: Context): boolean {
  if (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The caller's IP address. Behind a reverse proxy, set TRUST_PROXY to the
 * number of proxies in front of the server (usually 1). Without it the
 * X-Forwarded-For header is ignored, because anyone can send it.
 *
 * With TRUST_PROXY set, the server port must be reachable only through the
 * proxy. A caller who reaches the port directly could send a made-up header.
 */
export function clientIp(c: Context): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const list = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const fromProxy = list[list.length - hops];
    if (fromProxy) return fromProxy;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

function trustedProxyHops(): number {
  const raw = (process.env.TRUST_PROXY ?? "").trim().toLowerCase();
  // Vercel is always one proxy in front, and it sets the header itself.
  if (raw === "" && process.env.VERCEL) return 1;
  if (raw === "" || raw === "false" || raw === "0") return 0;
  if (raw === "true") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 0;
}

// ── Wrong-password limit ───────────────────────────────────────────

// Counted in the database, so all servers share the count.
const loginKey = (ip: string): string => `login:${ip}`;

/** Tests only. */
export function resetLoginLimits(): Promise<void> {
  return forgetHitsLike("login:");
}

/**
 * Count one login try. Returns the milliseconds this IP must still wait, or 0.
 * The try is counted before the password is checked, so many tries at the
 * same moment cannot get past the limit.
 */
async function countLoginTry(ip: string): Promise<number> {
  const time = now();
  const { count, resetAt } = await countHit(loginKey(ip), time, LOGIN_WAIT_MS, MAX_LOGIN_TRIES);
  return count > MAX_LOGIN_TRIES ? Math.max(1, resetAt - time) : 0;
}

// ── Middleware ─────────────────────────────────────────────────────

/** API paths that work without a staff login. */
export function isOpenPath(path: string): boolean {
  return (
    path === "/api/health" ||
    // The host's cron. It checks CRON_SECRET instead.
    path === "/api/cron/tick" ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/public/") ||
    // Provider webhooks. They check the provider's signature instead.
    path === "/api/stripe/webhook" ||
    path === "/api/sms/telnyx" ||
    path === "/api/sms/twilio"
  );
}

export const requireStaff: MiddlewareHandler = async (c, next) => {
  if (isOpenPath(c.req.path) || isStaff(c)) return next();
  return c.json({ error: "Please log in." }, 401);
};

// ── Routes ─────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() });
const MeSchema = z.object({ logged_in: z.boolean(), login_required: z.boolean() }).openapi("AuthStatus");

const loginRoute = createRoute({
  method: "post",
  path: "/api/auth/login",
  tags: ["Auth"],
  summary: "Log in with the staff password",
  request: {
    body: { content: { "application/json": { schema: z.object({ password: z.string().min(1).max(4096) }) } }, required: true },
  },
  responses: {
    200: { description: "Logged in", content: { "application/json": { schema: MeSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Wrong password", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Too many tries", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Auth"],
  summary: "Log out",
  responses: { 200: { description: "Logged out", content: { "application/json": { schema: MeSchema } } } },
});

const meRoute = createRoute({
  method: "get",
  path: "/api/auth/me",
  tags: ["Auth"],
  summary: "Is this browser logged in?",
  responses: { 200: { description: "Login status", content: { "application/json": { schema: MeSchema } } } },
});

export function registerAuthRoutes(app: OpenAPIHono): void {
  app.openapi(loginRoute, async (c) => {
    if (!loginRequired()) return c.json({ logged_in: true, login_required: false }, 200);

    const ip = clientIp(c);
    const wait = await countLoginTry(ip);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }, 429);
    }

    const { password } = c.req.valid("json");
    if (!safeEqual(password, staffPassword())) return c.json({ error: "Wrong password." }, 401);

    await forgetHits(loginKey(ip));
    setCookie(c, SESSION_COOKIE, createSessionValue(), {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return c.json({ logged_in: true, login_required: true }, 200);
  });

  app.openapi(logoutRoute, (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ logged_in: !loginRequired(), login_required: loginRequired() }, 200);
  });

  app.openapi(meRoute, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ logged_in: isStaff(c), login_required: loginRequired() }, 200);
  });
}
