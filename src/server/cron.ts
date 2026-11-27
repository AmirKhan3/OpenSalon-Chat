import { createHash, timingSafeEqual } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { oneAtATime } from "./lock.js";
import { releaseExpiredHolds } from "./prepay.js";
import { tick } from "./automations.js";
import { cleanRateLimits } from "./ratelimit.js";

/**
 * The work that must happen every minute:
 *
 * - release bookings whose pre-pay was not paid in time,
 * - run the automations whose moment came,
 * - delete rate limit rows that ended.
 *
 * The Node server calls runTimers() from a timer. A serverless host (Vercel)
 * has no timer, so its cron calls GET /api/cron/tick instead.
 * It is safe when two servers run it at the same moment: holds are released
 * under the booking lock, and each automation run is claimed in the database.
 */
export async function runTimers(): Promise<string[]> {
  const failed: string[] = [];
  const step = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (err) {
      failed.push(name);
      console.error(`[timers] ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };
  await step("holds", () => oneAtATime(releaseExpiredHolds));
  await step("automations", () => tick());
  await step("rate limits", () => cleanRateLimits());
  return failed;
}

function sameText(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export const CRON_PATH = "/api/cron/tick";

export function registerCronRoutes(app: OpenAPIHono): void {
  // Not in the OpenAPI document: only the host's cron calls it.
  app.get(CRON_PATH, async (c) => {
    const secret = process.env.CRON_SECRET ?? "";
    // With no secret the route is off.
    if (secret === "") return c.json({ error: "Not found" }, 404);
    if (!sameText(c.req.header("authorization") ?? "", `Bearer ${secret}`)) return c.json({ error: "Please log in." }, 401);
    const failed = await runTimers();
    return c.json({ ok: failed.length === 0, failed }, failed.length === 0 ? 200 : 500);
  });
}
