"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { money } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";
import { Portal } from "@/components/portal";

export type CorrectableInvoice = {
  document_id: string;
  doc_no: string;
  due_date: string | null;
  gross_total: string;
  /** What it owes right now — with this document's own money still on it. */
  outstanding: string;
  /** What this document currently puts against it. */
  allocated_here: string;
  /** What it would owe if this document did not exist. The ceiling. */
  available: string;
};

const n = (v: string) => {
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * Moving a receipt or a payment onto the right invoice.
 *
 * A customer with several bills open pays one, and the money is recorded
 * against another. Nothing about the money is wrong, so this does not void
 * and re-enter it — the document keeps its number and takes a new version,
 * and the two invoices correct themselves because what an invoice owes is
 * derived from the allocations, never stored on it.
 *
 * The figure each row is measured against is `available`, not `outstanding`:
 * the invoice this document currently pays reads as owing nothing, and that
 * is this document's own doing. Showing it that way would tell somebody an
 * invoice is fully paid at the moment they are trying to move the payment
 * off it.
 */
export function CorrectSettlement({
  action, documentId, docNo, version, docType, partnerName,
  invoices, cashAccounts, cashAccountId, memo, total,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  docNo: string;
  version: number;
  docType: string;
  partnerName: string | null;
  invoices: CorrectableInvoice[];
  cashAccounts: { id: string; code: string; name: string }[];
  cashAccountId: string | null;
  memo: string | null;
  /** What the document is for. The correction must still add up to it. */
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const i of invoices) {
      const here = Number(i.allocated_here);
      if (here > 0) seed[i.document_id] = String(here);
    }
    return seed;
  });
  const [account, setAccount] = useState(cashAccountId ?? cashAccounts[0]?.id ?? "");
  const [narration, setNarration] = useState(memo ?? "");
  const [reason, setReason] = useState("");

  const allocated = invoices.reduce((s, i) => s + (n(amounts[i.document_id]) || 0), 0);
  const over = invoices.filter(
    (i) => (n(amounts[i.document_id]) || 0) > Number(i.available) + 0.0001
  );
  // The money that came in has not changed; only which bills it answers. A
  // correction that did not add up to the same total would be a different
  // payment, and is a void and a new one rather than a version of this.
  const matchesTotal = Math.abs(allocated - total) < 0.0001;

  const payload = invoices
    .map((i) => ({ invoiceId: i.document_id, amount: n(amounts[i.document_id]) || 0 }))
    .filter((a) => a.amount > 0);

  const noun = docType === "SUPPLIER_PAYMENT" ? "payment" : "receipt";

  return (
    <>
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        <Pencil size={13} aria-hidden="true" /> Correct
      </button>

      {open && (
        <Portal>
          <div className="previewback" onClick={() => setOpen(false)}>
            <div className="previewbody" onClick={(e) => e.stopPropagation()}>
              <form action={formAction} className="card">
                <div className="card-head">
                  <h2>Correct {docNo}</h2>
                  <span className="page-sub">
                    {money(total)} from {partnerName ?? "this partner"}. Move it onto
                    the right invoice — this {noun} keeps its number and posts as
                    v{version + 1}.
                  </span>
                </div>

                <div className="card-body">
                  <input type="hidden" name="document_id" value={documentId} />
                  <input type="hidden" name="allocations" value={JSON.stringify(payload)} />

                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Invoice</th><th>Due</th>
                          <th className="r">Invoice total</th>
                          <th className="r">Available</th>
                          <th className="r">This {noun}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoices.map((i) => {
                          const here = n(amounts[i.document_id]) || 0;
                          const tooMuch = here > Number(i.available) + 0.0001;
                          return (
                            <tr key={i.document_id}>
                              <td>{i.doc_no}</td>
                              <td className="m">{i.due_date ?? "—"}</td>
                              <td className="r">{money(i.gross_total)}</td>
                              <td className="r">
                                {money(i.available)}
                                {Number(i.allocated_here) > 0 && (
                                  <span className="hint" style={{ display: "block" }}>
                                    reads as {money(i.outstanding)} with this {noun} on it
                                  </span>
                                )}
                              </td>
                              <td className="r">
                                <input type="number" step="any" min="0"
                                  value={amounts[i.document_id] ?? ""}
                                  style={tooMuch ? { borderColor: "var(--bad)" } : undefined}
                                  onChange={(e) => setAmounts((a) =>
                                    ({ ...a, [i.document_id]: e.target.value }))} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3}>Allocated</td>
                          <td className="r">{money(total)}</td>
                          <td className="r">
                            <strong style={matchesTotal ? undefined : { color: "var(--bad)" }}>
                              {money(allocated)}
                            </strong>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {over.length > 0 && (
                    <div className="alert" style={{ marginTop: "0.6rem" }}>
                      <TriangleAlert size={14} aria-hidden="true" />{" "}
                      {over.map((i) => i.doc_no).join(", ")} would take more than
                      {over.length === 1 ? " it has" : " they have"} left.
                    </div>
                  )}
                  {!matchesTotal && over.length === 0 && (
                    <div className="alert" style={{ marginTop: "0.6rem" }}>
                      <TriangleAlert size={14} aria-hidden="true" />{" "}
                      This {noun} is for {money(total)}. Allocate all of it — changing
                      how much came in is a different {noun}, not a correction of
                      this one.
                    </div>
                  )}

                  <div className="field" style={{ marginTop: "0.8rem", maxWidth: "24rem" }}>
                    <label htmlFor="cs_account">
                      {docType === "SUPPLIER_PAYMENT" ? "Paid from" : "Received into"}
                    </label>
                    <select id="cs_account" name="cash_account_id" value={account}
                            onChange={(e) => setAccount(e.target.value)} required>
                      {cashAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="cs_memo">Narration</label>
                    <textarea id="cs_memo" name="memo" rows={2} value={narration}
                              onChange={(e) => setNarration(e.target.value)} />
                  </div>

                  <div className="field">
                    <label htmlFor="cs_reason">Why is this being corrected? *</label>
                    <input id="cs_reason" name="reason" type="text" required
                           value={reason} onChange={(e) => setReason(e.target.value)}
                           placeholder="e.g. Paid against the wrong invoice" />
                  </div>

                  {state && "error" in state && state.error && (
                    <div className="alert bad">{state.error}</div>
                  )}
                </div>

                <div className="actions" style={{ padding: "0 1rem 1rem" }}>
                  <button type="button" className="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit"
                          disabled={pending || !matchesTotal || over.length > 0 || !reason.trim()}>
                    {pending ? "Posting…" : `Post v${version + 1}`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
