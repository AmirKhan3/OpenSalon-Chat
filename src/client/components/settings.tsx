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
  hours: DayHours[];
  slot_step: number;
  min_notice: number;
  booking_window_days: number;
  prepay_mode: "none" | "fixed" | "percent" | "full";
  prepay_amount: number;
  prepay_percent: number;
  refund_window_hours: number;
  hold_minutes: number;
}
interface SettingsReply { settings: ShopSettings; stripe_connected: boolean }

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SLOT_STEPS = [10, 15, 20, 30, 45, 60];
const NOTICES: [number, string][] = [
  [0, "No notice"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"],
  [720, "12 hours"], [1440, "1 day"], [2880, "2 days"],
];
const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    api<SettingsReply>("GET", "/api/settings")
      .then((r) => { setSettings(r.settings); setStripeConnected(r.stripe_connected); })
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
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <a href="/book" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
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
                <label className="flex min-h-10 w-32 items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="h-4 w-4" checked={!d.closed} onChange={(e) => setDay(i, { closed: !e.currentTarget.checked })} />
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
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground sm:col-span-2">
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

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        {message && <p role="status" className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p>}
      </div>
    </form>
  );
}
