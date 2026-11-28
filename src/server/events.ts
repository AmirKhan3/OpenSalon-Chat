/**
 * Booking events. The booking code says what happened; the automations listen.
 * A listener that fails never fails the booking.
 */

export type BookingEvent = "booking_created" | "prepay_paid" | "booking_cancelled" | "booking_moved";

type Listener = (event: BookingEvent, appointmentId: number) => Promise<void>;

const listeners: Listener[] = [];

export function onBookingEvent(listener: Listener): void {
  if (!listeners.includes(listener)) listeners.push(listener);
}

/**
 * Tell the listeners. Call it after the change is saved.
 * It may run inside the booking write queue, so a listener must not use that queue.
 */
export async function emitBookingEvent(event: BookingEvent, appointmentId: number): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event, appointmentId);
    } catch (err) {
      console.error(`A ${event} routine failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
}
