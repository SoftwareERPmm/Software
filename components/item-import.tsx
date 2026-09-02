"use client";

import { useActionState, useState, useTransition } from "react";
import { previewItemImport } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";

type Issue = { row: number; column?: string; message: string };
type PlannedRow = {
  row: number; barcode: string; name: string; qty: number; unitCost: number;
  locationName: string; unitName: string; categoryName: string; itemId: string | null;
};
type PlannedItem = {
  barcode: string; name: string; categoryName: string;
  isNew: boolean; locations: number; totalQty: number;
};
type Plan = {
  rows: PlannedRow[];
  items: PlannedItem[];
  errors: Issue[];
  warnings: Issue[];
  summary: {
    rows: number; newItems: number; existingItems: number;
    stockRows: number; totalUnits: number;
  };
};

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

const TEMPLATE_HEADER = "No,Barcode,Stock Name,Category,Brand,Location,Qty,Unit,Unit Cost";
const TEMPLATE_EXAMPLE = [
  '1,8851234567890,Coca-Cola 300ml,Beverages,Coca-Cola,Main Warehouse,100,Bottle,600',
  '2,8851234567891,Sprite 300ml,Beverages,Sprite,Main Warehouse,80,Bottle,550',
  '3,10001,T-Shirt Black,Clothing,ABC,Yangon Warehouse,50,Piece,4500',
].join("\n");

export function ItemImport({ action, today }: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  today: string;
}) {
  const [state, formAction, posting] = useActionState<ActionResult | null, FormData>(action as never, null);
  const [csv, setCsv] = useState("");
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [filename, setFilename] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();

  function downloadTemplate() {
    const blob = new Blob([`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "item-opening-stock-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** A workbook is sent as bytes; a CSV as text. Chunked on the way to base64
   *  because spreading a 500-row file into String.fromCharCode in one call
   *  overflows the argument list. */
  async function encode(file: File): Promise<{ content: string; kind: "csv" | "xlsx" }> {
    const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
    if (isCsv) return { content: await file.text(), kind: "csv" };

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { content: btoa(binary), kind: "xlsx" };
  }

  function onFile(file: File | undefined) {
    setPlan(null);
    setReadError(null);
    if (!file) return;
    startChecking(async () => {
      try {
        const { content, kind } = await encode(file);
        setCsv(content);
        setFormat(kind);
        setFilename(file.name);
        const res = await previewItemImport(content, file.name, kind);
        setPlan(res.plan as unknown as Plan);
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
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
            <span className="page-sub">Excel (.xlsx) or CSV — upload the workbook directly, no need to convert it</span>
          </div>
          <div className="card-body">
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field">
                <label htmlFor="file">Spreadsheet</label>
                <input id="file" type="file"
                       accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                       onChange={(e) => onFile(e.target.files?.[0])} />
              </div>
              <div className="actions">
                <button type="button" className="ghost" onClick={downloadTemplate}>Download template</button>
              </div>
            </div>

            <div className="alert" style={{ marginTop: "0.75rem" }}>
              <strong>Format the Barcode column as Text before you fill it.</strong>{" "}
              Excel treats a long barcode as a number otherwise, which drops any leading zero
              and rounds anything past fifteen digits — damage done in the sheet, before the
              file gets here.{" "}
              {format === "xlsx"
                ? "Reading the workbook directly does avoid the other half of the problem: a barcode merely displayed as 8.85E+12 is stored exactly, and comes through intact."
                : "Saving as CSV can also write out the displayed 8.85123E+12 instead of the real number, losing the digits that tell two products apart — uploading the .xlsx avoids that."}
            </div>

            {checking && <p className="page-sub">Checking the file…</p>}
            {readError && <div className="alert">{readError}</div>}
          </div>
        </div>
      </section>

      {plan && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>2 · What this would do</h2>
              <span className="page-sub">{filename}</span>
            </div>

            <div className="kpis" style={{ margin: "0.75rem" }}>
              <div className="kpi">
                <span className="kpi-label">Items found</span>
                <span className="kpi-value">{plan.items.length}</span>
                <span className="kpi-note">
                  {plan.summary.newItems} new · {plan.summary.existingItems} existing
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Stock records found</span>
                <span className="kpi-value">{plan.summary.stockRows}</span>
                <span className="kpi-note">one per item and warehouse</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Total units</span>
                <span className="kpi-value">{num(plan.summary.totalUnits)}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Rows read</span>
                <span className="kpi-value">{plan.summary.rows}</span>
                <span className="kpi-note">
                  {plan.summary.rows !== plan.items.length
                    ? "more rows than items — the same product appears in several warehouses"
                    : "one row per item"}
                </span>
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

            {plan.items.length > 0 && (
              <>
                <div className="card-head" style={{ borderTop: "1px solid var(--line)" }}>
                  <h2 style={{ fontSize: "var(--t-md)" }}>Item master</h2>
                  <span className="page-sub">
                    what will exist as products — one per barcode, however many warehouses it is in
                  </span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Barcode</th><th>Stock name</th><th>Category</th>
                        <th className="r">Warehouses</th><th className="r">Total qty</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {plan.items.map((it) => (
                        <tr key={it.barcode}>
                          <td className="code">{it.barcode}</td>
                          <td className="wrap">{it.name}</td>
                          <td style={{ color: "var(--muted)" }}>{it.categoryName}</td>
                          <td className="r">{it.locations}</td>
                          <td className="r">{num(it.totalQty)}</td>
                          <td>
                            <span className={`pill ${it.isNew ? "" : "ok"}`}>
                              {it.isNew ? "new" : "existing"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="card-head" style={{ borderTop: "1px solid var(--line)" }}>
                  <h2 style={{ fontSize: "var(--t-md)" }}>Opening stock</h2>
                  <span className="page-sub">
                    one balance per item and warehouse — the same product in two warehouses is two
                    balances, not two products
                  </span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th><th>Item</th><th>Warehouse</th>
                        <th className="r">Qty</th><th>Unit</th><th className="r">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r) => (
                        <tr key={`${r.barcode}-${r.locationName}`}>
                          <td className="code">{r.row}</td>
                          <td className="wrap">{r.name}</td>
                          <td>{r.locationName}</td>
                          <td className="r">{num(r.qty)}</td>
                          <td className="code">{r.unitName}</td>
                          <td className="r">{num(r.unitCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
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
                    {plan.errors.length > 200 && (
                      <tr><td colSpan={3} className="empty">
                        …and {plan.errors.length - 200} more. Fix these first.
                      </td></tr>
                    )}
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
                    {plan.warnings.length > 50 && (
                      <tr><td colSpan={3} className="empty">…and {plan.warnings.length - 50} more.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head"><h2>3 · Import</h2></div>
          <form action={formAction} className="form">
            <input type="hidden" name="csv" value={csv} />
            <input type="hidden" name="format" value={format} />
            <input type="hidden" name="filename" value={filename} />
            <div className="card-body">
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field">
                  <label htmlFor="doc_date">Opening stock date</label>
                  <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
                  <span className="hint">The date the stock is counted as being on hand.</span>
                </div>
              </div>

              {state && "error" in state && <div className="alert">{state.error}</div>}

              <p className="page-sub" style={{ marginTop: "0.5rem" }}>
                {blocked
                  ? "Upload a file with no errors to continue."
                  : `Creates ${plan!.summary.newItems} item${plan!.summary.newItems === 1 ? "" : "s"} and ` +
                    `${plan!.summary.stockRows} opening stock record${plan!.summary.stockRows === 1 ? "" : "s"}. ` +
                    `All of it lands or none of it does — there is no half-imported state.`}
              </p>
            </div>
            <div className="card-body" style={{ paddingTop: 0 }}>
              <button type="submit" disabled={blocked || posting || checking}>
                {posting ? "Importing…" : "Confirm import"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
