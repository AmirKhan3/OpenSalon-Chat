/**
 * A small rate limit, kept in memory. It counts hits per key (an IP address)
 * in a fixed window. One server process only: with more than one process,
 * each one counts on its own.
 */

interface Window { count: number; resetAt: number }

export interface RateLimit {
  /** Count one hit. Returns 0 when allowed, or the milliseconds to wait. */
  hit(key: string): number;
  /** Tests only. */
  reset(): void;
}

/** The most addresses one limit remembers. */
export const MAX_KEYS = 10_000;

let now: () => number = () => Date.now();

/** Tests only: replace the clock. Call with no argument to restore it. */
export function setRateClock(fn?: () => number): void {
  now = fn ?? (() => Date.now());
}

export function rateLimit(max: number, windowMs: number): RateLimit {
  const windows = new Map<string, Window>();
  return {
    hit(key) {
      const time = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= time) {
        // Keep the map small if hits come from many addresses: drop the ended
        // windows, then the oldest ones.
        if (!w && windows.size >= MAX_KEYS) {
          for (const [k, old] of windows) if (old.resetAt <= time) windows.delete(k);
          for (const k of windows.keys()) {
            if (windows.size < MAX_KEYS) break;
            windows.delete(k);
          }
        }
        w = { count: 0, resetAt: time + windowMs };
        // Delete first, so a new window moves to the end (the newest place).
        windows.delete(key);
        windows.set(key, w);
      }
      if (w.count >= max) return w.resetAt - time;
      w.count += 1;
      return 0;
    },
    reset() {
      windows.clear();
    },
  };
}

/** Web chat messages from one address. Each one can start an AI run. */
export const CHAT_MAX_PER_MINUTE = 20;
export const chatLimit = rateLimit(CHAT_MAX_PER_MINUTE, 60_000);
