"use client";

import { useActionState, useState, useTransition } from "react";
import { previewVoucherImport, voucherImportTemplate } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";
import { FileDrop, type Upload } from "./file-drop";

type Issue = { row: number; column?: string; message: string };
type Row = {
  row: number; docDate: string; moneyAccountName: string; otherAccountName: string;
  amount: number; locationName: string; reference: string | null; memo: string | null;
};
type Plan = {
  rows: Row[]; errors: Issue[]; warnings: Issue[];
  summary: { rows: number; receipts: number; total: number; accounts: number };
};

const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function VoucherImport({ kind, action }: {
  kind: "cash" | "bank";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, posting] = useActionState<ActionResult | null, FormData>(action as never, null);
  const [file, setFile] = useState<Upload | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [gettingTemplate, startTemplate] = useTransition();

  const moneyColumn = kind === "cash" ? "Cash Account" : "Bank Account";

  function onPick(u: Upload) {
    setPlan(null); setError(null); setFile(u);
    start(async () => {
      try {
        const res = await previewVoucherImport(u.content, u.name, u.format, kind);
        setPlan(res.plan as unknown as Plan);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function downloadTemplate() {
    startTemplate(async () => {
      setError(null);
      try {
        const { base64 } = await voucherImportTemplate(kind);
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(
          new Blob([bytes], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          })
        );
        a.download = `${kind}-receipt-template.xlsx`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const blocked = !plan || plan.errors.length > 0 || plan.rows.length === 0;

  return (
    <>
      <section>
        <div className="card">
          <div className="card-head">
            <h2>1 · The file</h2>
            <span className="page-sub">
              One row is one receipt. The columns are the fields this screen asks for:
              {" "}Date, {moneyColumn}, Received From, Amount, Branch, Reference, Description.
            </span>
            <span className="actions">
              <button type="button" onClick={downloadTemplate} disabled={gettingTemplate}>
                {gettingTemplate ? "Preparing…" : "Download Excel template"}
              </button>
            </span>
          </div>
          <div className="card-body">
            <FileDrop
              onPick={onPick}
              onClear={() => { setFile(null); setPlan(null); setError(null); }}
              picked={file?.name ?? null}
              busy={busy}
            />
            {error && <div className="alert" style={{ marginTop: "0.75rem" }}>{error}</div>}
          </div>
        </div>
      </section>

      {plan && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>2 · What this would post</h2>
              <span className="page-sub">{file?.name}</span>
            </div>

            <div className="kpis" style={{ margin: "0.75rem" }}>
              <div className="kpi">
                <span className="kpi-label">Receipts</span>
                <span className="kpi-value">{plan.summary.receipts}</span>
                <span className="kpi-note">one document each</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Total received</span>
                <span className="kpi-value">{money(plan.summary.total)}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Accounts credited</span>
                <span className="kpi-value">{plan.summary.accounts}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Errors</span>
                <span className="kpi-value" style={{ color: plan.errors.length ? "var(--bad)" : undefined }}>
                  {plan.errors.length}
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Warnings</span>
                <span className="kpi-value" style={{ color: plan.warnings.length ? "var(--warn)" : undefined }}>
                  {plan.warnings.length}
                </span>
              </div>
            </div>

            {plan.rows.length > 0 && (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th><th>Date</th><th>{moneyColumn}</th><th>Received from</th>
                      <th className="r">Amount</th><th>Branch</th><th>Reference</th><th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.map((r) => (
                      <tr key={r.row}>
                        <td className="code">{r.row}</td>
                        <td className="code">{r.docDate}</td>
                        <td>{r.moneyAccountName}</td>
                        <td>{r.otherAccountName}</td>
                        <td className="r">{money(r.amount)}</td>
                        <td style={{ color: r.locationName === "—" ? "var(--warn)" : undefined }}>
                          {r.locationName}
                        </td>
                        <td className="code">{r.reference ?? "—"}</td>
                        <td className="wrap" style={{ color: "var(--muted)" }}>{r.memo ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>Total</td>
                      <td className="r" style={{ fontWeight: 700 }}>{money(plan.summary.total)}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {plan.errors.length > 0 && (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Row</th><th>Column</th><th>Must be fixed before importing</th></tr>
                  </thead>
                  <tbody>
                    {plan.errors.slice(0, 200).map((e, i) => (
                      <tr key={i}>
                        <td className="code">{e.row}</td>
                        <td className="code" style={{ color: "var(--muted)" }}>{e.column ?? "—"}</td>
                        <td className="wrap" style={{ color: "var(--bad)" }}>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {plan.warnings.length > 0 && (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Row</th><th>Column</th><th>Worth a look, but will not stop the import</th></tr>
                  </thead>
                  <tbody>
                    {plan.warnings.slice(0, 50).map((w, i) => (
                      <tr key={i}>
                        <td className="code">{w.row}</td>
                        <td className="code" style={{ color: "var(--muted)" }}>{w.column ?? "—"}</td>
                        <td className="wrap" style={{ color: "var(--warn)" }}>{w.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head"><h2>3 · Post</h2></div>
          <form action={formAction} className="form">
            <input type="hidden" name="csv" value={file?.content ?? ""} />
            <input type="hidden" name="format" value={file?.format ?? "csv"} />
            <input type="hidden" name="filename" value={file?.name ?? ""} />
            <input type="hidden" name="kind" value={kind} />
            <div className="card-body">
              {state && "error" in state && <div className="alert">{state.error}</div>}
              <p className="page-sub">
                {blocked
                  ? "Upload a file with no errors to continue."
                  : `Posts ${plan!.summary.receipts} receipt${plan!.summary.receipts === 1 ? "" : "s"} ` +
                    `totalling ${money(plan!.summary.total)}. All of them post or none do.`}
              </p>
              <button type="submit" disabled={blocked || posting || busy} style={{ marginTop: "0.5rem" }}>
                {posting ? "Posting…" : "Confirm and post"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
