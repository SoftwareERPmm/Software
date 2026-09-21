"use client";

import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, LabelList, Cell, PieChart, Pie,
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

/**
 * The dashboard's revenue bars.
 *
 * Its own chart rather than a variant of RevenueTrendChart, because the two
 * are answering different questions. That one is a trend line with a grid and
 * axes, read for shape; this is six columns read for size, with the current
 * month picked out so the eye lands on it first.
 *
 * Months with nothing posted keep their place at zero. A gap in trading is
 * information, and a chart that quietly drops the month says the opposite of
 * what happened.
 */
export function RevenueBars({
  data,
}: { data: { month: string; revenue: number | string }[] }) {
  const rows = data.map((d) => ({ month: monthLabel(d.month), revenue: Number(d.revenue) }));
  const last = rows.length - 1;
  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: "var(--muted)" }}
          dy={6}
        />
        <Tooltip
          cursor={{ fill: "color-mix(in srgb, var(--brand) 6%, transparent)" }}
          content={<ChartTooltip />}
        />
        <Bar dataKey="revenue" radius={[6, 6, 0, 0]} maxBarSize={46}>
          {rows.map((_, i) => (
            <Cell
              key={i}
              fill={i === last
                ? "var(--brand)"
                : "color-mix(in srgb, var(--brand) 22%, transparent)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * A share-of-revenue donut — by item category, by customer region, by
 * anything where the question is "how much, and in what proportions".
 *
 * A donut rather than a full pie: the hole carries the total, so the chart
 * answers "how much, and in what proportions" in one shape instead of
 * needing a figure printed beside it.
 *
 * The palette is fixed and ordered, biggest slice first, so a category keeps
 * its colour between the arc and the legend. It deliberately starts on the
 * interface green the rest of the dashboard uses and moves away from it,
 * rather than being six unrelated hues.
 */
const SLICE_COLOURS = [
  "var(--brand)",   // the app's green, for the biggest share
  "#E8A33D",        // amber
  "#3D7FE8",        // blue
  "#7A5CD6",        // violet
  "#2FA8A0",        // teal
  "#C25B7C",        // rose
];

function SliceTooltip({ active, payload, total }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const share = total > 0 ? Math.round((p.value / total) * 100) : 0;
  return (
    <div
      className="card"
      style={{ padding: "0.4rem 0.6rem", fontSize: "0.78rem", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
    >
      <div style={{ color: "var(--muted)" }}>{p.name}</div>
      <div className="m" style={{ fontWeight: 600 }}>{money(p.value)} · {share}%</div>
    </div>
  );
}

export function ShareDonut({
  data, currency,
}: {
  data: { id: string; name: string; revenue: number | string; qty?: number | string }[];
  currency: string;
}) {
  const rows = data.map((d) => ({ id: d.id, name: d.name, value: Number(d.revenue) }));
  const total = rows.reduce((t, r) => t + r.value, 0);
  if (rows.length === 0 || total <= 0) {
    return <div className="empty">Nothing to show for the last six months.</div>;
  }

  return (
    <div className="donut-wrap">
      <div className="donut-chart">
        <ResponsiveContainer width="100%" height={190}>
          <PieChart>
            <Pie
              data={rows} dataKey="value" nameKey="name"
              cx="50%" cy="50%" innerRadius={52} outerRadius={82}
              paddingAngle={rows.length > 1 ? 2 : 0} stroke="var(--card)" strokeWidth={2}
            >
              {rows.map((r, i) => (
                <Cell key={r.id} fill={SLICE_COLOURS[i % SLICE_COLOURS.length]} />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
        {/* The total sits in the hole, where the eye already is. */}
        <div className="donut-centre" aria-hidden="true">
          <span className="donut-centre-label">{currency}</span>
          <span className="donut-centre-value">{money(total)}</span>
        </div>
      </div>

      <ul className="donut-legend">
        {rows.map((r, i) => (
          <li key={r.id}>
            <span className="donut-dot" style={{ background: SLICE_COLOURS[i % SLICE_COLOURS.length] }} />
            <span className="donut-name">{r.name}</span>
            <span className="donut-share">{Math.round((r.value / total) * 100)}%</span>
            <span className="donut-value">{money(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
