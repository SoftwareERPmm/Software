"use client";

import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, LabelList,
} from "recharts";
import { money } from "@/lib/format";

const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short" });
};

function ChartTooltip({ active, payload, label, valueLabel }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="card"
      style={{ padding: "0.4rem 0.6rem", fontSize: "0.78rem", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
    >
      <div style={{ color: "var(--muted)" }}>{label}</div>
      <div className="m" style={{ fontWeight: 600 }}>{valueLabel ?? money(payload[0].value)}</div>
    </div>
  );
}

/** Monthly revenue trend, including months with no postings — a flat/empty stretch is real information. */
export function RevenueTrendChart({ data }: { data: { month: string; revenue: number | string }[] }) {
  const rows = data.map((d) => ({ month: monthLabel(d.month), revenue: Number(d.revenue) }));
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="month" axisLine={false} tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }}
        />
        <YAxis hide />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--line)" }} />
        <Area type="monotone" dataKey="revenue" stroke="var(--brand)" strokeWidth={2} fill="url(#revenueFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** A horizontal ranked bar chart — top-selling items, top customers, anything "biggest N by X". */
export function RankedBarChart({
  data,
  height = 200,
}: {
  data: { label: string; value: number | string }[];
  height?: number;
}) {
  const rows = data.map((d) => ({ label: d.label, value: Number(d.value) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category" dataKey="label" axisLine={false} tickLine={false} width={110}
          tick={{ fill: "var(--ink-soft)", fontSize: 12 }}
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--line-soft)" }} />
        <Bar dataKey="value" fill="var(--brand)" radius={[0, 4, 4, 0]} barSize={16}>
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: unknown) => money(v as number)}
            style={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
