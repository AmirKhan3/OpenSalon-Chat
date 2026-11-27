import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { get, query, run } from "./db.js";
import { METHODS, METHOD_NAMES, amountDue, cents, paymentsFor, recordPayment, type Method, type PaymentRow } from "./payments.js";
import { money, settlePrepayOnStaffChange } from "./prepay.js";
import { bookingReport, checkRange, incomeReport } from "./reports.js";

/**
 * Staff routes for payments and reports.
 *
 * The routes under /api/appointments run inside the write queue (see index.ts),
 * so they must not take the lock again.
 */

// ── CSV ────────────────────────────────────────────────────────────

/**
 * One CSV cell. Text that a spreadsheet would run as a formula gets a leading
 * apostrophe, so a client name like "=HYPERLINK(...)" stays plain text.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(2) : "";
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

const CSV_HEAD = ["Date", "Type", "Method", "Services", "Tip", "Total", "Client", "Barber", "Booking", "Note", "Stripe reference"];

/** One row per payment or refund, oldest first. Refunds are negative. */
export async function incomeCsv(start: string, end: string): Promise<string> {
  const rows = await query<PaymentRow & { client: string | null; barber: string | null; booking: string | null }>(
    `SELECT p.*, c.name AS client, s.name AS barber, a.identifier AS booking
     FROM payments p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN staff s ON s.id = p.staff_id
       LEFT JOIN appointments a ON a.id = p.appointment_id
     WHERE p.paid_on >= ? AND p.paid_on <= ? ORDER BY p.paid_on, p.id`,
    [start, end],
  );
  const lines = [csvLine(CSV_HEAD)];
  for (const row of rows) {
    const amount = Number(row.amount);
    const tip = Number(row.tip);
    lines.push(csvLine([
      row.paid_on, row.kind === "refund" ? "Refund" : "Payment", METHOD_NAMES[row.method] ?? row.method,
      amount, tip, cents(amount + tip), row.client ?? "", row.barber ?? "", row.booking ?? "", row.note, row.stripe_ref ?? "",
    ]));
  }
  // The mark at the start tells Excel the file is UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ── Schemas ────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() });
const IdParam = z.object({ id: z.string().regex(/^\d{1,9}$/) });
const RangeQuery = z.object({ start: z.string(), end: z.string() });
const Loose = z.record(z.string(), z.any());
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get", path: "/api/appointments/{id}/payments", tags: ["Payments"], summary: "Payments of one appointment, and what is still due",
  request: { params: IdParam },
  responses: { 200: json("Payments", Loose), 404: json("Not found", ErrorSchema) },
});

const PaymentBody = z.object({
  amount: z.number().min(0).max(100_000),
  tip: z.number().min(0).max(100_000).optional(),
  method: z.enum(METHODS),
  kind: z.enum(["payment", "refund"]).optional(),
  note: z.string().max(300).optional(),
  paid_on: z.string().optional(),
  /** Also mark the visit as completed. */
  complete: z.boolean().optional(),
});

const recordRoute = createRoute({
  method: "post", path: "/api/appointments/{id}/payments", tags: ["Payments"], summary: "Record a payment or a refund",
  request: { params: IdParam, body: { content: { "application/json": { schema: PaymentBody } } } },
  responses: { 201: json("Saved", Loose), 400: json("Refused", ErrorSchema), 404: json("Not found", ErrorSchema) },
});

const removeRoute = createRoute({
  method: "delete", path: "/api/appointments/{id}/payments/{paymentId}", tags: ["Payments"],
  summary: "Remove a payment that was recorded by hand",
  request: { params: IdParam.extend({ paymentId: z.string().regex(/^\d{1,9}$/) }) },
  responses: { 200: json("Removed", Loose), 400: json("Refused", ErrorSchema), 404: json("Not found", ErrorSchema) },
});

const incomeRoute = createRoute({
  method: "get", path: "/api/reports/income", tags: ["Reports"], summary: "Money really taken, for taxes and proof of income",
  request: { query: RangeQuery },
  responses: { 200: json("Report", Loose), 400: json("Bad dates", ErrorSchema) },
});

const bookingsRoute = createRoute({
  method: "get", path: "/api/reports/bookings", tags: ["Reports"], summary: "What was on the calendar",
  request: { query: RangeQuery },
  responses: { 200: json("Report", Loose), 400: json("Bad dates", ErrorSchema) },
});

// ── Routes ─────────────────────────────────────────────────────────

const NOT_FOUND = "We could not find that booking.";

async function paymentView(appointmentId: number, totalPrice: number) {
  const payments = (await paymentsFor(appointmentId)).map((p) => ({
    ...p, amount: Number(p.amount), tip: Number(p.tip), method_name: METHOD_NAMES[p.method as Method] ?? p.method,
  }));
  return {
    payments,
    total_price: cents(Number(totalPrice)),
    paid: cents(payments.reduce((sum, p) => sum + p.amount, 0)),
    tips: cents(payments.reduce((sum, p) => sum + p.tip, 0)),
    due: await amountDue(appointmentId),
  };
}

export function registerPaymentRoutes(app: OpenAPIHono): void {
  app.openapi(listRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const apt = await get<{ total_price: number }>("SELECT total_price FROM appointments WHERE id = ?", [id]);
    if (!apt) return c.json({ error: NOT_FOUND }, 404);
    return c.json(await paymentView(id, apt.total_price), 200);
  });

  app.openapi(recordRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const body = c.req.valid("json");
    const apt = await get<{ status: string; total_price: number }>("SELECT status, total_price FROM appointments WHERE id = ?", [id]);
    if (!apt) return c.json({ error: NOT_FOUND }, 404);
    const kind = body.kind ?? "payment";
    const amount = cents(body.amount);
    const tip = cents(body.tip ?? 0);

    if (kind === "payment") {
      const due = await amountDue(id);
      if (amount > due) {
        return c.json({
          error: due > 0
            ? `Only ${money(due)} is still due. Put anything extra in the tip.`
            : "This visit is already paid in full. Put anything extra in the tip.",
        }, 400);
      }
    } else {
      // You cannot give back more than was taken.
      const now = await paymentView(id, apt.total_price);
      if (amount > now.paid || tip > now.tips) {
        return c.json({ error: `You can refund up to ${money(now.paid)}, and ${money(now.tips)} of tips.` }, 400);
      }
    }

    const saved = await recordPayment({
      appointmentId: id, kind, method: body.method, amount, tip, note: body.note, paidOn: body.paid_on,
    });
    if (!saved.ok) return c.json({ error: saved.error }, 400);

    let completed = false;
    if (body.complete && kind === "payment" && apt.status !== "completed" && apt.status !== "cancelled") {
      await run("UPDATE appointments SET status = 'completed', updated_at = utc_now() WHERE id = ?", [id]);
      await settlePrepayOnStaffChange(id, apt.status, "completed");
      completed = true;
    }
    return c.json({ payment: saved.payment, completed, ...(await paymentView(id, apt.total_price)) }, 201);
  });

  app.openapi(removeRoute, async (c) => {
    const { id, paymentId } = c.req.valid("param");
    const apt = await get<{ total_price: number }>("SELECT total_price FROM appointments WHERE id = ?", [Number(id)]);
    const row = await get<{ id: number; stripe_ref: string | null }>(
      "SELECT id, stripe_ref FROM payments WHERE id = ? AND appointment_id = ?", [Number(paymentId), Number(id)]);
    if (!apt || !row) return c.json({ error: "We could not find that payment." }, 404);
    if (row.stripe_ref) return c.json({ error: "This payment came from Stripe. It cannot be removed here." }, 400);
    await run("DELETE FROM payments WHERE id = ?", [row.id]);
    return c.json({ ok: true, ...(await paymentView(Number(id), apt.total_price)) }, 200);
  });

  app.openapi(incomeRoute, async (c) => {
    const { start, end } = c.req.valid("query");
    const report = await incomeReport(start, end);
    return report.ok ? c.json(report, 200) : c.json({ error: report.error }, 400);
  });

  app.openapi(bookingsRoute, async (c) => {
    const { start, end } = c.req.valid("query");
    const report = await bookingReport(start, end);
    return report.ok ? c.json(report, 200) : c.json({ error: report.error }, 400);
  });

  // One row per payment, for the accountant.
  app.get("/api/reports/income.csv", async (c) => {
    const start = c.req.query("start") ?? "";
    const end = c.req.query("end") ?? "";
    const bad = checkRange(start, end);
    if (bad) return c.json({ error: bad.error }, 400);
    return c.body(await incomeCsv(start, end), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="income-${start}-to-${end}.csv"`,
      "Cache-Control": "no-store",
    });
  });
}
