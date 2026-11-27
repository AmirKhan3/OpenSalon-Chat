/**
 * Work that goes on after the reply was sent (the assistant's answer, an
 * automation task).
 *
 * A normal Node server just keeps running. A serverless host (Vercel) pauses
 * the function after the reply, so it must be told to wait for this work.
 * The host's entry file sets the hook.
 */
type KeepAlive = (work: Promise<unknown>) => void;

let hook: KeepAlive | null = null;

/** Set by the host's entry file. Pass null to remove it. */
export function setKeepAlive(fn: KeepAlive | null): void {
  hook = fn;
}

/** Ask the host to stay awake until this work is done. The work must not reject. */
export function keepAlive(work: Promise<unknown>): void {
  if (!hook) return;
  try {
    hook(work);
  } catch (err) {
    console.error("[background] the host could not keep the work alive:", err instanceof Error ? err.message : err);
  }
}
