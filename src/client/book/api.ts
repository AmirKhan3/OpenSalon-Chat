/** Calls to the public API. No login. */

export interface Service { id: number; name: string; description: string; duration: number; price: number; category: string }
export interface Barber { id: number; name: string; title: string; color: string }
export interface DayHours { closed: boolean; open: string; close: string }
export interface Shop { name: string; address: string; timezone: string; hours: DayHours[]; booking_window_days: number }
export interface PrepayPolicy { mode: "none" | "fixed" | "percent" | "full"; amount: number; percent: number; minimum: number; refund_window_hours: number; hold_minutes: number }
export interface ShopData { shop: Shop; today: string; services: Service[]; barbers: Barber[]; prepay: PrepayPolicy }
export interface Availability { slots: Slot[]; price: number; prepay_amount: number }
export interface BookingPrepay {
  amount: number; status: string; pay_url: string | null; hold_expires_at: string | null;
  refund_on_cancel: boolean; refund_window_hours: number;
}
export interface Slot { time: string; staff_ids: number[] }
export interface Booking {
  reference: string; status: string; date: string; start_time: string; end_time: string; barber: string;
  services: { name: string; duration: number; price: number }[]; total_price: number; can_cancel: boolean; prepay: BookingPrepay;
}
export interface BookingData { booking: Booking; shop: { name: string; address: string; timezone: string }; manage_path: string; checkout_url?: string }

export class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new RequestError("We could not reach the shop. Check your connection and try again.", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch { /* not JSON */ }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new RequestError(message || "Something went wrong. Please try again.", res.status);
  }
  return data as T;
}
