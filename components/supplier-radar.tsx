"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, Tooltip, Legend,
} from "recharts";
import { METRICS, type MetricId, type MetricResult } from "@/lib/supplier-metrics";
import { formatRaw } from "@/lib/supplier-performance";

export type RadarSupplier = {
  partnerId: string;
  name: string;
  metrics: Record<MetricId, MetricResult>;
};

/**
 * Five or so axes, and the honesty to leave one blank.
 *
 * A radar chart's whole rhetorical force is that the shape is filled in.
 * The temptation, when a metric cannot be measured, is to drop the axis or
 * put a zero on it — the first quietly changes what is being compared
 * between two suppliers, and the second accuses a supplier of being bad at
 * something nobody measured. So an unmeasurable axis stays on the chart,
 * carries no point, and is labelled as unavailable: the gap in the outline
 * is the information.
 *
 * Recharts joins across a null, which would draw a straight line through a
 * missing axis and look like a measurement. The area is therefore drawn
 * with `connectNulls` off and every null left as a hole.
 */
export function SupplierRadar({
  axes, suppliers,
}: {
  axes: MetricId[];
  /** One supplier, or two to compare. Both are scored identically. */
  suppliers: RadarSupplier[];
}) {
  const data = useMemo(() => axes.map((id) => {
    const row: Record<string, unknown> = {
      axis: METRICS[id].name,
      metricId: id,
    };
    for (const s of suppliers) {
      row[s.partnerId] = s.metrics[id]?.score ?? null;
      row[`${s.partnerId}__raw`] = s.metrics[id]?.raw ?? null;
      row[`${s.partnerId}__why`] = s.metrics[id]?.unavailable ?? null;
    }
    return row;
  }), [axes, suppliers]);

  const colours = ["var(--brand)", "var(--accent-2, #B4691A)"];

  // How much of the chart is actually drawable. A radar whose points are
  // all absent is a bare web, which reads as a broken chart rather than as
  // a supplier nobody has enough history for — and the reason sits in a
  // table further down the page that nobody scrolls to first.
  const scored = (s: RadarSupplier) =>
    axes.filter((id) => s.metrics[id]?.score !== null && s.metrics[id]?.score !== undefined).length;
  const best = Math.max(...suppliers.map(scored));

  if (best === 0) {
    return (
      <div className="empty">
        <strong>Not enough history to chart yet</strong>
        <p className="page-sub">
          {suppliers.length > 1
            ? "Neither supplier has"
            : `${suppliers[0].name} does not have`}{" "}
          enough comparable transactions in this period for any of the{" "}
          {axes.length} axes to be scored. Each metric needs a handful of
          observations before a figure means anything — the table below says
          how many each one has and how many it wants. Widen the dates, or
          wait for more orders.
        </p>
      </div>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={340}>
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="var(--line)" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
          />
          <PolarRadiusAxis
            domain={[0, 100]} tickCount={5} axisLine={false}
            tick={{ fill: "var(--muted)", fontSize: 9 }}
          />
          {suppliers.map((s, i) => (
            <Radar
              key={s.partnerId}
              name={s.name}
              dataKey={s.partnerId}
              stroke={colours[i % colours.length]}
              fill={colours[i % colours.length]}
              fillOpacity={suppliers.length > 1 ? 0.14 : 0.22}
              connectNulls={false}
              dot
              // Off deliberately. The animation grows the shape out from the
              // centre, so anything that captures the first frame — a
              // screenshot, a print, a PDF taken for a supplier review —
              // gets an empty chart that looks like a supplier scoring zero
              // on everything. A dashboard figure has to be right the
              // instant it is on screen.
              isAnimationActive={false}
            />
          ))}
          <Tooltip content={<RadarTooltip suppliers={suppliers} />} />
          {suppliers.length > 1 && (
            <Legend wrapperStyle={{ fontSize: "0.78rem", color: "var(--muted)" }} />
          )}
        </RadarChart>
      </ResponsiveContainer>

      {/* Said on the chart, not only in the table underneath it: a gap in
          the outline is deliberate and should not be read as a zero. */}
      {suppliers.map((s) => {
        const missing = axes.length - scored(s);
        if (missing === 0) return null;
        return (
          <p className="page-sub" key={s.partnerId}>
            {suppliers.length > 1 ? `${s.name}: ` : ""}
            {missing} of {axes.length} axes could not be scored, so{" "}
            {missing === 1 ? "it carries" : "they carry"} no point rather than
            a zero.
          </p>
        );
      })}
    </div>
  );
}

/**
 * The measurement, the score, and how the one became the other.
 *
 * All three, because the score is the only one drawn and it is the least
 * informative: "85" means nothing without "8.5% premium over the reference
 * price" beside it and the rule that turned one into the other underneath.
 */
function RadarTooltip({ active, payload, suppliers }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const id = row.metricId as MetricId;
  const def = METRICS[id];

  return (
    <div
      className="card"
      style={{
        padding: "0.55rem 0.7rem", fontSize: "0.78rem", maxWidth: "20rem",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>{def.name}</div>
      {suppliers.map((s: RadarSupplier) => {
        const score = row[s.partnerId] as number | null;
        const raw = row[`${s.partnerId}__raw`] as number | null;
        const why = row[`${s.partnerId}__why`] as string | null;
        return (
          <div key={s.partnerId} style={{ marginBottom: "0.25rem" }}>
            {suppliers.length > 1 && (
              <div style={{ color: "var(--muted)" }}>{s.name}</div>
            )}
            {score === null ? (
              <div style={{ color: "var(--muted)" }}>{why ?? "No score"}</div>
            ) : (
              <div className="m">
                {formatRaw(id, raw)} → {Math.round(score)}/100
              </div>
            )}
          </div>
        );
      })}
      <div style={{
        color: "var(--muted)", marginTop: "0.35rem", paddingTop: "0.35rem",
        borderTop: "1px solid var(--line)", fontSize: "0.72rem", lineHeight: 1.45,
      }}>
        {def.methodology.slice(0, 180)}
        {def.methodology.length > 180 ? "…" : ""}
      </div>
    </div>
  );
}
