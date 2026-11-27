import { useEffect, useMemo, useState } from "preact/hooks";
import { CalendarPlus, Clock, MapPin } from "lucide-preact";
import { request, type BookingData } from "./api";
import { Notice, Page, PrimaryButton } from "./app";
import { formatPrice, formatTime, longDate } from "./dates";

const STATUS: Record<string, { label: string; tone: string }> = {
  booked: { label: "Booked", tone: "text-ok border-ok/40" },
  confirmed: { label: "Confirmed", tone: "text-ok border-ok/40" },
  pending: { label: "Waiting for pre-pay", tone: "text-brass border-brass/40" },
  in_progress: { label: "In progress", tone: "text-brass border-brass/40" },
  completed: { label: "Completed", tone: "text-dim border-line" },
  cancelled: { label: "Cancelled", tone: "text-danger border-danger/40" },
  no_show: { label: "Missed", tone: "text-danger border-danger/40" },
};

/** "3:45 PM" in the shop's time. */
function holdTime(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** /book/manage/:token — the client's own booking: details, status, cancel. */
export function ManagePage({ token }: { token: string }) {
  const [data, setData] = useState<BookingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const path = `/api/public/bookings/${encodeURIComponent(token)}`;

  // Stripe sends the client back here with ?paid=1. The payment can take a moment to arrive.
  const justPaid = useMemo(() => new URLSearchParams(window.location.search).get("paid") === "1", []);
  const [checks, setChecks] = useState(0);
  // The link in a text ends with ?calendar=1. It points the client at the calendar buttons.
  const fromCalendarLink = useMemo(() => new URLSearchParams(window.location.search).get("calendar") === "1", []);

  useEffect(() => {
    request<BookingData>("GET", path)
      .then((d) => { setData(d); document.title = `Your booking - ${d.shop.name}`; })
      .catch((e: Error) => setError(e.message));
  }, [path, checks]);

  const waitingForPayment = justPaid && checks < 15 && data?.booking.status === "pending";
  useEffect(() => {
    if (!waitingForPayment) return;
    const timer = setTimeout(() => setChecks((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [waitingForPayment, checks, data]);

  const cancel = async () => {
    setBusy(true);
    setCancelError(null);
    try {
      setData(await request<BookingData>("POST", `${path}/cancel`));
      setConfirming(false);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Page>
        <div className="space-y-4">
          <Notice>{error}</Notice>
          <a href="/book" className="block text-center text-sm text-brass underline">Book a new visit</a>
        </div>
      </Page>
    );
  }
  if (!data) return <Page><p className="text-dim">Loading...</p></Page>;

  const { booking, shop } = data;
  const status = STATUS[booking.status] ?? { label: booking.status, tone: "text-dim border-line" };
  const prepay = booking.prepay;
  const paid = formatPrice(prepay.amount);
  const holdUntil = prepay.hold_expires_at ? holdTime(prepay.hold_expires_at, shop.timezone) : "";

  return (
    <Page shopName={shop.name}>
      <div className="rise space-y-5">
        <div>
          <span className={`inline-block rounded-full border px-3 py-1 text-xs font-medium ${status.tone}`}>{status.label}</span>
          <h1 className="mt-3 font-display text-3xl text-cream">{longDate(booking.date)}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-dim">
            <Clock className="h-4 w-4" aria-hidden="true" />
            {formatTime(booking.start_time)} to {formatTime(booking.end_time)}{booking.barber ? ` with ${booking.barber}` : ""}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-panel p-4 text-sm">
          <ul className="space-y-1">
            {booking.services.map((s, i) => (
              <li key={i} className="flex justify-between"><span>{s.name}</span><span className="text-dim">{formatPrice(s.price)}</span></li>
            ))}
            <li className="flex justify-between border-t border-line pt-2 font-medium"><span>Total</span><span className="text-brass-2">{formatPrice(booking.total_price)}</span></li>
            {prepay.status === "paid" && (
              <>
                <li className="flex justify-between text-ok"><span>Pre-paid</span><span>{paid}</span></li>
                {booking.status !== "cancelled" && booking.total_price - prepay.amount > 0 && (
                  <li className="flex justify-between text-dim"><span>Pay at the shop</span><span>{formatPrice(booking.total_price - prepay.amount)}</span></li>
                )}
              </>
            )}
            {prepay.status === "due" && <li className="flex justify-between text-dim"><span>Pre-pay to book</span><span>{paid}</span></li>}
          </ul>
          <p className="mt-3 flex justify-between text-dim"><span>Booking</span><span>{booking.reference}</span></p>
          {shop.address && <p className="mt-2 flex items-start gap-1.5 text-dim"><MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{shop.address}</p>}
        </div>

        {["booked", "confirmed", "pending"].includes(booking.status) && (
          <div
            id="calendar"
            className={`rounded-xl border p-4 ${fromCalendarLink ? "border-brass bg-brass/10" : "border-line bg-panel"}`}
          >
            <p className="flex items-center gap-1.5 text-sm font-medium text-cream">
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />Add to your calendar
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <a href={`${path}/calendar.ics`} className="flex min-h-12 items-center justify-center rounded-xl border border-line text-sm font-medium text-cream hover:border-brass">
                iPhone / Apple
              </a>
              <a href={`${path}/google-calendar`} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-center rounded-xl border border-line text-sm font-medium text-cream hover:border-brass">
                Google
              </a>
            </div>
          </div>
        )}

        {waitingForPayment && <p role="status" className="text-sm text-dim">Checking your payment...</p>}
        {!waitingForPayment && justPaid && booking.status === "pending" && (
          <p role="status" className="text-sm text-dim">Your payment has not arrived yet. This can take a minute. Reload this page to check again.</p>
        )}
        {!waitingForPayment && !justPaid && booking.status === "pending" && prepay.pay_url && (
          <div className="space-y-2">
            <PrimaryButton onClick={() => { window.location.assign(prepay.pay_url!); }}>Pre-pay {paid}</PrimaryButton>
            <p className="text-sm text-dim">
              Your time is not booked until you pay.{holdUntil ? ` We hold it until ${holdUntil}.` : ""}
            </p>
          </div>
        )}
        {prepay.status === "expired" && <p className="text-sm text-dim">The pre-pay was not paid in time, so this booking was cancelled.</p>}
        {prepay.status === "refunded" && <p className="text-sm text-dim">Your pre-pay of {paid} was refunded. It can take a few days to show on your card.</p>}
        {prepay.status === "refund_due" && <p className="text-sm text-dim">The shop will refund your pre-pay of {paid}.</p>}
        {booking.status === "cancelled" && prepay.status === "paid" && <p className="text-sm text-dim">The pre-pay of {paid} was not refunded.</p>}

        {booking.status === "cancelled" && <PrimaryButton onClick={() => { window.location.href = "/book"; }}>Book a new visit</PrimaryButton>}

        {booking.can_cancel && !confirming && (
          <button onClick={() => setConfirming(true)} className="min-h-12 w-full rounded-xl border border-danger/50 text-sm font-medium text-danger hover:bg-danger/10">
            Cancel this booking
          </button>
        )}
        {booking.can_cancel && confirming && (
          <div className="space-y-3 rounded-xl border border-danger/50 bg-panel p-4">
            <p className="font-medium text-cream">Cancel this booking?</p>
            <p className="text-sm text-dim">
              Your time will open up for someone else.
              {prepay.status === "paid" && (prepay.refund_on_cancel
                ? ` We will refund your pre-pay of ${paid}.`
                : ` Your pre-pay of ${paid} will not be refunded, because the visit is less than ${prepay.refund_window_hours} hours away.`)}
            </p>
            {cancelError && <Notice>{cancelError}</Notice>}
            <div className="grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={() => setConfirming(false)} className="min-h-12 rounded-xl border border-line text-sm font-medium text-cream">Keep it</button>
              <button disabled={busy} onClick={cancel} className="min-h-12 rounded-xl bg-danger text-sm font-semibold text-ink">{busy ? "Cancelling..." : "Yes, cancel"}</button>
            </div>
          </div>
        )}
        {!booking.can_cancel && ["booked", "confirmed", "pending"].includes(booking.status) && (
          <p className="text-sm text-dim">This booking can no longer be cancelled online. Please contact the shop.</p>
        )}
      </div>
    </Page>
  );
}
