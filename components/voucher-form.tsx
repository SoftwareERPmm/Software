"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { groupAccountsBySection } from "@/lib/format";
import { ACCOUNT_TYPE_LABEL } from "./account-form";

type Account = {
  id: string; code: string; name: string; parent_id: string | null;
  account_type: string; is_control: boolean;
  is_cash_account: boolean; is_bank_account: boolean;
};
/** Every account including section headings, for resolving an account's group. */
type TreeNode = {
  id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
};
type Branch = { id: string; code: string; name: string };

type Row = { key: number; accountId: string; debit: string; credit: string; memo: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// Grouped and ordered the way Master data draws the chart — assets,
// liabilities, equity, revenue, cost of sales, expense, tax — rather than in
// an order of this form's own invention. Someone who has just read the chart
// should find the same shape here.
//
// The group comes from the section an account sits under, not from its stored
// account_type, because the chart draws distinctions the six stored types do
// not carry: a tax payable is a LIABILITY in the database and reads as Tax on
// screen, and current and fixed assets are both ASSET. On a chart with no
// sections the walk falls back to the stored type, so this still groups
// sensibly on the seed chart.

/**
 * Cash book, bank book and journal are the same voucher with different
 * defaults. Cash and bank fix one side to a till or bank account and ask
 * only for the other; the journal leaves both open.
 */
export function VoucherForm({
  kind,
  accountTree = [],
  action,
  accounts,
  branches,
  moneyAccounts,
  today,
  nextNo,
  presetDirection,
}: {
  kind: "cash" | "bank" | "journal";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  accounts: Account[];
  accountTree?: TreeNode[];
  branches: Branch[];
  moneyAccounts: Account[];
  today: string;
  nextNo: string;
  /** Locks the direction and hides the toggle — a receipt is always in, a payment always out. */
  presetDirection?: "in" | "out";
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const simple = kind !== "journal";

  // Simple mode: one money account, a direction, and the other side.
  const [moneyId, setMoneyId] = useState(moneyAccounts[0]?.id ?? "");
  const [direction, setDirection] = useState<"in" | "out">(presetDirection ?? "out");
  const [otherId, setOtherId] = useState("");
  const [amount, setAmount] = useState("");

  // Journal mode: free rows.
  const [rows, setRows] = useState<Row[]>([
    { key: 1, accountId: "", debit: "", credit: "", memo: "" },
    { key: 2, accountId: "", debit: "", credit: "", memo: "" },
  ]);

  // Control accounts belong to their subledger; the database refuses them on
  // a manual entry, so they are not offered.
  const postable = accounts.filter((a) => !a.is_control);

  // One group per section of the chart, named and ordered as the chart names
  // and orders them — so "General & Administration Expenses" and "Selling &
  // Distribution Expenses" are two groups here because they are two headings
  // there, rather than both being flattened into "Expense".
  //
  // Section codes carry the order (1-CA, 2-CL, 3-EQ, 4-SA, 5-CG, 6-GA, 6-SD,
  // 7-TX), which is assets, liabilities, equity, revenue, cost of sales,
  // expense, tax — the order Master data draws. A chart with no sections at
  // all falls back to the account type, and to the fixed sequence that goes
  // with it.
  const tree: TreeNode[] = accountTree.length ? accountTree : accounts;
  const groups = groupAccountsBySection(postable, tree, ACCOUNT_TYPE_LABEL);

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((rs) => [...rs, { key: Math.max(0, ...rs.map((r) => r.key)) + 1, accountId: "", debit: "", credit: "", memo: "" }]);

  const removeRow = (key: number) =>
    setRows((rs) => (rs.length <= 2 ? rs : rs.filter((r) => r.key !== key)));

  const amt = Number(amount) || 0;

  const lines = simple
    ? amt > 0 && moneyId && otherId
      ? direction === "in"
        ? [{ accountId: moneyId, amount: amt }, { accountId: otherId, amount: -amt }]
        : [{ accountId: otherId, amount: amt }, { accountId: moneyId, amount: -amt }]
      : []
    : rows
        .filter((r) => r.accountId && (Number(r.debit) || Number(r.credit)))
        .map((r) => ({
          accountId: r.accountId,
          amount: (Number(r.debit) || 0) - (Number(r.credit) || 0),
          memo: r.memo || null,
        }));

  const totalDr = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalCr = lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
  const diff = totalDr - totalCr;
  const ready = lines.length >= 2 && Math.abs(diff) < 0.0001;

  const moneyLabel = kind === "cash" ? "Cash account" : "Bank account";

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      <div className="card">
        <div className="card-head">
          <h2>Voucher</h2>
          <span className="m" style={{ color: "var(--muted)" }}>No. {nextNo}</span>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>

            {branches.length > 1 ? (
              <div className="field">
                <label htmlFor="location_id">Branch</label>
                <select id="location_id" name="location_id" defaultValue="">
                  <option value="">None</option>
                  {branches.map((l) => (
                    <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              branches.length === 1 && <input type="hidden" name="location_id" value={branches[0].id} />
            )}

            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text" placeholder="Voucher or cheque no." />
            </div>
          </div>
        </div>
      </div>

      {simple ? (
        <div className="card">
          <div className="card-head"><h2>Movement</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="money">{moneyLabel}</label>
                <select id="money" value={moneyId} onChange={(e) => setMoneyId(e.target.value)}>
                  {moneyAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>

              {!presetDirection && (
                <div className="field">
                  <label htmlFor="direction">Direction</label>
                  <select id="direction" value={direction}
                    onChange={(e) => setDirection(e.target.value as "in" | "out")}>
                    <option value="out">Paid out</option>
                    <option value="in">Received in</option>
                  </select>
                  <span className="hint">
                    {direction === "out" ? "Money leaves this account" : "Money arrives in this account"}
                  </span>
                </div>
              )}

              <div className="field">
                <label htmlFor="other">{direction === "out" ? "Paid for" : "Received from"}</label>
                <select id="other" value={otherId} onChange={(e) => setOtherId(e.target.value)} required>
                  <option value="">Choose an account…</option>
                  {groups.map(([label, group]) => (
                    <optgroup key={label} label={label}>
                      {group.filter((a) => a.id !== moneyId).map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="amount">Amount</label>
                <input id="amount" type="number" min="0" step="any"
                  value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
            </div>

            {lines.length === 2 && (
              <div style={{ marginTop: "1rem" }}>
                <span className="hint">Accounting entry</span>
                <div className="posting">
                {lines
                  .map((l) => {
                    const a = accounts.find((x) => x.id === l.accountId)!;
                    const side = l.amount > 0 ? "Dr" : "Cr";
                    const pad = l.amount > 0 ? "" : "    ";
                    return `${pad}${side}  ${a.code} ${a.name.padEnd(26)}${fmt(Math.abs(l.amount)).padStart(12)}`;
                  })
                  .join("\n")}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>Lines</h2>
            <button type="button" className="ghost tiny" onClick={addRow}>Add line</button>
          </div>
          <div className="tablewrap">
            <table className="linetable">
              <thead>
                <tr>
                  <th>Account</th><th>Description</th>
                  <th className="r">Debit</th><th className="r">Credit</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ minWidth: 240 }}>
                      <select value={r.accountId} onChange={(e) => setRow(r.key, { accountId: e.target.value })}>
                        <option value="">Choose an account…</option>
                        {/* Grouped like the picker above and like the chart —
                            the stored account_type in brackets said "expense"
                            for two different headings, which is the thing the
                            chart draws a distinction between. */}
                        {groups.map(([label, group]) => (
                          <optgroup key={label} label={label}>
                            {group.map((a) => (
                              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="text" value={r.memo}
                        onChange={(e) => setRow(r.key, { memo: e.target.value })} aria-label="Description" />
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
                        onClick={() => removeRow(r.key)} disabled={rows.length <= 2}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>{ready ? "Balanced" : diff === 0 ? "" : `Out by ${fmt(Math.abs(diff))}`}</td>
                  <td className="r dr">{fmt(totalDr)}</td>
                  <td className="r cr">{fmt(totalCr)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="memo">Description</label>
        <textarea id="memo" name="memo" rows={2} placeholder="What this voucher is for — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || !ready}>
          {pending ? "Posting…" : ready ? `Post ${fmt(totalDr)}` : "Post voucher"}
        </button>
        <span className="page-sub">
          {ready
            ? "Ready to post."
            : simple
              ? "Fill in the account and amount to continue."
              : "The two sides don't add up to the same total yet."}
        </span>
      </div>
    </form>
  );
}
