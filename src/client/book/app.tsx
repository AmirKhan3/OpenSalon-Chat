import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Check, ChevronLeft, Clock, MapPin, Scissors, User } from "lucide-preact";
import { request, RequestError, type Barber, type BookingData, type Service, type ShopData, type Slot } from "./api";
import {
  bookableDates, dayNumber, formatDuration, formatPrice, formatTime, isPhone, longDate, shortMonth, shortWeekday, weekdayOf,
} from "./dates";
import { ManagePage } from "./manage";

type Step = "services" | "barber" | "time" | "details" | "done";
const STEPS: Step[] = ["services", "barber", "time", "details"];
const TITLES: Record<Step, string> = {
  services: "What are you getting?",
  barber: "Who do you want?",
  time: "Pick a time",
  details: "Your details",
  done: "You're booked",
};

export function BookApp() {
  const manage = window.location.pathname.match(/^\/book\/manage\/([^/]+)\/?$/);
  return manage ? <ManagePage token={decodeURIComponent(manage[1])} /> : <BookingFlow />;
}

export function Page({ shopName, children }: { shopName?: string; children: ComponentChildren }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)]">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brass/40 bg-panel text-brass">
          <Scissors className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-display text-xl leading-tight text-cream">{shopName || " "}</p>
          <p className="text-xs uppercase tracking-[0.18em] text-dim">Online booking</p>
        </div>
      </header>
      {children}
    </div>
  );
}

export function PrimaryButton(props: { children: ComponentChildren; disabled?: boolean; onClick?: () => void; type?: "button" | "submit" }) {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.onClick}
      className="min-h-13 w-full rounded-xl bg-brass px-5 py-3.5 text-base font-semibold text-ink transition-colors hover:bg-brass-2 disabled:bg-panel-2 disabled:text-dim"
    >
      {props.children}
    </button>
  );
}

export function Notice({ tone = "danger", children }: { tone?: "danger" | "ok"; children: ComponentChildren }) {
  const color = tone === "ok" ? "border-ok/40 text-ok" : "border-danger/40 text-danger";
  return <p role="alert" className={`rounded-xl border bg-panel px-4 py-3 text-sm ${color}`}>{children}</p>;
}

function BookingFlow() {
  const [data, setData] = useState<ShopData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("services");
  const [serviceIds, setServiceIds] = useState<number[]>([]);
  const [barberId, setBarberId] = useState<number | null>(null); // null is "Any barber"
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [result, setResult] = useState<BookingData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    request<ShopData>("GET", "/api/public/shop")
      .then((d) => {
        setData(d);
        setDate((current) => current || firstOpenDate(d));
        document.title = `Book a visit - ${d.shop.name}`;
      })
      .catch((e: Error) => setLoadError(e.message));
  };
  useEffect(load, []);
  useEffect(() => { window.scrollTo(0, 0); }, [step]);

  const picked = useMemo(
    () => (data ? serviceIds.map((id) => data.services.find((s) => s.id === id)).filter(Boolean) as Service[] : []),
    [data, serviceIds],
  );
  const duration = picked.reduce((sum, s) => sum + s.duration, 0);
  const price = picked.reduce((sum, s) => sum + s.price, 0);

  if (loadError) {
    return (
      <Page>
        <div className="space-y-4">
          <Notice>{loadError}</Notice>
          <PrimaryButton onClick={load}>Try again</PrimaryButton>
        </div>
      </Page>
    );
  }
  if (!data) return <Page><p className="text-dim">Loading...</p></Page>;

  if (data.services.length === 0 || data.barbers.length === 0) {
    return <Page shopName={data.shop.name}><Notice>Online booking is not open yet. Please contact the shop.</Notice></Page>;
  }

  if (step === "done" && result) return <Done data={result} />;

  const index = STEPS.indexOf(step);
  const back = () => { setNotice(null); setStep(STEPS[Math.max(0, index - 1)]); };
  const barber = data.barbers.find((b) => b.id === barberId) ?? null;

  return (
    <Page shopName={data.shop.name}>
      <div className="mb-5">
        <div className="mb-3 flex gap-1.5" aria-hidden="true">
          {STEPS.map((s, i) => <div key={s} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-brass" : "bg-line"}`} />)}
        </div>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button onClick={back} aria-label="Back" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-dim hover:text-cream">
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <div>
            <p className="text-xs text-dim">Step {index + 1} of {STEPS.length}</p>
            <h1 className="font-display text-2xl text-cream">{TITLES[step]}</h1>
          </div>
        </div>
      </div>

      {notice && <div className="mb-4"><Notice>{notice}</Notice></div>}

      <div key={step} className="rise flex flex-1 flex-col">
        {step === "services" && (
          <ServiceStep
            services={data.services} selected={serviceIds} duration={duration} price={price}
            onToggle={(id) => setServiceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
            onNext={() => { setTime(""); setStep("barber"); }}
          />
        )}
        {step === "barber" && (
          <BarberStep
            barbers={data.barbers} selected={barberId}
            onPick={(id) => { setBarberId(id); setTime(""); setNotice(null); setStep("time"); }}
          />
        )}
        {step === "time" && (
          <TimeStep
            data={data} serviceIds={serviceIds} barberId={barberId} date={date} time={time}
            onDate={(d) => { setDate(d); setTime(""); }} onTime={setTime} onNext={() => { setNotice(null); setStep("details"); }}
          />
        )}
        {step === "details" && (
          <DetailsStep
            summary={{ services: picked, barber, date, time, duration, price }}
            onSubmit={async (details) => {
              const booked = await request<BookingData>("POST", "/api/public/bookings", {
                ...details, date, time, service_ids: serviceIds, staff_id: barberId,
              });
              setResult(booked);
              setStep("done");
            }}
            onTaken={(message) => { setTime(""); setNotice(message); setStep("time"); }}
          />
        )}
      </div>
    </Page>
  );
}

function firstOpenDate(d: ShopData): string {
  const dates = bookableDates(d.today, d.shop.booking_window_days);
  return dates.find((day) => !d.shop.hours[weekdayOf(day)]?.closed) ?? d.today;
}

function ServiceStep(props: {
  services: Service[]; selected: number[]; duration: number; price: number;
  onToggle: (id: number) => void; onNext: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const s of props.services) map.set(s.category, [...(map.get(s.category) ?? []), s]);
    return [...map.entries()];
  }, [props.services]);
  const count = props.selected.length;

  return (
    <>
      <div className="flex-1 space-y-5 pb-28">
        <p className="text-sm text-dim">Pick one or more.</p>
        {groups.map(([category, list]) => (
          <section key={category}>
            {groups.length > 1 && category && <h2 className="mb-2 text-xs uppercase tracking-[0.18em] text-dim">{category}</h2>}
            <ul className="space-y-2">
              {list.map((s) => {
                const on = props.selected.includes(s.id);
                return (
                  <li key={s.id}>
                    <button
                      aria-pressed={on}
                      onClick={() => props.onToggle(s.id)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ${on ? "border-brass bg-panel-2" : "border-line bg-panel hover:border-dim"}`}
                    >
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${on ? "border-brass bg-brass text-ink" : "border-dim"}`}>
                        {on && <Check className="h-4 w-4" aria-hidden="true" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-cream">{s.name}</span>
                        {s.description && <span className="block text-sm text-dim">{s.description}</span>}
                        <span className="block text-sm text-dim">{formatDuration(s.duration)}</span>
                      </span>
                      <span className="font-display text-lg text-brass-2">{formatPrice(s.price)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <StickyBar>
        {count > 0 && (
          <p className="mb-2 flex justify-between text-sm text-dim">
            <span>{count} {count === 1 ? "service" : "services"} · {formatDuration(props.duration)}</span>
            <span className="text-cream">{formatPrice(props.price)}</span>
          </p>
        )}
        <PrimaryButton disabled={count === 0} onClick={props.onNext}>{count === 0 ? "Pick a service" : "Continue"}</PrimaryButton>
      </StickyBar>
    </>
  );
}

function StickyBar({ children }: { children: ComponentChildren }) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-line bg-ink/95 backdrop-blur">
      <div className="mx-auto w-full max-w-md px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3">{children}</div>
    </div>
  );
}

function BarberStep({ barbers, selected, onPick }: { barbers: Barber[]; selected: number | null; onPick: (id: number | null) => void }) {
  const row = "flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors";
  const state = (on: boolean) => (on ? "border-brass bg-panel-2" : "border-line bg-panel hover:border-dim");
  return (
    <ul className="space-y-2">
      {barbers.length > 1 && (
        <li>
          <button className={`${row} ${state(selected === null)}`} onClick={() => onPick(null)}>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brass/15 text-brass"><User className="h-5 w-5" aria-hidden="true" /></span>
            <span>
              <span className="block font-medium text-cream">Any barber</span>
              <span className="block text-sm text-dim">Shows the most open times.</span>
            </span>
          </button>
        </li>
      )}
      {barbers.map((b) => (
        <li key={b.id}>
          <button className={`${row} ${state(selected === b.id)}`} onClick={() => onPick(b.id)}>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-lg text-ink" style={{ background: "var(--color-brass)" }}>
              {b.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <span className="block font-medium text-cream">{b.name}</span>
              {b.title && <span className="block text-sm text-dim">{b.title}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TimeStep(props: {
  data: ShopData; serviceIds: number[]; barberId: number | null; date: string; time: string;
  onDate: (date: string) => void; onTime: (time: string) => void; onNext: () => void;
}) {
  const { data, date } = props;
  const dates = useMemo(() => bookableDates(data.today, data.shop.booking_window_days), [data]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setSlots(null);
    setError(null);
    const query = new URLSearchParams({ date, service_ids: props.serviceIds.join(",") });
    if (props.barberId !== null) query.set("staff_id", String(props.barberId));
    request<{ slots: Slot[] }>("GET", `/api/public/availability?${query}`)
      .then((r) => { if (live) setSlots(r.slots); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [date, props.barberId, props.serviceIds.join(","), attempt]);

  useEffect(() => {
    strip.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, []);

  const groups: [string, Slot[]][] = slots ? [
    ["Morning", slots.filter((s) => s.time < "12:00")],
    ["Afternoon", slots.filter((s) => s.time >= "12:00" && s.time < "17:00")],
    ["Evening", slots.filter((s) => s.time >= "17:00")],
  ] : [];

  return (
    <>
      <div className="flex-1 pb-28">
        <div ref={strip} className="no-scrollbar -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1">
          {dates.map((d) => {
            const closed = data.shop.hours[weekdayOf(d)]?.closed ?? true;
            const on = d === date;
            return (
              <button
                key={d} disabled={closed} aria-pressed={on} aria-label={longDate(d) + (closed ? ", closed" : "")}
                onClick={() => props.onDate(d)}
                className={`flex min-w-14 shrink-0 flex-col items-center rounded-xl border px-2 py-2.5 transition-colors ${on ? "border-brass bg-brass text-ink" : closed ? "border-line/60 text-dim/40" : "border-line bg-panel text-cream hover:border-dim"}`}
              >
                <span className="text-[11px] uppercase tracking-wide">{d === data.today ? "Today" : shortWeekday(d)}</span>
                <span className="font-display text-xl leading-tight">{dayNumber(d)}</span>
                <span className="text-[11px]">{shortMonth(d)}</span>
              </button>
            );
          })}
        </div>

        <p className="mb-3 text-sm text-dim">{longDate(date)}</p>
        {error && (
          <div className="space-y-3">
            <Notice>{error}</Notice>
            <button className="text-sm text-brass underline" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </div>
        )}
        {!error && slots === null && <p className="text-dim">Finding open times...</p>}
        {!error && slots?.length === 0 && (
          <p className="rounded-xl border border-line bg-panel px-4 py-6 text-center text-dim">No open times on this day. Try another day.</p>
        )}
        {groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
          <section key={label} className="mb-5">
            <h2 className="mb-2 text-xs uppercase tracking-[0.18em] text-dim">{label}</h2>
            <div className="grid grid-cols-3 gap-2">
              {list.map((s) => {
                const on = s.time === props.time;
                return (
                  <button
                    key={s.time} aria-pressed={on} onClick={() => props.onTime(s.time)}
                    className={`min-h-12 rounded-xl border text-sm font-medium transition-colors ${on ? "border-brass bg-brass text-ink" : "border-line bg-panel text-cream hover:border-dim"}`}
                  >
                    {formatTime(s.time)}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <p className="text-xs text-dim">Times are shown in the shop's time.</p>
      </div>
      <StickyBar>
        <PrimaryButton disabled={!props.time} onClick={props.onNext}>
          {props.time ? `Continue with ${formatTime(props.time)}` : "Pick a time"}
        </PrimaryButton>
      </StickyBar>
    </>
  );
}

interface Summary { services: Service[]; barber: Barber | null; date: string; time: string; duration: number; price: number }

function SummaryCard({ summary }: { summary: Summary }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="font-display text-lg text-cream">{longDate(summary.date)}</p>
      <p className="mb-3 flex items-center gap-1.5 text-sm text-dim">
        <Clock className="h-4 w-4" aria-hidden="true" />
        {formatTime(summary.time)} · {formatDuration(summary.duration)} · {summary.barber ? `with ${summary.barber.name}` : "any barber"}
      </p>
      <ul className="space-y-1 border-t border-line pt-3 text-sm">
        {summary.services.map((s) => (
          <li key={s.id} className="flex justify-between"><span>{s.name}</span><span className="text-dim">{formatPrice(s.price)}</span></li>
        ))}
        <li className="flex justify-between pt-1 font-medium"><span>Total</span><span className="text-brass-2">{formatPrice(summary.price)}</span></li>
      </ul>
    </div>
  );
}

const field = "h-13 w-full rounded-xl border border-line bg-panel px-4 text-base text-cream placeholder:text-dim/60 focus:border-brass focus:outline-none";

function DetailsStep(props: {
  summary: Summary;
  onSubmit: (details: { name: string; phone: string; email: string }) => Promise<void>;
  onTaken: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("Enter your name.");
    if (!isPhone(phone.trim())) return setError("Enter a phone number with the area code.");
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({ name: name.trim(), phone: phone.trim(), email: email.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      if (err instanceof RequestError && err.status === 409) props.onTaken(message);
      else setError(message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SummaryCard summary={props.summary} />
      <label className="block">
        <span className="mb-1.5 block text-sm text-dim">Name</span>
        <input className={field} value={name} onInput={(e) => setName(e.currentTarget.value)} autoComplete="name" maxLength={100} required />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm text-dim">Mobile number</span>
        <input className={field} value={phone} onInput={(e) => setPhone(e.currentTarget.value)} type="tel" inputMode="tel" autoComplete="tel" maxLength={30} placeholder="(555) 555-0123" required />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm text-dim">Email (optional)</span>
        <input className={field} value={email} onInput={(e) => setEmail(e.currentTarget.value)} type="email" autoComplete="email" maxLength={200} />
      </label>
      {error && <Notice>{error}</Notice>}
      <PrimaryButton type="submit" disabled={busy}>{busy ? "Booking..." : "Book it"}</PrimaryButton>
    </form>
  );
}

function Done({ data }: { data: BookingData }) {
  const { booking, shop } = data;
  const link = `${window.location.origin}${data.manage_path}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch { /* the link is on screen */ }
  };
  return (
    <Page shopName={shop.name}>
      <div className="rise space-y-5">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brass text-ink"><Check className="h-7 w-7" aria-hidden="true" /></div>
        <div>
          <h1 className="font-display text-3xl text-cream">You're booked.</h1>
          <p className="mt-1 text-dim">See you {longDate(booking.date)} at {formatTime(booking.start_time)}.</p>
        </div>
        <div className="space-y-2 rounded-xl border border-line bg-panel p-4 text-sm">
          <p className="flex justify-between"><span className="text-dim">Barber</span><span>{booking.barber}</span></p>
          <p className="flex justify-between gap-4"><span className="text-dim">Services</span><span className="text-right">{booking.services.map((s) => s.name).join(", ")}</span></p>
          <p className="flex justify-between"><span className="text-dim">Total</span><span>{formatPrice(booking.total_price)}</span></p>
          <p className="flex justify-between"><span className="text-dim">Booking</span><span>{booking.reference}</span></p>
          {shop.address && <p className="flex items-start gap-1.5 border-t border-line pt-2 text-dim"><MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{shop.address}</p>}
        </div>
        <div className="space-y-2">
          <p className="text-sm text-dim">Keep this link. Use it to see or cancel your booking.</p>
          <a href={data.manage_path} className="block break-all rounded-xl border border-line bg-panel px-4 py-3 text-sm text-brass underline">{link}</a>
          <button onClick={copy} className="min-h-11 w-full rounded-xl border border-line text-sm font-medium text-cream hover:border-dim">{copied ? "Link copied" : "Copy link"}</button>
        </div>
      </div>
    </Page>
  );
}
