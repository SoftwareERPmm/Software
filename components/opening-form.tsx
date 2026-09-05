"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { groupAccountsBySection } from "@/lib/format";
import { ACCOUNT_TYPE_LABEL } from "./account-form";

type Account = {
  id: string; code: string; name: string; parent_id?: string | null;
  account_type: string; is_control: boolean;
};
/** Every account including the non-postable headings, so an account's section
 *  can be found by walking up to it. */
type TreeNode = {
  id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
};

type Row = { key: number; accountId: string; debit: string; credit: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Opening balances. Whatever the entered balances do not account for goes to
 * Opening Balance Equity, so this posts as a balanced entry without anyone
 * having to compute the balancing figure.
 */
export function OpeningForm({
  action,
  accounts,
  accountTree = [],
  today,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  accounts: Account[];
  /** The chart with its headings, so this list reads the way Master data
   *  draws it rather than as one long alphabet of accounts. */
  accountTree?: TreeNode[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [rows, setRows] = useState<Row[]>([
    { key: 1, accountId: "", debit: "", credit: "" },
    { key: 2, accountId: "", debit: "", credit: "" },
    { key: 3, accountId: "", debit: "", credit: "" },
  ]);

  // Receivables and payables open through their own subledger, not here, or
  // the control account would stop agreeing with the invoices behind it.
  const postable = accounts.filter((a) => !a.is_control);
  const groups = groupAccountsBySection(
    postable, accountTree.length ? accountTree : (postable as never), ACCOUNT_TYPE_LABEL
  );

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((rs) => [...rs, { key: Math.max(0, ...rs.map((r) => r.key)) + 1, accountId: "", debit: "", credit: "" }]);

  const removeRow = (key: number) =>
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.key !== key)));

  const lines = rows
    .filter((r) => r.accountId && (Number(r.debit) || Number(r.credit)))
    .map((r) => ({
      accountId: r.accountId,
      amount: (Number(r.debit) || 0) - (Number(r.credit) || 0),
    }));

  const totalDr = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalCr = lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
  const toEquity = totalDr - totalCr;

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      <div className="row">
        <div className="field">
          <label htmlFor="doc_date">As at</label>
          <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
          <span className="hint">The day before you started trading in this system</span>
        </div>
        <div className="field">
          <label htmlFor="memo">Description</label>
          <textarea id="memo" name="memo" rows={2} defaultValue="Opening balances" />
          <span className="hint">English or Myanmar</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Balances</h2>
          <button type="button" className="ghost tiny" onClick={addRow}>Add line</button>
        </div>
        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Account</th><th className="r">Debit</th><th className="r">Credit</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ minWidth: 280 }}>
                    <select value={r.accountId} onChange={(e) => setRow(r.key, { accountId: e.target.value })}>
                      <option value="">Choose an account…</option>
                      {/* Under the same headings, in the same order, as the
                          chart under Master data. Someone who has just set the
                          chart up should not have to re-learn its shape here.
                          The stored type is dropped from the label because the
                          heading above already says it, and says it more
                          precisely than the six stored types can. */}
                      {groups.map(([heading, items]) => (
                        <optgroup key={heading} label={heading}>
                          {items.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  <td className="narrow">
                    <input type="number" min="0" step="any" value={r.debit} aria-label="Debit"
                      onChange={(e) => setRow(r.key, { debit: e.target.value, credit: "" })} />
                  </td>
                  <td className="narrow">
                    <input type="number" min="0" step="any" value={r.credit} aria-label="Credit"
                      onChange={(e) => setRow(r.key, { credit: e.target.value, debit: "" })} />
                  </td>
                  <td className="tight">
                    <button type="button" className="ghost tiny" aria-label="Remove line"
                      onClick={() => removeRow(r.key)} disabled={rows.length <= 1}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Entered</td>
                <td className="r dr">{fmt(totalDr)}</td>
                <td className="r cr">{fmt(totalCr)}</td>
                <td />
              </tr>
              {toEquity !== 0 && (
                <tr>
                  <td style={{ fontWeight: 400, color: "var(--muted)" }}>
                    Opening Balance Equity (balancing figure)
                  </td>
                  <td className="r dr">{toEquity < 0 ? fmt(-toEquity) : ""}</td>
                  <td className="r cr">{toEquity > 0 ? fmt(toEquity) : ""}</td>
                  <td />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </div>

      <div className="note">
        <p>
          Receivables and payables are deliberately not listed. Those open through
          their own invoices, so the control account keeps agreeing with the
          documents behind it.
        </p>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || lines.length === 0}>
          {pending ? "Posting…" : "Post opening balances"}
        </button>
      </div>
    </form>
  );
}
