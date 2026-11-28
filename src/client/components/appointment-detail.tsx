import { useState } from "preact/hooks";
import { useApp } from "../context";
import { ArrowLeft, Trash2, Send, Clock, User, DollarSign } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "./status-badge";
import { RescheduleAppointment } from "./reschedule-appointment";
import { AppointmentPayments } from "./appointment-payments";
import { conflictsFrom, conflictSentence } from "@/lib/conflicts";
import { soloBarber } from "@/lib/solo";
import { friendlyDate } from "@/lib/dates";
import { formatRange } from "@/lib/calendar-slot";
import { RowMenu } from "./row-menu";
import { useConfirm } from "./confirm-sheet";

export function AppointmentDetail() {
  const {
    selectedAppointment: apt, navigate, updateAppointment, deleteAppointment,
    addAppointmentNote, deleteAppointmentNote, staffLookup, setError,
  } = useApp();
  const [noteText, setNoteText] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  const [ask, sheet] = useConfirm();

  if (!apt) return null;

  // Reassigning can now be refused, because the new person may already be busy.
  const save = async (patch: Partial<typeof apt>) => {
    try {
      await updateAppointment(apt.id, patch);
    } catch (err) {
      const clashes = conflictsFrom(err);
      setError(clashes
        ? conflictSentence(staffLookup.find((s) => s.id === patch.staff_id)?.name ?? "", clashes)
        : (err as Error).message);
    }
  };

  const handleStatusChange = (status: string) => save({ status } as Partial<typeof apt>);
  const handleStaffChange = (staffId: string) => save({ staff_id: staffId ? parseInt(staffId) : null } as Partial<typeof apt>);

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    await addAppointmentNote(apt.id, noteText.trim());
    setNoteText("");
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex min-h-11 items-center gap-2 md:gap-4">
        <Button variant="ghost" size="sm" className="max-md:-ml-2 max-md:px-0" onClick={() => navigate("/appointments")}>
          <ArrowLeft className="h-4 w-4 md:mr-1" aria-hidden="true" /> <span className="max-md:sr-only">Back</span>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-[1.65rem] font-medium leading-tight tracking-tight">{apt.identifier}</h1>
        <StatusBadge status={apt.status} />
        <RowMenu
          label={`More for booking ${apt.identifier}`} className="-mr-2"
          actions={[{ label: "Delete booking", destructive: true, onSelect: () => ask({
            title: `Delete booking ${apt.identifier}?`,
            text: "The booking and its notes are removed. Payments you took stay in your reports. To keep a record, set the status to Cancelled instead. You cannot undo this.",
            action: "Delete booking", run: () => deleteAppointment(apt.id),
          }) }]}
        />
      </div>
      {sheet}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Booking details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3 w-3" /> Date and time</Label>
                  <p className="text-sm font-medium">{friendlyDate(apt.scheduled_date)}, {formatRange(apt.start_time, apt.end_time)}</p>
                  <Button variant="outline" size="sm" className="px-3" onClick={() => setRescheduling(true)}>Reschedule</Button>
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><User className="h-3 w-3" /> Client</Label>
                  <button className="flex min-h-11 items-center text-left text-sm font-medium text-primary hover:underline md:min-h-0" onClick={() => navigate(`/clients/${apt.client_id}`)}>
                    {apt.client_name}
                  </button>
                  {apt.client_phone && <p className="text-xs text-muted-foreground">{apt.client_phone}</p>}
                </div>
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-4">
                {/* A one-barber shop has nothing to choose once the booking is theirs. */}
                {soloBarber(staffLookup)?.id !== apt.staff_id && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Staff</Label>
                    <select className="flex h-11 w-full rounded-xl border border-input bg-card px-3 text-base md:h-9 md:text-sm" value={apt.staff_id || ""} onChange={(e) => handleStaffChange((e.target as HTMLSelectElement).value)}>
                      <option value="">Unassigned</option>
                      {staffLookup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <select className="flex h-11 w-full rounded-xl border border-input bg-card px-3 text-base md:h-9 md:text-sm" value={apt.status} onChange={(e) => handleStatusChange((e.target as HTMLSelectElement).value)}>
                    {apt.status === "pending" && <option value="pending">Waiting for pre-pay</option>}
                    <option value="booked">Booked</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="in_progress">In progress</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="no_show">No show</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><DollarSign className="h-3 w-3" /> Total</Label>
                <p className="text-lg font-medium">${apt.total_price.toFixed(2)}</p>
              </div>
              {apt.notes && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <p className="text-sm">{apt.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
          <AppointmentPayments key={apt.id} appointmentId={apt.id} status={apt.status} totalPrice={apt.total_price} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Services</CardTitle>
            </CardHeader>
            <CardContent>
              {(!apt.appointment_services || apt.appointment_services.length === 0) ? (
                <p className="text-sm text-muted-foreground">No services added</p>
              ) : (
                <div className="space-y-2">
                  {apt.appointment_services.map((svc) => (
                    <div key={svc.id} className="flex items-center justify-between text-sm">
                      <span>{svc.service_name || `Service #${svc.service_id}`}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{svc.duration}min</span>
                        <span className="font-medium">${svc.price.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a note..."
                  value={noteText}
                  onChange={(e) => setNoteText((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
                />
                <Button variant="outline" size="icon" onClick={handleAddNote}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              {(!apt.appointment_notes || apt.appointment_notes.length === 0) ? (
                <p className="text-sm text-muted-foreground">No notes yet</p>
              ) : (
                <div className="space-y-2">
                  {apt.appointment_notes.map((note) => (
                    <div key={note.id} className="rounded-md border bg-muted/30 p-2.5">
                      <p className="text-sm">{note.content}</p>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{new Date(note.created_at).toLocaleString()}</span>
                        <Button variant="ghost" aria-label="Delete this note" size="icon" className="h-5 w-5 text-muted-foreground hover:text-destructive" onClick={() => ask({ title: "Delete this note?", text: "You cannot undo this.", action: "Delete note", run: () => deleteAppointmentNote(note.id) })}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {rescheduling && <RescheduleAppointment key={apt.id} appointment={apt} onClose={() => setRescheduling(false)} />}
    </div>
  );
}
