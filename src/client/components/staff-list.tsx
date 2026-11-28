import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateStaff } from "./create-staff";
import { inkOn } from "@/lib/calendar-slot";
import { staffDeleteWords } from "@/lib/confirm";
import type { Staff } from "../types";
import { RowMenu } from "./row-menu";
import { useConfirm } from "./confirm-sheet";

export function StaffList() {
  const { staffMembers, deleteStaff, updateStaff } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [ask, sheet] = useConfirm();

  const deactivate = (s: Staff) => ask({
    title: `Deactivate ${s.name}?`,
    text: `Clients can no longer book with ${s.name}. Past bookings and payments stay. You can activate ${s.name} again any time.`,
    action: `Deactivate ${s.name}`,
    run: () => updateStaff(s.id, { active: 0 }),
  });
  const remove = (s: Staff) => {
    const words = staffDeleteWords(s.name, s.appointment_count || 0, staffMembers.length === 1);
    if (!words.blocked) { ask({ ...words, run: () => deleteStaff(s.id) }); return; }
    // Nothing can be deleted here. The only step on offer is the safe one.
    const canDeactivate = (s.appointment_count || 0) > 0 && !!s.active;
    ask({
      ...words, destructive: false,
      // Already off and has bookings: there is nothing left to do, so the words must not offer a step.
      text: !canDeactivate && staffMembers.length > 1
        ? `${s.name} has bookings, so their name must stay on your records. ${s.name} is already off. Clients cannot book with them.`
        : words.text,
      action: canDeactivate ? words.action : "OK",
      run: canDeactivate ? () => updateStaff(s.id, { active: 0 }) : () => {},
    });
  };
  // Rare and risky steps sit in the "more" menu, and each one asks first.
  const actionsFor = (s: Staff) => [
    s.active
      ? { label: "Deactivate", onSelect: () => deactivate(s) }
      : { label: "Activate", onSelect: () => { updateStaff(s.id, { active: 1 }); } },
    { label: "Delete", destructive: true, onSelect: () => remove(s) },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Staff</h1>
        <Button size="sm" className="min-h-11 sm:min-h-0" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add Staff
        </Button>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        All-time completed visits and booked service value. Service value is not payment received, tips, commission, or take-home pay.
      </p>

      {showCreate && <CreateStaff onClose={() => setShowCreate(false)} />}
      {sheet}

      <Card>
        <CardContent className="p-0">
          <div className="divide-y lg:hidden">
            {staffMembers.length === 0 && (
              <p className="py-12 text-center text-muted-foreground">No staff members yet</p>
            )}
            {staffMembers.map((s) => (
              <div key={s.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-semibold" style={{ backgroundColor: s.color, color: inkOn(s.color) }}>
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{s.name}</h2>
                      {!s.active && <span className="rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground">Inactive</span>}
                    </div>
                    <p className="text-sm text-muted-foreground">{s.title || "No role set"}</p>
                    {(s.email || s.phone) && (
                      <p className="break-words text-sm text-muted-foreground">{[s.email, s.phone].filter(Boolean).join(" · ")}</p>
                    )}
                  </div>
                  <RowMenu label={`More for ${s.name}`} actions={actionsFor(s)} className="-mr-2 -mt-1" />
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-4 border-t pt-4">
                  <div><dt className="text-sm text-muted-foreground">Bookings</dt><dd className="font-semibold tabular-nums">{s.appointment_count || 0}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">Completed</dt><dd className="font-semibold tabular-nums">{s.completed_appointment_count || 0}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">Service value</dt><dd className="font-semibold tabular-nums">${(s.completed_service_value || 0).toFixed(2)}</dd></div>
                </dl>
              </div>
            ))}
          </div>

          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-24 text-right">Bookings</TableHead>
                  <TableHead className="w-24 text-right">Completed</TableHead>
                  <TableHead className="w-36 text-right">Service value</TableHead>
                  <TableHead className="w-14" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {staffMembers.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">No staff members yet</TableCell></TableRow>
                )}
                {staffMembers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ backgroundColor: s.color, color: inkOn(s.color) }}>
                          {s.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{s.name}</span>
                            {!s.active && <span className="rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground">Inactive</span>}
                          </div>
                          <p className="text-sm text-muted-foreground">{s.email || s.phone || "No contact details"}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.title || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.appointment_count || 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.completed_appointment_count || 0}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">${(s.completed_service_value || 0).toFixed(2)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <RowMenu label={`More for ${s.name}`} actions={actionsFor(s)} className="h-9 w-9" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
