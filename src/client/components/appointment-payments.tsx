import { useEffect, useState } from "preact/hooks";
import { Trash2 } from "lucide-preact";
import { api } from "../api";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Payment {
  id: number; kind: "payment" | "refund"; method: string; method_name: string;
  amount: number; tip: number; note: string; paid_on: string; stripe_ref: string | null;
}
interface PaymentView { payments: Payment[]; total_price: number; paid: number; tips: number; due: number }

const METHODS = [
  { value: "card_in_person", label: "Card / tap to pay" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const selectClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/** What was paid for one visit, what is still due, and a form to record a payment. */
export function AppointmentPayments({ appointmentId, status, totalPrice }: { appointmentId: number; status: string; totalPrice: number }) {
  const { selectAppointment, setError } = useApp();
  const [view, setView] = useState<PaymentView | null>(null);
  const [amount, setAmount] = useState("");
  const [tip, setTip] = useState("");
  const [method, setMethod] = useState("card_in_person");
  const [complete, setComplete] = useState(true);
  const [saving, setSaving] = useState(false);

  const show = (next: PaymentView) => {
    setView(next);
    // The amount starts at what is still due.
    setAmount(next.due > 0 ? next.due.toFixed(2) : "");
    setTip("");
  };

  // The price can change when the booking changes, so load again then.
  useEffect(() => {
    let live = true;
    api<PaymentView>("GET", `/api/appointments/${appointmentId}/payments`)
      .then((res) => { if (live) show(res); })
      .catch((err) => setError((err as Error).message));
    return () => { live = false; };
  }, [appointmentId, totalPrice]); // eslint-disable-line react-hooks/exhaustive-deps

  const canComplete = status !== "completed" && status !== "cancelled";

  const record = async (e: Event) => {
    e.preventDefault();
    const paid = Number(amount || 0);
    const extra = Number(tip || 0);
    if (!Number.isFinite(paid) || !Number.isFinite(extra) || paid < 0 || extra < 0 || paid + extra <= 0) {
      setError("Enter an amount above zero.");
      return;
    }
    setSaving(true);
    try {
      const res = await api<PaymentView & { completed: boolean }>("POST", `/api/appointments/${appointmentId}/payments`, {
        amount: paid, tip: extra, method, complete: complete && canComplete,
      });
      show(res);
      if (res.completed) await selectAppointment(appointmentId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (payment: Payment) => {
    if (!window.confirm(`Remove this ${payment.kind} of ${money(Math.abs(payment.amount + payment.tip))}?`)) return;
    try {
      show(await api<PaymentView>("DELETE", `/api/appointments/${appointmentId}/payments/${payment.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!view ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {view.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments yet.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {view.payments.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {p.kind === "refund" ? "Refund" : "Payment"} · {p.method_name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.paid_on}{p.tip !== 0 ? ` · tip ${money(p.tip)}` : ""}{p.note ? ` · ${p.note}` : ""}
                      </p>
                    </div>
                    <span className={p.amount + p.tip < 0 ? "font-medium text-destructive" : "font-medium"}>{money(p.amount + p.tip)}</span>
                    {!p.stripe_ref && (
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Remove this payment" onClick={() => remove(p)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>Price: <strong>{money(view.total_price)}</strong></span>
              <span>Paid: <strong>{money(view.paid)}</strong></span>
              {view.tips !== 0 && <span>Tips: <strong>{money(view.tips)}</strong></span>}
              <span>Still due: <strong className={view.due > 0 ? "text-destructive" : ""}>{money(view.due)}</strong></span>
            </div>

            <form className="space-y-3 border-t pt-4" onSubmit={record}>
              <p className="text-sm font-medium">Record payment</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pay-amount" className="text-xs text-muted-foreground">Amount</Label>
                  <Input id="pay-amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                    value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pay-tip" className="text-xs text-muted-foreground">Tip</Label>
                  <Input id="pay-tip" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                    value={tip} onInput={(e) => setTip((e.target as HTMLInputElement).value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pay-method" className="text-xs text-muted-foreground">Paid with</Label>
                  <select id="pay-method" className={selectClass} value={method} onChange={(e) => setMethod((e.target as HTMLSelectElement).value)}>
                    {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>
              {canComplete && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={complete} onChange={(e) => setComplete((e.target as HTMLInputElement).checked)} />
                  Mark the visit as completed
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                Took the card with tap to pay in the Stripe app? Record it here as "Card / tap to pay".
              </p>
              <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving..." : "Record payment"}</Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
