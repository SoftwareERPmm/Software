"use client";

import { useState } from "react";
import { MeasureBars } from "@/components/charts";

export type Row = {
  key: string; code: string; name: string;
  qty: number; revenue: number; unmatched: number;
  cost: number; margin: number;
  marginPct: number | null; discount: number; returned: number;
};

/**
 * One chart, several questions.
 *
 * Net sales, cost, profit, margin and units are five answers about the same
 * five things, and five charts would be five places to look. A measure
 * picker keeps the shape of the page still and changes only what is in it —
 * which also makes the comparison honest, because the bars stay in the same
 * order whichever measure is showing.
 */
const PERIOD = [
  ["revenue", "Net sales", "money"],
  ["cost", "COGS", "money"],
  ["margin", "Gross profit", "money"],
  ["marginPct", "Margin %", "percent"],
  ["qty", "Units", "plain"],
  ["discount", "Discounts given", "money"],
  ["returned", "Returns", "money"],
  ["unmatched", "Not yet shipped", "money"],
] as const;

type Measure = (typeof PERIOD)[number][0];

export function BreakdownPerformance({ rows, label }: {
  rows: Row[]; label: string;
}) {
  const MEASURES = PERIOD;
  const [measure, setMeasure] = useState<Measure>("revenue");
  /* Switching basis drops whichever measure the other one had and this one
     does not, so the fallback is what keeps the chart on screen instead of
     reading a label off nothing. */
  const chosen = MEASURES.find((m) => m[0] === measure) ?? MEASURES[0];
  const active = chosen[0];

  const data = rows.slice(0, 6).map((r) => ({
    label: r.code || r.name,
    value: active === "marginPct" ? (r.marginPct ?? 0) : (r[active] as number),
  }));

  return (
    <div className="card">
      <div className="card-head">
        <h2>{label} performance</h2>
        <select value={active} aria-label="Measure"
                onChange={(e) => setMeasure(e.target.value as Measure)}>
          {MEASURES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
      </div>
      <div className="card-body">
        <div className="chartbox">
          <MeasureBars data={data} height={280} format={chosen[2]} />
        </div>
      </div>
    </div>
  );
}
