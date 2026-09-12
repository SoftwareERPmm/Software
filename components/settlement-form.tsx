"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { PartnerPicker } from "./partner-picker";

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

  /** What the invoice this screen was opened for still owes, if any. */
  const prefill = (forPartner: string): Record<string, string> => {
    if (!initialInvoiceId) return {};
    const inv = invoices.find((i) => i.document_id === initialInvoiceId);
    // Only where it belongs to the partner being settled with. An amount
    // against somebody else's invoice is not a starting point, it is a
    // mistake waiting to be posted.
    if (!inv || (forPartner && inv.partner_id !== forPartner)) return {};
    return { [inv.document_id]: String(Number(inv.outstanding)) };
  };

  const [amounts, setAmounts] = useState<Record<string, string>>(
    () => prefill(initialPartnerId ?? ""));
  const isPay = kind === "pay";

  /**
   * What this money is for. Settling bills, or sitting on the partner's
   * account until there is a bill to settle.
   *
   * Two purposes rather than an amount field that may or may not be filled,
   * because they are genuinely different transactions — one relieves a
   * receivable, the other creates a liability — and a screen that lets both
   * happen at once would have to explain which part of the money the next
   * invoice may claim.
   */
  const [purpose, setPurpose] = useState<"settle" | "advance">("settle");
  const [advance, setAdvance] = useState("");

  const open = useMemo(
    () => invoices.filter((i) => i.partner_id === partnerId),
    [invoices, partnerId]
  );

  const owed = open.reduce((s, i) => s + Number(i.outstanding), 0);
  const applied = open.reduce((s, i) => s + (Number(amounts[i.document_id]) || 0), 0);

  // Every invoice this receipt will touch. The one arrived from is filled in
  // before anyone has looked at the screen, so a receipt meant for a
  // different invoice quietly carries it along — the total on the button was
  // right and nobody read it, because nothing said a second invoice was in.
  const settling = open.filter((i) => (Number(amounts[i.document_id]) || 0) > 0);

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
      <input type="hidden" name="purpose" value={purpose} />

      <fieldset className="purpose">
        <legend>Payment purpose</legend>
        {([
          ["settle", isPay ? "Pay existing bills" : "Pay existing invoices"],
          ["advance", isPay ? "Advance to supplier" : "Customer advance"],
        ] as const).map(([value, label]) => (
          <label key={value} className={purpose === value ? "on" : undefined}>
            <input
              type="radio" name="purpose_choice" value={value}
              checked={purpose === value}
              onChange={() => setPurpose(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="card">
        <div className="card-head">
          <h2>{isPay ? "Supplier and account" : "Customer and account"}</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isPay ? "Supplier" : "Customer"}</label>
              {/* Amounts belong to one partner's bills, so changing partner
                  clears them — but the invoice this screen was opened for is
                  filled in again where it belongs to the new one. It used to
                  be wiped unconditionally, so arriving from an invoice and
                  then choosing its supplier by hand lost the figure the screen
                  had just said was filled in for you. */}
              <PartnerPicker
                partners={partners as never}
                value={partnerId}
                placeholder={isPay ? "Type a supplier…" : "Type a customer…"}
                onPick={(id) => { setPartnerId(id); setAmounts(prefill(id)); }}
              />
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
                <label htmlFor="location_id">
                  Branch{purpose === "advance" && <span aria-hidden="true"> *</span>}
                </label>
                {/* An advance settles nothing, so there are no invoices for the
                    cash side to follow. Asked for rather than guessed: money in
                    no branch at all reappears as an unexplained difference the
                    first time anyone reads the branch reports. */}
                <select
                  id="location_id" name="location_id" defaultValue=""
                  required={purpose === "advance"}
                >
                  <option value="">
                    {purpose === "advance" ? "Choose a branch…" : "Follow the invoices"}
                  </option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                  ))}
                </select>
                <span className="hint">
                  {purpose === "advance"
                    ? "Required for an advance: there is no invoice branch to follow."
                    : <>
                        Which branch&rsquo;s cash moves. Left alone it follows the invoices being
                        settled, which is right unless one branch pays another&rsquo;s bills. The
                        payable itself always clears in the branch that raised it.
                      </>}
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

      {purpose === "advance" ? (
        <div className="card">
          <div className="card-head">
            <h2>{isPay ? "Advance to supplier" : "Customer advance"}</h2>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="advance">Amount {isPay ? "paid" : "received"}</label>
                <div className="amountbox">
                  <input
                    id="advance" name="advance" type="number" min="0" step="any" required
                    value={advance} onChange={(e) => setAdvance(e.target.value)}
                  />
                  <span className="amountbox-unit">MMK</span>
                </div>
              </div>
              <div className="field advance-note">
                <strong>No invoice required</strong>
                <span className="hint">
                  {isPay
                    ? "This money stays available against a future bill from them."
                    : "This money stays available for a future invoice."}
                </span>
              </div>
            </div>

            <p className="advance-after">
              After posting: <strong>
                {isPay ? "Advance paid" : "Available advance"} +{fmt(Number(advance) || 0)} MMK
              </strong>
              {" · "}Allocated to invoices 0 MMK
            </p>
          </div>
        </div>
      ) : (
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
                      <td className="code">
                        {i.doc_no}
                        {/* Only where something actually was. The label used
                            to key off which invoice this screen was opened
                            for, so it kept saying "filled in for you" over an
                            empty box — which is the screen telling somebody
                            their own eyes are wrong. */}
                        {i.document_id === initialInvoiceId
                          && (Number(amounts[i.document_id]) || 0) > 0 && (
                          <div className="hint" style={{ fontSize: "var(--t-2xs)" }}>
                            filled in for you
                          </div>
                        )}
                      </td>
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
      )}

      {purpose === "settle" && overApplied.length > 0 && (
        <div className="alert">
          More than the outstanding amount applied to{" "}
          {overApplied.map((i) => i.doc_no).join(", ")}.
        </div>
      )}

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      {/* What is about to be settled, named. One invoice needs no list; two or
          more is exactly the case where an amount nobody typed rides along
          on the total. */}
      {purpose === "settle" && settling.length > 1 && (
        <div className="alert" style={{ marginBottom: "0.75rem" }}>
          <strong>
            This one {isPay ? "payment" : "receipt"} settles {settling.length} invoices.
          </strong>
          <ul style={{ margin: "0.35rem 0 0 1.1rem" }}>
            {settling.map((i) => (
              <li key={i.document_id}>
                {i.doc_no} — {fmt(Number(amounts[i.document_id]) || 0)}
                {i.document_id === initialInvoiceId && " (filled in for you)"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        <button
          type="submit"
          disabled={pending
            || (purpose === "advance"
              ? !(Number(advance) > 0)
              : applied <= 0 || overApplied.length > 0)}
        >
          {pending ? "Posting…"
            : purpose === "advance"
              ? Number(advance) > 0
                ? `Post ${isPay ? "payment" : "receipt"} of ${fmt(Number(advance))} on account`
                : `Post ${isPay ? "payment" : "receipt"}`
            : applied > 0
              ? `Post ${isPay ? "payment" : "receipt"} of ${fmt(applied)}`
                + (settling.length > 1 ? ` across ${settling.length} invoices` : "")
              : `Post ${isPay ? "payment" : "receipt"}`}
        </button>
        <span className="page-sub">
          {purpose === "advance"
            ? `Records money ${isPay ? "paid" : "received"} on account. No invoice is `
              + "settled and no stock moves; it waits until there is a bill to put it against."
            : "The invoices are not edited — this records a document allocated against them."}
        </span>
      </div>
    </form>
  );
}
