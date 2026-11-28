import { query, run } from "./db.js";

/**
 * A small rate limit, kept in the database. It counts hits per key (an IP
 * address) in a window. All servers share the count, so it also works when
 * more than one server runs (Vercel).
 */

export interface RateLimit {
  /** Count one hit. Returns 0 when allowed, or the milliseconds to wait. */
  hit(key: string): Promise<number>;
  /** Tests only. */
  reset(): Promise<void>;
}

let now: () => number = () => Date.now();

/** Tests only: replace the clock. Call with no argument to restore it. */
export function setRateClock(fn?: () => number): void {
  now = fn ?? (() => Date.now());
}

export interface Counted { count: number; resetAt: number }

/**
 * Count one hit for a key, in one statement, so two servers never lose a hit.
 *
 * A new window starts when the old one ended. `slideUpTo` > 0 makes the window
 * start again on each hit until the count is over that number (used for wrong
 * passwords: the wait starts at the last try that was allowed).
 */
export async function countHit(key: string, time: number, windowMs: number, slideUpTo = 0): Promise<Counted> {
  const rows = await query<{ count: number; reset_at: number }>(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE LEAST(rate_limits.count + 1, 1000000) END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? OR rate_limits.count < ? THEN ? ELSE rate_limits.reset_at END
     RETURNING count, reset_at`,
    [key.slice(0, 200), time + windowMs, time, time, slideUpTo, time + windowMs],
  );
  return { count: Number(rows[0].count), resetAt: Number(rows[0].reset_at) };
}

/** Forget one key. */
export async function forgetHits(key: string): Promise<void> {
  await run("DELETE FROM rate_limits WHERE key = ?", [key.slice(0, 200)]);
}

/** Forget all keys that start with a prefix. Tests only. */
export async function forgetHitsLike(prefix: string): Promise<void> {
  await run("DELETE FROM rate_limits WHERE starts_with(key, ?)", [prefix]);
}

/** Delete the windows that ended. Called every minute, so the table stays small. */
export async function cleanRateLimits(time: number = now()): Promise<number> {
  return (await run("DELETE FROM rate_limits WHERE reset_at <= ?", [time])).changes;
}

/** `name` keeps the keys of two limits apart. */
export function rateLimit(name: string, max: number, windowMs: number): RateLimit {
  return {
    async hit(key) {
      const time = now();
      const { count, resetAt } = await countHit(`${name}:${key}`, time, windowMs);
      return count > max ? Math.max(1, resetAt - time) : 0;
    },
    reset() {
      return forgetHitsLike(`${name}:`);
    },
  };
}

/** Web chat messages from one address. Each one can start an AI run. */
export const CHAT_MAX_PER_MINUTE = 20;
export const chatLimit = rateLimit("chat", CHAT_MAX_PER_MINUTE, 60_000);
