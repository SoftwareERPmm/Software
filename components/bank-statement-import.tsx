"use client";

import { useActionState, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { FileDrop, type Upload } from "./file-drop";

const money = (n: number | string) =>
  Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

type Plan = {
  mapping: {
    date: string | null; description: string | null; reference: string | null;
    amount: string | null; paidIn: string | null; paidOut: string | null;
    balance: string | null;
  };
  rows: {
    lineNo: number; txnDate: string; description: string | null;
    reference: string | null; amount: number; balance: number | null;
  }[];
  skipped: { rowNo: number; raw: string; why: string }[];
  from: string | null;
  to: string | null;
  netMovement: number;
};

const LABEL: Record<string, string> = {
  date: "Date", description: "Description", reference: "Reference",
  amount: "Signed amount", paidIn: "Money in", paidOut: "Money out",
  balance: "Balance",
};

/**
 * Importing a statement exactly as the bank exported it.
 *
 * No template, because a bank will not export one — and asking somebody to
 * re-key a statement into our columns is asking them to make the mistakes
 * reconciliation exists to catch.
 *
 * What it reads is shown before anything is saved. The failure that matters
 * is a silent one: a money-out column read as money-in reverses every sign
 * and matches nothing, and the only way to catch it is to say out loud which
 * column was understood as what.
 */
export function BankStatementImport({
  accounts, preview, action,
}: {
  accounts: { id: string; code: string; name: string }[];
  preview: (content: string, filename: string, format: "csv" | "xlsx")
    => Promise<{ plan: Plan; filename: string }>;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, saving] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [file, setFile] = useState<Upload | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");

  function onPick(u: Upload) {
    setPlan(null); setError(null); setFile(u);
    start(async () => {
      try {
        const res = await preview(u.content, u.name, u.format);
        setPlan(res.plan);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const mapped = plan
    ? (Object.keys(LABEL) as (keyof Plan["mapping"])[])
        .filter((k) => plan.mapping[k])
    : [];
  const moneyRead = plan
    ? (plan.mapping.amount ? "one signed column"
       : plan.mapping.paidIn || plan.mapping.paidOut ? "money in minus money out"
       : null)
    : null;

  return (
    <>
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <section>
        <div className="card">
          <div className="card-head"><h2>The file</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="account_id">Bank account</label>
                <select id="account_id" value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
                <span className="hint">Which account this is a statement of</span>
              </div>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <FileDrop
                onPick={onPick}
                onClear={() => { setFile(null); setPlan(null); setError(null); }}
                picked={file?.name ?? null}
                busy={busy}
              />
            </div>
            {error && <div className="alert" style={{ marginTop: "0.75rem" }}>{error}</div>}
          </div>
        </div>
      </section>

      {plan && (
        <>
          <section>
            <div className="card">
              <div className="card-head">
                <h2>What was understood</h2>
                <span className="page-sub">
                  {plan.rows.length} line{plan.rows.length === 1 ? "" : "s"}
                  {plan.from && <> · {plan.from} to {plan.to}</>}
                  {" · net "}{money(plan.netMovement)}
                </span>
              </div>
              <div className="card-body">
                {mapped.length === 0 ? (
                  <div className="alert">
                    No columns were recognised. The file needs a header row
                    naming at least a date column and an amount, credit or
                    debit column.
                  </div>
                ) : (
                  <>
                    {/* Read this before importing: it is the only place the
                        sign convention is visible. */}
                    <div className="hintbar caution">
                      <strong>Check the columns.</strong> Money read as{" "}
                      {moneyRead}. A money-out column read as money-in
                      reverses every sign and will match nothing.
                    </div>
                    <div className="tablewrap" style={{ marginTop: "0.6rem" }}>
                      <table>
                        <thead>
                          <tr><th>Read as</th><th>Column in your file</th></tr>
                        </thead>
                        <tbody>
                          {mapped.map((k) => (
                            <tr key={k}>
                              <td>{LABEL[k]}</td>
                              <td className="code">{plan.mapping[k]}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>

          {plan.skipped.length > 0 && (
            <section>
              <div className="card">
                <div className="card-head">
                  <h2>Rows not imported</h2>
                  <span className="page-sub">
                    {plan.skipped.length} row{plan.skipped.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>Row</th><th>Why</th><th>Content</th></tr></thead>
                    <tbody>
                      {plan.skipped.map((s, i) => (
                        <tr key={`${s.rowNo}-${i}`}>
                          <td className="code">{s.rowNo || "—"}</td>
                          <td className="wrap">{s.why}</td>
                          <td className="wrap subline">{s.raw}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {plan.rows.length > 0 && (
            <section>
              <div className="card">
                <div className="card-head"><h2>Lines to import</h2></div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th><th>Date</th><th>Description</th>
                        <th>Reference</th><th className="r">Amount</th>
                        <th className="r">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r) => (
                        <tr key={r.lineNo}>
                          <td className="code">{r.lineNo}</td>
                          <td className="code">{r.txnDate}</td>
                          <td className="wrap">{r.description ?? "—"}</td>
                          <td className="code">{r.reference ?? "—"}</td>
                          <td className="r" style={{
                            color: r.amount < 0 ? "var(--bad)" : undefined,
                          }}>
                            {money(r.amount)}
                          </td>
                          <td className="r">{r.balance === null ? "—" : money(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          <form action={formAction}>
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="file" value={file?.content ?? ""} />
            <input type="hidden" name="filename" value={file?.name ?? ""} />
            <input type="hidden" name="format" value={file?.format ?? "csv"} />

            <div className="card">
              <div className="card-head">
                <h2>What the bank says the balance was</h2>
                <span className="page-sub">Optional</span>
              </div>
              <div className="card-body">
                <div className="row">
                  <div className="field">
                    <label htmlFor="opening_balance">Opening balance</label>
                    <input id="opening_balance" name="opening_balance"
                           type="number" step="any" />
                  </div>
                  <div className="field">
                    <label htmlFor="closing_balance">Closing balance</label>
                    <input id="closing_balance" name="closing_balance"
                           type="number" step="any" />
                    <span className="hint">
                      The only independent check that the imported lines are complete
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="actions">
              <button type="submit"
                      disabled={saving || plan.rows.length === 0 || !accountId}>
                {saving ? "Importing…" : `Import ${plan.rows.length} lines`}
              </button>
              <span className="page-sub">
                No accounting entries are created. This only puts the bank&rsquo;s
                list beside ours.
              </span>
            </div>
          </form>
        </>
      )}
    </>
  );
}
