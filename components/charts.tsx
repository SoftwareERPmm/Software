"use client";

import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, LabelList, Cell, PieChart, Pie, Legend,
} from "recharts";
import { useRouter } from "next/navigation";
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
  compact = false,
}: {
  data: { label: string; value: number | string }[];
  height?: number;
  /**
   * Thinner bars and smaller labels, for a chart showing ten rows in the
   * space this one usually gives six. Six fat bars read better than six
   * thin ones, so the dashboard keeps what it has; ten at that weight are
   * a solid block with gaps in it.
   */
  compact?: boolean;
}) {
  const rows = data.map((d) => ({ label: d.label, value: Number(d.value) }));
  const bar = compact ? 8 : 16;
  const tick = compact ? 10 : 12;
  const axis = compact ? 96 : 110;
  const cut = compact ? 14 : 16;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical"
                margin={{ top: 4, right: compact ? 54 : 40, left: 4, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category" dataKey="label" axisLine={false} tickLine={false} width={axis}
          tick={{ fill: "var(--ink-soft)", fontSize: tick }}
          tickFormatter={(v: string) => (v.length > cut ? `${v.slice(0, cut - 1)}…` : v)}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--line-soft)" }} />
        <Bar dataKey="value" fill="var(--brand)" radius={[0, 4, 4, 0]} barSize={bar}>
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: unknown) => money(v as number)}
            style={{ fill: "var(--muted)", fontSize: compact ? 10 : 11, fontFamily: "var(--mono)" }}
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
  data, selected, hrefs,
}: {
  data: { month: string; revenue: number | string }[];
  /** The month this card is currently reporting on, as YYYY-MM. */
  selected?: string | null;
  /** Where each bar goes — built on the server so a click keeps whatever
   *  the other cards' pickers are set to. */
  hrefs?: Record<string, string>;
}) {
  const router = useRouter();
  const rows = data.map((d) => ({
    ym: d.month, month: monthLabel(d.month), revenue: Number(d.revenue),
  }));
  // Whichever month the figures above are about is the one picked out. With
  // no month chosen that is the newest bar, as it always was.
  const lit = selected
    ? rows.findIndex((r) => r.ym === selected)
    : rows.length - 1;
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
        {/* A bar is the way to ask for that month on its own — the whole
            dashboard follows, and the month keeps five behind it for
            context rather than becoming the entire chart. */}
        <Bar
          dataKey="revenue" radius={[6, 6, 0, 0]} maxBarSize={46}
          cursor="pointer"
          onClick={(_data: unknown, index: number) => {
            const href = hrefs?.[rows[index]?.ym ?? ""];
            // Same reason as the period links: the chart stays where it is.
            if (href) router.push(href, { scroll: false });
          }}
        >
          {rows.map((_, i) => (
            <Cell
              key={i}
              fill={i === lit
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
  data, currency, emptyLabel = "Nothing to show for the last six months.",
}: {
  data: {
    id: string; name: string; revenue: number | string; qty?: number | string;
    /** The gathered remainder. Grey, and outside the palette: it is not a
     *  thing that sold, it is everything the chart stopped naming, and
     *  giving it a colour of its own invites reading it as one more item. */
    rest?: boolean;
  }[];
  currency: string;
  /** Said by whoever is showing the chart: the dashboard means its own six
   *  months, a report means the period its filters are set to. */
  emptyLabel?: string;
}) {
  const rows = data.map((d) => ({
    id: d.id, name: d.name, value: Number(d.revenue), rest: !!d.rest,
  }));
  /* The remainder takes grey wherever it sits, and the named slices keep
     the palette in order regardless — so a colour means the same thing
     whether or not a remainder happens to be present. */
  const REST = "var(--line)";
  let n = 0;
  const colourOf = (r: { rest: boolean }) =>
    r.rest ? REST : SLICE_COLOURS[n++ % SLICE_COLOURS.length];
  const colours = rows.map(colourOf);
  const total = rows.reduce((t, r) => t + r.value, 0);
  if (rows.length === 0 || total <= 0) {
    return <div className="empty">{emptyLabel}</div>;
  }

  return (
    <div className="donut-wrap">
      <div className="donut-chart">
        <ResponsiveContainer width="100%" height={190}>
          <PieChart>
            <Pie
              data={rows} dataKey="value" nameKey="name"
              cx="50%" cy="50%" innerRadius={52} outerRadius={82}
              paddingAngle={rows.length > 1 ? 2 : 0} stroke="var(--surface)" strokeWidth={2}
            >
              {rows.map((r, i) => (
                <Cell key={r.id} fill={colours[i]} />
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
            <span className="donut-dot" style={{ background: colours[i] }} />
            <span className="donut-name">{r.name}</span>
            <span className="donut-share">{Math.round((r.value / total) * 100)}%</span>
            <span className="donut-value">{money(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Two series side by side, month by month — net sales against the gross
 * profit inside it.
 *
 * Grouped rather than stacked: stacking would read as sales *plus* profit,
 * which is nonsense, since the profit is already part of the sales beside
 * it. Side by side the gap between the pair is the cost, which is the thing
 * worth seeing.
 */
export function TwoSeriesBars({
  data, height = 240, aLabel, bLabel,
}: {
  data: { month: string; a: number | string; b: number | string }[];
  height?: number;
  aLabel: string;
  bLabel: string;
}) {
  const rows = data.map((d) => ({
    month: monthLabel(d.month), [aLabel]: Number(d.a), [bLabel]: Number(d.b),
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey="month" axisLine={false} tickLine={false}
               tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }} />
        <YAxis axisLine={false} tickLine={false} width={46}
               tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--mono)" }}
               tickFormatter={(v: number) =>
                 Math.abs(v) >= 1e6 ? `${Math.round(v / 1e5) / 10}M`
                 : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v)} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--line-soft)" }} />
        <Legend iconType="circle" iconSize={8}
                wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
        {/* The darker of the two is the bigger figure, so the pair reads
            in the same direction as the numbers. */}
        <Bar dataKey={aLabel} fill="var(--brand)" radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Bar dataKey={bLabel} fill="#6FBF95" radius={[3, 3, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}
