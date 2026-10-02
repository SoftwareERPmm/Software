import Link from "next/link";
import { notFound } from "next/navigation";
import { money, shortDate } from "@/lib/db";
import {
  getCompany, getSupplierSpend, getSupplierCommitmentData, getSupplierFulfilment,
  getSupplierLeadTimeObservations, getSupplierPriceObservations,
  getSupplierDeliveryCompleteness, getSupplierMatchingVariance,
  getSupplierPerformanceSetting, getRadarPresets, getSupplierFulfilmentByMonth,
} from "@/lib/queries";
import { saveRadarPreset } from "@/lib/actions";
import { SupplierTrend } from "@/components/supplier-trend";
import { HelpHint } from "@/components/help-hint";
import { requireFeature } from "@/lib/plans";
import {
  METRICS, DEFAULT_RADAR, MIN_RADAR_AXES, MAX_RADAR_AXES, supportedMetrics,
  resolveThresholds, resolveTargets, sanitizeAxes, type MetricId,
} from "@/lib/supplier-metrics";
import { buildPerformance, buildTrend, formatRaw } from "@/lib/supplier-performance";
import { SupplierRadar } from "@/components/supplier-radar";
import { ComparePicker } from "@/components/compare-picker";
import { DataTable } from "@/components/data-table";
import { RadarAxisPicker } from "@/components/radar-axis-picker";
import { MethodologyPanel } from "@/components/methodology-panel";

/**
 * Which suppliers are worth keeping, argued from the purchase ledger.
 *
 * Every figure here is derived at read time from posted orders, receipts
 * and invoices. Nothing is stored, so nothing can drift from the documents
 * it claims to summarise, and re-running last quarter gives last quarter's
 * answer rather than one improved by what has happened since.
 *
 * There is deliberately no overall score. Averaging five axes invents a
 * sixth number with no unit and no defensible weighting, and it is the one
 * everybody would quote. The table sorts by real measurements instead.
 */

const asDate = (v: string | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

const pct = (v: number | null, dp = 1) =>
  v === null ? "—" : `${v.toFixed(dp)}%`;

const days = (v: number | null) =>
  v === null ? "—" : `${v.toFixed(1)} days`;

export default async function SupplierPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company is set up yet.</div>;

  // Gating, not security: see lib/plans.ts. There is no sign-in to check a
  // permission against, so this withholds an upsell and nothing more. It is
  // stated on the page too rather than only in a comment.
  if (!requireFeature(company.plan, "supplier_performance")) {
    notFound();
  }

  const q = await searchParams;

  const today = new Date().toISOString().slice(0, 10);
  const asked = asDate(q.to);
  // Clamped, because a period running into the future reports a supplier as
  // having failed to deliver things that are not due yet.
  const to = asked === null || asked > today ? today : asked;
  const from = asDate(q.from)
    ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  const [stored, presets] = await Promise.all([
    getSupplierPerformanceSetting(company.id),
    getRadarPresets(company.id),
  ]);
  // The company's own scale where it has one, the illustrative defaults
  // elsewhere. Merged rather than replaced, so a company that set only a
  // target still follows later changes to the boundaries.
  const thresholds = resolveThresholds(stored?.thresholds);
  const targets = resolveTargets(stored?.targets);

  const [spend, commitments, fulfilment, leadTimes, prices, completeness, variance] =
    await Promise.all([
      getSupplierSpend(company.id, from, to),
      getSupplierCommitmentData(company.id, from, to),
      getSupplierFulfilment(company.id, from, to),
      getSupplierLeadTimeObservations(company.id, from, to),
      getSupplierPriceObservations(company.id, from, to),
      getSupplierDeliveryCompleteness(company.id, from, to),
      getSupplierMatchingVariance(company.id, from, to),
    ]);

  // Suppliers that only appear on an order and never an invoice are added
  // by buildPerformance itself, so this page and the CSV cannot disagree
  // about who is on the report.
  const rows = buildPerformance({
    suppliers: spend,
    commitments, fulfilment, leadTimes, prices, completeness, variance,
    cutoff: to,
    thresholds,
    targets,
  });

  if (rows.length === 0) {
    return (
      <>
        <Header from={from} to={to} />
        <div className="empty">
          No supplier had a posted purchase in this period.
        </div>
      </>
    );
  }

  // --- what is on the chart ------------------------------------------------
  const available = supportedMetrics().map((m) => m.id);
  // The URL wins, then whichever preset the company marked as its default,
  // then the built-in five. Sanitised at every step: a hand-edited URL, or
  // a preset saved before a metric was withdrawn, must not be able to ask
  // for an axis that cannot be drawn.
  const fromUrl = sanitizeAxes((q.axes ?? "").split(",").filter(Boolean));
  const fromPreset = sanitizeAxes(presets.find((p) => p.is_default)?.axes);
  const axes = fromUrl ?? fromPreset ?? DEFAULT_RADAR;

  // Biggest spender first, which is where a buyer looks. The table sorts
  // itself from here on — the column headings are DataTable's and the
  // ordering never reaches the URL, so this only decides what the picker
  // lists and which supplier is charted when none was asked for.
  const sorted = [...rows].sort((a, b) => b.spend - a.spend);

  const selected = sorted.find((r) => r.partnerId === q.supplier) ?? sorted[0];
  const compare = q.compare && q.compare !== selected.partnerId
    ? sorted.find((r) => r.partnerId === q.compare) ?? null
    : null;

  // Monthly figures for the selected supplier only: a trend is a question
  // about one supplier, and fetching twelve months for everyone to draw one
  // line would be work nobody asked for.
  const monthly = await getSupplierFulfilmentByMonth(
    company.id, selected.partnerId, from, to);
  const trend = buildTrend({
    commitments: commitments.filter((c) => c.partner_id === selected.partnerId),
    leadTimes: leadTimes.filter((l) => l.partner_id === selected.partnerId),
    fulfilment: monthly,
    from: from.slice(0, 7),
    to: to.slice(0, 7),
  });

  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      from, to, supplier: selected.partnerId,
      compare: compare?.partnerId, axes: axes.join(","),
    };
    for (const [k, v] of Object.entries({ ...base, ...patch })) {
      if (v) p.set(k, v);
    }
    return `/purchases/supplier-performance?${p.toString()}`;
  };

  // --- the KPI row, in real units ------------------------------------------
  const totalSpend = rows.reduce((t, r) => t + r.spend, 0);
  const allDue = rows.reduce((t, r) => t + r.actuals.onTime.due, 0);
  const allOnTime = rows.reduce((t, r) => t + r.actuals.onTime.onTime, 0);
  const allLate = rows.reduce((t, r) => t + r.actuals.onTime.late, 0);
  const allLateDays = rows.reduce((t, r) => t + r.actuals.onTime.lateDays, 0);
  const ordered = fulfilment.reduce((t, f) => t + Number(f.ordered), 0);
  const received = fulfilment.reduce((t, f) => t + Number(f.received), 0);
  const leadWeight = leadTimes.reduce((t, l) => t + Number(l.qty), 0);
  const leadTotal = leadTimes.reduce((t, l) => t + l.days * Number(l.qty), 0);

  return (
    <>
      <Header from={from} to={to} />

      <div className="kpis kpis-tiled">
        <Kpi label="Suppliers" value={String(rows.length)}
             note="with purchase activity in this period" />
        <Kpi label="On-time delivery"
             value={allDue > 0 ? pct((100 * allOnTime) / allDue) : "—"}
             note={allDue > 0
               ? `of ${allDue.toLocaleString()} units committed and due`
               : "no supplier has confirmed a delivery date yet"} />
        <Kpi label="Average delay when late"
             value={allLate > 0 ? days(allLateDays / allLate) : "—"}
             note={allLate > 0
               ? `across ${allLate.toLocaleString()} units that missed their date`
               : "nothing arrived late"} />
        <Kpi label="Average lead time"
             value={leadWeight > 0 ? days(leadTotal / leadWeight) : "—"}
             note="order to receipt, weighted by quantity" />
        <Kpi label="Purchase spend" value={money(totalSpend)}
             note={ordered > 0
               ? `${pct((100 * received) / ordered, 0)} of ordered quantity received`
               : "nothing ordered in this period"} />
      </div>

      {/* Said before the figures are read rather than after somebody has
          acted on them: three of the ten metrics have no data behind them
          in this database, and a customer promised seven should be told
          which four are missing and why. */}
      <UnavailableNote />

      <section className="grid2 perf-compare">
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>Supplier comparison</h2>
              <HelpHint label="Why there is no overall score">
                Averaging the axes would invent a sixth number with no unit
                and no defensible weighting, and it is the one everybody
                would quote. These are five different questions with five
                different answers, so the table sorts by real measurements
                instead. Click a supplier to chart it against the others.
              </HelpHint>
            </div>
          </div>
          {/* The shared list table, so this behaves like every other list
              in the product: search, sort, choose columns, and pages rather
              than one unbounded run of rows. A company with two hundred
              suppliers gets twenty at a time and a search box, not two
              hundred rows pushing the chart off the screen. */}
          <DataTable
            rows={sorted.map((r) => {
              const isSelected = r.partnerId === selected.partnerId;
              const isCompare = r.partnerId === compare?.partnerId;
              return {
                key: r.partnerId,
                searchText: `${r.name} ${r.code}`.toLowerCase(),
                sort: {
                  supplier: r.name.toLowerCase(),
                  spend: r.spend,
                  // Unmeasured sorts last whichever way the column is
                  // pointed, rather than counting as nought and leading
                  // the "worst suppliers" list with suppliers nobody
                  // has measured.
                  on_time: r.actuals.onTimePct ?? -1,
                  fulfilment: r.actuals.fulfilmentPct ?? -1,
                  lead: r.actuals.averageLeadDays ?? Number.MAX_SAFE_INTEGER,
                  revisions: r.actuals.supplierRevisions,
                },
                csv: {
                  supplier: r.name, code: r.code, spend: r.spend,
                  on_time: r.actuals.onTimePct, fulfilment: r.actuals.fulfilmentPct,
                  lead: r.actuals.averageLeadDays,
                  revisions: r.actuals.supplierRevisions,
                },
                node: (
                  <tr className={isSelected ? "row-selected" : undefined}>
                    <td className="wrap">
                      <Link href={link({ supplier: r.partnerId, compare: null })}
                            className="plain">
                        <strong>{r.name}</strong>
                      </Link>
                      {r.code && <div className="subline code">{r.code}</div>}
                    </td>
                    <td className="r">{money(r.spend)}</td>
                    <td className="r">{pct(r.actuals.onTimePct)}</td>
                    <td className="r">{pct(r.actuals.fulfilmentPct)}</td>
                    <td className="r">{days(r.actuals.averageLeadDays)}</td>
                    <td className="r">
                      {r.actuals.supplierRevisions > 0
                        ? <span className="pill warn">{r.actuals.supplierRevisions}</span>
                        : <span className="page-sub">—</span>}
                    </td>
                    <td>
                      {isSelected ? (
                        <span className="pill ok">charted</span>
                      ) : isCompare ? (
                        <Link className="chip" href={link({ compare: null })}>
                          stop comparing
                        </Link>
                      ) : (
                        <Link className="chip" href={link({ compare: r.partnerId })}>
                          + compare
                        </Link>
                      )}
                    </td>
                  </tr>
                ),
              };
            })}
            emptyLabel="No supplier had a posted purchase in this period"
            searchPlaceholder="Search suppliers…"
            defaultSort={{ key: "spend", dir: "desc" }}
            // Ten, not the usual twenty: a row here is two lines tall, so
            // twenty of them make a column twice the height of the chart
            // beside it and strand the chart at the top.
            defaultPageSize={10}
            columns={[
              { key: "supplier", label: "Supplier", sortable: true },
              { key: "spend", label: "Spend", sortable: true, align: "r" },
              { key: "on_time", label: "On-time", sortable: true, align: "r" },
              { key: "fulfilment", label: "Fulfillment", sortable: true, align: "r" },
              { key: "lead", label: "Avg lead time", sortable: true, align: "r" },
              { key: "revisions", label: "Revisions", sortable: true, align: "r" },
              { key: "chart", label: "" },
            ]}
          />
        </div>

        {/* The wrapper is what stretches; the card inside it is what
            sticks. A sticky grid item can only travel within its own grid
            area, and .grid2 aligns its children to the start, so the area
            is exactly the card's height and there is nowhere to go. */}
        <div className="stickycol">
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>{selected.name}{compare ? ` vs ${compare.name}` : ""}</h2>
              <HelpHint label="Reading the radar">
                Each spoke is one metric on a 0&ndash;100 scale, and an axis
                that could not be measured carries no point rather than a
                zero — the gap in the outline is the information. When two
                suppliers are shown they are scored on identical axes under
                identical normalization. Hover a point for the measurement
                behind it.
              </HelpHint>
            </div>
            <span className="page-sub">
              {shortDate(from)} to {shortDate(to)}
            </span>
          </div>
          <div className="card-body">
            <ComparePicker
              suppliers={sorted.map((r) => ({ id: r.partnerId, name: r.name }))}
              selectedId={selected.partnerId}
              compareId={compare?.partnerId ?? null}
            />
            <SupplierRadar
              axes={axes}
              suppliers={[
                { partnerId: selected.partnerId, name: selected.name, metrics: selected.metrics },
                ...(compare
                  ? [{ partnerId: compare.partnerId, name: compare.name, metrics: compare.metrics }]
                  : []),
              ]}
            />
            {/* A client component: it edits the query string itself rather
                than taking a callback, because a function cannot cross the
                server/client boundary. */}
            <RadarAxisPicker
              axes={axes}
              available={supportedMetrics().map((m) => ({ id: m.id, name: m.name }))}
              defaults={DEFAULT_RADAR}
              presets={presets}
              saveAction={saveRadarPreset}
            />
          </div>
        </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>How {selected.name} was measured</h2>
              <HelpHint label="Reading this table">
                Both numbers are kept because the score is the less
                informative of the two: 85 means nothing without the
                measurement it came from. A target is what you expect; a
                score is where that measurement falls on the 0&ndash;100
                scale. Sample is how many observations stood behind it.
                Every metric is listed, whether or not it is on the chart.
              </HelpHint>
            </div>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="r">Measured</th>
                  <th className="r">Score</th>
                  <th className="r">Target</th>
                  <th className="r">Sample</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(METRICS).map((def) => {
                  const m = selected.metrics[def.id];
                  const onChart = axes.includes(def.id);
                  return (
                    <tr key={def.id}>
                      <td className="wrap">
                        {def.name}
                        {onChart && <span className="vartag">on chart</span>}
                        <div className="subline">{def.description}</div>
                      </td>
                      <td className="r m">{formatRaw(def.id, m.raw)}</td>
                      <td className="r">
                        {m.score === null
                          ? <span className="page-sub">—</span>
                          : <strong>{Math.round(m.score)}</strong>}
                      </td>
                      <td className="r page-sub">
                        {m.target === null ? "—" : `≥ ${m.target}%`}
                      </td>
                      <td className="r page-sub">{m.n || "—"}</td>
                      <td className="wrap">
                        {m.unavailable
                          ? <span className="page-sub">{m.unavailable}</span>
                          : <span className="pill ok">measured</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-body">
            <PriceCoverageNote coverage={selected.priceCoverage} name={selected.name} />
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>{selected.name} month by month</h2>
              <HelpHint label="How the months are worked out">
                The same definitions as above, a month at a time. Each month
                is scored as at its own end, so it reads as it read then
                rather than being improved by deliveries that came later.
                Only the three metrics with an honest monthly value are
                drawn: a price premium needs other suppliers buying the same
                item in the same month, and a line full of gaps would invite
                reading its straight segments as measurements.
              </HelpHint>
            </div>
          </div>
          <div className="card-body">
            <SupplierTrend data={trend} name={selected.name} />
          </div>
        </div>
      </section>

      <MethodologyPanel />
    </>
  );
}

function Header({ from, to }: { from: string; to: string }) {
  const exportHref =
    `/purchases/supplier-performance/export?from=${from}&to=${to}`;
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Supplier performance</h1>
        <HelpHint>
          Who is worth keeping, argued from the purchase ledger. Every
          figure is worked out from posted orders, receipts and invoices
          when the page loads — nothing is stored, so nothing here can
          drift from the documents it summarises, and re-reading last
          quarter gives last quarter&rsquo;s answer rather than one
          improved by what has happened since.
        </HelpHint>
      </div>

      {/* Its own strip under the title, the way the other report screens do
          it. Inside the page-head the form was laying out as a column
          against a class the stylesheet does not define, which pushed the
          title into a narrow column beside it. */}
      <div className="filterbar">
        <form method="get" action="/purchases/supplier-performance"
              className="daterange">
          <div className="field">
            <label htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={from}
                   max={to} />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={to} max={to} />
          </div>
          <button type="submit" className="btn ghost">Apply</button>
        </form>

        {/* The same queries, as a file — so it cannot disagree with the
            screen it was downloaded from. */}
        <div className="field exportfield">
          <label>&nbsp;</label>
          <Link className="btn ghost" href={exportHref}>Export CSV</Link>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="kpi">
      <span className="kpi-body">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">{value}</span>
        <span className="kpi-note">{note}</span>
      </span>
    </div>
  );
}

/**
 * The three metrics this database cannot answer, named rather than omitted.
 *
 * A dashboard that silently shows seven axes where ten were promised makes
 * the customer wonder whether it is broken. One that says which three are
 * missing, and what would have to be recorded for them to work, turns a
 * gap into a decision they can make.
 */
function UnavailableNote() {
  const missing = Object.values(METRICS).filter((m) => !m.supported);
  if (missing.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: "var(--s3)" }}>
      <div className="card-body">
        <div className="headwith">
          <strong>What this cannot measure yet</strong>
          <HelpHint label="Why these are blank">
            Three of the ten metrics have no data behind them in this
            database, so they are named rather than quietly dropped — a
            dashboard showing seven axes where ten were promised makes
            people wonder whether it is broken. Each needs something
            recorded that is not recorded today:
            <ul>
              {missing.map((m) => (
                <li key={m.id}>
                  <strong>{m.name}</strong> — {m.supported ? null : m.requires}
                </li>
              ))}
            </ul>
          </HelpHint>
          <span className="vartags">
            {missing.map((m) => (
              <span className="vartag" key={m.id}>{m.name}</span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * How much of the spend the price comparison actually saw.
 *
 * A supplier who sells things nobody else sells has no competitiveness
 * score at all, and one where a tenth of spend is comparable has a score
 * about a tenth of their business. The axis looks equally confident in
 * both cases, so the coverage is stated underneath it.
 */
function PriceCoverageNote({
  coverage, name,
}: {
  coverage: { comparableItems: number; totalItems: number; spendCovered: number };
  name: string;
}) {
  if (coverage.totalItems === 0) return null;
  const none = coverage.comparableItems === 0;
  return (
    <div className="headwith">
      <span className="page-sub">
        Price comparison: {coverage.comparableItems} of {coverage.totalItems}{" "}
        items, {(coverage.spendCovered * 100).toFixed(0)}% of spend
      </span>
      <HelpHint label="How much of the spend was compared">
        {none ? (
          <>
            Nothing {name} sells was bought from anyone else in this period,
            so there is no reference price and no competitiveness score.
          </>
        ) : (
          <>
            An item bought from nobody else has no reference price, so it is
            left out of the comparison entirely. A supplier where only a
            fraction of spend is comparable has a score covering only that
            fraction of their business — the axis looks equally confident
            either way, which is why the coverage is stated here.
          </>
        )}
      </HelpHint>
    </div>
  );
}
