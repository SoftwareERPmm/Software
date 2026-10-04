import { money } from "@/lib/db";
import { RevenueTrendChart, TwoSeriesBars } from "@/components/charts";

type Side = {
  net: number; units: number; cost: number; profit: number;
  marginPct: number | null; avgPrice: number | null;
  discount: number; unmatched: number; returned: number;
};

const num = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Label, this period, the one before, whether it moves in points, whether
 *  down is the good direction, and what it means. */
type MetricRow = [string, number | null, number | null, boolean, boolean, string];

/** Revenue with no goods behind it: shown, and shown as a thing to reduce. */
const unmatchedRow = (now: Side, before: Side): MetricRow => [
  "Not yet shipped", now.unmatched, before.unmatched, false, true,
  "Invoiced with no goods out against it, so no cost has been recognised for it",
];

/**
 * Up or down, against the run of days immediately before.
 *
 * Every figure is shown with its own movement rather than a single headline
 * change, because they move independently and the interesting case is when
 * they disagree: sales up and margin down is a different month from both up,
 * and a report that gave one number would hide it.
 *
 * A percentage that is itself a percentage moves in points, not per cent.
 * Margin going from 24.3% to 25.5% is 1.2 points; calling that "+4.9%" is
 * true of the ratio and misleading about the business.
 */
function Delta({ now, before, points = false, invert = false }: {
  now: number | null; before: number | null; points?: boolean; invert?: boolean;
}) {
  if (now === null || before === null) return <span className="page-sub">—</span>;
  const diff = now - before;
  if (before === 0 && diff === 0) return <span className="page-sub">no change</span>;
  const up = diff > 0;
  // Fewer discounts and fewer returns are good news, so the colour follows
  // what the movement means rather than its sign.
  const good = invert ? !up : up;
  if (diff === 0) return <span className="page-sub">no change</span>;
  const text = points
    ? `${up ? "+" : ""}${diff.toFixed(1)} pp`
    : before === 0 ? "new"
    : `${up ? "+" : ""}${((diff / Math.abs(before)) * 100).toFixed(1)}%`;
  return (
    <span className="delta" style={{ color: good ? "var(--ok-ink, var(--brand))" : "var(--bad)" }}>
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

function Kpi({ label, value, now, before, points, invert }: {
  label: string; value: string;
  now: number | null; before: number | null; points?: boolean; invert?: boolean;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-note">
        <Delta now={now} before={before} points={points} invert={invert} />
        {" "}vs previous period
      </div>
    </div>
  );
}

export function SalesOverview({
  now, before, series, prevFrom, prevTo, currency,
}: {
  now: Side; before: Side;
  series: { month: string; net: number | string; profit: number | string }[];
  prevFrom: string; prevTo: string; currency: string;
}) {
  const revenueLabel = "Net sales";

  const rows: MetricRow[] = [
    [revenueLabel, now.net, before.net, false, false,
     "What was invoiced, after discounts"],
    ["Units sold", now.units, before.units, false, false,
     "Free units excluded — they earn nothing"],
    ["Gross profit", now.profit, before.profit, false, false,
     "Net sales less the cost the invoices released"],
    ["Gross margin", now.marginPct, before.marginPct, true, false,
     "Profit as a share of net sales"],
    ["Average selling price", now.avgPrice, before.avgPrice, false, false,
     `${revenueLabel} divided by units`],
    unmatchedRow(now, before),
    ["Discounts given", now.discount, before.discount, false, true, "Off the list price, all three kinds"],
    ["Returns", now.returned, before.returned, false, true, "Credited back to customers"],
  ];

  return (
    <>
      <div className="kpis kpis-five">
        <Kpi label={revenueLabel} value={`${currency} ${num(now.net)}`}
             now={now.net} before={before.net} />
        <Kpi label="Units sold" value={num(now.units)}
             now={now.units} before={before.units} />
        <Kpi label="Gross profit" value={`${currency} ${num(now.profit)}`}
             now={now.profit} before={before.profit} />
        <Kpi label="Gross margin"
             value={now.marginPct === null ? "—" : `${now.marginPct.toFixed(1)}%`}
             now={now.marginPct} before={before.marginPct} points />
        <Kpi label="Not yet shipped" value={`${currency} ${num(now.unmatched)}`}
             now={now.unmatched} before={before.unmatched} invert />
      </div>

      <section className="grid2">
        <div className="card">
          <div className="card-head">
            <h2>Sales trend</h2>
            <span className="page-sub">net sales by month</span>
          </div>
          <div className="card-body">
            <RevenueTrendChart
              data={series.map((s) => ({ month: s.month, revenue: s.net }))} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Sales vs gross profit</h2>
            <span className="page-sub">the gap is the cost</span>
          </div>
          <div className="card-body">
            <TwoSeriesBars height={200} aLabel={revenueLabel} bLabel="Gross profit"
              data={series.map((s) => ({ month: s.month, a: s.net, b: s.profit }))} />
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Sales summary</h2>
            <span className="page-sub">
              against {prevFrom} to {prevTo}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="r">This period</th>
                  <th className="r">Previous period</th>
                  <th className="r">Change</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, a, b, points, invert, note]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="r">
                      {a === null ? "—" : points ? `${a.toFixed(1)}%` : money(String(Math.round(a)))}
                    </td>
                    <td className="r">
                      {b === null ? "—" : points ? `${b.toFixed(1)}%` : money(String(Math.round(b)))}
                    </td>
                    <td className="r">
                      <Delta now={a} before={b} points={points} invert={invert} />
                    </td>
                    <td className="page-sub wrap">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
