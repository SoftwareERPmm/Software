/**
 * The window the dashboard's period figures are measured over.
 *
 * One place decides it, because the revenue total, the bars, the top-selling
 * items and both donuts have to be talking about the same stretch of time —
 * four cards each doing their own date arithmetic is how a dashboard ends up
 * contradicting itself.
 *
 * Windows are whole calendar months. "Last 3 months" means this month and the
 * two before it, not the last ninety days: a trading month is the unit people
 * compare, and a rolling ninety days silently cuts one in half.
 */
export type PeriodSpec = "1m" | "3m" | "6m" | "12m" | string;

export type Period = {
  /** What goes back in the URL. */
  key: string;
  /** For a heading: "This month", "Last 6 months", "August 2026". */
  label: string;
  /** Inside a sentence: "this month", "the last 6 months", "August 2026". */
  phrase: string;
  /** For a picker sitting inside a card header, where space is short. */
  short: string;
  /** Inclusive first day, exclusive last day, both YYYY-MM-DD. */
  from: string;
  to: string;
  /** How many months of bars to draw, and the month they end at. */
  chartMonths: number;
  chartAnchor: string;
  /** Set when one specific month was asked for, rather than a trailing span. */
  month: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const firstOf = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const monthName = (y: number, m: number) =>
  firstOf(y, m).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

const SPANS: Record<string, { months: number; label: string; phrase: string; short: string }> = {
  "1m": { months: 1, label: "This month", phrase: "this month", short: "1M" },
  "3m": { months: 3, label: "Last 3 months", phrase: "the last 3 months", short: "3M" },
  "6m": { months: 6, label: "Last 6 months", phrase: "the last 6 months", short: "6M" },
  "12m": { months: 12, label: "Last 12 months", phrase: "the last 12 months", short: "12M" },
};

/** The spans the picker offers, in order. */
export const PERIOD_SPANS = ["1m", "3m", "6m", "12m"] as const;

export const DEFAULT_PERIOD = "6m";

export function resolvePeriod(spec: string | undefined, today = new Date()): Period {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();

  // One named month — "2026-08". Anything unparseable falls back to the
  // default rather than erroring: a hand-edited URL should not break a page.
  const named = /^(\d{4})-(\d{2})$/.exec(spec ?? "");
  if (named) {
    const yy = Number(named[1]), mm = Number(named[2]) - 1;
    if (mm >= 0 && mm <= 11) {
      return {
        key: `${named[1]}-${named[2]}`,
        label: monthName(yy, mm),
        phrase: monthName(yy, mm),
        short: firstOf(yy, mm).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
        from: iso(firstOf(yy, mm)),
        to: iso(firstOf(yy, mm + 1)),
        // Six months of context around the month chosen, so a single bar is
        // never the whole chart — the point of picking a month is to see it
        // against its neighbours.
        chartMonths: 6,
        chartAnchor: iso(firstOf(yy, mm)),
        month: `${named[1]}-${named[2]}`,
      };
    }
  }

  const span = SPANS[spec ?? ""] ?? SPANS[DEFAULT_PERIOD];
  const key = Object.keys(SPANS).find((k) => SPANS[k] === span) ?? DEFAULT_PERIOD;
  return {
    key,
    label: span.label,
    phrase: span.phrase,
    short: span.short,
    from: iso(firstOf(y, m - (span.months - 1))),
    to: iso(firstOf(y, m + 1)),
    // A single month still gets half a year of bars behind it.
    chartMonths: Math.max(span.months, 6),
    chartAnchor: iso(firstOf(y, m)),
    month: null,
  };
}
