import Link from "next/link";
import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { HelpHint } from "@/components/help-hint";
import { DataTable, type DataRow } from "@/components/data-table";
import { RankedBarChart, ShareDonut } from "@/components/charts";
import { BreakdownPerformance } from "@/components/breakdown-performance";
import {
  getCompany, getBranches, getSalesBreakdown, getSalesOverview, UNASSIGNED_BRANCH,
  type SalesBreakdownBy,
} from "@/lib/queries";
import { SalesOverview } from "@/components/sales-overview";

type Tab = SalesBreakdownBy | "overview";

const TABS: [Tab, string, string][] = [
  ["overview", "Overview", "How the period compares with the one before"],
  ["item", "By item", "Which products earned it"],
  ["customer", "By customer", "Who it came from"],
  ["category", "By category", "Which part of the catalogue"],
  ["brand", "By brand", "Whose goods sold"],
];

const qty = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });
const pct = (v: number | null) =>
  v === null ? "—" : `${v.toFixed(1)}%`;

const defaultFrom = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

export default async function SalesReports({
  searchParams,
}: {
  searchParams: Promise<{
    by?: string; from?: string; to?: string; branch?: string }>;
}) {
  const p = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const tab = (TABS.find(([k]) => k === p.by)?.[0] ?? "overview") as Tab;
  const by = (tab === "overview" ? "item" : tab) as SalesBreakdownBy;
  const range = { from: p.from || defaultFrom(), to: p.to || today() };

  const branches = (await getBranches(company.id)) as unknown as Array<{
    id: string; code: string; name: string;
  }>;
  const branchId =
    p.branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : p.branch && branches.some((b) => b.id === p.branch) ? p.branch
    : null;

  /* Only what the open tab needs. The overview compares two periods and
     the breakdowns scan one, and running both on every load would double
     the work to show half of it. */
  const overview = tab === "overview"
    ? await getSalesOverview(company.id, range.from, range.to, branchId)
    : null;
  const rows = tab === "overview"
    ? []
    : await getSalesBreakdown(company.id, range.from, range.to, by, branchId);

  const tot = rows.reduce((t, r) => ({
    qty: t.qty + r.qty,
    freeQty: t.freeQty + r.freeQty,
    gross: t.gross + r.gross, discount: t.discount + r.discount,
    revenue: t.revenue + r.revenue, unmatched: t.unmatched + r.unmatched,
    cost: t.cost + r.cost, margin: t.margin + r.margin,
  }), { qty: 0, freeQty: 0, gross: 0, discount: 0,
        revenue: 0, unmatched: 0, cost: 0, margin: 0 });

  const TOP = 5;
  const head = rows.slice(0, TOP);
  const tail = rows.slice(TOP);
  const donut = [
    ...head.map((r) => ({ id: r.key, name: `${r.code} · ${r.name}`, revenue: r.revenue })),
    ...(tail.length > 0
      ? [{ id: "rest", name: `${tail.length} others`, rest: true,
           revenue: tail.reduce((t, r) => t + r.revenue, 0) }]
      : []),
  ].filter((d) => d.revenue > 0);

  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const all = { by: tab, from: range.from, to: range.to,
                  branch: branchId ?? undefined, ...over };
    for (const [k, v] of Object.entries(all)) if (v) q.set(k, String(v));
    return `/sales/reports?${q.toString()}`;
  };

  const label = { item: "Item", customer: "Customer", category: "Category", brand: "Brand" }[by];
  /* Written out, because adding an s gives "categorys". English plurals are
     not a rule the code can apply and these are four known words. */
  const plural = { item: "items", customer: "customers",
                   category: "categories", brand: "brands" }[by];

  /* The fourth tile asks something the table and the donut do not already
     answer, and what is worth asking changes with the cut: how dear the
     goods are, how much a customer is worth, and — for the two cuts short
     enough to read whole — which part of the business is making the least
     on what it sells.
     Rows that earned nothing are left out of "lowest margin" on purpose. A
     category with no matched revenue has no margin to be lowest; counting
     it would answer the question with whatever happens to be empty. */
  const earners = rows.filter((r) => r.revenue > 0 && r.marginPct !== null);
  const lowest = [...earners].sort((a, b) => a.marginPct! - b.marginPct!)[0] ?? null;
  const avgPrice = tot.qty > 0 ? tot.revenue / tot.qty : null;
  const perCustomer = earners.length > 0 ? tot.revenue / earners.length : null;

  const fourth =
    by === "item"
      ? { label: "Average selling price",
          value: avgPrice === null ? "—" : money(String(Math.round(avgPrice))),
          sub: avgPrice === null ? "nothing sold"
             : `per unit, across ${qty(tot.qty)} units` }
    : by === "customer"
      ? { label: "Average per customer",
          value: perCustomer === null ? "—" : money(String(Math.round(perCustomer))),
          sub: perCustomer === null ? "nobody bought anything"
             : `across ${earners.length} ${earners.length === 1 ? "customer" : "customers"} who bought` }
    : { label: `Lowest-margin ${by}`,
        value: lowest === null ? "—" : pct(lowest.marginPct),
        sub: lowest === null ? `no ${plural} earned anything`
           : `${lowest.code} · ${lowest.name}` };

  const table: DataRow[] = rows.map((r) => ({
    key: r.key,
    searchText: `${r.code} ${r.name}`.toLowerCase(),
    sort: {
      code: r.code ?? "", name: (r.name ?? "").toLowerCase(),
      qty: r.qty,
      gross: r.gross, discount: r.discount, returned: r.returned,
      revenue: r.revenue, unmatched: r.unmatched,
      cost: r.cost, margin: r.margin,
      // Unmeasured sorts last rather than counting as nought and topping
      // a "worst margin" list with rows nobody has costed.
      margin_pct: r.marginPct ?? -1e9,
      share: r.revenue,
    },
    csv: {
      code: r.code, name: r.name, qty: r.qty, free_qty: r.freeQty,
      gross: r.gross, discount: r.discount, revenue: r.revenue,
      unmatched_revenue: r.unmatched,
      cost: r.cost, margin: r.margin,
      margin_pct: r.marginPct === null ? "" : r.marginPct.toFixed(2),
      invoices: r.invoices,
    },
    /* Two shapes, written out rather than woven together with conditionals
       on every cell. The columns differ in meaning, not only in label — a
       matched revenue is not a net sale — and a row built out of ternaries
       is a row nobody can check against its header. */
    node: (
      <tr>
        <td className="code">{r.code}</td>
        <td className="wrap">
          {r.name}
          {r.freeQty > 0 && (
            <div className="subline">{qty(r.freeQty)} given free</div>
          )}
        </td>
        <td className="r">{qty(r.qty)}</td>
        <td className="r">{money(String(r.gross))}</td>
        <td className="r">{r.discount ? money(String(r.discount)) : "—"}</td>
        <td className="r">{r.returned ? money(String(r.returned)) : "—"}</td>
        <td className="r"><strong>{money(String(r.revenue))}</strong></td>
        <td className="r">{r.cost ? money(String(r.cost)) : "—"}</td>
        <td className="r" style={{ color: r.margin < 0 ? "var(--bad)" : undefined }}>
          {money(String(r.margin))}
        </td>
        <td className="r">{pct(r.marginPct)}</td>
        {/* Revenue the ledger cannot put a cost against yet, because the
            goods have not gone out. The one way the two halves still part
            company now that both are recognised on the invoice. */}
        <td className="r" style={{ color: r.unmatched > 0 ? "var(--bad)" : undefined }}>
          {r.unmatched ? money(String(r.unmatched)) : "—"}
        </td>
        <td className="r">
          {tot.revenue > 0 ? `${((r.revenue / tot.revenue) * 100).toFixed(1)}%` : "—"}
        </td>
        <td className="r">{r.invoices}</td>
      </tr>
    ),
  }));

  return (
    <div className="reportpage">
      {/* The cuts sit beside the title rather than under the filters.
          They are not a filter — they choose which report this is — and
          below the date row they read as one more thing to set before the
          page means anything. */}
      <div className="reporthead">
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Sales report</h1>
        <HelpHint label="Where these figures come from">
          Revenue is posted sales invoices in the period. Cost is the FIFO
          cost of the goods those invoices billed, released to cost of sales
          by the invoice itself, so both halves of a sale land together and
          the figures here tie to the income statement.
          <br /><br />
          <strong>Not yet shipped</strong> is the exception: an invoice
          raised before the goods go out earns revenue the books cannot put
          a cost against yet. It is shown so a flattering margin can be
          recognised for what it is. The cost appears when the goods do, in
          the period they leave.
          <br /><br />
          Free-of-charge lines earn nothing and their cost goes to promotion
          expense, so they are counted as units given away and left out of
          both money columns.
        </HelpHint>
      </div>

      <div className="erp-tabs">
        {TABS.map(([k, t, hint]) => (
          <Link key={k} href={link({ by: k })} title={hint}
                className={`erp-tab ${tab === k ? "here" : ""}`}>{t}</Link>
        ))}
      </div>
      </div>

      <form className="row" style={{ margin: 0, alignItems: "flex-end" }}>
        <input type="hidden" name="by" value={tab} />
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={range.to} />
        </div>
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
          </select>
        </div>
        <div className="actions">
          <AutoApply />
          <button type="submit" data-apply>Update</button>
        </div>
      </form>

      {overview ? (
        <SalesOverview
          now={overview.now} before={overview.before}
          series={overview.series} prevFrom={overview.prevFrom} prevTo={overview.prevTo}
          currency={company.base_currency}
        />
      ) : (
      <>
      <div className="kpis kpis-five">
        <Tile label="Revenue" value={money(String(tot.revenue))}
              sub={`${rows.length} ${rows.length === 1 ? label.toLowerCase() : plural} sold`} />
        <Tile label="Cost of those goods" value={money(String(tot.cost))}
              sub="FIFO, released by the invoices" />
        <Tile label="Gross profit" value={money(String(tot.margin))}
              sub={tot.revenue > 0
                ? `${((tot.margin / tot.revenue) * 100).toFixed(1)}% margin`
                : "nothing sold"} />
        <Tile label="Not yet shipped" value={money(String(tot.unmatched))}
              sub={tot.unmatched > 0
                ? "invoiced with no goods out — no cost against it yet"
                : "every invoice has its goods behind it"} />
        <Tile {...fourth} />
      </div>

      {/* Item reads as three: revenue ranked, units ranked separately
          because what sells most is rarely what earns most, and the share
          beside them. A long catalogue is read as rankings.

          Every other cut reads as two that agree on colour: the donut says
          how lopsided it is, the columns say how big each one is, and the
          measure picker turns the second into net sales, cost, profit,
          margin, units, discounts or returns without moving the page. A
          handful of categories, brands or customers suits one chart that
          can be re-asked rather than two fixed rankings. */}
      {rows.length > 0 && (by !== "item" ? (
        <section className="grid2 chartrow">
          <div className="card">
            <div className="card-head">
              <h2>Share of net sales</h2>
              <span className="page-sub">top 5</span>
            </div>
            <div className="card-body">
              <div className="chartbox">
                <ShareDonut
                  currency={company.base_currency}
                  emptyLabel="Nothing was invoiced in this period."
                  data={donut}
                />
              </div>
            </div>
          </div>

          <BreakdownPerformance rows={rows} label={label} />
        </section>
      ) : (
        <section className="grid3">
          <div className="card">
            <div className="card-head">
              <h2>Top 10 by net sales</h2>
              <span className="page-sub">{company.base_currency}</span>
            </div>
            <div className="card-body">
              <div className="chartbox">
                <RankedBarChart height={280} compact
                  data={rows.slice(0, 10).map((r) => ({
                    label: `${r.code} ${r.name}`, value: r.revenue,
                  }))} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Units sold (top 10)</h2>
              <span className="page-sub">quantity, not money</span>
            </div>
            <div className="card-body">
              <div className="chartbox">
                <RankedBarChart height={280} compact
                  data={[...rows]
                    .sort((a, b) => b.qty - a.qty)
                    .slice(0, 10)
                    .map((r) => ({ label: `${r.code} ${r.name}`, value: r.qty }))} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Share of revenue</h2>
              <span className="page-sub">top 5</span>
            </div>
            <div className="card-body">
              <div className="chartbox">
                <ShareDonut
                  currency={company.base_currency}
                  emptyLabel="Nothing was invoiced in this period."
                  data={donut}
                />
              </div>
            </div>
          </div>
        </section>
      ))}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{TABS.find(([k]) => k === by)?.[1]}</h2>
            <span className="page-sub">
              {range.from} to {range.to}
              {tot.freeQty > 0 && ` · ${qty(tot.freeQty)} units given free`}
            </span>
          </div>
          <DataTable
            rows={table}
            emptyLabel="Nothing was invoiced in this period."
            searchPlaceholder={`Search ${plural}…`}
            defaultSort={{ key: "revenue", dir: "desc" }}
            defaultPageSize={20}
            columns={[
              { key: "code", label: "Code", sortable: true },
              { key: "name", label, sortable: true },
              { key: "qty", label: "Qty sold", sortable: true, align: "r" },
              { key: "gross", label: "Gross revenue", sortable: true, align: "r" },
              { key: "discount", label: "Discounts", sortable: true, align: "r" },
              { key: "returned", label: "Returns", sortable: true, align: "r" },
              { key: "revenue", label: "Net sales", sortable: true, align: "r" },
              { key: "cost", label: "COGS", sortable: true, align: "r" },
              { key: "margin", label: "Gross margin", sortable: true, align: "r" },
              { key: "margin_pct", label: "Gross margin %", sortable: true, align: "r" },
              { key: "unmatched", label: "Not yet shipped", sortable: true, align: "r" },
              { key: "share", label: "Share", sortable: true, align: "r" },
              { key: "invoices", label: "Invoices", align: "r" },
            ]}
          />
        </div>
      </section>
      </>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-note">{sub}</div>
    </div>
  );
}
