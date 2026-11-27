import { useEffect, useState } from "preact/hooks";
import { Download, Printer } from "lucide-preact";
import { api } from "../api";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Totals { income: number; services: number; tips: number; refunds: number }
interface IncomeReport extends Totals {
  start: string; end: string; payments: number;
  by_month: ({ month: string } & Totals)[];
  by_method: { method: string; name: string; total: number }[];
  by_barber: { staff_id: number | null; barber: string; total: number; tips: number }[];
}
interface BookingReport {
  start: string; end: string; bookings: number; completed: number; cancelled: number; no_shows: number;
  booked_value: number; completed_value: number; new_clients: number;
  by_barber: { barber: string; bookings: number; booked_value: number }[];
  top_services: { service: string; bookings: number }[];
}

type Tab = "bookings" | "income";
type Period = "year" | "q1" | "q2" | "q3" | "q4";

const PERIODS: { value: Period; label: string; start: string; end: string }[] = [
  { value: "year", label: "Full year", start: "01-01", end: "12-31" },
  { value: "q1", label: "Q1", start: "01-01", end: "03-31" },
  { value: "q2", label: "Q2", start: "04-01", end: "06-30" },
  { value: "q3", label: "Q3", start: "07-01", end: "09-30" },
  { value: "q4", label: "Q4", start: "10-01", end: "12-31" },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const cell = "px-3 py-2";
const num = "px-3 py-2 text-right tabular-nums";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto p-0 pb-2">{children}</CardContent>
    </Card>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-6 pb-4 text-sm text-muted-foreground">{text}</p>;

export function ReportsPage() {
  const { setError } = useApp();
  const thisYear = new Date().getFullYear();
  const [tab, setTab] = useState<Tab>("bookings");
  const [year, setYear] = useState(thisYear);
  const [period, setPeriod] = useState<Period>("year");
  const [income, setIncome] = useState<IncomeReport | null>(null);
  const [bookings, setBookings] = useState<BookingReport | null>(null);

  const chosen = PERIODS.find((p) => p.value === period)!;
  const start = `${year}-${chosen.start}`;
  const end = `${year}-${chosen.end}`;
  const range = `start=${start}&end=${end}`;
  const title = `${chosen.label === "Full year" ? "" : `${chosen.label} `}${year}`;

  useEffect(() => {
    let live = true;
    const path = tab === "income" ? "income" : "bookings";
    api<IncomeReport | BookingReport>("GET", `/api/reports/${path}?${range}`)
      .then((res) => {
        if (!live) return;
        if (tab === "income") setIncome(res as IncomeReport);
        else setBookings(res as BookingReport);
      })
      .catch((err) => setError((err as Error).message));
    return () => { live = false; };
  }, [tab, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const incomeNow = income && income.start === start && income.end === end ? income : null;
  const bookingsNow = bookings && bookings.start === start && bookings.end === end ? bookings : null;
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);

  const tabClass = (t: Tab) =>
    `rounded-sm px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-bold">Reports</h1>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <label className="sr-only" htmlFor="report-year">Year</label>
          <select id="report-year" className={selectClass} value={year} onChange={(e) => setYear(Number((e.target as HTMLSelectElement).value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <label className="sr-only" htmlFor="report-period">Period</label>
          <select id="report-period" className={selectClass} value={period} onChange={(e) => setPeriod((e.target as HTMLSelectElement).value as Period)}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>

      <div role="tablist" className="inline-flex h-10 items-center rounded-md bg-muted p-1 print:hidden">
        <button role="tab" aria-selected={tab === "bookings"} className={tabClass("bookings")} onClick={() => setTab("bookings")}>Bookings</button>
        <button role="tab" aria-selected={tab === "income"} className={tabClass("income")} onClick={() => setTab("income")}>Income &amp; taxes</button>
      </div>

      {tab === "bookings" && (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            What was on the calendar in {title}. This is the booked price, not money taken. See "Income &amp; taxes" for that.
          </p>
          {!bookingsNow ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Bookings" value={String(bookingsNow.bookings)} hint={`${money(bookingsNow.booked_value)} booked`} />
                <Stat label="Completed" value={String(bookingsNow.completed)} hint={`${money(bookingsNow.completed_value)} of visits`} />
                <Stat label="Cancelled" value={String(bookingsNow.cancelled)} />
                <Stat label="No-shows" value={String(bookingsNow.no_shows)} />
                <Stat label="New clients" value={String(bookingsNow.new_clients)} />
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <Section title="By barber">
                  {bookingsNow.by_barber.length === 0 ? <Empty text="No bookings in this period." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className={cell}>Barber</th><th className={num}>Bookings</th><th className={num}>Booked</th></tr></thead>
                      <tbody>{bookingsNow.by_barber.map((b) => (
                        <tr key={b.barber} className="border-b last:border-0"><td className={cell}>{b.barber}</td><td className={num}>{b.bookings}</td><td className={num}>{money(b.booked_value)}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
                </Section>
                <Section title="Top services">
                  {bookingsNow.top_services.length === 0 ? <Empty text="No bookings in this period." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className={cell}>Service</th><th className={num}>Bookings</th></tr></thead>
                      <tbody>{bookingsNow.top_services.map((s) => (
                        <tr key={s.service} className="border-b last:border-0"><td className={cell}>{s.service}</td><td className={num}>{s.bookings}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
                </Section>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "income" && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm text-muted-foreground">
              Money really taken in {title} ({start} to {end}). It comes from recorded payments only.
            </p>
            <div className="flex gap-2 print:hidden">
              <Button asChild variant="outline" size="sm">
                <a href={`/api/reports/income.csv?${range}`} download><Download className="mr-1 h-3.5 w-3.5" /> Download CSV</a>
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="mr-1 h-3.5 w-3.5" /> Print / save as PDF
              </Button>
            </div>
          </div>
          {!incomeNow ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Income" value={money(incomeNow.income)} hint="Services + tips − refunds" />
                <Stat label="Services" value={money(incomeNow.services)} />
                <Stat label="Tips" value={money(incomeNow.tips)} />
                <Stat label="Refunds" value={money(incomeNow.refunds)} />
              </div>
              <Section title="By month">
                {incomeNow.by_month.length === 0 ? <Empty text="No payments in this period." /> : (
                  <table className="w-full text-sm">
                    <thead><tr className="border-b text-left text-xs text-muted-foreground">
                      <th className={cell}>Month</th><th className={num}>Services</th><th className={num}>Tips</th><th className={num}>Refunds</th><th className={num}>Income</th>
                    </tr></thead>
                    <tbody>
                      {incomeNow.by_month.map((m) => (
                        <tr key={m.month} className="border-b">
                          <td className={cell}>{monthName(m.month)}</td><td className={num}>{money(m.services)}</td><td className={num}>{money(m.tips)}</td>
                          <td className={num}>{money(m.refunds)}</td><td className={`${num} font-medium`}>{money(m.income)}</td>
                        </tr>
                      ))}
                      <tr className="font-medium">
                        <td className={cell}>Total</td><td className={num}>{money(incomeNow.services)}</td><td className={num}>{money(incomeNow.tips)}</td>
                        <td className={num}>{money(incomeNow.refunds)}</td><td className={num}>{money(incomeNow.income)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Section>
              <div className="grid gap-6 lg:grid-cols-2">
                <Section title="By payment method">
                  {incomeNow.by_method.length === 0 ? <Empty text="No payments in this period." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className={cell}>Method</th><th className={num}>Income</th></tr></thead>
                      <tbody>{incomeNow.by_method.map((m) => (
                        <tr key={m.method} className="border-b last:border-0"><td className={cell}>{m.name}</td><td className={num}>{money(m.total)}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
                </Section>
                <Section title="By barber">
                  {incomeNow.by_barber.length === 0 ? <Empty text="No payments in this period." /> : (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className={cell}>Barber</th><th className={num}>Tips</th><th className={num}>Income</th></tr></thead>
                      <tbody>{incomeNow.by_barber.map((b) => (
                        <tr key={b.staff_id ?? "none"} className="border-b last:border-0"><td className={cell}>{b.barber}</td><td className={num}>{money(b.tips)}</td><td className={num}>{money(b.total)}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
                </Section>
              </div>
              <p className="text-xs text-muted-foreground">
                Card fees are not subtracted. Check your Stripe reports for fees. This report is not tax advice. Ask your accountant how to use it.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
