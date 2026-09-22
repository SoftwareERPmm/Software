"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

type Invoice = {
  id: string; doc_no: string; doc_date: string;
  partner_id: string; partner_name: string;
  gross_total: string; outstanding: string;
};

const money = (v: string | number) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * A note that reduces one invoice, without goods moving.
 *
 * Deliberately not a line-by-line document. Goods coming back is a return,
 * and returns already exist with all the costing that implies; this is the
 * other case — the price was agreed differently, a short delivery was billed
 * in full, a discount was settled after the fact. What it needs is an
 * amount, whether tax comes off with it, and why.
 */
export function NoteForm({
  kind, invoice, taxCodes, today, action,
}: {
  kind: "credit" | "debit";
  invoice: Invoice;
  taxCodes: { id: string; code: string; rate: string | number }[];
  today: string;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [attemptKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [taxCodeId, setTaxCodeId] = useState("");

  const owed = Number(invoice.outstanding);
  const net = Number(amount) || 0;
  const rate = Number(taxCodes.find((t) => t.id === taxCodeId)?.rate ?? 0);
  const tax = rate > 0 ? Math.round((net * rate) / 100) : 0;
  const gross = net + tax;
  const tooMuch = gross > owed + 0.0001;
  const isCredit = kind === "credit";

  return (
    <form action={formAction} className="form wide">
      <input type="hidden" name="idempotency_key" value={attemptKey} />
      <input type="hidden" name="source_document_id" value={invoice.id} />
      <input type="hidden" name="partner_id" value={invoice.partner_id} />

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card doc-meta">
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label>{isCredit ? "Invoice being credited" : "Bill being debited"}</label>
              <span className="fixedfield">
                <Link href={`/documents/${invoice.id}`} style={{ color: "var(--brand)" }}>
                  {invoice.doc_no}
                </Link>
              </span>
              <span className="hint">{invoice.partner_name}</span>
            </div>
            <div className="field">
              <label>Still owing</label>
              <span className="fixedfield">{money(owed)}</span>
              <span className="hint">of {money(invoice.gross_total)} billed</span>
            </div>
            <div className="field">
              <label htmlFor="doc_date">Note date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>
            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text"
                     placeholder="Their credit note no., if any" />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>What comes off</h2></div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="amount">Amount before tax</label>
              <input
                id="amount" name="amount" type="number" min="0" step="any" required
                value={amount} onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            {taxCodes.length > 0 && (
              <div className="field">
                <label htmlFor="tax_code_id">Tax to give back</label>
                <select id="tax_code_id" name="tax_code_id" value={taxCodeId}
                        onChange={(e) => setTaxCodeId(e.target.value)}>
                  <option value="">None</option>
                  {taxCodes.filter((t) => Number(t.rate) > 0).map((t) => (
                    <option key={t.id} value={t.id}>{t.code} · {Number(t.rate)}%</option>
                  ))}
                </select>
                <span className="hint">
                  {isCredit
                    ? "The tax charged on this part comes off the customer's bill too"
                    : "The tax claimed on this part is given back"}
                </span>
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: "0.6rem" }}>
            <label htmlFor="reason">Why</label>
            <input
              id="reason" name="reason" type="text" required
              placeholder={isCredit
                ? "Short delivery billed in full — 10 boxes never sent"
                : "Two cartons short on arrival — supplier agreed the deduction"}
            />
            <span className="hint">
              Kept on the note for good. A tax office reads this, and so does whoever
              finds the note in a year.
            </span>
          </div>

          <div className="totalbar">
            {tax > 0 && (
              <span style={{ color: "var(--muted)" }}>
                {money(net)} + tax {money(tax)}
              </span>
            )}
            <span style={{ color: "var(--muted)" }}>
              {isCredit ? "Customer will owe" : "We will owe"}
            </span>
            <span className="big">{money(Math.max(0, owed - gross))} MMK</span>
          </div>
        </div>
      </div>

      {tooMuch && (
        <div className="alert">
          That is more than the {money(owed)} still owing. A note cannot take an
          invoice below nothing — {isCredit
            ? "refund what was overpaid instead, or reduce the amount."
            : "reduce the amount, or raise it against another bill."}
        </div>
      )}

      <div className="actions">
        <button type="submit" disabled={pending || tooMuch || net <= 0}>
          {pending ? "Posting…" : `Post ${isCredit ? "credit" : "debit"} note`}
        </button>
        <span className="page-sub">
          {isCredit
            ? "Dr Sales Return / Cr Accounts Receivable. No stock moves — goods coming back is a return."
            : "Dr Accounts Payable / Cr Purchase Return. No stock moves — goods going back is a return."}
        </span>
      </div>
    </form>
  );
}
