import Link from "next/link";
import { qty as fmtQty } from "@/lib/db";
import {
  getCompany, getItems, getLocations, getStockByLocation, getReservedQty,
  getIncomingQty, getReorderPoints, getConsumptionRate, getItemSupply, getSupplierLeadTimes,
} from "@/lib/queries";
import { AccountPicker } from "@/components/account-picker";
import { VariantTags, asVariant } from "@/components/variant-tags";
import { ItemThumb } from "@/components/item-thumb";
import { variantPhotos } from "@/lib/variants";
import { getVariantStock } from "@/lib/queries";
import { HelpHint } from "@/components/help-hint";
import { ReplenishOrderButton } from "@/components/replenish-order-button";
import { draftOrderFromReplenishment } from "@/lib/actions";
import { replenishment, type ReplenishRow } from "@/lib/replenish";

/**
 * What to buy, and by when.
 *
 * Every figure here is derived at read time from the ledger — nothing is
 * stored, and nothing is forecast. The claim is only ever "this is what has
 * been going out, this is what is left, and at that rate it runs out on this
 * date" — arithmetic somebody can check against the stock card, not a
 * prediction they have to trust.
 *
 * An item with no sales in the window makes no claim at all rather than a
 * confident zero, and is listed separately so the silence is visible.
 */

const WINDOWS = [30, 60, 90] as const;
const COVERS = [14, 30, 60] as const;

const round = (n: number) => Math.round(n * 100) / 100;

export default async function Replenishment({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; cover?: string; location?: string }>;
}) {
  const sp = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const windowDays = WINDOWS.includes(Number(sp.window) as never) ? Number(sp.window) : 30;
  const coverDays = COVERS.includes(Number(sp.cover) as never) ? Number(sp.cover) : 30;

  const [items, locations, stockByLocation, reserved, incoming, reorderPoints,
         consumption, supply, observedLead, variantStock] = await Promise.all([
    getItems(company.id) as unknown as Promise<any[]>,
    getLocations(company.id) as unknown as Promise<any[]>,
    getStockByLocation(company.id) as unknown as Promise<any[]>,
    getReservedQty(company.id) as unknown as Promise<any[]>,
    getIncomingQty(company.id) as unknown as Promise<any[]>,
    getReorderPoints(company.id) as unknown as Promise<any[]>,
    getConsumptionRate(company.id, windowDays) as unknown as Promise<any[]>,
    getItemSupply(company.id) as unknown as Promise<any[]>,
    getSupplierLeadTimes(company.id) as unknown as Promise<any[]>,
    getVariantStock(company.id) as unknown as Promise<any[]>,
  ]);

  const stockLocations = locations.filter((l) => l.is_stock_location);
  const chosen = sp.location && stockLocations.some((l) => l.id === sp.location)
    ? sp.location : "all";
  const allLocations = chosen === "all";
  const here = (locId: string) => allLocations || locId === chosen;

  // What was last paid, so the draft carries an expected price rather
  // than a column of noughts for somebody to fill in by hand.
  const lastCost = new Map<string, number>(
    (items as any[]).filter((i) => i.last_purchase_price !== null)
      .map((i) => [i.id as string, Number(i.last_purchase_price)]));

  const photos = variantPhotos(variantStock as never);
  const srcOf = (itemId: string) => {
    const v = variantStock.find((x) => x.id === itemId);
    return v ? photos.srcFor(v as never) : null;
  };

  // Only things that can actually be bought and held. A product with
  // variants is neither: its variants are what get ordered.
  const buyable = new Map(items.filter((i) => i.is_stocked && i.variant_count === 0)
                               .map((i) => [i.id as string, i]));
  const supplyOf = new Map(supply.map((s) => [s.item_id as string, s]));

  const { rows, quiet } = replenishment({
    items: [...buyable.values()] as never,
    stockByLocation: stockByLocation as never,
    reserved: reserved as never,
    incoming: incoming as never,
    reorderPoints: reorderPoints as never,
    consumption: consumption as never,
    supply: supply as never,
    observed: observedLead as never,
    windowDays, coverDays, here,
    fallbackLeadDays: company.default_lead_time_days,
  });
  type Row = ReplenishRow;

  const urgent = rows.filter((r) => r.urgency === "now").length;

  /** One purchase order per supplier is how buying actually happens. */
  const bySupplier = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.supplier ?? "\u0000none";
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), r]);
  }

  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    if (windowDays !== 30) q.set("window", String(windowDays));
    if (coverDays !== 30) q.set("cover", String(coverDays));
    if (!allLocations) q.set("location", chosen);
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) q.delete(k); else q.set(k, v);
    }
    const s = q.toString();
    return `/inventory/replenishment${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Replenishment</h1>
        <HelpHint>
          What has been going out, what is left, and how much to buy to cover
          the next stretch. Every figure is worked out from the stock ledger
          when this page loads — nothing is stored and nothing is forecast, so
          each line can be checked against the item&rsquo;s own stock card.
        </HelpHint>
      </div>

      <div className="row movefilters">
        {stockLocations.length > 1 && (
          <AccountPicker
            accounts={[{ id: "all", code: "—", name: "All warehouses" }, ...stockLocations]}
            selectedId={chosen}
            basePath="/inventory/replenishment"
            paramName="location"
            label="Warehouse"
            keep={{ window: windowDays !== 30 ? String(windowDays) : undefined,
                    cover: coverDays !== 30 ? String(coverDays) : undefined }}
          />
        )}
        <div className="field">
          <label>Sales measured over</label>
          <div className="scopetabs" style={{ margin: 0 }}>
            {WINDOWS.map((w) => (
              <Link key={w} className="scopetab" data-active={w === windowDays}
                    href={href({ window: w === 30 ? undefined : String(w) })}>
                {w} days
              </Link>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Buy enough to cover</label>
          <div className="scopetabs" style={{ margin: 0 }}>
            {COVERS.map((c) => (
              <Link key={c} className="scopetab" data-active={c === coverDays}
                    href={href({ cover: c === 30 ? undefined : String(c) })}>
                {c} days
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">To order</span>
            <span className="kpi-value">{rows.length}</span>
            <span className="kpi-note">
              item{rows.length === 1 ? "" : "s"} short of {coverDays} days&rsquo; cover
            </span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Order today</span>
            <span className="kpi-value" style={{ color: urgent > 0 ? "var(--bad)" : undefined }}>
              {urgent}
            </span>
            <span className="kpi-note">
              will run out before a new order could arrive
            </span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">No sales to go on</span>
            <span className="kpi-value">{quiet.length}</span>
            <span className="kpi-note">
              below a reorder point with nothing sold in {windowDays} days
            </span>
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          Nothing needs ordering for the next {coverDays} days, measured on the
          last {windowDays}.
        </div>
      ) : (
        [...bySupplier.entries()].map(([key, list]) => (
          <section key={key}>
            <div className="card">
              <div className="card-head">
                <h2>{key === "\u0000none" ? "No supplier on record" : key}</h2>
                <span className="page-sub">
                  {list.length} item{list.length === 1 ? "" : "s"}
                  {/* Measured belongs to the supplier, so it is said once
                      here. Expected can differ item by item, so it has a
                      column of its own. */}
                  {list[0].measuredDays !== null &&
                    ` · actually taking ${list[0].measuredDays} day${
                      list[0].measuredDays === 1 ? "" : "s"} over ${
                      list[0].measuredSample} receipt${
                      list[0].measuredSample === 1 ? "" : "s"}`}
                </span>
              </div>

              {key === "\u0000none" && (
                <div className="card-body" style={{ paddingBottom: 0 }}>
                  <span className="page-sub">
                    Nothing has been bought from anybody for these, so the
                    company default of {list[0].leadTime} days is assumed.
                  </span>
                </div>
              )}

              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th colSpan={2}>Item</th>
                      <th className="r">On hand</th>
                      <th className="r">Reserved</th>
                      <th className="r">Incoming</th>
                      <th className="r">Per day</th>
                      <th className="r">Lead</th>
                      <th className="r">Runs out in</th>
                      <th>Order by</th>
                      <th className="r">Suggest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id}>
                        <td className="vgroup-thumb">
                          <ItemThumb src={srcOf(r.id)} name={r.name} />
                        </td>
                        <td className="wrap">
                          <span className="m">{r.code}</span>
                          <div className="subline">
                            {r.name}
                            <VariantTags variant={asVariant(r.variant)}
                                         className="vartags-inline" />
                          </div>
                        </td>
                        <td className="r">{fmtQty(String(r.onHand))}</td>
                        <td className="r" style={{ color: r.reserved > 0 ? "var(--warn)" : undefined }}>
                          {r.reserved > 0 ? fmtQty(String(r.reserved)) : "—"}
                        </td>
                        <td className="r" style={{ color: r.incoming > 0 ? "var(--ok)" : undefined }}>
                          {r.incoming > 0 ? fmtQty(String(r.incoming)) : "—"}
                        </td>
                        <td className="r">{r.perDay}</td>
                        <td className="r">
                          <span title={
                            r.leadSource === "item" ? "Set on this item from this supplier"
                            : r.leadSource === "supplier" ? "This supplier's usual lead time"
                            : "Company default — nothing set for this supplier"}>
                            {r.leadTime} d
                          </span>
                          {r.leadSource === "item" && (
                            <span className="page-sub"> item</span>
                          )}
                          {/* Never acted on, only raised. The figure above
                              is what somebody configured and it stays that
                              way until they change it. */}
                          {r.reviewSuggested && (
                            <div className="subline" style={{ color: "var(--warn)" }}>
                              actually {r.measuredDays} d — review
                            </div>
                          )}
                        </td>
                        <td className="r">
                          {r.daysLeft === null ? "—" : `${Math.floor(r.daysLeft)} d`}
                        </td>
                        <td>
                          <span className={`pill ${
                            r.urgency === "now" ? "overdue" : r.urgency === "soon" ? "warn" : ""}`}>
                            {r.urgency === "now" ? "today" : r.orderBy ?? "—"}
                          </span>
                        </td>
                        <td className="r">
                          <strong>{fmtQty(String(r.suggest))}</strong>{" "}
                          <span className="page-sub">{r.uom}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card-body">
                <ReplenishOrderButton
                  action={draftOrderFromReplenishment}
                  supplierId={list[0].supplierId}
                  supplierName={key === "\u0000none" ? "no supplier" : key}
                  lines={list.map((r) => ({
                    itemId: r.id, qty: r.suggest,
                    unitPrice: lastCost.get(r.id) ?? undefined,
                    // Frozen onto the draft line, so a later change to the
                    // supplier's settings cannot restate what this order
                    // was expecting when it was drafted.
                    leadDays: r.leadTime, leadSource: r.leadSource,
                  }))}
                />
                <span className="page-sub" style={{ marginLeft: "0.6rem" }}>
                  Puts these {list.length} line{list.length === 1 ? "" : "s"} on a
                  draft order you can edit before posting.
                </span>
              </div>
            </div>
          </section>
        ))
      )}

      {quiet.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Below a reorder point, but nothing sold</h2>
              <span className="page-sub">
                no issues in {windowDays} days, so there is no rate to work from
              </span>
            </div>
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <span className="page-sub">
                These are short of the minimum somebody set, but the suggestion
                above is built from what actually sells and these have sold
                nothing. Judgement, not arithmetic.
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Code</th><th>Item</th><th className="r">Short by</th></tr>
                </thead>
                <tbody>
                  {quiet.map((q) => (
                    <tr key={q.code}>
                      <td className="code">{q.code}</td>
                      <td className="wrap">
                        {q.name}
                        <VariantTags variant={asVariant(q.variant)} className="vartags-inline" />
                      </td>
                      <td className="r">{fmtQty(String(q.short))} {q.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
