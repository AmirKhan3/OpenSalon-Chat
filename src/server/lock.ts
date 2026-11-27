/**
 * Run tasks one at a time, in the order they arrive.
 *
 * Booking writes check for overlaps and then insert. Two requests at the same
 * moment could both pass the check. The server is one process, so a queue is
 * enough to stop that.
 */
let tail: Promise<unknown> = Promise.resolve();

export function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  // Keep the queue going after a failure.
  tail = result.catch(() => undefined);
  return result;
}
