import { withDbLock } from "./db.js";

/**
 * Run tasks one at a time, in the order they arrive.
 *
 * Booking writes check for overlaps and then insert. Two requests at the same
 * moment could both pass the check. Two things stop that:
 *
 * - a queue in this process, and
 * - a lock in Postgres, for when more than one server runs (Vercel).
 *
 * The queue comes first, so one server waits for the lock with one connection only.
 * Do not call oneAtATime from inside a task: it would wait for itself.
 */
let tail: Promise<unknown> = Promise.resolve();

export function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const locked = (): Promise<T> => withDbLock(task);
  const result = tail.then(locked, locked);
  // Keep the queue going after a failure.
  tail = result.catch(() => undefined);
  return result;
}
