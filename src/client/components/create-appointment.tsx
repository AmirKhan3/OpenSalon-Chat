import { useEffect, useRef, useState } from "preact/hooks";
import { BlockTitle, Button, Checkbox, Link, List, ListInput, ListItem, Navbar, Page, Popup } from "konsta/react";
import { TriangleAlert, UserRound, UserRoundPlus } from "lucide-preact";
import { useApp } from "../context";
import { useBackCloses } from "../hooks/use-back-closes";
import { api } from "../api";
import { conflictsFrom, describeConflict, type Conflict } from "@/lib/conflicts";
import { joinName, phoneLooksRight, splitName, tidyPhone } from "@/lib/client-name";
import { today } from "@/lib/dates";
import { barberChoice, soloBarber } from "@/lib/solo";

interface Props {
  onClose: () => void;
  defaultDate?: string;
  defaultClientId?: number;
  defaultStaffId?: number | null;
  defaultStartTime?: string;
}

/** A customer the form can offer or use. */
interface Customer { id: number; name: string; phone: string }

const value = (e: Event) => (e.target as HTMLInputElement).value;

export function CreateAppointment({ onClose, defaultDate, defaultClientId, defaultStaffId, defaultStartTime }: Props) {
  useBackCloses(onClose);
  const { addAppointment, createClient, clientLookup, staffLookup, services } = useApp();

  const startClient = defaultClientId ? clientLookup.find((c) => c.id === defaultClientId) : undefined;
  const startName = splitName(startClient?.name ?? "");

  // The customer: an existing one (picked) or a new one (typed).
  const [picked, setPicked] = useState<Customer | null>(startClient ? { id: startClient.id, name: startClient.name, phone: "" } : null);
  const [first, setFirst] = useState(startName.first);
  const [last, setLast] = useState(startName.last);
  const [phone, setPhone] = useState("");
  const [suggestions, setSuggestions] = useState<Customer[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(!startClient);
  /** A customer with the same name as the typed one. The barber chooses: use them, or add a new one. */
  const [twin, setTwin] = useState<Customer | null>(null);
  const addAsNew = useRef(false);
  /** True while a booking is on its way. A ref, so a fast second tap sees it at once. */
  const busy = useRef(false);

  const [pickedStaff, setStaffId] = useState(defaultStaffId ? String(defaultStaffId) : "");
  // A one-barber shop never asks which barber.
  const solo = soloBarber(staffLookup);
  const staffId = barberChoice(staffLookup, pickedStaff);
  const [date, setDate] = useState(defaultDate || today());
  const [startTime, setStartTime] = useState(defaultStartTime || "09:00");
  const [selectedServices, setSelectedServices] = useState<number[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [problem, setProblem] = useState("");

  // Up to 3 customers under the first name: recent ones at first, then ones that match the text.
  useEffect(() => {
    if (picked) { setSuggestions([]); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      api<{ clients: Customer[] }>("GET", `/api/clients/suggest?q=${encodeURIComponent(first.trim())}`)
        .then((r) => { if (!stale) setSuggestions(r.clients); })
        .catch(() => { if (!stale) setSuggestions([]); });
    }, first.trim() ? 150 : 0);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [first, picked]);

  const fullName = joinName(first, last);

  /** The barber changed the name by hand: this is no longer the picked customer. */
  const nameEdited = () => {
    setPicked(null);
    setTwin(null);
    addAsNew.current = false;
    setProblem("");
  };

  const pick = (c: Customer) => {
    const name = splitName(c.name);
    setPicked(c);
    setFirst(name.first);
    setLast(name.last);
    setPhone("");
    setTwin(null);
    setShowSuggestions(false);
    setProblem("");
  };

  const toggleService = (id: number) => {
    setConflicts(null);
    setSelectedServices((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const chosen = services.filter((s) => selectedServices.includes(s.id));
  const totalPrice = chosen.reduce((sum, s) => sum + s.price, 0);
  const totalDuration = chosen.reduce((sum, s) => sum + s.duration, 0);
  const staffName = staffLookup.find((s) => String(s.id) === staffId)?.name ?? "That staff member";

  /** The customer to book: the picked one, or a new one made from the typed name. `null` means stop and ask. */
  const customerId = async (): Promise<number | null> => {
    if (picked) return picked.id;
    if (!addAsNew.current) {
      const found = await api<{ clients: Customer[] }>("GET", `/api/clients/suggest?exact=1&q=${encodeURIComponent(fullName)}`);
      if (found.clients[0]) { setTwin(found.clients[0]); return null; }
    }
    const created = await createClient({ name: fullName, ...(tidyPhone(phone) ? { phone: tidyPhone(phone) } : {}) });
    addAsNew.current = false;
    // From here on this is an existing customer. A second try must not add them again.
    setPicked({ id: created.id, name: created.name, phone: created.phone ?? "" });
    setShowSuggestions(false);
    return created.id;
  };

  const handleSubmit = async (allowConflict = false) => {
    if (busy.current) return;
    if (!first.trim()) { setProblem("Enter the customer's first name."); return; }
    if (!picked && !phoneLooksRight(phone)) { setProblem("Check the mobile number. It needs 10 digits."); return; }
    busy.current = true;
    setSaving(true);
    setConflicts(null);
    setProblem("");
    setTwin(null);
    try {
      const clientId = await customerId();
      if (clientId === null) return;
      await addAppointment({
        client_id: clientId,
        staff_id: staffId ? parseInt(staffId) : null,
        scheduled_date: date,
        start_time: startTime,
        notes,
        service_ids: selectedServices,
        ...(allowConflict ? { allow_conflict: true } : {}),
      });
      onClose();
    } catch (err) {
      // A clash is answered in the form, next to the time that caused it, rather
      // than thrown at the page as a failure: the booking is one field away.
      const clashes = conflictsFrom(err);
      if (clashes) setConflicts(clashes);
      else setProblem((err as Error).message || "Something went wrong. Please try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <Popup opened onBackdropClick={onClose} className="sheet-page z-50">
      <Page>
        <Navbar
          title="New booking"
          left={<Link onClick={onClose}>Cancel</Link>}
          right={<Link onClick={() => handleSubmit()} className={saving ? "pointer-events-none opacity-50" : ""}>{saving ? "Booking..." : "Book"}</Link>}
        />

        <BlockTitle>Customer</BlockTitle>
        <List strong inset>
          <ListInput
            label="First name"
            type="text"
            placeholder="Type a name"
            autoComplete="off"
            autoCapitalize="words"
            value={first}
            onInput={(e: Event) => { setFirst(value(e)); nameEdited(); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
          />
          {showSuggestions && !picked && suggestions.map((c) => (
            <ListItem
              key={c.id}
              link
              chevron={false}
              media={<UserRound className="h-5 w-5 text-primary" aria-hidden="true" />}
              title={c.name}
              after={c.phone ? `...${c.phone.replace(/\D/g, "").slice(-4)}` : undefined}
              onClick={() => pick(c)}
            />
          ))}
          <ListInput
            label="Last name"
            type="text"
            placeholder="Last name"
            autoComplete="off"
            autoCapitalize="words"
            value={last}
            onInput={(e: Event) => { setLast(value(e)); nameEdited(); }}
            onFocus={() => setShowSuggestions(false)}
          />
          {!picked && (
            <ListInput
              label="Mobile number (optional)"
              type="tel"
              inputMode="tel"
              placeholder="For text reminders"
              autoComplete="off"
              value={phone}
              onInput={(e: Event) => { setPhone(value(e)); setProblem(""); }}
              onFocus={() => setShowSuggestions(false)}
            />
          )}
        </List>
        <p className="-mt-4 mb-2 flex items-center gap-1.5 px-8 text-xs text-muted-foreground" aria-live="polite">
          {picked ? (
            <><UserRound className="h-3.5 w-3.5" aria-hidden="true" /> Existing customer.</>
          ) : first.trim() ? (
            <><UserRoundPlus className="h-3.5 w-3.5" aria-hidden="true" /> New customer. We add {fullName} when you book.</>
          ) : (
            <>Pick a recent customer, or type a new name.</>
          )}
        </p>

        {twin && (
          <div className="mx-4 mb-4 space-y-3 rounded-2xl border border-warning-border bg-warning-soft p-4 text-sm" role="alert">
            <p className="font-medium">{twin.name} is already a customer.</p>
            <div className="flex gap-2">
              <Button small onClick={() => pick(twin)}>Use {splitName(twin.name).first}</Button>
              <Button small tonal onClick={() => { addAsNew.current = true; setTwin(null); handleSubmit(); }}>Add as new</Button>
            </div>
          </div>
        )}

        <BlockTitle>When</BlockTitle>
        <List strong inset>
          {!solo && (
            <ListInput
              label="Barber"
              type="select"
              dropdown
              value={staffId}
              onChange={(e: Event) => { setStaffId(value(e)); setConflicts(null); }}
            >
              <option value="">Unassigned</option>
              {staffLookup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </ListInput>
          )}
          <ListInput label="Date" type="date" value={date} onInput={(e: Event) => { setDate(value(e)); setConflicts(null); }} />
          <ListInput label="Start time" type="time" value={startTime} onInput={(e: Event) => { setStartTime(value(e)); setConflicts(null); }} />
        </List>

        <BlockTitle>Services</BlockTitle>
        <List strong inset>
          {services.filter((s) => s.active).map((svc) => (
            <ListItem
              key={svc.id}
              label
              title={svc.name}
              after={`${svc.duration} min · $${svc.price}`}
              media={
                <Checkbox
                  component="div"
                  name={`service-${svc.id}`}
                  checked={selectedServices.includes(svc.id)}
                  onChange={() => toggleService(svc.id)}
                />
              }
            />
          ))}
        </List>
        {selectedServices.length > 0 && (
          <p className="-mt-4 mb-2 px-8 text-sm font-medium text-primary">
            Total: {totalDuration} min &middot; ${totalPrice.toFixed(2)}
          </p>
        )}

        <BlockTitle>Notes</BlockTitle>
        <List strong inset>
          <ListInput
            type="textarea"
            placeholder="Special requests, preferences..."
            inputClassName="!h-20 resize-none"
            value={notes}
            onInput={(e: Event) => setNotes(value(e))}
          />
        </List>

        {conflicts && (
          <div className="mx-4 mb-4 flex gap-2.5 rounded-2xl border border-warning-border bg-warning-soft p-4 text-sm" role="alert">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium">{staffName} is not free then.</p>
              <ul className="text-muted-foreground">
                {conflicts.map((c) => (
                  <li key={`${c.start_time}-${c.label}`}>{describeConflict(c)}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">Pick another time or barber, or book it anyway.</p>
            </div>
          </div>
        )}
        {problem && (
          <p className="mx-4 mb-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{problem}</p>
        )}

        <div className="space-y-2 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            disabled={saving}
            onClick={() => handleSubmit()}
            className="glass-tint flex h-12 w-full items-center justify-center rounded-full text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            {saving ? "Booking..." : "Book"}
          </button>
          {conflicts && (
            <Button large tonal disabled={saving} onClick={() => handleSubmit(true)}>
              Book anyway
            </Button>
          )}
        </div>
      </Page>
    </Popup>
  );
}
