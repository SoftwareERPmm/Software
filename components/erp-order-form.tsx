import Link from "next/link";
import { ArrowLeft, Printer, UserRound } from "lucide-react";
import { money, qty as fmtQty, shortDate } from "@/lib/format";
import { ErpCopyNumber } from "@/components/erp-doc-toolbar";
import { ErpMore } from "@/components/erp-more";
import type { ChainStage } from "@/components/erp-doc-shell";

/**
 * The order screen: sales and purchase orders, which are the same document
 * with buyer-side vocabulary — Customer/Vendor, Delivered/Received. Building
 * them as two screens means maintaining the same bugs twice, so the only
 * thing that varies is the config passed in.
 *
 * This is the first screen on the card layout, adopted deliberately one
 * screen at a time rather than switched on across all twelve document types
 * at once. ErpDocShell still frames everything else and is untouched; when
 * this proves itself, the frame here is what the rest move onto. Until then
 * two frames exist on purpose.
 *
 * What changed from the shell, and why:
 *
 *   The header names the document once — an icon for the type, the number,
 *   where it stands, and who it is with — instead of spreading those across a
 *   breadcrumb, a type caption and a stats row.
 *
 *   Progress is one card, not three loose tiles: the figures, the bar that
 *   reads them at a glance, and the one action they lead to. The action row
 *   used to be a flex line of buttons that a whole receiving card had been
 *   dropped into, which is why it sat where it did.
 *
 *   Correcting and cancelling moved into the overflow menu. Both are rare and
 *   one is irreversible; neither should stand at the same weight as the
 *   routine act of receiving goods.
 *
 * Two things are still shown rather than enforced, which is the pattern worth
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
  config, docId, docNo, status, partnerName, partnerCode, docDate, dueDate,
  locationName, reference, memo, lines, netTotal, chain, related,
  banner, footer, badges, fulfilActions, menuActions, openLineCount, unitWord,
  backHref, backLabel,
}: {
  config: OrderFormConfig;
  docId: string;
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
  /**
   * The related-documents panel. An order earns one as much as anything
   * downstream of it does — it is the head of the chain, and the question
   * "what came of this order" is the one the page exists to answer.
   */
  related?: React.ReactNode;
  /** Whose move it is, when somebody is late. Above the document itself. */
  banner?: React.ReactNode;
  footer?: React.ReactNode;
  /** Beside the status pill — the version, mainly. */
  badges?: React.ReactNode;
  /**
   * The one or two things to do about an order that is still owed. They sit
   * inside the progress card, under the figure they answer, rather than in a
   * button row above it.
   */
  fulfilActions?: React.ReactNode;
  /** Correcting and cancelling: rare, consequential, behind the overflow menu. */
  menuActions?: React.ReactNode;
  /** How many lines still have something outstanding. */
  openLineCount?: number;
  /** The unit the quantities are counted in — CTN, PCS. */
  unitWord?: string | null;
  /** Where the reader came from, when it was not the list. */
  backHref?: string | null;
  backLabel?: string | null;
}) {
  const totalOrdered = lines.reduce((s, l) => s + l.ordered, 0);
  const totalFulfilled = lines.reduce((s, l) => s + l.fulfilled, 0);
  const remaining = Math.max(0, Math.round((totalOrdered - totalFulfilled) * 10000) / 10000);
  const complete = totalOrdered > 0 && totalFulfilled >= totalOrdered;
  const started = totalFulfilled > 0;
  // Never rounded up to 100: a bar reading full beside a remaining figure that
  // is not zero is the one thing this card must never say.
  const pct = totalOrdered > 0
    ? (complete ? 100 : Math.min(99, Math.floor((totalFulfilled / totalOrdered) * 100)))
    : 0;

  const done = config.fulfilledLabel.toLowerCase();
  const progressWord = complete ? `Fully ${done}` : started ? `Partly ${done}` : `Not ${done}`;
  const unit = unitWord ? ` ${unitWord}` : "";
  const openLines = openLineCount ?? lines.filter((l) => l.fulfilled < l.ordered).length;

  // Two letters for the type, the way the number itself is read out loud.
  const initials = config.typeLabel.split(/\s+/).map((w) => w[0]).join("").toUpperCase();
  const currentIndex = chain.findIndex((s) => s.doc?.doc_no === docNo);

  return (
    <div data-density="odoo" className="erp-form erp-doc">
      <div className="erp-crumb">
        {backHref && (
          <>
            <Link href={backHref} className="erp-crumb-link backlink">
              <ArrowLeft size={13} aria-hidden="true" /> {backLabel ?? "Back"}
            </Link>
            <span className="erp-crumb-sep">/</span>
          </>
        )}
        <Link href={config.listHref} className="erp-crumb-link">{config.listLabel}</Link>
        <span className="erp-crumb-sep">/</span>
        <span className="erp-crumb-here">{docNo}</span>
        <ErpCopyNumber docNo={docNo} />
      </div>

      <header className="erp-head">
        <span className="erp-head-tile" aria-hidden="true">{initials}</span>
        <div className="erp-head-id">
          <div className="erp-head-line">
            <h1>{docNo}</h1>
            <span className={`pill plain ${status.toLowerCase()}`}>
              {status.charAt(0) + status.slice(1).toLowerCase()}
            </span>
            {badges}
          </div>
          <span className="erp-head-sub">
            {partnerName
              ? `${partnerName}${partnerCode ? ` · ${partnerCode}` : ""}`
              : config.typeLabel}
          </span>
        </div>
        <div className="erp-head-tools">
          <a href={`/documents/${docId}/print`} className="erp-hbtn">
            <Printer size={15} aria-hidden="true" /> Print
          </a>
          {menuActions && <ErpMore>{menuActions}</ErpMore>}
        </div>
      </header>

      {chain.length > 0 && (
        <div className="erp-pipeline" role="list" aria-label="Workflow">
          {chain.map((stage, i) => {
            const stageDone = !!stage.doc;
            const here = i === currentIndex;
            const body = (
              <>
                {stage.label}
                {stage.doc && !here && <span className="erp-stage-no">{stage.doc.doc_no}</span>}
                {!stage.doc && stage.href && <span className="erp-stage-no">create</span>}
              </>
            );
            return (
              <div key={stage.type} role="listitem"
                   className={`erp-stage ${here ? "here" : stageDone ? "done" : "todo"}${
                     !stageDone && stage.href ? " next" : ""}${
                     !stageDone && stage.optional ? " optional" : ""}`}
                   title={!stageDone && stage.optional
                     ? `${stage.label} is optional — this chain is valid without one`
                     : undefined}
                   aria-current={here ? "step" : undefined}>
                {stage.doc && !here
                  ? <Link href={`/documents/${stage.doc.id}`}>{body}</Link>
                  : !stage.doc && stage.href
                    ? <Link href={stage.href}>{body}</Link>
                    : body}
              </div>
            );
          })}
        </div>
      )}

      {banner}

      {totalOrdered > 0 && (
        <section className="erp-card">
          <div className="erp-card-head">
            <h2>{config.fulfilledLabel === "Delivered" ? "Delivery" : "Receiving"} progress</h2>
            <span className={`pill plain ${complete ? "ok" : started ? "warn" : ""}`}>
              {progressWord}
            </span>
          </div>
          <div className="erp-card-body">
            <div className="erp-figs">
              <div className="erp-fig">
                <span className="erp-fig-label">Ordered</span>
                <strong className="erp-fig-value">{fmtQty(totalOrdered)}{unit}</strong>
              </div>
              <div className="erp-fig">
                <span className="erp-fig-label">{config.fulfilledLabel}</span>
                <strong className="erp-fig-value">{fmtQty(totalFulfilled)}{unit}</strong>
              </div>
              <div className="erp-fig">
                <span className="erp-fig-label">Remaining</span>
                <strong className="erp-fig-value">{fmtQty(remaining)}{unit}</strong>
              </div>
            </div>

            <div className="erp-progress">
              <div className="erp-bar">
                <span className={`erp-bar-fill${complete ? " full" : ""}`}
                      style={{ width: `${pct}%` }} />
              </div>
              <span className="erp-bar-pct">{pct}%</span>
            </div>
            <p className="erp-bar-note">
              {fmtQty(totalFulfilled)} of {fmtQty(totalOrdered)}{unit} {done}
            </p>

            {fulfilActions && (
              <div className="erp-fulfil">
                <span className="erp-fulfil-icon" aria-hidden="true">
                  <UserRound size={20} />
                </span>
                <div className="erp-fulfil-text">
                  <strong>{partnerName ?? config.partyLabel}</strong>
                  <span>
                    {openLines} order line{openLines === 1 ? "" : "s"} awaiting{" "}
                    {config.fulfilledLabel === "Delivered" ? "delivery" : "receipt"}
                    {remaining > 0 && ` · ${fmtQty(remaining)}${unit} remaining`}
                  </span>
                </div>
                <div className="erp-fulfil-actions">{fulfilActions}</div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="erp-card">
        <div className="erp-card-head"><h2>Order details</h2></div>
        <div className="erp-card-body">
          <div className="erp-fields">
            <div>
              <dl className="erp-kv">
                <dt>{config.partyLabel}</dt>
                <dd>{partnerName ? `${partnerCode ? partnerCode + " · " : ""}${partnerName}` : "—"}</dd>
                <dt>Reference</dt>
                <dd className="m">{reference ?? "—"}</dd>
                <dt>Order date</dt>
                <dd className="m">{shortDate(docDate)}</dd>
              </dl>
            </div>
            <div>
              <dl className="erp-kv">
                <dt>Expected</dt>
                <dd className="m">{dueDate ? shortDate(dueDate) : "—"}</dd>
                <dt>Warehouse</dt>
                <dd>{locationName ?? "—"}</dd>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="erp-card">
        <div className="erp-card-head"><h2>Order items</h2></div>

        <div className="erp-scroll">
          <table className="erp-table">
            <thead>
              <tr>
                <th className="erp-th erp-lineno">#</th>
                <th className="erp-th">Item</th>
                <th className="erp-th erp-num">Ordered</th>
                <th className="erp-th erp-num">{config.fulfilledLabel}</th>
                <th className="erp-th erp-num">Remaining</th>
                <th className="erp-th erp-num">Unit price</th>
                <th className="erp-th erp-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, n) => {
                const left = Math.max(0, Math.round((l.ordered - l.fulfilled) * 10000) / 10000);
                return (
                  <tr key={l.id} className="erp-tr">
                    <td className="erp-td erp-lineno">{n + 1}</td>
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
      </section>

      {related}
      {footer}
    </div>
  );
}
