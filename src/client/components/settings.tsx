import { useEffect, useMemo, useState } from "preact/hooks";
import { ExternalLink } from "lucide-preact";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DayHours { closed: boolean; open: string; close: string }
interface ShopSettings {
  shop_name: string;
  timezone: string;
  address: string;
  access_instructions: string;
  hours: DayHours[];
  slot_step: number;
  min_notice: number;
  booking_window_days: number;
  prepay_mode: "none" | "fixed" | "percent" | "full";
  prepay_amount: number;
  prepay_percent: number;
  refund_window_hours: number;
  hold_minutes: number;
  agent_name: string;
  sign_messages: boolean;
  agent_instructions: string;
}
interface SmsInfo { provider: string; connected: boolean; from_number: string; webhook_url: string }
interface SettingsReply { settings: ShopSettings; stripe_connected: boolean; sms: SmsInfo }

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SLOT_STEPS = [10, 15, 20, 30, 45, 60];
const NOTICES: [number, string][] = [
  [0, "No notice"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"],
  [720, "12 hours"], [1440, "1 day"], [2880, "2 days"],
];
const selectClass =
  "h-11 w-full rounded-xl border border-input bg-card px-3.5 text-base focus:outline-none md:text-sm focus:ring-2 focus:ring-ring";

const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
  }
}

/** Shop settings: name, time zone, address, opening hours, and the online booking rules. */
export function SettingsPage() {
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [stripeConnected, setStripeConnected] = useState(false);
  const [sms, setSms] = useState<SmsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    api<SettingsReply>("GET", "/api/settings")
      .then((r) => { setSettings(r.settings); setStripeConnected(r.stripe_connected); setSms(r.sms); })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  if (loadError) return <div className="p-6 text-sm text-destructive">{loadError}</div>;
  if (!settings) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  const set = (patch: Partial<ShopSettings>) => { setSettings({ ...settings, ...patch }); setMessage(null); };
  const setDay = (index: number, patch: Partial<DayHours>) =>
    set({ hours: settings.hours.map((d, i) => (i === index ? { ...d, ...patch } : d)) });

  const problem = (): string | null => {
    if (!settings.shop_name.trim()) return "Enter the shop name.";
    if (!settings.timezone.trim()) return "Enter the time zone.";
    if (!settings.agent_name.trim()) return "Enter a name for the assistant.";
    for (let i = 0; i < 7; i++) {
      const d = settings.hours[i];
      if (!d.closed && (!d.open || !d.close || d.open >= d.close)) return `${DAYS[i]}: the closing time must be after the opening time.`;
    }
    if (!Number.isInteger(settings.booking_window_days) || settings.booking_window_days < 1 || settings.booking_window_days > 365) {
      return "Clients can book 1 to 365 days ahead.";
    }
    if (settings.prepay_mode === "fixed" && !(settings.prepay_amount >= 0.5 && settings.prepay_amount <= 10000)) {
      return "The pre-pay amount must be at least $0.50.";
    }
    if (settings.prepay_mode === "percent" && !(Number.isInteger(settings.prepay_percent) && settings.prepay_percent >= 1 && settings.prepay_percent <= 100)) {
      return "The pre-pay percent must be 1 to 100.";
    }
    if (!Number.isInteger(settings.refund_window_hours) || settings.refund_window_hours < 0 || settings.refund_window_hours > 720) {
      return "The refund window must be 0 to 720 hours.";
    }
    if (!Number.isInteger(settings.hold_minutes) || settings.hold_minutes < 30 || settings.hold_minutes > 1380) {
      return "The hold time must be at least 30 minutes.";
    }
    return null;
  };

  const save = async (e: Event) => {
    e.preventDefault();
    const bad = problem();
    if (bad) return setMessage({ ok: false, text: bad });
    setSaving(true);
    setMessage(null);
    try {
      const r = await api<SettingsReply>("PUT", "/api/settings", {
        ...settings, shop_name: settings.shop_name.trim(), timezone: settings.timezone.trim(), address: settings.address.trim(),
        access_instructions: settings.access_instructions.trim(),
        agent_name: settings.agent_name.trim(), agent_instructions: settings.agent_instructions.trim(),
      });
      setSettings(r.settings);
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const noticeOptions = NOTICES.some(([m]) => m === settings.min_notice)
    ? NOTICES
    : [...NOTICES, [settings.min_notice, `${settings.min_notice} minutes`] as [number, string]];
  const stepOptions = SLOT_STEPS.includes(settings.slot_step) ? SLOT_STEPS : [...SLOT_STEPS, settings.slot_step].sort((a, b) => a - b);

  return (
    <form onSubmit={save} className="max-w-2xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Settings</h1>
        <a href="/book" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          Open the booking page <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Shop</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="shop-name">Shop name</Label>
            <Input id="shop-name" value={settings.shop_name} maxLength={100} onInput={(e: Event) => set({ shop_name: val(e) })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shop-address">Address</Label>
            <Input id="shop-address" value={settings.address} maxLength={300} onInput={(e: Event) => set({ address: val(e) })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="shop-access">How to get in</Label>
            <Input id="shop-access" value={settings.access_instructions} maxLength={500} placeholder="Park in the back. Ring the bell at the side door."
              onInput={(e: Event) => set({ access_instructions: val(e) })} />
            <p className="text-xs text-muted-foreground">Parking, door code, which floor. Automatic texts can include it.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shop-timezone">Time zone</Label>
            <Input id="shop-timezone" list="timezones" value={settings.timezone} onInput={(e: Event) => set({ timezone: val(e) })} />
            <datalist id="timezones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            <p className="text-xs text-muted-foreground">All booking times use this time zone. Example: America/New_York.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Opening hours</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {DAYS.map((day, i) => {
            const d = settings.hours[i];
            return (
              <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex min-h-11 w-32 items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="h-5 w-5 accent-primary md:h-4 md:w-4" checked={!d.closed} onChange={(e) => setDay(i, { closed: !e.currentTarget.checked })} />
                  {day}
                </label>
                {d.closed ? (
                  <span className="text-sm text-muted-foreground">Closed</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <Input type="time" className="w-32" aria-label={`${day} opens`} value={d.open} onInput={(e: Event) => setDay(i, { open: val(e) })} />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input type="time" className="w-32" aria-label={`${day} closes`} value={d.close} onInput={(e: Event) => setDay(i, { close: val(e) })} />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Online booking</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="slot-step">Times start every</Label>
            <select id="slot-step" className={selectClass} value={settings.slot_step} onChange={(e) => set({ slot_step: Number(e.currentTarget.value) })}>
              {stepOptions.map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="min-notice">Minimum notice</Label>
            <select id="min-notice" className={selectClass} value={settings.min_notice} onChange={(e) => set({ min_notice: Number(e.currentTarget.value) })}>
              {noticeOptions.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="booking-window">Days ahead</Label>
            <Input
              id="booking-window" type="number" min={1} max={365} value={settings.booking_window_days}
              onInput={(e: Event) => set({ booking_window_days: Math.round(Number(val(e))) })}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Clients can book from the minimum notice up to this many days ahead.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Pre-pay</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {!stripeConnected && (
            <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground sm:col-span-2">
              Stripe is not connected, so clients do not pre-pay and bookings are confirmed at once.
              Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the server to turn this on.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="prepay-mode">Clients pre-pay</Label>
            <select id="prepay-mode" className={selectClass} value={settings.prepay_mode}
              onChange={(e) => set({ prepay_mode: e.currentTarget.value as ShopSettings["prepay_mode"] })}>
              <option value="none">Nothing</option>
              <option value="fixed">A fixed amount</option>
              <option value="percent">A percent of the price</option>
              <option value="full">The full price</option>
            </select>
          </div>
          {settings.prepay_mode === "fixed" && (
            <div className="space-y-1.5">
              <Label htmlFor="prepay-amount">Amount ($)</Label>
              <Input id="prepay-amount" type="number" min={0.5} max={10000} step={0.01} value={settings.prepay_amount}
                onInput={(e: Event) => set({ prepay_amount: Number(val(e)) })} />
            </div>
          )}
          {settings.prepay_mode === "percent" && (
            <div className="space-y-1.5">
              <Label htmlFor="prepay-percent">Percent (%)</Label>
              <Input id="prepay-percent" type="number" min={1} max={100} value={settings.prepay_percent}
                onInput={(e: Event) => set({ prepay_percent: Math.round(Number(val(e))) })} />
            </div>
          )}
          {settings.prepay_mode !== "none" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="refund-window">Refund window (hours)</Label>
                <Input id="refund-window" type="number" min={0} max={720} value={settings.refund_window_hours}
                  onInput={(e: Event) => set({ refund_window_hours: Math.round(Number(val(e))) })} />
                <p className="text-xs text-muted-foreground">A client who cancels at least this long before the visit gets the pre-pay back.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hold-minutes">Hold time (minutes)</Label>
                <Input id="hold-minutes" type="number" min={30} max={1380} value={settings.hold_minutes}
                  onInput={(e: Event) => set({ hold_minutes: Math.round(Number(val(e))) })} />
                <p className="text-xs text-muted-foreground">We hold the time this long while the client pays. At least 30 minutes.</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Assistant</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" className="max-w-xs" value={settings.agent_name} maxLength={30} onInput={(e: Event) => set({ agent_name: val(e) })} />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-primary md:h-4 md:w-4" checked={settings.sign_messages} onChange={(e) => set({ sign_messages: e.currentTarget.checked })} />
            Sign the assistant's messages to clients, like "- {settings.agent_name.trim() || "Tolly"}"
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="agent-instructions">Extra instructions</Label>
            <textarea
              id="agent-instructions" rows={4} maxLength={2000} value={settings.agent_instructions}
              onInput={(e) => set({ agent_instructions: e.currentTarget.value })}
              className="w-full rounded-xl border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Things the assistant should know or do. Example: "Parking is behind the shop. We do not cut kids under 5."
            </p>
          </div>
        </CardContent>
      </Card>

      <CalendarLinks />

      {sms && <Connections sms={sms} stripeConnected={stripeConnected} />}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        {message && <p role="status" className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p>}
      </div>
    </form>
  );
}

const PROVIDERS: Record<string, string> = { telnyx: "Telnyx", twilio: "Twilio" };

/** What is connected. Keys are set on the server, never here. */
function Connections({ sms, stripeConnected }: { sms: SmsInfo; stripeConnected: boolean }) {
  const [copied, setCopied] = useState(false);
  const provider = PROVIDERS[sms.provider] ?? "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sms.webhook_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* the address is on the screen: the barber can select it */ }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Connections</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2">
          <p className="font-medium">Texts (SMS)</p>
          {sms.connected ? (
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted-foreground">Provider</dt><dd>{provider || "Connected"}</dd>
              <dt className="text-muted-foreground">Shop number</dt><dd>{sms.from_number}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">
              {provider
                ? `${provider} is not ready. Check the key and the shop number on the server.`
                : "Texts are off. Set TELNYX_API_KEY and TELNYX_FROM_NUMBER on the server to turn them on."}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="sms-webhook">Webhook address for incoming texts</Label>
            <div className="flex gap-2">
              <Input id="sms-webhook" readOnly value={sms.webhook_url} onFocus={(e: FocusEvent) => (e.currentTarget as HTMLInputElement).select()} />
              <Button type="button" variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste this address at your text provider, as the webhook for incoming messages. It must be an https address that the internet can reach.
            </p>
          </div>
        </div>
        <div className="space-y-1 border-t pt-4">
          <p className="font-medium">Payments (Stripe)</p>
          <p className="text-muted-foreground">
            {stripeConnected ? "Connected." : "Not connected. Set STRIPE_SECRET_KEY on the server to take pre-pay."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

interface CalendarLink { staff_id: number; name: string; feed_url: string; webcal_url: string }

/** Each barber's bookings as a calendar feed, for the phone's own calendar app. */
function CalendarLinks() {
  const [links, setLinks] = useState<CalendarLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    api<{ links: CalendarLink[] }>("GET", "/api/calendar-links")
      .then((d) => setLinks(d.links))
      .catch((e: Error) => setError(e.message));
  }, []);

  const copy = async (link: CalendarLink) => {
    try {
      await navigator.clipboard.writeText(link.feed_url);
      setCopied(link.staff_id);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // No clipboard: show the link, so the barber can select it.
      setShown(link.staff_id);
    }
  };

  const renew = async (link: CalendarLink) => {
    setError(null);
    try {
      const made = await api<{ link: CalendarLink }>("POST", `/api/calendar-links/${link.staff_id}/reset`);
      setLinks((all) => (all ?? []).map((l) => (l.staff_id === link.staff_id ? made.link : l)));
      setAsking(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Calendar on your phone</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          See your bookings in your own calendar app. The calendar updates by itself. This can take a few hours.
          Anyone with a link can see that barber's bookings, so keep it private.
        </p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {!links && !error && <p className="text-muted-foreground">Loading...</p>}
        {links && links.length === 0 && <p className="text-muted-foreground">Add a barber first.</p>}
        {links?.map((link) => (
          <div key={link.staff_id} className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
            <p className="font-medium">{link.name}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => { window.location.href = link.webcal_url; }}>Add to iPhone / Mac Calendar</Button>
              <Button type="button" variant="outline" onClick={() => copy(link)}>{copied === link.staff_id ? "Copied" : "Copy link for Google"}</Button>
              {asking !== link.staff_id && <Button type="button" variant="ghost" onClick={() => setAsking(link.staff_id)}>New link</Button>}
            </div>
            {shown === link.staff_id && (
              <Input readOnly aria-label={`Calendar link for ${link.name}`} value={link.feed_url} onFocus={(e: FocusEvent) => (e.currentTarget as HTMLInputElement).select()} />
            )}
            {asking === link.staff_id && (
              <div className="space-y-2 rounded-xl border border-destructive/40 p-3">
                <p>Make a new link for {link.name}? The old link stops working. Calendars that use it will stop updating.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="destructive" onClick={() => renew(link)}>Yes, make a new link</Button>
                  <Button type="button" variant="outline" onClick={() => setAsking(null)}>Keep the old link</Button>
                </div>
              </div>
            )}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Google Calendar: copy the link. On a computer, open Google Calendar, then Other calendars, then From URL, and paste it.
        </p>
      </CardContent>
    </Card>
  );
}
