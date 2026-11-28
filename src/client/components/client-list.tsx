import { useState } from "preact/hooks";
import { useApp } from "../context";
import { ChevronRight, Plus, Search } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "./pagination";
import { CreateClient } from "./create-client";

export function ClientList() {
  const { clients, clientsPag, setClientsPage, clientsSearch, setClientsSearch, navigate } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex min-h-11 items-center justify-between">
        <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Clients</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add client
        </Button>
      </div>

      {showCreate && <CreateClient onClose={() => setShowCreate(false)} />}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" aria-label="Search clients" placeholder="Search clients" value={clientsSearch} onInput={(e) => setClientsSearch((e.target as HTMLInputElement).value)} />
      </div>

      <ul className="divide-y border-y md:hidden">
        {clients.length === 0 && <li className="py-8 text-center text-sm text-muted-foreground">No clients found</li>}
        {clients.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="flex min-h-16 w-full items-center gap-3 py-3 text-left active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => navigate(`/clients/${c.id}`)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block truncate text-sm text-muted-foreground">{c.phone || c.email || "No phone number"}</span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {c.appointment_count || 0} {c.appointment_count === 1 ? "visit" : "visits"}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-44">Email</TableHead>
                <TableHead className="w-28">Phone</TableHead>
                <TableHead className="w-24 text-center">Visits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 && (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No clients found</TableCell></TableRow>
              )}
              {clients.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/clients/${c.id}`)}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.email || "—"}</TableCell>
                  <TableCell className="text-sm">{c.phone || "—"}</TableCell>
                  <TableCell className="text-center">{c.appointment_count || 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination pag={clientsPag} setPage={setClientsPage} />
    </div>
  );
}
