"use client";

import { useActionState, useState, useTransition } from "react";
import { previewItemImport, itemImportTemplate, createMissingBrands } from "@/lib/actions";
import { FileDrop, type Upload } from "./file-drop";
import type { ActionResult } from "@/lib/actions";

type Issue = { row: number; column?: string; message: string };
type PlannedRow = {
  row: number; barcode: string; name: string; itemId: string | null; isNew: boolean;
  serial: string; code: string; serialAssigned: boolean;
  unitName: string; categoryName: string; brandName: string | null;
};
type Plan = {
  rows: PlannedRow[];
  missingBrands: string[];
  errors: Issue[];
  warnings: Issue[];
  summary: { rows: number; newItems: number; existingItems: number };
};

const TEMPLATE_HEADER = "No,Barcode,Stock ID,Stock Name,Category,Brand,Unit";
const TEMPLATE_EXAMPLE = [
  '1,8851234567890,Item001,Coca-Cola 300ml,Beverages,Coca-Cola,Bottle',
  '2,8851234567891,Item002,Sprite 300ml,Beverages,Sprite,Bottle',
  '3,10001,,T-Shirt Black L,Clothing,,Piece',
].join("\n");

export function ItemImport({ action }: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
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
          "item-import-template.xlsx"
        );
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function downloadCsvTemplate() {
    save(new Blob([`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`], { type: "text/csv;charset=utf-8" }),
         "item-import-template.csv");
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
                <span className="kpi-label">New items</span>
                <span className="kpi-value">{plan.summary.newItems}</span>
                <span className="kpi-note">created when you confirm</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Already here</span>
                <span className="kpi-value">{plan.summary.existingItems}</span>
                <span className="kpi-note">matched by barcode, left untouched</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Rows read</span>
                <span className="kpi-value">{plan.summary.rows}</span>
                <span className="kpi-note">one row per item</span>
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

            {plan.rows.length > 0 && (
              <>
                <div className="card-head" style={{ borderTop: "1px solid var(--line)" }}>
                  <h2 style={{ fontSize: "var(--t-md)" }}>Item master</h2>
                  <span className="page-sub">
                    what will exist as products — no stock and no cost until a goods receipt
                    or an opening stock adjustment gives them one. <strong>Code</strong> is the
                    identifier the item will carry: its category&rsquo;s code followed by the
                    Stock ID. A blank Stock ID is given the next number in that category.
                  </span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th><th>Barcode</th><th>Stock ID</th><th>Code</th>
                        <th>Stock name</th><th>Category</th><th>Brand</th><th>Unit</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r) => (
                        <tr key={r.barcode}>
                          <td className="code">{r.row}</td>
                          <td className="code">{r.barcode}</td>
                          <td className="code">
                            {r.serial}
                            {r.serialAssigned && (
                              <div className="subline" style={{ color: "var(--muted)" }}>assigned</div>
                            )}
                          </td>
                          <td className="code"><strong>{r.code}</strong></td>
                          <td className="wrap">{r.name}</td>
                          <td style={{ color: "var(--muted)" }}>{r.categoryName}</td>
                          <td style={{ color: "var(--muted)" }}>{r.brandName ?? "—"}</td>
                          <td className="code">{r.unitName}</td>
                          <td>
                            <span className={`pill ${r.isNew ? "" : "ok"}`}>
                              {r.isNew ? "new" : "existing"}
                            </span>
                          </td>
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
              {state && "error" in state && <div className="alert">{state.error}</div>}

              <p className="page-sub">
                {blocked
                  ? "Upload a file with no errors to continue."
                  : `Creates ${plan!.summary.newItems} item${plan!.summary.newItems === 1 ? "" : "s"}` +
                    (plan!.summary.existingItems > 0
                      ? `, leaving the ${plan!.summary.existingItems} already here as they are`
                      : "") +
                    `. Nothing is posted and no stock moves — all of it lands or none of it does.`}
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
