"use client";

import { useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, LabelList,
} from "recharts";
import { money } from "@/lib/format";
import { CycleGauge } from "@/components/cycle-gauge";
import { HelpHint } from "@/components/help-hint";

type Metrics = {
  from: string; to: string; days: number;
  revenue: number; cogs: number;
  inventory: number; receivable: number; payable: number;
  dio: number | null; dso: number | null; dpo: number | null; ccc: number | null;
  currentRatio: number | null; quickRatio: number | null;
};

type Point = {
  label: string; ccc: number | null;
  dio: number | null; dso: number | null; dpo: number | null;
};

const d0 = (v: number | null) => (v === null ? "—" : Math.round(v).toString());

/**
 * The four spans, once, so both charts colour them the same.
 *
 * DIO blue and DSO amber matched nothing in particular until they also had
 * to match the bars beside them; a reader comparing the two charts should
 * not have to work out that the amber line and the amber bar are the same
 * thing.
 */
const SERIES = [
  { key: "dio", name: "DIO", colour: "#3D7FE8" },
  { key: "dso", name: "DSO", colour: "#E8A33D" },
  { key: "dpo", name: "DPO", colour: "#7FBF9B" },
  { key: "ccc", name: "CCC", colour: "var(--brand)" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];
type Hidden = Partial<Record<SeriesKey, boolean>>;

/**
 * A legend you can switch off.
 *
 * Four spans on one axis is three too many when the question is whether
 * receivables alone moved. Clicking a key drops that span out of both
 * charts and clicking it again brings it back.
 *
 * Hiding changes what is drawn and never what is counted: the waterfall
 * leaves the gap where a hidden bar stood rather than closing up, because
 * closing up would silently restate the cycle as though that span were
 * zero.
 */
function ChartLegend({ hidden, toggle }: {
  hidden: Hidden;
  toggle: (k: SeriesKey) => void;
}) {
  return (
    <div className="chart-legend">
      {SERIES.map((sr) => {
        const off = !!hidden[sr.key];
        return (
          <button key={sr.key} type="button" aria-pressed={!off}
                  className={off ? "off" : undefined}
                  onClick={() => toggle(sr.key)}
                  title={off ? `Show ${sr.name}` : `Hide ${sr.name}`}>
            <span className="chart-legend-swatch"
                  style={{ borderColor: sr.colour,
                           background: off ? "transparent" : sr.colour }} />
            {sr.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A change in days, said the way a reader needs it.
 *
 * Direction alone is not the answer: fewer days receivable is good and fewer
 * days payable is not, because paying later is free funding. So "better" is
 * a property of the span, not of the arrow.
 */
function Delta({ now, before, betterWhenLower = true }: {
  now: number | null; before: number | null; betterWhenLower?: boolean;
}) {
  if (now === null || before === null) {
    return <span className="subline">no comparable period</span>;
  }
  const diff = now - before;
  if (Math.abs(diff) < 0.5) return <span className="subline">unchanged</span>;
  const better = betterWhenLower ? diff < 0 : diff > 0;
  return (
    <span className="subline" style={{ color: better ? "var(--brand)" : "var(--warn)" }}>
      {diff < 0 ? "▼" : "▲"} {Math.abs(Math.round(diff))} days vs previous period
    </span>
  );
}

/** A ratio's change. Unlike a span, higher is the safer direction. */
function Ratio({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null) {
    return <span className="subline">no comparable period</span>;
  }
  const diff = now - before;
  if (Math.abs(diff) < 0.005) return <span className="subline">unchanged</span>;
  return (
    <span className="subline" style={{ color: diff > 0 ? "var(--brand)" : "var(--warn)" }}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff).toFixed(2)} vs previous period
    </span>
  );
}

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: "0.4rem 0.6rem", fontSize: "0.78rem" }}>
      <strong>{label}</strong>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value === null ? "—" : Math.round(p.value)} days
        </div>
      ))}
    </div>
  );
}

export function CashCycle({
  current, previous, trend, currency,
}: {
  current: Metrics; previous: Metrics; trend: Point[]; currency: string;
}) {
  const c = current;
  const unanswerable = c.ccc === null;

  /*
   * A waterfall, not four bars side by side.
   *
   * Each span begins where the last one ended: the goods sit for DIO days,
   * then the customer takes DSO more, and paying the supplier DPO days in
   * pulls the whole thing back. The cycle is the gap between where the last
   * bar lands and where the first one started — which is the point, and is
   * invisible if every bar starts from zero.
   *
   * Recharts draws a floating bar from a [low, high] pair, so each step
   * carries its own base rather than being stacked on a transparent one.
   */
  const [hidden, setHidden] = useState<Hidden>({});
  const toggle = (k: SeriesKey) =>
    setHidden((h) => ({ ...h, [k]: !h[k] }));

  const dio = c.dio ?? 0, dso = c.dso ?? 0, dpo = c.dpo ?? 0, ccc = c.ccc ?? 0;
  const afterDio = dio;
  const afterDso = dio + dso;
  const afterDpo = afterDso - dpo;
  const waterfall = [
    { key: "dio" as SeriesKey, name: "DIO", sub: "Inventory", delta: dio,
      range: [0, afterDio], colour: "#3D7FE8", on: "#FFFFFF" },
    { key: "dso" as SeriesKey, name: "DSO", sub: "Receivable", delta: dso,
      range: [afterDio, afterDso], colour: "#E8A33D", on: "#12161C" },
    { key: "dpo" as SeriesKey, name: "DPO", sub: "Payable", delta: -dpo,
      range: [afterDpo, afterDso], colour: "#7FBF9B", on: "#12161C" },
    // --brand is dark on a light theme and light on a dark one; --surface
    // inverts with it, so the figure stays legible in both.
    { key: "ccc" as SeriesKey, name: "CCC", sub: "Days", delta: ccc,
      range: [Math.min(0, ccc), Math.max(0, ccc)],
      colour: "var(--brand)", on: "var(--surface)" },
  ];
  const off = (k: SeriesKey) => !!hidden[k];

  const rows = [
    {
      key: "dio", label: "Days inventory", sense: "Goods sit on the shelf",
      now: c.dio, before: previous.dio, betterWhenLower: true,
      balance: c.inventory, base: c.cogs, baseLabel: "Cost of sales",
      formula: "Avg inventory / COGS × days",
    },
    {
      key: "dso", label: "Days receivable", sense: "Customers take to pay",
      now: c.dso, before: previous.dso, betterWhenLower: true,
      balance: c.receivable, base: c.revenue, baseLabel: "Revenue",
      formula: "Avg receivable / Revenue × days",
    },
    {
      key: "dpo", label: "Days payable", sense: "We take to pay suppliers",
      now: c.dpo, before: previous.dpo, betterWhenLower: false,
      balance: c.payable, base: c.cogs, baseLabel: "Cost of sales",
      formula: "Avg payable / COGS × days",
    },
  ];

  const suspicious =
    (c.dso !== null && c.dso > 120) || (c.dpo !== null && c.dpo > 120) ||
    (c.dio !== null && c.dio > 180);

  return (
    <>
      <section>
        <div className="ccc-top">
          <div className="dash-card dash-card-pad">
            <div className="dash-section-head">
              <div>
                <h2 style={{ fontSize: "var(--t-md)" }}>
                  Cash conversion cycle
                  <HelpHint label="How the cycle is worked out">
                    DIO + DSO − DPO.
                    <br /><br />
                    Days of trading you must fund between paying for goods and
                    being paid for them. Negative means the goods are sold and
                    collected before their bill falls due — suppliers are
                    funding the business.
                    <br /><br />
                    Year-end closing entries are excluded: closing a year
                    empties revenue and cost of sales into retained earnings,
                    and a cycle divided by nil revenue is a missing figure, not
                    a large one.
                  </HelpHint>
                </h2>
              </div>
            </div>
            {unanswerable ? (
              <div className="empty">
                Not enough trading in this period. The cycle needs revenue and
                cost of sales to divide by, and one of them is nil.
              </div>
            ) : (
              <>
                <div style={{
                  fontSize: "2.2rem", fontWeight: 700, lineHeight: 1.1,
                  color: c.ccc! < 0 ? "var(--brand)" : "var(--ink)",
                }}>
                  {d0(c.ccc)} days
                </div>
                <Delta now={c.ccc} before={previous.ccc} />
                <div className="hintbar" style={{ marginTop: "0.6rem" }}>
                  {c.ccc! < 0
                    ? "Cash is released before you pay suppliers."
                    : "Days of trading to fund between paying for goods and being paid."}
                </div>
              </>
            )}
          </div>

          {/* Scales differ per span on purpose: days payable runs far longer
              than days inventory in any real trade. */}
          <CycleGauge value={c.dio} max={180} label="Days Inventory (DIO)"
                      hint="Goods sit on the shelf"
                      explain={<>
                        Average inventory ÷ cost of sales × days in the period.
                        <br /><br />
                        How long stock waits between arriving and being sold.
                        Lower means less money standing on the shelf — but too
                        low and you are running out.
                      </>} />
          <CycleGauge value={c.dso} max={180} label="Days Receivable (DSO)"
                      hint="Customers take to pay"
                      explain={<>
                        Average receivable ÷ revenue × days in the period.
                        <br /><br />
                        How long a customer takes to pay after being invoiced.
                        Lower is better: it is your money sitting in their till.
                      </>} />
          <CycleGauge value={c.dpo} max={600} label="Days Payable (DPO)"
                      hint="We take to pay suppliers" invert
                      explain={<>
                        Average payable ÷ cost of sales × days in the period.
                        <br /><br />
                        How long you take to pay a supplier. <strong>Higher is
                        better here</strong> — an unpaid bill is free funding —
                        which is why this dial runs the other way. Pushed too
                        far it costs you the relationship.
                      </>} />

          <div className="dash-card dash-card-pad">
            <div className="dash-section-head">
              <div>
                <h2 style={{ fontSize: "var(--t-md)" }}>
                  Current ratio
                  <HelpHint label="How the current ratio is worked out">
                    Current assets ÷ current liabilities.
                    <br /><br />
                    Whether what you hold, or expect within the year, covers
                    what falls due within it. Below 1 means it does not.
                    <br /><br />
                    Read from the chart&rsquo;s own <strong>Current
                    Assets</strong> and <strong>Current Liabilities</strong>
                    headings — current versus fixed is a position in the chart,
                    not a type of account.
                  </HelpHint>
                </h2>
              </div>
            </div>
            <div style={{ fontSize: "1.9rem", fontWeight: 700, lineHeight: 1.15 }}>
              {c.currentRatio === null ? "—" : c.currentRatio.toFixed(2)}
            </div>
            <Ratio now={c.currentRatio} before={previous.currentRatio} />

            <div className="dash-section-head" style={{ marginTop: "0.9rem" }}>
              <div>
                <h2 style={{ fontSize: "var(--t-md)" }}>
                  Quick ratio
                  <HelpHint label="How the quick ratio is worked out">
                    (Current assets − inventory) ÷ current liabilities.
                    <br /><br />
                    The same test without the stock, because stock has to be
                    sold before it can pay anybody. The stricter of the two,
                    and the one that matters if trade slows.
                  </HelpHint>
                </h2>
              </div>
            </div>
            <div style={{ fontSize: "1.9rem", fontWeight: 700, lineHeight: 1.15 }}>
              {c.quickRatio === null ? "—" : c.quickRatio.toFixed(2)}
            </div>
            <Ratio now={c.quickRatio} before={previous.quickRatio} />
          </div>
        </div>
      </section>

      <section>
        <div className="dash-split">
          <div className="dash-card dash-card-pad">
            <div className="dash-section-head">
              <div>
                <h2>CCC trend</h2>
                <span className="dash-sub">
                  each point a rolling twelve months — a single month of a
                  seasonal trade reads as brilliance or disaster
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                <Tooltip content={<Tip />} />
                <ReferenceLine y={0} stroke="var(--muted)" />
                <Line type="monotone" dataKey="dio" name="DIO" hide={!!hidden.dio} stroke="#3D7FE8" dot={{ r: 2 }} />
                <Line type="monotone" dataKey="dso" name="DSO" hide={!!hidden.dso} stroke="#E8A33D" dot={{ r: 2 }} />
                <Line type="monotone" dataKey="dpo" name="DPO" hide={!!hidden.dpo} stroke="#7FBF9B" dot={{ r: 2 }} />
                <Line type="monotone" dataKey="ccc" name="CCC" hide={!!hidden.ccc} stroke="var(--brand)"
                      strokeWidth={2.2} dot={{ r: 2.5 }} />
              </LineChart>
            </ResponsiveContainer>
            <ChartLegend hidden={hidden} toggle={toggle} />
          </div>

          <div className="dash-card dash-card-pad">
            <div className="dash-section-head">
              <div>
                <h2>What makes up the cycle</h2>
                <span className="dash-sub">
                  inventory and receivables push it out, payables pull it in
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={waterfall} margin={{ top: 18, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="var(--muted)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                <ReferenceLine y={0} stroke="var(--muted)" />
                <Bar dataKey="range" radius={[3, 3, 3, 3]}>
                  {/* Outside the bar whichever way it points — "top" puts a
                      negative bar's label underneath the axis, on top of the
                      bar it belongs to. */}
                  {/* The step, not the bar's own extent — a floating bar's
                      value is a pair, and what a reader wants is how far
                      this span moved the cycle. */}
                  {/* The step, not the bar's own extent — a floating bar's
                      value is a pair, and what a reader wants is how far
                      this span moved the cycle. Inside the bar where there
                      is room for it, just outside where there is not, and
                      under a bar that hangs below the axis rather than on
                      top of the bar it belongs to. */}
                  <LabelList dataKey="delta"
                             content={(props: any) => {
                               const { x, y, width, height, index } = props;
                               const w = waterfall[index as number];
                               if (!w || off(w.key)) return null;
                               const d = w.delta;
                               const inside = height >= 18;
                               return (
                                 <text
                                   x={x + width / 2}
                                   y={inside ? y + height / 2
                                             : d < 0 ? y + height + 13 : y - 6}
                                   textAnchor="middle"
                                   dominantBaseline={inside ? "central" : undefined}
                                   style={{ fontSize: 11, fontWeight: 600,
                                            fill: inside ? w.on : "var(--ink)" }}>
                                   {d > 0 ? "+" : ""}{Math.round(d)} days
                                 </text>
                               );
                             }} />
                  {waterfall.map((w) => (
                    <Cell key={w.name} fill={off(w.key) ? "transparent" : w.colour} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <ChartLegend hidden={hidden} toggle={toggle} />
          </div>
        </div>
      </section>

      {suspicious && (
        <section>
          <div className="card">
            <div className="card-body">
              <div className="hintbar caution">
                <strong>These spans look long.</strong> On a young ledger, or one
                where little has been settled, that usually means invoices and
                bills are still open rather than that money is moving slowly.
                The table below says which figures produced them.
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Key metrics</h2>
            <span className="page-sub">
              every span, with the two figures behind it
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="r">Days</th>
                  <th className="r">Previous</th>
                  <th>Change</th>
                  <th className="r">Average balance</th>
                  <th className="r">Annualised base</th>
                  <th>Formula</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="wrap">
                      <strong>{r.label}</strong>
                      <div className="subline">{r.sense}</div>
                    </td>
                    <td className="r"><strong>{d0(r.now)}</strong></td>
                    <td className="r">{d0(r.before)}</td>
                    <td>
                      <Delta now={r.now} before={r.before}
                             betterWhenLower={r.betterWhenLower} />
                    </td>
                    <td className="r">{money(r.balance)}</td>
                    <td className="r">
                      {money(r.base)}
                      <div className="subline">{r.baseLabel} · {currency}</div>
                    </td>
                    <td className="wrap subline">{r.formula}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>
                    Cash conversion cycle — {d0(c.dio)} + {d0(c.dso)} − {d0(c.dpo)}
                  </td>
                  <td className="r"><strong>{d0(c.ccc)} days</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
