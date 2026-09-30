import Link from "next/link";
import { money, qty as fmtQty, shortDate } from "@/lib/db";
import {
  getCompany, getVariantProfitability, getVariantStock, getInventoryAging,
} from "@/lib/queries";
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
  { key: "profit", label: "Profitability" },
  { key: "aging", label: "Inventory aging" },
] as const;

/** Only a real date gets through; anything else is treated as not set. */
const asDate = (v: string | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default async function InventoryIntelligence({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "profit";

  // A year to today, unless asked otherwise. Long enough that a seasonal
  // product is not judged on a quiet fortnight.
  const today = new Date();
  const to = asDate(sp.to) ?? new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const from = asDate(sp.from)
    ?? new Date(today.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  const href = (t: string) => {
    const q = new URLSearchParams();
    if (t !== "profit") q.set("tab", t);
    if (asDate(sp.from)) q.set("from", sp.from!);
    if (asDate(sp.to)) q.set("to", sp.to!);
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

      {tab === "profit" && (
      <form method="get" action="/inventory/intelligence" className="row movefilters">
        {tab !== "profit" && <input type="hidden" name="tab" value={tab} />}
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={to} />
        </div>
        <button type="submit" className="btn ghost">Apply</button>
      </form>
      )}

      {tab === "profit"
        ? <Profitability companyId={company.id} from={from} to={to} />
        : <Aging companyId={company.id} />}
    </>
  );
}

async function Profitability({
  companyId, from, to,
}: { companyId: string; from: string; to: string }) {
  const [rows, variantStock] = await Promise.all([
    getVariantProfitability(companyId, from, to) as unknown as Promise<any[]>,
    getVariantStock(companyId) as unknown as Promise<any[]>,
  ]);

  const photos = variantPhotos(variantStock as never);
  const srcOf = (id: string) => {
    const v = variantStock.find((x) => x.id === id);
    return v ? photos.srcFor(v as never) : null;
  };

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
              {shortDate(from)} to {shortDate(to)} · ties to Sales and Cost of
              goods sold in the ledger
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th colSpan={2}>Item</th>
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
                      <td className="vgroup-thumb">
                        <ItemThumb src={srcOf(r.id)} name={r.name} />
                      </td>
                      <td className="wrap">
                        <span className="m">{r.code}</span>
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
                  <td colSpan={3}><strong>Total</strong></td>
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

async function Aging({ companyId }: { companyId: string }) {
  const [rows, variantStock] = await Promise.all([
    getInventoryAging(companyId) as unknown as Promise<any[]>,
    getVariantStock(companyId) as unknown as Promise<any[]>,
  ]);

  const photos = variantPhotos(variantStock as never);
  const srcOf = (id: string) => {
    const v = variantStock.find((x) => x.id === id);
    return v ? photos.srcFor(v as never) : null;
  };

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
                  <th colSpan={2}>Item</th>
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
                    <td className="vgroup-thumb">
                      <ItemThumb src={srcOf(r.id)} name={r.name} />
                    </td>
                    <td className="wrap">
                      <span className="m">{r.code}</span>
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
                  <td colSpan={3}><strong>Total</strong></td>
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
