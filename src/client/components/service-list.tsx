import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus, Trash2 } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateService } from "./create-service";

export function ServiceList() {
  const { services, deleteService, updateService } = useApp();
  const [showCreate, setShowCreate] = useState(false);

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

      <ul className="divide-y border-y md:hidden">
        {services.length === 0 && <li className="py-8 text-center text-sm text-muted-foreground">No services yet</li>}
        {services.map((svc) => (
          <li key={svc.id} className="flex min-h-16 items-center gap-3 py-2">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: svc.color }} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{svc.name}</span>
              <span className="block text-sm tabular-nums text-muted-foreground">{svc.duration} min, ${svc.price.toFixed(2)}</span>
            </span>
            <button
              type="button"
              aria-pressed={!!svc.active}
              className={`min-h-11 shrink-0 rounded-md px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${svc.active ? "text-success" : "text-muted-foreground"}`}
              onClick={() => updateService(svc.id, { active: svc.active ? 0 : 1 })}
            >
              {svc.active ? "Active" : "Inactive"}
            </button>
            <Button aria-label={`Delete ${svc.name}`} variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => deleteService(svc.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
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
                    <button
                      className={`text-xs font-medium ${svc.active ? "text-success" : "text-muted-foreground"}`}
                      onClick={() => updateService(svc.id, { active: svc.active ? 0 : 1 })}
                    >
                      {svc.active ? "Active" : "Inactive"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Button aria-label={`Delete ${svc.name}`} variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => deleteService(svc.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
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
