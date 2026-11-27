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
}

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    api<{ settings: ShopSettings }>("GET", "/api/settings")
      .then((r) => setSettings(r.settings))
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
    return null;
  };

  const save = async (e: Event) => {
    e.preventDefault();
    const bad = problem();
    if (bad) return setMessage({ ok: false, text: bad });
    setSaving(true);
    setMessage(null);
    try {
      const r = await api<{ settings: ShopSettings }>("PUT", "/api/settings", {
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

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        {message && <p role="status" className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p>}
      </div>
    </form>
  );
}
