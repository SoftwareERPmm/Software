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
  lastCostDate: string | null;
  /** Empty when this item carries no consigned stock. */
  consignors: string[];
  warehouses: StockWarehouseRow[];
};

/** The page's own formatters cannot cross the boundary, so they live here. */
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const qty = (v: number) =>
  Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

const DASH = "—";

export function StockRow({ item, columnCount }: { item: StockRowItem; columnCount: number }) {
  const [open, setOpen] = useState(false);
  const consigned = item.consignors.length > 0;

  // Value divided by units, not a column anyone stores: what the FIFO layers
  // behind this item average out to. Meaningless with nothing on hand, and
  // shown as such rather than as zero.
  const averageCost = item.onHand > 0 ? item.valueOnHand / item.onHand : null;

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
                        <th className="r">Reserved</th>
                        <th className="r">Available</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.warehouses.map((w) => (
                        <tr key={w.locationId}>
                          <td className="code">{w.code}</td>
                          <td className="r">{qty(w.onHand)}</td>
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
                        <td className="r">{item.reservedQty > 0 ? qty(item.reservedQty) : DASH}</td>
                        <td className="r">{qty(item.available)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>

              <section className="stockpanel">
                <h3>Pricing</h3>
                <dl className="stockpanel-kv">
                  {/* What the last one cost, not what the ones on hand are
                      carried at — a receipt at a new price does not restate
                      the FIFO layers already on the shelf. */}
                  <div>
                    <dt>Last cost</dt>
                    <dd className="r">{item.lastCost ? money(item.lastCost) : DASH}</dd>
                  </div>
                  <div>
                    <dt>From</dt>
                    <dd>{item.lastCostDocNo ?? DASH}</dd>
                  </div>
                  <div>
                    <dt>Last cost date</dt>
                    <dd>{item.lastCostDate ?? DASH}</dd>
                  </div>
                  <div>
                    <dt>Average cost</dt>
                    <dd className="r">{averageCost === null ? DASH : money(averageCost)}</dd>
                  </div>
                  <div>
                    <dt>Value (MMK)</dt>
                    <dd className="r"><strong>{money(item.valueOnHand)}</strong></dd>
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
