import { useEffect, useRef, useState } from "preact/hooks";
import { Bot, MessageSquareText, Plus } from "lucide-preact";
import { api, ApiError } from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormPage } from "./form-page";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfirmSheet } from "./confirm-sheet";

type Trigger = "daily" | "before_appointment" | "after_appointment" | "booking_created" | "prepay_paid" | "booking_cancelled" | "booking_moved";
type Action = "text_client" | "agent_task";
interface Filters { statuses?: string[]; sources?: string[]; staff_ids?: number[]; service_ids?: number[]; first_visit?: boolean }
interface Run { id: number; status: string; detail: string; created_at: string; reference: string | null; client_name: string | null }
interface Automation {
  id: number; name: string; enabled: boolean; trigger: Trigger; trigger_config: Record<string, unknown>;
  action: Action; action_config: Record<string, unknown>; filters: Filters; created_by: string; builtin_key: string | null;
  summary: string; last_run: { status: string; detail: string; created_at: string } | null;
}
interface ListReply { automations: Automation[]; placeholders: string[]; assistant_ready: boolean; texts_ready: boolean }
interface Named { id: number; name: string }

/** What the editor holds while you type. */
interface Draft {
  id: number | null; name: string; enabled: boolean; trigger: Trigger; action: Action;
  time: string; days: number[]; scope: "today" | "tomorrow"; amount: number; unit: "minutes" | "hours" | "days";
  message: string; instructions: string; filters: Filters;
}

const TRIGGERS: [Trigger, string][] = [
  ["daily", "Every day at a set time"],
  ["before_appointment", "Before a visit"],
  ["after_appointment", "After a visit"],
  ["booking_created", "When a visit is booked"],
  ["prepay_paid", "When a pre-pay is paid"],
  ["booking_cancelled", "When a visit is cancelled"],
  ["booking_moved", "When a visit is moved"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUSES: [string, string][] = [
  ["pending", "Waiting for pre-pay"], ["booked", "Booked"], ["confirmed", "Confirmed"], ["in_progress", "In progress"],
  ["completed", "Completed"], ["cancelled", "Cancelled"], ["no_show", "No-show"],
];
const SOURCES: [string, string][] = [["staff", "Made by staff"], ["online", "Booked online"], ["chat", "Web chat"], ["sms", "Text message"]];
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 };
const selectClass =
  "h-11 w-full rounded-xl border border-input bg-card px-3 text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.");

function splitMinutes(total: number): { amount: number; unit: Draft["unit"] } {
  if (total >= 1440 && total % 1440 === 0) return { amount: total / 1440, unit: "days" };
  if (total >= 60 && total % 60 === 0) return { amount: total / 60, unit: "hours" };
  return { amount: total, unit: "minutes" };
}

function newDraft(): Draft {
  return {
    id: null, name: "", enabled: true, trigger: "before_appointment", action: "text_client",
    time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], scope: "today", amount: 2, unit: "hours",
    message: "Hi {client_first_name}! See you {day} at {time}.", instructions: "", filters: {},
  };
}

function toDraft(a: Automation): Draft {
  const c = a.trigger_config;
  const split = splitMinutes(typeof c.minutes === "number" ? c.minutes : 120);
  return {
    ...newDraft(), id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, action: a.action,
    time: typeof c.time === "string" ? c.time : "08:00",
    days: Array.isArray(c.days) ? (c.days as number[]) : [0, 1, 2, 3, 4, 5, 6],
    scope: c.scope === "tomorrow" ? "tomorrow" : "today",
    ...split,
    message: typeof a.action_config.message === "string" ? a.action_config.message : "",
    instructions: typeof a.action_config.instructions === "string" ? a.action_config.instructions : "",
    filters: a.filters ?? {},
  };
}

function toBody(d: Draft) {
  const trigger_config = d.trigger === "daily"
    ? { time: d.time, days: d.days, scope: d.scope }
    : d.trigger === "before_appointment" || d.trigger === "after_appointment"
      ? { minutes: Math.round(d.amount * UNIT_MINUTES[d.unit]) }
      : {};
  const filters: Filters = {};
  if (d.action === "text_client") {
    if (d.filters.statuses?.length) filters.statuses = d.filters.statuses;
    if (d.filters.sources?.length) filters.sources = d.filters.sources;
    if (d.filters.staff_ids?.length) filters.staff_ids = d.filters.staff_ids;
    if (d.filters.service_ids?.length) filters.service_ids = d.filters.service_ids;
    if (typeof d.filters.first_visit === "boolean") filters.first_visit = d.filters.first_visit;
  }
  return {
    name: d.name, enabled: d.enabled, trigger: d.trigger, trigger_config, action: d.action,
    action_config: d.action === "text_client" ? { message: d.message } : { instructions: d.instructions },
    filters,
  };
}

function when(text: string): string {
  const date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const RUN_WORDS: Record<string, string> = { sent: "Sent", done: "Done", skipped: "Skipped", failed: "Failed", running: "Running" };

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors before:absolute before:-inset-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
        on ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-card shadow transition-transform", on ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

function Chips<T extends string | number>({ options, chosen, onChange }: { options: [T, string][]; chosen: T[]; onChange: (next: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([value, label]) => {
        const on = chosen.includes(value);
        return (
          <button
            key={String(value)} type="button" aria-pressed={on}
            onClick={() => onChange(on ? chosen.filter((v) => v !== value) : [...chosen, value])}
            className={cn(
              "min-h-11 rounded-full border px-3.5 md:min-h-9 md:px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-accent",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Automations: routines that send texts or give the assistant a task, without anyone pressing a button. */
export function AutomationsPage() {
  const [data, setData] = useState<ListReply | null>(null);
  const [staff, setStaff] = useState<Named[]>([]);
  const [services, setServices] = useState<Named[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async () => {
    try {
      setData(await api<ListReply>("GET", "/api/automations"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  };

  useEffect(() => {
    load();
    api<{ staff: Named[] }>("GET", "/api/staff").then((r) => setStaff(r.staff)).catch(() => {});
    api<{ services: Named[] }>("GET", "/api/services").then((r) => setServices(r.services)).catch(() => {});
  }, []);

  const toggle = async (a: Automation, enabled: boolean) => {
    setBusyId(a.id);
    try {
      await api("PUT", `/api/automations/${a.id}`, { enabled });
      await load();
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Automations</h1>
          <p className="text-sm text-muted-foreground">Routines that run on their own. Set one up once.</p>
          <p className="mt-1 text-xs text-muted-foreground">Ask your assistant to set one up.</p>
        </div>
        <Button onClick={() => setDraft(newDraft())}><Plus className="mr-2 h-4 w-4" />New automation</Button>
      </div>

      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      {data && !data.texts_ready && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Texts are not set up yet. Text routines will be skipped until you add a text provider.
        </p>
      )}
      {!data && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.automations.length === 0 && (
        <p className="text-sm text-muted-foreground">No automations yet.</p>
      )}

      <div className="space-y-3">
        {data?.automations.map((a) => (
          <Card key={a.id} className={cn(!a.enabled && "opacity-70")}>
            <CardContent className="flex items-start gap-4 p-4">
              <button type="button" className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setDraft(toDraft(a))}>
                <div className="flex flex-wrap items-center gap-2">
                  {a.action === "agent_task" ? <Bot className="h-4 w-4 shrink-0 text-muted-foreground" /> : <MessageSquareText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="font-medium">{a.name}</span>
                  {a.created_by === "agent" && <Badge variant="secondary">Made by the assistant</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.last_run ? `Last run: ${when(a.last_run.created_at)} · ${RUN_WORDS[a.last_run.status] ?? a.last_run.status}` : "Has not run yet."}
                </p>
              </button>
              <Switch on={a.enabled} label={`${a.name}: ${a.enabled ? "on" : "off"}`} disabled={busyId === a.id} onChange={(on) => toggle(a, on)} />
            </CardContent>
          </Card>
        ))}
      </div>

      {draft && data && (
        <Editor
          key={draft.id ?? "new"} initial={draft} placeholders={data.placeholders} assistantReady={data.assistant_ready}
          staff={staff} services={services}
          onClose={() => setDraft(null)}
          onSaved={async () => { setDraft(null); await load(); }}
          onChanged={load}
        />
      )}
    </div>
  );
}

interface EditorProps {
  initial: Draft; placeholders: string[]; assistantReady: boolean; staff: Named[]; services: Named[];
  onClose: () => void; onSaved: () => Promise<void>; onChanged: () => Promise<void>;
}

function Editor({ initial, placeholders, assistantReady, staff, services, onClose, onSaved, onChanged }: EditorProps) {
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ text: string; sample: boolean; appointment: { client_name: string; date: string; time: string } | null } | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<Draft>) => { setD((old) => ({ ...old, ...patch })); setPreview(null); };
  const setFilter = (patch: Partial<Filters>) => set({ filters: { ...d.filters, ...patch } });
  const timed = d.trigger === "before_appointment" || d.trigger === "after_appointment";
  const isText = d.action === "text_client";

  const loadRuns = () => {
    if (d.id === null) return;
    api<{ runs: Run[] }>("GET", `/api/automations/${d.id}/runs`).then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  };
  useEffect(loadRuns, [d.id]);

  const addPlaceholder = (name: string) => {
    const el = messageRef.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? d.message.length;
    const end = el?.selectionEnd ?? d.message.length;
    set({ message: d.message.slice(0, start) + token + d.message.slice(end) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setNote(null);
    try { await work(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const save = () => act(async () => {
    if (d.id === null) await api("POST", "/api/automations", toBody(d));
    else await api("PUT", `/api/automations/${d.id}`, toBody(d));
    await onSaved();
  });

  const remove = () => act(async () => {
    setAsking(false);
    if (d.id === null || busy) return;
    await api("DELETE", `/api/automations/${d.id}`);
    await onSaved();
  });

  const showPreview = () => act(async () => {
    setPreview(await api("POST", "/api/automations/preview", { message: d.message }));
  });

  const runNow = () => act(async () => {
    await api("POST", `/api/automations/${d.id}/run`);
    setNote("Started. The report will show in your assistant chat.");
    setTimeout(() => { loadRuns(); onChanged(); }, 4000);
  });

  return (
    <FormPage
      title={d.id === null ? "New automation" : "Edit automation"}
      description="Choose when it runs, what it does, and for which visits."
      onClose={onClose}
      className="max-h-[90dvh] sm:max-w-xl"
      footer={<>
        {d.id !== null && <Button type="button" variant="ghost" className="text-destructive sm:mr-auto" disabled={busy} onClick={() => setAsking(true)}>Delete</Button>}
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
      </>}
    >
        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="auto-name">Name</Label>
            <Input id="auto-name" value={d.name} maxLength={80} placeholder="Day-before reminder" onInput={(e) => set({ name: val(e) })} />
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">When</h3>
            <select aria-label="When it runs" className={selectClass} value={d.trigger} onChange={(e) => set({ trigger: val(e) as Trigger })}>
              {TRIGGERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {d.trigger === "daily" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Label htmlFor="auto-time">Time</Label>
                  <Input id="auto-time" type="time" className="w-36" value={d.time} onInput={(e) => set({ time: val(e) })} />
                </div>
                <Chips options={DAYS.map((label, i) => [i, label] as [number, string])} chosen={d.days} onChange={(days) => set({ days: [...days].sort() })} />
                {isText && (
                  <select aria-label="Which visits" className={selectClass} value={d.scope} onChange={(e) => set({ scope: val(e) as Draft["scope"] })}>
                    <option value="today">Clients with a visit that day</option>
                    <option value="tomorrow">Clients with a visit the next day</option>
                  </select>
                )}
              </div>
            )}
            {timed && (
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="How long" type="number" min={1} className="w-24" value={d.amount} onInput={(e) => set({ amount: Number(val(e)) || 0 })} />
                <select aria-label="Unit" className={cn(selectClass, "w-32")} value={d.unit} onChange={(e) => set({ unit: val(e) as Draft["unit"] })}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
                <span className="text-sm text-muted-foreground">{d.trigger === "before_appointment" ? "before the visit starts" : "after the visit ends"}</span>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Do</h3>
            <select
              aria-label="What it does" className={selectClass} value={d.action}
              onChange={(e) => {
                const action = val(e) as Action;
                // The assistant has no single visit to work on, so its tasks run on a schedule.
                set(action === "agent_task" && d.trigger !== "daily" ? { action, trigger: "daily" } : { action });
              }}
            >
              <option value="text_client">Text the client</option>
              <option value="agent_task">Give the assistant a task</option>
            </select>
            {isText ? (
              <div className="space-y-2">
                <Textarea ref={messageRef} aria-label="Message" rows={4} value={d.message} onInput={(e) => set({ message: val(e) })} />
                <p className="text-xs text-muted-foreground">Tap to add a detail. It is filled in for each client.</p>
                <div className="flex flex-wrap gap-1.5">
                  {placeholders.map((name) => (
                    <button
                      key={name} type="button" onClick={() => addPlaceholder(name)}
                      className="rounded-md border bg-muted px-2 py-1 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {`{${name}}`}
                    </button>
                  ))}
                </div>
                <Button type="button" variant="outline" size="sm" disabled={busy || !d.message.trim()} onClick={showPreview}>Preview</Button>
                {preview && (
                  <div className="space-y-1">
                    <p className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm">{preview.text}</p>
                    <p className="text-xs text-muted-foreground">
                      {preview.appointment
                        ? `Made with ${preview.appointment.client_name}'s visit on ${preview.appointment.date}. Nothing was sent.`
                        : "Made with sample details. Nothing was sent."}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Textarea aria-label="Task for the assistant" rows={4} value={d.instructions} placeholder="Tell me who has not confirmed for tomorrow." onInput={(e) => set({ instructions: val(e) })} />
                <p className="text-xs text-muted-foreground">The assistant does the task and posts a short report in your assistant chat.</p>
                {!assistantReady && <p className="text-xs text-destructive">The assistant is off: no AI key is set.</p>}
                {d.id !== null && (
                  <Button type="button" variant="outline" size="sm" disabled={busy || !assistantReady} onClick={runNow}>Run now</Button>
                )}
              </div>
            )}
          </section>

          {isText && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Only for</h3>
              <p className="text-xs text-muted-foreground">Leave a line empty to include everyone.</p>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Chips options={STATUSES} chosen={d.filters.statuses ?? []} onChange={(statuses) => setFilter({ statuses })} />
              </div>
              <div className="space-y-1.5">
                <Label>How it was booked</Label>
                <Chips options={SOURCES} chosen={d.filters.sources ?? []} onChange={(sources) => setFilter({ sources })} />
              </div>
              {staff.length > 1 && (
                <div className="space-y-1.5">
                  <Label>Barber</Label>
                  <Chips options={staff.map((s) => [s.id, s.name] as [number, string])} chosen={d.filters.staff_ids ?? []} onChange={(staff_ids) => setFilter({ staff_ids })} />
                </div>
              )}
              {services.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Service</Label>
                  <Chips options={services.map((s) => [s.id, s.name] as [number, string])} chosen={d.filters.service_ids ?? []} onChange={(service_ids) => setFilter({ service_ids })} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="auto-first">Clients</Label>
                <select
                  id="auto-first" className={selectClass}
                  value={d.filters.first_visit === true ? "first" : d.filters.first_visit === false ? "returning" : "all"}
                  onChange={(e) => { const v = val(e); setFilter({ first_visit: v === "first" ? true : v === "returning" ? false : undefined }); }}
                >
                  <option value="all">All clients</option>
                  <option value="first">First visit only</option>
                  <option value="returning">Returning clients only</option>
                </select>
              </div>
            </section>
          )}

          {d.id !== null && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">History</h3>
              {runs === null && <p className="text-xs text-muted-foreground">Loading…</p>}
              {runs?.length === 0 && <p className="text-xs text-muted-foreground">Has not run yet.</p>}
              {runs && runs.length > 0 && (
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
                  {runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
                      <span className="text-xs text-muted-foreground">{when(r.created_at)}</span>
                      <span className={cn("font-medium", r.status === "failed" && "text-destructive")}>{RUN_WORDS[r.status] ?? r.status}</span>
                      {r.client_name && <span>{r.client_name}</span>}
                      {r.detail && r.status !== "sent" && <span className="w-full break-words text-xs text-muted-foreground">{r.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}

        </div>
        <ConfirmSheet
          open={asking}
          title={`Delete "${d.name}"?`}
          text="Its history is deleted too."
          action="Delete"
          onConfirm={remove}
          onCancel={() => setAsking(false)}
        />
    </FormPage>
  );
}
