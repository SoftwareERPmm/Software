"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Partner = { id: string; code: string; name: string };
type CashAccount = { id: string; code: string; name: string };
type Branch = { id: string; code: string; name: string };
type Invoice = {
  document_id: string; doc_no: string; partner_id: string;
  posting_date: string; due_date: string | null;
  gross_total: string; paid: string; outstanding: string;
  payment_status: string; days_overdue: number | null;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const day = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/**
 * Settling invoices. The invoices themselves are never edited — this records
 * a payment document and allocates it, so outstanding stays derived and a
 * part payment leaves the balance attached to the invoice it belongs to.
 */
export function SettlementForm({
  kind,
  action,
  partners,
  invoices,
  cashAccounts,
  branches,
  today,
  initialPartnerId,
  initialInvoiceId,
}: {
  kind: "pay" | "receive";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  partners: Partner[];
  invoices: Invoice[];
  cashAccounts: CashAccount[];
  branches: Branch[];
  today: string;
  /** Arriving from a specific document's page — jump straight to it. */
  initialPartnerId?: string;
  initialInvoiceId?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [partnerId, setPartnerId] = useState(initialPartnerId ?? "");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    if (!initialInvoiceId) return {};
    const inv = invoices.find((i) => i.document_id === initialInvoiceId);
    return inv ? { [inv.document_id]: String(Number(inv.outstanding)) } : {};
  });
  const isPay = kind === "pay";

  const open = useMemo(
    () => invoices.filter((i) => i.partner_id === partnerId),
    [invoices, partnerId]
  );

  const owed = open.reduce((s, i) => s + Number(i.outstanding), 0);
  const applied = open.reduce((s, i) => s + (Number(amounts[i.document_id]) || 0), 0);

  const overApplied = open.filter(
    (i) => (Number(amounts[i.document_id]) || 0) > Number(i.outstanding)
  );

  function payAll() {
    const next: Record<string, string> = {};
    for (const i of open) next[i.document_id] = String(Number(i.outstanding));
    setAmounts(next);
  }

  const payload = JSON.stringify(
    open
      .map((i) => ({ invoiceId: i.document_id, amount: Number(amounts[i.document_id]) || 0 }))
      .filter((a) => a.amount > 0)
  );

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="allocations" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>{isPay ? "Supplier and account" : "Customer and account"}</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isPay ? "Supplier" : "Customer"}</label>
              <select
                id="partner_id" name="partner_id" value={partnerId} required
                onChange={(e) => { setPartnerId(e.target.value); setAmounts({}); }}
              >
                <option value="">Choose…</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="cash_account_id">{isPay ? "Paid from" : "Received into"}</label>
              <select id="cash_account_id" name="cash_account_id" required
                defaultValue={cashAccounts[0]?.id ?? ""}>
                {cashAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>

            {branches.length > 1 && (
              <div className="field">
                <label htmlFor="location_id">Branch</label>
                <select id="location_id" name="location_id" defaultValue="">
                  <option value="">Follow the invoices</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                  ))}
                </select>
                <span className="hint">
                  Which branch&rsquo;s cash moves. Left alone it follows the invoices being
                  settled, which is right unless one branch pays another&rsquo;s bills. The
                  payable itself always clears in the branch that raised it.
                </span>
              </div>
            )}

            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>

            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text"
                placeholder={isPay ? "Cheque or transfer no." : "Their receipt no."} />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{isPay ? "Bills outstanding" : "Invoices outstanding"}</h2>
          <span className="actions">
            {open.length > 0 && (
              <>
                <span className="page-sub">{fmt(owed)} owed</span>
                <button type="button" className="ghost tiny" onClick={payAll}>
                  {isPay ? "Pay all" : "Receive all"}
                </button>
              </>
            )}
          </span>
        </div>

        {!partnerId ? (
          <div className="empty">Choose a {isPay ? "supplier" : "customer"} to see what is outstanding.</div>
        ) : open.length === 0 ? (
          <div className="empty">Nothing outstanding — everything is settled.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th><th>Posted</th><th>Due</th><th>Status</th>
                  <th className="r">Total</th><th className="r">Already {isPay ? "paid" : "received"}</th>
                  <th className="r">Outstanding</th><th className="r">Apply now</th>
                </tr>
              </thead>
              <tbody>
                {open.map((i) => {
                  const over = (Number(amounts[i.document_id]) || 0) > Number(i.outstanding);
                  const late = i.days_overdue !== null && i.days_overdue > 0;
                  return (
                    <tr key={i.document_id}>
                      <td className="code">{i.doc_no}</td>
                      <td className="code">{day(i.posting_date)}</td>
                      <td className="code">{day(i.due_date)}</td>
                      <td>
                        <span className={`pill ${late ? "overdue" : i.payment_status === "PARTIALLY_PAID" ? "warn" : "ok"}`}>
                          {late ? `${i.days_overdue}d late`
                            : i.payment_status === "PARTIALLY_PAID" ? "Part paid" : "Open"}
                        </span>
                      </td>
                      <td className="r">{fmt(Number(i.gross_total))}</td>
                      <td className="r">{fmt(Number(i.paid))}</td>
                      <td className="r">{fmt(Number(i.outstanding))}</td>
                      <td className="narrow">
                        <input
                          type="number" min="0" step="any"
                          aria-label={`Amount for ${i.doc_no}`}
                          style={over ? { borderColor: "var(--bad)" } : undefined}
                          value={amounts[i.document_id] ?? ""}
                          onChange={(e) =>
                            setAmounts({ ...amounts, [i.document_id]: e.target.value })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>Total {isPay ? "paid" : "received"}</td>
                  <td className="r">{fmt(owed - applied)} left</td>
                  <td className="r">{fmt(applied)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {overApplied.length > 0 && (
        <div className="alert">
          More than the outstanding amount applied to{" "}
          {overApplied.map((i) => i.doc_no).join(", ")}.
        </div>
      )}

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || applied <= 0 || overApplied.length > 0}>
          {pending ? "Posting…"
            : applied > 0
              ? `Post ${isPay ? "payment" : "receipt"} of ${fmt(applied)}`
              : `Post ${isPay ? "payment" : "receipt"}`}
        </button>
        <span className="page-sub">
          The invoices are not edited — this records a document allocated against them.
        </span>
      </div>
    </form>
  );
}
