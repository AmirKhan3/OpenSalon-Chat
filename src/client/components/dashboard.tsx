import { useApp } from "../context";
import { CalendarDays, Users, Clock, DollarSign, Package, AlertTriangle } from "lucide-preact";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { today } from "@/lib/dates";
import { formatClock } from "@/lib/calendar-slot";
import { DEFAULT_STAFF_COLOR } from "@/lib/palette";

export function Dashboard() {
  const { stats, navigate, calendarAppointments } = useApp();

  const todayStr = today();
  const todayAppointments = calendarAppointments
    .filter((a) => a.scheduled_date === todayStr)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const statCards = [
    { label: "Bookings today", value: stats.today_appointments, icon: CalendarDays, color: "bg-primary/10 text-primary", onClick: () => navigate("/calendar") },
    { label: "Upcoming", value: stats.upcoming_appointments, icon: Clock, color: "bg-primary/10 text-primary", onClick: () => navigate("/appointments") },
    { label: "Clients", value: stats.clients, icon: Users, color: "bg-primary/10 text-primary", onClick: () => navigate("/clients") },
    { label: "Completed service value", value: `$${stats.revenue.toFixed(0)}`, icon: DollarSign, color: "bg-primary/10 text-primary" },
    { label: "Products", value: stats.products, icon: Package, color: "bg-primary/10 text-primary", onClick: () => navigate("/products") },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <h1 className="flex min-h-11 items-center text-[1.65rem] font-medium leading-tight tracking-tight">Today</h1>

      <div className="grid grid-cols-2 gap-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
        {statCards.map((stat) => (
          <Card
            key={stat.label}
            className={stat.onClick ? "cursor-pointer transition-shadow hover:shadow-float" : ""}
            onClick={stat.onClick}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${stat.color}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <div className="text-xl font-medium leading-tight">{stat.value}</div>
                <div className="text-xs text-muted-foreground">{stat.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
        {stats.low_stock_products > 0 && (
          <Card className="cursor-pointer bg-warning-soft transition-shadow hover:shadow-float" onClick={() => navigate("/products")}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-card text-warning">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <div className="text-xl font-medium">{stats.low_stock_products}</div>
                <div className="text-xs text-muted-foreground">Low stock</div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-lg">Today's schedule</CardTitle>
          <Button variant="outline" size="sm" onClick={() => navigate("/calendar")}>Open calendar</Button>
        </CardHeader>
        <CardContent>
          {todayAppointments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing booked today.</p>
          ) : (
            <>
            <ul className="divide-y md:hidden">
              {todayAppointments.map((apt) => (
                <li key={apt.id}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 py-2 text-left active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => navigate(`/appointments/${apt.id}`)}
                  >
                    <span className="w-[4.5rem] shrink-0 text-sm font-medium tabular-nums">{formatClock(apt.start_time)}</span>
                    <span className="min-w-0 flex-1 truncate">{apt.client_name}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">${apt.total_price.toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Time</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="w-36">Staff</TableHead>
                  <TableHead className="w-24 text-right">Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayAppointments.map((apt) => (
                  <TableRow key={apt.id} className="cursor-pointer" onClick={() => navigate(`/appointments/${apt.id}`)}>
                    <TableCell className="whitespace-nowrap font-medium">{formatClock(apt.start_time)}</TableCell>
                    <TableCell>{apt.client_name}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {apt.staff_name && (
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: apt.staff_color || DEFAULT_STAFF_COLOR }} />
                        )}
                        {apt.staff_name || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">${apt.total_price.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
