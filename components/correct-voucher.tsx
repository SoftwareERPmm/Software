"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { money } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";
import { Portal } from "@/components/portal";

export type VoucherAccount = { id: string; code: string; name: string };
export type CorrectableVoucherLine = {
  accountId: string;
  /** Positive debit, negative credit — the engine's own convention. */
  amount: number;
  memo: string | null;
};

type Row = { key: number; accountId: string; debit: string; credit: string; memo: string };

const n = (v: string) => {
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * Correcting a voucher.
 *
 * The order and invoice corrections edit quantities and prices, because that
 * is what those documents are made of. A voucher is made of accounts and
 * amounts, so this is its own editor rather than a fourth mode of that one.
 *
 * What it does is identical underneath: the original is voided and a
 * replacement posts under the same number at the next version, with the
 * reason kept against it. Nothing is rewritten, so a report printed before
 * the correction still says what it said.
 */
export function CorrectVoucher({
  action, documentId, docNo, version, accounts, lines, memo, docType,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  docNo: string;
  version: number;
  accounts: VoucherAccount[];
  lines: CorrectableVoucherLine[];
  memo: string | null;
  docType: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  const [rows, setRows] = useState<Row[]>(() =>
    lines.map((l, i) => ({
      key: i + 1,
      accountId: l.accountId,
      debit: l.amount > 0 ? String(l.amount) : "",
      credit: l.amount < 0 ? String(-l.amount) : "",
      memo: l.memo ?? "",
    }))
  );
  const [narration, setNarration] = useState(memo ?? "");
  const [reason, setReason] = useState("");

  const totalDr = rows.reduce((s, r) => s + n(r.debit), 0);
  const totalCr = rows.reduce((s, r) => s + n(r.credit), 0);
  const difference = totalDr - totalCr;
  const balanced = Math.abs(difference) < 0.0001;
  const filled = rows.filter((r) => r.accountId && (n(r.debit) || n(r.credit)));
  // Same shape the voucher form posts, so the action parses one thing.
  const payload = filled.map((r) => ({
    accountId: r.accountId,
    amount: n(r.debit) - n(r.credit),
    memo: r.memo || null,
  }));

  const set = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const noun = docType === "CASH_VOUCHER" ? "cash voucher"
    : docType === "BANK_VOUCHER" ? "bank voucher"
    : docType === "OPENING_BALANCE" ? "opening balance" : "journal voucher";

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
                    This {noun} is voided and posted again as v{version + 1},
                    under the same number.
                  </span>
                </div>

                <div className="card-body">
                  <input type="hidden" name="document_id" value={documentId} />
                  <input type="hidden" name="lines" value={JSON.stringify(payload)} />

                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Account</th><th>Line note</th>
                          <th className="r">Debit</th><th className="r">Credit</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.key}>
                            <td>
                              <select value={r.accountId}
                                      onChange={(e) => set(r.key, { accountId: e.target.value })}>
                                <option value="">Choose an account…</option>
                                {accounts.map((a) => (
                                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input type="text" value={r.memo}
                                     onChange={(e) => set(r.key, { memo: e.target.value })} />
                            </td>
                            <td>
                              {/* One side at a time. A line carrying both is
                                  not a line anybody meant to write. */}
                              <input type="number" step="any" min="0" value={r.debit}
                                     onChange={(e) => set(r.key, { debit: e.target.value, credit: "" })} />
                            </td>
                            <td>
                              <input type="number" step="any" min="0" value={r.credit}
                                     onChange={(e) => set(r.key, { credit: e.target.value, debit: "" })} />
                            </td>
                            <td>
                              <button type="button" className="ghost tiny"
                                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={2}>
                            <button type="button" className="ghost tiny" onClick={() =>
                              setRows((rs) => [...rs, {
                                key: Math.max(0, ...rs.map((x) => x.key)) + 1,
                                accountId: "", debit: "", credit: "", memo: "",
                              }])}>
                              Add line
                            </button>
                          </td>
                          <td className="r">{money(totalDr)}</td>
                          <td className="r">{money(totalCr)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {!balanced && (
                    <div className="alert" style={{ marginTop: "0.6rem" }}>
                      <TriangleAlert size={14} aria-hidden="true" />{" "}
                      The two sides differ by {money(Math.abs(difference))}.
                    </div>
                  )}

                  <div className="field" style={{ marginTop: "0.8rem" }}>
                    <label htmlFor="cv_memo">Narration</label>
                    <textarea id="cv_memo" name="memo" rows={2} value={narration}
                              onChange={(e) => setNarration(e.target.value)} />
                  </div>

                  {/* Kept with the version, which is the point of correcting
                      rather than voiding and re-entering: the books say what
                      changed and why. */}
                  <div className="field">
                    <label htmlFor="cv_reason">Why is this being corrected? *</label>
                    <input id="cv_reason" name="reason" type="text" required
                           value={reason} onChange={(e) => setReason(e.target.value)}
                           placeholder="e.g. Figure was 65,000, not 50,000" />
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
                          disabled={pending || !balanced || filled.length < 2 || !reason.trim()}>
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
