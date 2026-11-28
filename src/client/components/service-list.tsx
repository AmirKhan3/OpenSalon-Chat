import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateService } from "./create-service";
import type { Service } from "../types";
import { RowMenu } from "./row-menu";
import { useConfirm } from "./confirm-sheet";

export function ServiceList() {
  const { services, deleteService, updateService } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [ask, sheet] = useConfirm();

  const actionsFor = (svc: Service) => [
    svc.active
      ? { label: "Turn off", onSelect: () => ask({
          title: `Turn off ${svc.name}?`,
          text: "Clients can no longer book it. Bookings already made stay. You can turn it on again any time.",
          action: "Turn off", run: () => updateService(svc.id, { active: 0 }),
        }) }
      : { label: "Turn on", onSelect: () => { updateService(svc.id, { active: 1 }); } },
    { label: "Delete", destructive: true, onSelect: () => ask({
        title: `Delete ${svc.name}?`,
        text: "The service is removed for good. To only hide it from clients, turn it off instead.",
        action: "Delete service", run: () => deleteService(svc.id),
      }) },
  ];

  const categories = [...new Set(services.map((s) => s.category).filter(Boolean))];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex min-h-11 items-center justify-between">
        <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Services</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add service
        </Button>
      </div>

      {showCreate && <CreateService onClose={() => setShowCreate(false)} />}
      {sheet}

      <ul className="divide-y border-y md:hidden">
        {services.length === 0 && <li className="py-8 text-center text-sm text-muted-foreground">No services yet</li>}
        {services.map((svc) => (
          <li key={svc.id} className="flex min-h-16 items-center gap-3 py-2">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: svc.color }} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{svc.name}</span>
              <span className="block text-sm tabular-nums text-muted-foreground">{svc.duration} min, ${svc.price.toFixed(2)}</span>
            </span>
            <span className={`shrink-0 text-sm font-medium ${svc.active ? "text-success" : "text-muted-foreground"}`}>{svc.active ? "Active" : "Off"}</span>
            <RowMenu label={`More for ${svc.name}`} actions={actionsFor(svc)} className="-mr-2" />
          </li>
        ))}
      </ul>

      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Category</TableHead>
                <TableHead className="w-24 text-center">Duration</TableHead>
                <TableHead className="w-20 text-right">Price</TableHead>
                <TableHead className="w-20">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No services yet</TableCell></TableRow>
              )}
              {services.map((svc) => (
                <TableRow key={svc.id}>
                  <TableCell>
                    <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: svc.color }} />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{svc.name}</div>
                    {svc.description && <div className="text-xs text-muted-foreground">{svc.description}</div>}
                  </TableCell>
                  <TableCell>
                    {svc.category && <Badge variant="outline" className="text-xs">{svc.category}</Badge>}
                  </TableCell>
                  <TableCell className="text-center">{svc.duration} min</TableCell>
                  <TableCell className="text-right font-medium">${svc.price.toFixed(2)}</TableCell>
                  <TableCell>
                    <span className={`text-xs font-medium ${svc.active ? "text-success" : "text-muted-foreground"}`}>{svc.active ? "Active" : "Off"}</span>
                  </TableCell>
                  <TableCell>
                    <RowMenu label={`More for ${svc.name}`} actions={actionsFor(svc)} className="h-9 w-9" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
