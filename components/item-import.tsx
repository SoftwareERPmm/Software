"use client";

import { useActionState, useState, useTransition } from "react";
import { previewItemImport, itemImportTemplate, createMissingBrands } from "@/lib/actions";
import { FileDrop, type Upload } from "./file-drop";
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
  missingBrands: string[];
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
  const [picked, setPicked] = useState(false);
  const [gettingTemplate, startTemplate] = useTransition();
  const [addingBrands, startBrands] = useTransition();
  const [checking, startChecking] = useTransition();

  function save(blob: Blob, name: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** The Excel template, built on the server so the Barcode column can arrive
   *  already formatted as Text — which is what stops the barcode being
   *  mangled before the file ever gets back here. */
  function downloadTemplate() {
    startTemplate(async () => {
      setReadError(null);
      try {
        const { base64 } = await itemImportTemplate();
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        save(
          new Blob([bytes], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          "item-opening-stock-template.xlsx"
        );
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function downloadCsvTemplate() {
    save(new Blob([`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`], { type: "text/csv;charset=utf-8" }),
         "item-opening-stock-template.csv");
  }

  function onPick(u: Upload) {
    setPlan(null);
    setReadError(null);
    setCsv(u.content);
    setFormat(u.format);
    setFilename(u.name);
    setPicked(true);
    startChecking(async () => {
      try {
        const res = await previewItemImport(u.content, u.name, u.format);
        setPlan(res.plan as unknown as Plan);
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function recheck() {
    startChecking(async () => {
      try {
        const res = await previewItemImport(csv, filename, format);
        setPlan(res.plan as unknown as Plan);
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function addBrands(names: string[]) {
    startBrands(async () => {
      setReadError(null);
      const res = await createMissingBrands(names);
      if (!res.ok) { setReadError(res.error); return; }
      recheck();
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
            <FileDrop
              onPick={onPick}
              onClear={() => { setPicked(false); setPlan(null); setCsv(""); setFilename(""); }}
              picked={picked ? filename : null}
              busy={checking}
            />

            <div className="row" style={{ alignItems: "flex-end", marginTop: "0.75rem" }}>
              <div className="actions">
                <button type="button" onClick={downloadTemplate} disabled={gettingTemplate}>
                  {gettingTemplate ? "Preparing…" : "Download Excel template"}
                </button>
                <button type="button" className="ghost" onClick={downloadCsvTemplate}>CSV instead</button>
              </div>
            </div>

            <div className="alert" style={{ marginTop: "0.75rem" }}>
              <strong>Format the Barcode column as Text before you fill it.</strong>{" "}
              Excel treats a long barcode as a number otherwise, which drops any leading zero
              and rounds anything past fifteen digits — damage done in the sheet, before the
              file gets here.{" "}
              {!picked
                ? "The Excel template above already has that column formatted, so filling it in is enough."
                : format === "xlsx"
                  ? "Reading the workbook directly avoids the other half of the problem: a barcode merely displayed as 8.85E+12 is stored exactly, and comes through intact."
                  : "Saving as CSV can also write out the displayed 8.85123E+12 in place of the real number, losing the digits that tell two products apart — uploading the .xlsx avoids that."}
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

            {plan.missingBrands.length > 0 && (
              <div className="card-body">
                <div className="alert">
                  <strong>
                    {plan.missingBrands.length} brand
                    {plan.missingBrands.length === 1 ? " is" : "s are"} not registered yet.
                  </strong>{" "}
                  A brand named in the file has to exist in Master data first, so that items
                  point at one brand rather than each carrying its own spelling of it — which is
                  how Coca-Cola, Coca Cola and COKE end up as three brands with a share of the
                  sales each. Register them, or blank the cells for products that have no brand.
                  <div style={{ margin: "0.6rem 0", display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                    {plan.missingBrands.map((b) => (
                      <span key={b} className="pill">{b}</span>
                    ))}
                  </div>
                  <button type="button" onClick={() => addBrands(plan.missingBrands)}
                          disabled={addingBrands || checking}>
                    {addingBrands ? "Adding…" : `Add ${plan.missingBrands.length} brand${plan.missingBrands.length === 1 ? "" : "s"} to Master data`}
                  </button>
                  <a href="/items/brands" className="btn ghost" style={{ marginLeft: "0.4rem" }}>
                    Manage brands
                  </a>
                </div>
              </div>
            )}

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
