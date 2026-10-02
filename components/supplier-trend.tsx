"use client";

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import type { TrendPoint } from "@/lib/supplier-performance";

/**
 * Three series a month at a time, and nothing else.
 *
 * On-time and fulfilment share a percentage axis; lead time is in days and
 * gets its own on the right, because plotting days against percent on one
 * scale makes an eleven-day lead time look like eleven percent of
 * something.
 *
 * Gaps are gaps. A month with no orders due has no on-time figure, and
 * `connectNulls` stays off so the line breaks rather than drawing straight
 * through a month nobody measured.
 */
export function SupplierTrend({ data, name }: { data: TrendPoint[]; name: string }) {
  const measured = data.filter(
    (d) => d.onTimePct !== null || d.fulfilmentPct !== null || d.leadDays !== null);

  if (measured.length < 2) {
    return (
      <p className="page-sub">
        A trend needs at least two months with something in them. {name} has{" "}
        {measured.length === 0 ? "none" : "one"} in this period — widen the
        dates, or there is simply not enough history yet.
      </p>
    );
  }

  const label = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return new Date(Date.UTC(y, mm - 1, 1))
      .toLocaleDateString("en-GB", { month: "short" });
  };

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="month" tickFormatter={label} axisLine={false} tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }}
        />
        <YAxis
          yAxisId="pct" domain={[0, 100]} width={34} axisLine={false} tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
        />
        <YAxis
          yAxisId="days" orientation="right" width={34} axisLine={false} tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
        />
        <Tooltip content={<TrendTooltip />} />
        <Legend wrapperStyle={{ fontSize: "0.75rem", color: "var(--muted)" }} />
        <Line
          yAxisId="pct" dataKey="onTimePct" name="On-time %"
          stroke="var(--brand)" strokeWidth={2} dot={{ r: 2 }}
          connectNulls={false} isAnimationActive={false}
        />
        <Line
          yAxisId="pct" dataKey="fulfilmentPct" name="Fulfillment %"
          stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 3"
          dot={{ r: 2 }} connectNulls={false} isAnimationActive={false}
        />
        <Line
          yAxisId="days" dataKey="leadDays" name="Lead time (days)"
          stroke="#B4691A" strokeWidth={1.5} dot={{ r: 2 }}
          connectNulls={false} isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const [y, m] = String(label).split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return (
    <div className="card" style={{
      padding: "0.45rem 0.65rem", fontSize: "0.78rem",
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    }}>
      <div style={{ color: "var(--muted)" }}>{month}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="m">
          {p.name}: {p.value === null || p.value === undefined
            ? "—" : Number(p.value).toFixed(1)}
        </div>
      ))}
    </div>
  );
}
