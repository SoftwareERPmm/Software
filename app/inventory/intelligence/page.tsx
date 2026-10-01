import Link from "next/link";
import { money, qty as fmtQty, shortDate } from "@/lib/db";
import {
  getCompany, getVariantProfitability, getVariantStock, getInventoryAging,
  getMatchedProfitability, getLocations,
} from "@/lib/queries";
import { AccountPicker } from "@/components/account-picker";
import { VariantTags, asVariant } from "@/components/variant-tags";
import { ItemThumb } from "@/components/item-thumb";
import { variantPhotos } from "@/lib/variants";
import { HelpHint } from "@/components/help-hint";

/**
 * What the stock is doing for the business, as against where it is.
 *
 * Two questions that share a page because they are the same conversation:
 * which products earn their shelf space, and which have been sitting on it.
 * Neither belongs on the stock screens — those answer "what have I got",
 * and a manager deciding what to buy and what to discount is asking
 * something else.
 *
 * Every figure is derived at read time and ties to the ledger. Nothing here
 * is a stored metric, so nothing here can drift from the books.
 */

const TABS = [
  { key: "matched", label: "Profitability" },
  { key: "period", label: "Revenue vs COGS" },
  { key: "aging", label: "Inventory aging" },
] as const;

/**
 * Whether any row in this table has a picture at all.
 *
 * The thumbnail column is 25px of nothing in a catalogue nobody has
 * photographed, and a column of empty boxes reads as a page that failed to
 * load rather than as a catalogue without photos. When one row has a photo
 * the column earns its place for all of them; when none does, it goes.
 */
const anyPhoto = (ids: string[], srcOf: (id: string) => string | null) =>
  ids.some((id) => srcOf(id) !== null);

/** Only a real date gets through; anything else is treated as not set. */
const asDate = (v: string | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/**
 * Where a figure came from.
 *
 * The stock card is the right destination for all three reports: it is the
 * ledger these are summaries of, so "why is this number what it is" is
 * answered by the rows behind it rather than by another summary.
 */
function ItemLink({ id, code }: { id: string; code: string }) {
  return (
    <Link href={`/inventory/movements?item=${id}`} className="m"
          style={{ color: "var(--brand)" }} title="Stock movements for this item">
      {code}
    </Link>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default async function InventoryIntelligence({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string;
                          location?: string }>;
}) {
  const sp = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "matched";

  const locations = (await getLocations(company.id)) as unknown as any[];
  const warehouses = locations.filter((l) => l.is_stock_location);
  const chosen = sp.location && warehouses.some((l) => l.id === sp.location)
    ? sp.location : "all";
  const locationId = chosen === "all" ? null : chosen;

  const exportHref = (() => {
    const q = new URLSearchParams();
    q.set("tab", tab);
    if (asDate(sp.from)) q.set("from", sp.from!);
    if (asDate(sp.to)) q.set("to", sp.to!);
    if (locationId) q.set("location", locationId);
    return `/inventory/intelligence/export?${q.toString()}`;
  })();

  /*
   * A year to today, unless asked otherwise. Long enough that a seasonal
   * product is not judged on a quiet fortnight.
   *
   * The end is clamped to today and never accepts a future date. Nothing in
   * the ledger is dated ahead — the movement trigger from 0102 refuses it —
   * so a range running into next year adds nothing but a figure somebody
   * might read as a forecast. When a later date is asked for, the page says
   * it was pulled back rather than silently using a different window than
   * the one on screen.
   */
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const asked = asDate(sp.to);
  const clamped = asked !== null && asked > todayIso;
  // Exclusive upper bound, so "to today" includes everything posted today.
  const toShown = clamped || asked === null ? todayIso : asked;
  const to = new Date(new Date(toShown).getTime() + 86400000).toISOString().slice(0, 10);
  const from = asDate(sp.from)
    ?? new Date(today.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  const href = (t: string) => {
    const q = new URLSearchParams();
    if (t !== "matched") q.set("tab", t);
    if (asDate(sp.from)) q.set("from", sp.from!);
    if (asDate(sp.to)) q.set("to", sp.to!);
    if (locationId) q.set("location", locationId);
    const s = q.toString();
    return `/inventory/intelligence${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Inventory intelligence</h1>
        <HelpHint>
          Which products earn their shelf space, and which have been sitting
          on it. Worked out from the ledger when this page loads — the
          revenue is what the invoices say and the cost is what the stock
          ledger released, so both tie to the profit and loss exactly.
        </HelpHint>
      </div>

      <div className="scopetabs viewtabs">
        {TABS.map((t) => (
          <Link key={t.key} className="scopetab" data-active={tab === t.key}
                href={href(t.key)}>
            {t.label}
          </Link>
        ))}
      </div>

      <div className="filterbar">
        {warehouses.length > 1 && (
          <AccountPicker
            accounts={[{ id: "all", code: "\u2014", name: "All warehouses" }, ...warehouses]}
            selectedId={chosen}
            basePath="/inventory/intelligence"
            paramName="location"
            label="Warehouse"
            keep={{ tab: tab === "matched" ? undefined : tab,
                    from: asDate(sp.from) ?? undefined,
                    to: asDate(sp.to) ?? undefined }}
          />
        )}
      {tab !== "aging" && (
      <form method="get" action="/inventory/intelligence" className="daterange">
        {tab !== "matched" && <input type="hidden" name="tab" value={tab} />}
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={from}
                 max={todayIso} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={toShown}
                 max={todayIso} />
          {clamped && (
            <span className="hint" style={{ color: "var(--warn)" }}>
              pulled back to today — nothing is posted ahead
            </span>
          )}
        </div>
        {locationId && <input type="hidden" name="location" value={locationId} />}
        <button type="submit" className="btn ghost">Apply</button>
      </form>
      )}

        {/* The same queries, as a file — so it cannot disagree with the
            screen it was downloaded from. */}
        <div className="field exportfield">
          <label>&nbsp;</label>
          <Link className="btn ghost" href={exportHref}>Export CSV</Link>
        </div>
      </div>

      {tab === "matched" ? <Matched companyId={company.id} from={from} to={to} shown={toShown}
                  locationId={locationId} />
       : tab === "period" ? <Profitability companyId={company.id} from={from} to={to}
                  shown={toShown} locationId={locationId} />
       : <Aging companyId={company.id} locationId={locationId} />}
    </>
  );
}

async function Profitability({
  companyId, from, to, shown, locationId,
}: { companyId: string; from: string; to: string; shown: string;
     locationId: string | null }) {
  const [rows, variantStock] = await Promise.all([
    getVariantProfitability(companyId, from, to, locationId) as unknown as Promise<any[]>,
    getVariantStock(companyId) as unknown as Promise<any[]>,
  ]);

  const photos = variantPhotos(variantStock as never);
  const srcOf = (id: string) => {
    const v = variantStock.find((x) => x.id === id);
    return v ? photos.srcFor(v as never) : null;
  };
  const showThumbs = anyPhoto(rows.map((r: any) => r.id), srcOf);

  const revenue = rows.reduce((t, r) => t + Number(r.revenue), 0);
  const cogs = rows.reduce((t, r) => t + Number(r.cogs), 0);
  const margin = revenue - cogs;

  /**
   * Billed and shipped in different windows.
   *
   * Revenue is recognised by the invoice and cost by the delivery, and the
   * two are not always the same document or even the same month. Counted
   * and said out loud, because a margin computed across a mismatch is not
   * wrong so much as answering a slightly different question.
   */
  const mismatched = rows.filter(
    (r) => Math.abs(Number(r.qty_sold) - Number(r.qty_shipped)) > 0.0001).length;

  if (rows.length === 0) {
    return (
      <div className="empty">
        Nothing was sold or shipped in that period.
      </div>
    );
  }

  return (
    <>
      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Revenue</span>
            <span className="kpi-value">{money(revenue)}</span>
            <span className="kpi-note">invoiced in this period</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Cost of goods</span>
            <span className="kpi-value">{money(cogs)}</span>
            <span className="kpi-note">released by the stock ledger</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Gross margin</span>
            <span className="kpi-value" style={{ color: margin < 0 ? "var(--bad)" : undefined }}>
              {money(margin)}
            </span>
            <span className="kpi-note">
              {revenue > 0 ? `${pct(margin / revenue)} of revenue` : "no revenue"}
            </span>
          </span>
        </div>
      </div>

      {mismatched > 0 && (
        <div className="card" style={{ marginBottom: "var(--s3)" }}>
          <div className="card-body">
            <strong>{mismatched} item{mismatched === 1 ? "" : "s"} billed and shipped
            in different quantities this period.</strong>
            <div className="page-sub" style={{ marginTop: "0.3rem" }}>
              An invoice recognises the revenue and a delivery releases the
              cost, and they need not fall in the same window — goods shipped
              but not yet billed show a cost with no revenue against it, and
              the margin on that row reads worse than the trade really was.
              The quantities are shown so the gap is visible.
            </div>
          </div>
        </div>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>By item</h2>
            <span className="page-sub">
              {shortDate(from)} to {shortDate(shown)} · ties to Sales and Cost of
              goods sold in the ledger
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th colSpan={showThumbs ? 2 : 1}>Item</th>
                  <th className="r">Sold</th>
                  <th className="r">Revenue</th>
                  <th className="r">Shipped</th>
                  <th className="r">Cost</th>
                  <th className="r">Margin</th>
                  <th className="r">%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rev = Number(r.revenue);
                  const m = Number(r.margin);
                  const gap = Math.abs(Number(r.qty_sold) - Number(r.qty_shipped)) > 0.0001;
                  return (
                    <tr key={r.id}>
                      {showThumbs && (
                        <td className="vgroup-thumb">
                          <ItemThumb src={srcOf(r.id)} name={r.name} />
                        </td>
                      )}
                      <td className="wrap">
                        <ItemLink id={r.id} code={r.code} />
                        <div className="subline">
                          {r.name}
                          <VariantTags variant={asVariant(r.variant)} className="vartags-inline" />
                        </div>
                      </td>
                      <td className="r">{fmtQty(String(r.qty_sold))}</td>
                      <td className="r">{money(rev)}</td>
                      <td className="r" style={{ color: gap ? "var(--warn)" : undefined }}>
                        {fmtQty(String(r.qty_shipped))}
                        {gap && <div className="subline">not the same</div>}
                      </td>
                      <td className="r">{money(Number(r.cogs))}</td>
                      <td className="r" style={{ color: m < 0 ? "var(--bad)" : undefined }}>
                        <strong>{money(m)}</strong>
                      </td>
                      <td className="r" style={{ color: m < 0 ? "var(--bad)" : undefined }}>
                        {rev > 0 ? pct(m / rev) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={showThumbs ? 3 : 2}><strong>Total</strong></td>
                  <td className="r"><strong>{money(revenue)}</strong></td>
                  <td />
                  <td className="r"><strong>{money(cogs)}</strong></td>
                  <td className="r"><strong>{money(margin)}</strong></td>
                  <td className="r">
                    <strong>{revenue > 0 ? pct(margin / revenue) : "—"}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

async function Aging({
  companyId, locationId,
}: { companyId: string; locationId: string | null }) {
  const [rows, variantStock] = await Promise.all([
    getInventoryAging(companyId, locationId) as unknown as Promise<any[]>,
    getVariantStock(companyId) as unknown as Promise<any[]>,
  ]);

  const photos = variantPhotos(variantStock as never);
  const srcOf = (id: string) => {
    const v = variantStock.find((x) => x.id === id);
    return v ? photos.srcFor(v as never) : null;
  };
  const showThumbs = anyPhoto(rows.map((r: any) => r.id), srcOf);

  if (rows.length === 0) {
    return <div className="empty">Nothing is in stock, so nothing is aging.</div>;
  }

  const total = rows.reduce((t, r) => t + Number(r.value), 0);
  const n = (r: any, k: string) => Number(r[k] ?? 0);
  const bucket = (k: string) => rows.reduce((t, r) => t + n(r, k), 0);
  /** Over ninety days is the conventional line for "this is not moving". */
  const slow = bucket("v90") + bucket("v180");
  const weightedAge = total > 0
    ? Math.round(rows.reduce((t, r) => t + Number(r.avg_age ?? 0) * Number(r.value), 0) / total)
    : 0;

  const BUCKETS = [
    { key: "v0", label: "0–30 d" }, { key: "v30", label: "31–60 d" },
    { key: "v60", label: "61–90 d" }, { key: "v90", label: "91–180 d" },
    { key: "v180", label: "180 d +" },
  ] as const;

  return (
    <>
      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Stock value</span>
            <span className="kpi-value">{money(total)}</span>
            <span className="kpi-note">ties to the stock page exactly</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Sitting over 90 days</span>
            <span className="kpi-value" style={{ color: slow > 0 ? "var(--warn)" : undefined }}>
              {money(slow)}
            </span>
            <span className="kpi-note">
              {total > 0 ? `${pct(slow / total)} of the money on the shelf` : "—"}
            </span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Average age</span>
            <span className="kpi-value">{weightedAge} d</span>
            <span className="kpi-note">weighted by value, not by units</span>
          </span>
        </div>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>By item, as it stands today</h2>
            <span className="page-sub">
              read from the FIFO layers, so it adds up to stock on hand ·
              consigned goods are excluded, being nobody&rsquo;s capital but
              the consignor&rsquo;s
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th colSpan={showThumbs ? 2 : 1}>Item</th>
                  <th className="r">On hand</th>
                  <th className="r">Value</th>
                  <th className="r">Avg age</th>
                  <th className="r">Oldest</th>
                  {BUCKETS.map((b) => <th key={b.key} className="r">{b.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {showThumbs && (
                      <td className="vgroup-thumb">
                        <ItemThumb src={srcOf(r.id)} name={r.name} />
                      </td>
                    )}
                    <td className="wrap">
                      <ItemLink id={r.id} code={r.code} />
                      <div className="subline">
                        {r.name}
                        <VariantTags variant={asVariant(r.variant)} className="vartags-inline" />
                      </div>
                    </td>
                    <td className="r">{fmtQty(String(r.qty))} {r.uom_code}</td>
                    <td className="r">{money(Number(r.value))}</td>
                    <td className="r">{r.avg_age} d</td>
                    <td className="r">
                      {r.oldest_days} d
                      <div className="subline">{shortDate(r.oldest)}</div>
                    </td>
                    {BUCKETS.map((b) => (
                      <td key={b.key} className="r"
                          style={{ color: n(r, b.key) === 0 ? "var(--line)"
                                        : b.key === "v180" ? "var(--bad)"
                                        : b.key === "v90" ? "var(--warn)" : undefined }}>
                        {n(r, b.key) === 0 ? "—" : money(n(r, b.key))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={showThumbs ? 3 : 2}><strong>Total</strong></td>
                  <td className="r"><strong>{money(total)}</strong></td>
                  <td colSpan={2} />
                  {BUCKETS.map((b) => (
                    <td key={b.key} className="r"><strong>
                      {bucket(b.key) === 0 ? "—" : money(bucket(b.key))}
                    </strong></td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * Profit matched to the units that earned it.
 *
 * The default reading, because it is the one that answers "is this product
 * worth selling". Revenue vs COGS next door answers "do the books agree",
 * which is a different and also necessary question.
 */
async function Matched({
  companyId, from, to, shown, locationId,
}: { companyId: string; from: string; to: string; shown: string;
     locationId: string | null }) {
  const [rows, variantStock] = await Promise.all([
    getMatchedProfitability(companyId, from, to, locationId) as unknown as Promise<any[]>,
    getVariantStock(companyId) as unknown as Promise<any[]>,
  ]);

  const photos = variantPhotos(variantStock as never);
  const srcOf = (id: string) => {
    const v = variantStock.find((x) => x.id === id);
    return v ? photos.srcFor(v as never) : null;
  };
  const showThumbs = anyPhoto(rows.map((r: any) => r.id), srcOf);

  if (rows.length === 0) {
    return <div className="empty">Nothing was invoiced in that period.</div>;
  }

  const n = (r: any, k: string) => Number(r[k] ?? 0);
  const revenue = rows.reduce((t, r) => t + n(r, "revenue"), 0);
  const matchedRev = rows.reduce((t, r) => t + n(r, "revenue_matched"), 0);
  const cost = rows.reduce((t, r) => t + n(r, "cost"), 0);
  const margin = matchedRev - cost;
  const unmatchedRev = revenue - matchedRev;
  const byItem = rows.reduce((t, r) => t + n(r, "n_by_item"), 0);
  const partShipped = rows.reduce((t, r) => t + n(r, "n_part_shipped"), 0);
  const returned = rows.reduce((t, r) => t + n(r, "n_returned"), 0);

  return (
    <>
      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Matched revenue</span>
            <span className="kpi-value">{money(matchedRev)}</span>
            <span className="kpi-note">
              {unmatchedRev > 0
                ? `${money(unmatchedRev)} more invoiced with no goods to cost`
                : "every invoiced line found its goods"}
            </span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Cost of those units</span>
            <span className="kpi-value">{money(cost)}</span>
            <span className="kpi-note">the FIFO layers they actually drew on</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-body">
            <span className="kpi-label">Gross margin</span>
            <span className="kpi-value" style={{ color: margin < 0 ? "var(--bad)" : undefined }}>
              {money(margin)}
            </span>
            <span className="kpi-note">
              {matchedRev > 0 ? `${pct(margin / matchedRev)} of matched revenue` : "nothing matched"}
            </span>
          </span>
        </div>
      </div>

      {/* How firm the figures are, said before they are read rather than
          after somebody has acted on them. */}
      {(unmatchedRev > 0 || byItem > 0 || partShipped > 0 || returned > 0) && (
        <div className="card" style={{ marginBottom: "var(--s3)" }}>
          <div className="card-body">
            <strong>How these were matched</strong>
            <ul className="matchnotes">
              {byItem > 0 && (
                <li>
                  <span className="pill">by item</span>
                  {byItem} line{byItem === 1 ? "" : "s"} found their goods through
                  the delivery the invoice names, matched on the item rather than
                  the line. Exact whenever that delivery lists the item once.
                </li>
              )}
              {partShipped > 0 && (
                <li>
                  <span className="pill warn">part shipped</span>
                  {partShipped} line{partShipped === 1 ? "" : "s"} billed more
                  than has gone out. Only the delivered units are costed and
                  only their share of the revenue is matched; the rest is
                  carried as unmatched until the goods follow.
                </li>
              )}
              {returned > 0 && (
                <li>
                  <span className="pill">returns</span>
                  {returned} return line{returned === 1 ? "" : "s"} taken off
                  both sides — the revenue and the cost the goods originally
                  left at, not today&rsquo;s.
                </li>
              )}
              {unmatchedRev > 0 && (
                <li>
                  <span className="pill overdue">unmatched</span>
                  {money(unmatchedRev)} of revenue has no goods to cost against,
                  usually invoiced before shipping. Left out of the margin
                  entirely rather than counted as pure profit.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>By item</h2>
            <span className="page-sub">
              {shortDate(from)} to {shortDate(shown)} · cost taken from the FIFO
              layers each sale drew on
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th colSpan={showThumbs ? 2 : 1}>Item</th>
                  <th className="r">Sold</th>
                  <th className="r">
                    Revenue
                    <div className="subline">invoiced</div>
                  </th>
                  <th className="r">Cost</th>
                  <th className="r">Margin</th>
                  <th className="r">%</th>
                  <th>Matched</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mr = n(r, "revenue_matched");
                  const m = r.margin === null ? null : Number(r.margin);
                  return (
                    <tr key={r.id}>
                      {showThumbs && (
                        <td className="vgroup-thumb">
                          <ItemThumb src={srcOf(r.id)} name={r.name} />
                        </td>
                      )}
                      <td className="wrap">
                        <ItemLink id={r.id} code={r.code} />
                        <div className="subline">
                          {r.name}
                          <VariantTags variant={asVariant(r.variant)} className="vartags-inline" />
                        </div>
                      </td>
                      <td className="r">{fmtQty(String(r.qty))}</td>
                      <td className="r">{money(n(r, "revenue"))}</td>
                      <td className="r">
                        {r.cost === null ? <span className="page-sub">—</span> : money(Number(r.cost))}
                      </td>
                      <td className="r" style={{ color: m !== null && m < 0 ? "var(--bad)" : undefined }}>
                        {m === null ? <span className="page-sub">—</span> : <strong>{money(m)}</strong>}
                      </td>
                      <td className="r" style={{ color: m !== null && m < 0 ? "var(--bad)" : undefined }}>
                        {m !== null && mr > 0 ? pct(m / mr) : "—"}
                      </td>
                      <td>
                        <span className="vartags">
                          {n(r, "n_exact") > 0 && (
                            <span className="vartag">exact {n(r, "n_exact")}</span>
                          )}
                          {n(r, "n_by_item") > 0 && (
                            <span className="vartag">by item {n(r, "n_by_item")}</span>
                          )}
                          {n(r, "n_unmatched") > 0 && (
                            <span className="vartag" style={{ color: "var(--bad)" }}>
                              unmatched {n(r, "n_unmatched")}
                            </span>
                          )}
                          {n(r, "n_part_shipped") > 0 && (
                            <span className="vartag" style={{ color: "var(--warn)" }}>
                              part shipped {n(r, "n_part_shipped")}
                            </span>
                          )}
                          {n(r, "n_returned") > 0 && (
                            <span className="vartag">
                              returns {n(r, "n_returned")}
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Two totals, because they are two different numbers. The
                  column adds up every invoice; the margin below it is only
                  ever over the part that found its goods, and one row
                  carrying both made the table look as though it disagreed
                  with the card above it. */}
              {/* The spans follow the thumbnail column. They were written
                  for a table that always had one, so when it drops out
                  every total slides one column to the right of the figures
                  it is totalling. */}
              <tfoot>
                <tr>
                  <td colSpan={showThumbs ? 3 : 2}>
                    <strong>Total invoiced revenue</strong>
                  </td>
                  <td className="r"><strong>{money(revenue)}</strong></td>
                  <td colSpan={4} />
                </tr>
                <tr>
                  <td colSpan={showThumbs ? 3 : 2}>
                    <strong>Matched revenue</strong>
                    {unmatchedRev > 0 && (
                      <div className="subline">
                        {money(unmatchedRev)} not yet costed, left out below
                      </div>
                    )}
                  </td>
                  <td className="r"><strong>{money(matchedRev)}</strong></td>
                  <td className="r"><strong>{money(cost)}</strong></td>
                  <td className="r"><strong>{money(margin)}</strong></td>
                  <td className="r">
                    <strong>{matchedRev > 0 ? pct(margin / matchedRev) : "—"}</strong>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
