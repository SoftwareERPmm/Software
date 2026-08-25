import Link from "next/link";
import { money, qty as fmtQty, shortDate } from "@/lib/format";

/**
 * The transaction-document form: breadcrumb, action row with a chevron
 * pipeline, a sheet of header fields, a line grid, and totals.
 *
 * Sales and purchase orders render through this one component. They are the
 * same document with buyer-side vocabulary — Customer/Vendor,
 * Delivered/Received — and the reference patterns make the point that
 * building them as two screens means maintaining the same bugs twice. The
 * only thing that varies is the config passed in.
 *
 * Two things are shown rather than enforced here, which is the pattern worth
 * copying: a stage that has not happened is dimmed instead of hidden, so the
 * shape of the workflow is visible from any point in it; and a line that is
 * fully fulfilled loses its "remaining" figure rather than showing a zero to
 * be read past.
 */

export type OrderLine = {
  id: string;
  itemCode: string;
  itemName: string;
  itemNameMy: string | null;
  uomCode: string | null;
  ordered: number;
  fulfilled: number;
  unitPrice: number;
  netAmount: number;
};

export type ChainStage = {
  type: string;
  label: string;
  doc: { id: string; doc_no: string } | null;
};

export type OrderFormConfig = {
  /** "Sales Order" / "Purchase Order" — the type name above the number. */
  typeLabel: string;
  /** "Customer" / "Vendor" */
  partyLabel: string;
  /** "Delivered" / "Received" — the fulfilment column header. */
  fulfilledLabel: string;
  /** Where the breadcrumb goes back to. */
  listHref: string;
  listLabel: string;
};

export function ErpOrderForm({
  config, docNo, status, partnerName, partnerCode, docDate, dueDate,
  locationName, reference, memo, lines, netTotal, chain, actions,
}: {
  config: OrderFormConfig;
  docNo: string;
  status: string;
  partnerName: string | null;
  partnerCode: string | null;
  docDate: string;
  dueDate: string | null;
  locationName: string | null;
  reference: string | null;
  memo: string | null;
  lines: OrderLine[];
  netTotal: number;
  chain: ChainStage[];
  /** Rendered left of the pipeline, the way the reference puts workflow actions there. */
  actions?: React.ReactNode;
}) {
  const totalOrdered = lines.reduce((s, l) => s + l.ordered, 0);
  const totalFulfilled = lines.reduce((s, l) => s + l.fulfilled, 0);
  const complete = totalOrdered > 0 && totalFulfilled >= totalOrdered;

  // The stage this document is, and everything the chain has actually
  // produced — a stage with no document behind it is dimmed, not dropped.
  const currentIndex = chain.findIndex((s) => s.doc?.doc_no === docNo);

  return (
    <div data-density="odoo" className="erp-form">
      {/* ---- breadcrumb ------------------------------------------------- */}
      <div className="erp-crumb">
        <Link href={config.listHref} className="erp-crumb-link">{config.listLabel}</Link>
        <span className="erp-crumb-sep">/</span>
        <span className="erp-crumb-here">{docNo}</span>
      </div>

      {/* ---- actions + pipeline ----------------------------------------- */}
      <div className="erp-actionbar">
        <div className="erp-actions">{actions}</div>
        <div className="erp-pipeline" role="list" aria-label="Workflow">
          {chain.map((stage, i) => {
            const done = !!stage.doc;
            const here = i === currentIndex;
            const cls = here ? "here" : done ? "done" : "todo";
            const body = (
              <>
                {stage.label}
                {stage.doc && !here && (
                  <span className="erp-stage-no">{stage.doc.doc_no}</span>
                )}
              </>
            );
            return (
              <div key={stage.type} role="listitem"
                   className={`erp-stage ${cls}`}
                   aria-current={here ? "step" : undefined}>
                {stage.doc && !here
                  ? <Link href={`/documents/${stage.doc.id}`}>{body}</Link>
                  : body}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- the sheet --------------------------------------------------- */}
      <div className="erp-sheet-page">
        <div className="erp-doc-title">
          <span className="erp-doc-type">{config.typeLabel}</span>
          <h1>{docNo}</h1>
          <span className={`pill ${status.toLowerCase()}`}>{status}</span>
          {totalOrdered > 0 && (
            <span className={`pill ${complete ? "ok" : "warn"}`}>
              {complete
                ? `Fully ${config.fulfilledLabel.toLowerCase()}`
                : `${fmtQty(totalFulfilled)} of ${fmtQty(totalOrdered)} ${config.fulfilledLabel.toLowerCase()}`}
            </span>
          )}
        </div>

        <div className="erp-fields">
          <div>
            <dl className="erp-kv">
              <dt>{config.partyLabel}</dt>
              <dd>{partnerName ? `${partnerCode ? partnerCode + " · " : ""}${partnerName}` : "—"}</dd>
              <dt>Reference</dt>
              <dd className="m">{reference ?? "—"}</dd>
            </dl>
          </div>
          <div>
            <dl className="erp-kv">
              <dt>Order date</dt>
              <dd className="m">{shortDate(docDate)}</dd>
              <dt>Expected</dt>
              <dd className="m">{dueDate ? shortDate(dueDate) : "—"}</dd>
              <dt>Warehouse</dt>
              <dd>{locationName ?? "—"}</dd>
            </dl>
          </div>
        </div>

        <div className="erp-tabs"><span className="erp-tab here">Lines</span></div>

        <div className="erp-scroll">
          <table className="erp-table">
            <thead>
              <tr>
                <th className="erp-th">Item</th>
                <th className="erp-th erp-num">Ordered</th>
                <th className="erp-th erp-num">{config.fulfilledLabel}</th>
                <th className="erp-th erp-num">Remaining</th>
                <th className="erp-th erp-num">Unit price</th>
                <th className="erp-th erp-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const left = Math.max(0, Math.round((l.ordered - l.fulfilled) * 10000) / 10000);
                return (
                  <tr key={l.id} className="erp-tr">
                    <td className="erp-td erp-item">
                      <span className="erp-item-code">{l.itemCode}</span>
                      <span className="erp-item-name">{l.itemName}</span>
                      {l.itemNameMy && <span className="erp-item-my name-my">{l.itemNameMy}</span>}
                    </td>
                    <td className="erp-td erp-num">
                      {fmtQty(l.ordered)}
                      {l.uomCode && <span className="erp-uom">{l.uomCode}</span>}
                    </td>
                    <td className="erp-td erp-num">
                      {l.fulfilled > 0
                        ? fmtQty(l.fulfilled)
                        : <span style={{ color: "var(--erp-fg-muted)" }}>—</span>}
                    </td>
                    <td className="erp-td erp-num">
                      {left > 0
                        ? <strong>{fmtQty(left)}</strong>
                        : <span style={{ color: "var(--erp-fg-muted)" }}>—</span>}
                    </td>
                    <td className="erp-td erp-num">{money(l.unitPrice)}</td>
                    <td className="erp-td erp-num">{money(l.netAmount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="erp-foot">
          <div className="erp-memo">{memo ?? ""}</div>
          <dl className="erp-totals">
            <dt>Untaxed</dt><dd>{money(netTotal)}</dd>
            <dt className="grand">Total</dt><dd className="grand">{money(netTotal)}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
