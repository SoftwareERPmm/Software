"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Home, Users } from "lucide-react";

/**
 * One item's stock position, with the detail folded underneath it.
 *
 * Twelve columns is what this table needs and more than a row can carry
 * legibly, so the ones a person reads at a glance stay up top — what is on
 * hand, what is spoken for, what it is worth — and the rest waits behind a
 * chevron. Where the stock actually sits and what it cost are questions about
 * one item, asked one item at a time; as columns they would be read once and
 * then squeeze the eleven figures beside them for the rest of the day.
 *
 * Nothing here is fetched when it opens. Every figure was already on the page
 * — this is a disclosure, not a lookup, so opening a row cannot fail, cannot
 * spin, and cannot disagree with the row it came from.
 */

export type StockWarehouseRow = {
  locationId: string;
  code: string;
  name: string;
  onHand: number;
  /** Held here but owned by a consignor. Never part of onHand. */
  consigned: number;
  reserved: number;
};

export type StockRowItem = {
  id: string;
  code: string;
  name: string;
  nameMy: string | null;
  itemGroupId: string;
  category: string;
  uomCode: string;
  barcode: string | null;
  brandName: string | null;
  onHand: number;
  consignedQty: number;
  reservedQty: number;
  available: number;
  incomingQty: number;
  projected: number;
  valueOnHand: number;
  lastCost: string | null;
  lastCostDocNo: string | null;
  lastCostDocId: string | null;
  lastCostDate: string | null;
  /** Empty when this item carries no consigned stock. */
  consignors: string[];
  warehouses: StockWarehouseRow[];
  /** One row per batch per warehouse, earliest expiry first. Empty for an
   *  item that keeps no lots, and for a tracked item whose only stock came
   *  in before tracking was switched on. */
  batches: {
    locationCode: string;
    batchNo: string | null;
    expiryDate: string | null;
    daysLeft: number | null;
    qty: number;
  }[];
  tracksBatch: boolean;
  tracksExpiry: boolean;
};

/** The page's own formatters cannot cross the boundary, so they live here. */
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const qty = (v: number) =>
  Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

const DASH = "—";

/** Near enough to worry about. Ninety days is a buying decision for a
 *  distributor — long enough to move the stock, short enough that nobody
 *  should be surprised by it later. */
const EXPIRING_DAYS = 90;

export function StockRow(
  { item, columnCount, showConsigned }:
  { item: StockRowItem; columnCount: number; showConsigned: boolean }
) {
  const [open, setOpen] = useState(false);
  const consigned = item.consignors.length > 0;
  // Only where there is some: a fifth column of dashes on a 380px panel costs
  // more than it tells anyone.
  const anyConsigned = item.warehouses.some((w) => w.consigned > 0);

  // Value divided by units, not a column anyone stores: what the FIFO layers
  // behind this item average out to. Meaningless with nothing on hand, and
  // shown as such rather than as zero.
  const averageCost = item.onHand > 0 ? item.valueOnHand / item.onHand : null;

  // Counted here rather than passed in: the row already has every batch, and
  // a figure computed in two places is a figure that will disagree with
  // itself eventually.
  const expired = item.batches.filter((b) => b.daysLeft !== null && b.daysLeft < 0).length;
  const expiringSoon = item.batches.filter(
    (b) => b.daysLeft !== null && b.daysLeft >= 0 && b.daysLeft <= EXPIRING_DAYS).length;

  return (
    <>
      <tr className="stockrow" data-open={open || undefined}>
        <td className="expandcell">
          <button
            type="button"
            className="rowexpand"
            aria-expanded={open}
            aria-label={open ? `Hide details for ${item.name}` : `Show details for ${item.name}`}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </td>

        <td className="code codecell">
          <Link href={`/items/categories/${item.itemGroupId}`} style={{ color: "var(--brand)" }}>
            {item.code}
          </Link>
        </td>

        <td className="wrap">
          {item.name}
          {item.nameMy && <div className="subline">{item.nameMy}</div>}
        </td>

        <td>
          {consigned ? (
            <>
              <Link href="/inventory/consignment" className="ownpill" data-kind="consigned">
                <Users size={11} aria-hidden="true" />
                Consignment
              </Link>
              {/* Whose it is, under the badge rather than inside it: one
                  consignor's name is short and three are not, and a cell that
                  grows with the data squeezes eleven figures beside it. */}
              <div className="subline">{item.consignors.join(", ")}</div>
            </>
          ) : (
            <span className="ownpill" data-kind="owned">
              <Home size={11} aria-hidden="true" />
              Company-owned
            </span>
          )}
        </td>

        <td className="catcell" style={{ color: "var(--muted)" }}>{item.category}</td>
        <td className="code">{item.uomCode}</td>
        <td className="r">{qty(item.onHand)}</td>
        {/* Held but not owned, so it is deliberately absent from On hand and
            from Value — a consignor's goods are not the company's stock and
            must not be counted as either. Without a column of its own the
            quantity had nowhere to appear at all: a row with twelve units on
            the shelf read as zero of everything, which is worse than not
            listing it.

            Only where the company holds consigned goods at all. A trading
            company that has never taken any would otherwise carry a thirteenth
            column of dashes, and thirteen is the width at which this table
            stops fitting. */}
        {showConsigned && (
          <td className="r">
            {item.consignedQty > 0 ? (
              <Link href="/inventory/consignment" style={{ color: "var(--brand)" }}>
                {qty(item.consignedQty)}
              </Link>
            ) : DASH}
          </td>
        )}
        <td className="r" style={{ color: item.reservedQty > 0 ? "var(--warn)" : undefined }}>
          {item.reservedQty > 0 ? qty(item.reservedQty) : DASH}
        </td>
        <td className="r" style={{ fontWeight: 600 }}>{qty(item.available)}</td>
        <td className="r" style={{ color: item.incomingQty > 0 ? "var(--ok)" : undefined }}>
          {item.incomingQty > 0 ? qty(item.incomingQty) : DASH}
        </td>
        <td className="r">{qty(item.projected)}</td>
        <td className="r">{money(item.valueOnHand)}</td>
      </tr>

      {open && (
        <tr className="stockdetail-row">
          <td colSpan={columnCount}>
            <div className="stockdetail">
              <section className="stockpanel">
                <h3>Item details</h3>
                <dl className="stockpanel-kv">
                  <div><dt>Item code</dt><dd className="code">{item.code}</dd></div>
                  <div><dt>Item name</dt><dd>{item.name}</dd></div>
                  <div><dt>Category</dt><dd>{item.category}</dd></div>
                  <div><dt>Unit</dt><dd className="code">{item.uomCode}</dd></div>
                  <div><dt>Brand</dt><dd>{item.brandName ?? DASH}</dd></div>
                  <div><dt>Barcode</dt><dd className="code">{item.barcode ?? DASH}</dd></div>
                </dl>
              </section>

              <section className="stockpanel">
                <h3>Stock by warehouse</h3>
                {item.warehouses.length === 0 ? (
                  <p className="hint">This item has never been held anywhere.</p>
                ) : (
                  <table className="stockpanel-table">
                    <thead>
                      <tr>
                        <th>Warehouse</th>
                        <th className="r">On hand</th>
                        {anyConsigned && <th className="r">Consigned</th>}
                        <th className="r">Reserved</th>
                        <th className="r">Available</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.warehouses.map((w) => (
                        <tr key={w.locationId}>
                          <td className="code">{w.code}</td>
                          <td className="r">{qty(w.onHand)}</td>
                          {anyConsigned && (
                            <td className="r">{w.consigned > 0 ? qty(w.consigned) : DASH}</td>
                          )}
                          <td className="r" style={{ color: w.reserved > 0 ? "var(--warn)" : undefined }}>
                            {w.reserved > 0 ? qty(w.reserved) : DASH}
                          </td>
                          <td className="r">{qty(w.onHand - w.reserved)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Reserved is company-wide per item and location, so the
                        total is the item's own figure rather than the sum of
                        what happens to be listed above. */}
                    <tfoot>
                      <tr>
                        <td>Total</td>
                        <td className="r">{qty(item.onHand)}</td>
                        {anyConsigned && (
                          <td className="r">{qty(item.consignedQty)}</td>
                        )}
                        <td className="r">{item.reservedQty > 0 ? qty(item.reservedQty) : DASH}</td>
                        <td className="r">{qty(item.available)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>

              {/* Batches, where the item keeps them. Expiry is read here
                  rather than on the dashboard: most of a distributor's
                  catalogue never expires, and a company-wide alert about
                  something only some items do would be noise on every other
                  screen. The place to notice a short-dated batch is the
                  place you are already looking at that item's stock. */}
              {item.tracksBatch && (
                <section className="stockpanel stockpanel-wide">
                  <h3>
                    Batches on hand
                    {expiringSoon > 0 && (
                      <span className="pill warn" style={{ marginLeft: "0.5rem" }}>
                        {expiringSoon} expiring
                      </span>
                    )}
                    {expired > 0 && (
                      <span className="pill overdue" style={{ marginLeft: "0.4rem" }}>
                        {expired} expired
                      </span>
                    )}
                  </h3>
                  {item.batches.length === 0 ? (
                    <div className="empty">
                      Nothing batched on hand.
                      {item.onHand > 0 && " What is here arrived before batches were tracked."}
                    </div>
                  ) : (
                    <table className="stockpanel-table">
                      <thead>
                        <tr>
                          <th>Batch</th>
                          <th>Warehouse</th>
                          {item.tracksExpiry && <th>Expires</th>}
                          <th className="r">On hand</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.batches.map((b, i) => {
                          const d = b.daysLeft;
                          const state = d === null ? null
                            : d < 0 ? "expired"
                            : d <= EXPIRING_DAYS ? "soon" : null;
                          return (
                            <tr key={`${b.batchNo}-${b.locationCode}-${i}`}>
                              <td className="code">{b.batchNo ?? DASH}</td>
                              <td className="code">{b.locationCode}</td>
                              {item.tracksExpiry && (
                                <td className="code">
                                  {b.expiryDate ?? DASH}
                                  {state === "expired" && (
                                    <span className="pill overdue" style={{ marginLeft: "0.4rem" }}>
                                      {Math.abs(d as number)}d ago
                                    </span>
                                  )}
                                  {state === "soon" && (
                                    <span className="pill warn" style={{ marginLeft: "0.4rem" }}>
                                      {d}d left
                                    </span>
                                  )}
                                </td>
                              )}
                              <td className="r">{qty(b.qty)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {item.tracksExpiry && item.batches.length > 1 && (
                    <div className="hint">
                      Sold earliest-expiry first, so {item.batches[0].batchNo} leaves before the rest.
                    </div>
                  )}
                </section>
              )}

              <section className="stockpanel">
                <h3>Pricing</h3>
                {/* The last price paid, the bill it was paid on, and what the
                    units actually on the shelf cost.

                    The invoice is the part worth having here: a cost figure
                    with no provenance invites being read as "the" cost, and
                    the answer to "says who?" is one click away rather than a
                    number to go looking for. Last against Average is the other
                    half — average below last means the shelf is cheaper than
                    replacing it, and the margin on these units is not the
                    margin on the next ones.

                    Value is deliberately absent: it is the last column of the
                    row this panel opened from, two inches above. */}
                <dl className="stockpanel-kv">
                  <div>
                    <dt>Latest purchase price</dt>
                    <dd className="r">{item.lastCost ? money(item.lastCost) : DASH}</dd>
                  </div>
                  <div>
                    <dt>From invoice</dt>
                    <dd>
                      {item.lastCostDocNo
                        ? (item.lastCostDocId
                            ? <Link href={`/documents/${item.lastCostDocId}`}
                                    style={{ color: "var(--brand)" }}>{item.lastCostDocNo}</Link>
                            : item.lastCostDocNo)
                        : DASH}
                    </dd>
                  </div>
                  <div>
                    <dt>Invoice date</dt>
                    <dd>{item.lastCostDate ?? DASH}</dd>
                  </div>
                  <div>
                    <dt>Average cost</dt>
                    <dd className="r">{averageCost === null ? DASH : money(averageCost)}</dd>
                  </div>
                </dl>
                {consigned && (
                  <p className="hint">
                    Consigned units are held but not owned, so they carry no value here.
                  </p>
                )}
              </section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
