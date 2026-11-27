import { attachDatabasePool, waitUntil } from "@vercel/functions";
import app from "./index.js";
import { setPoolHook } from "./db.js";
import { setKeepAlive } from "./background.js";
import { loginRequired } from "./auth.js";
import { ensureSeeded } from "./seed.js";
import { runTimers } from "./cron.js";

/**
 * Tolly on Vercel. There is no server process here: each request runs in a
 * function, and many functions can run at the same moment. So:
 *
 * - the database must be a real Postgres (DATABASE_URL),
 * - the login cookie needs SESSION_SECRET, or each function signs its own,
 * - work after the reply (the assistant's answer) uses waitUntil,
 * - the every-minute work runs from a Vercel schedule (api/tick.ts).
 *
 * The files in /api only pass requests to this module.
 */

// Vercel closes idle database connections before it pauses a function.
setPoolHook((pool) => attachDatabasePool(pool as Parameters<typeof attachDatabasePool>[0]));
setKeepAlive((work) => waitUntil(work));

/** What is missing in the project's settings, in plain words. Null when all is there. */
export function setupProblem(): string | null {
  if (!process.env.DATABASE_URL) return "DATABASE_URL is not set. On Vercel, Tolly needs a Postgres database.";
  if (!loginRequired()) return "STAFF_PASSWORD is not set. Set it in the Vercel project, then deploy again.";
  if (!process.env.SESSION_SECRET) return "SESSION_SECRET is not set. Set it in the Vercel project, then deploy again.";
  return null;
}

/** Every request to /api/*. */
export async function handle(request: Request): Promise<Response> {
  const problem = setupProblem();
  if (problem) {
    console.error(`[vercel] ${problem}`);
    return Response.json({ error: `Tolly is not set up yet. ${problem}` }, { status: 503 });
  }
  return app.fetch(request);
}

/** The every-minute work. A thrown error shows as a failed run in Vercel. */
export async function runScheduled(): Promise<void> {
  const problem = setupProblem();
  if (problem) throw new Error(problem);
  await ensureSeeded();
  const failed = await runTimers();
  if (failed.length > 0) throw new Error(`These timers failed: ${failed.join(", ")}`);
}
