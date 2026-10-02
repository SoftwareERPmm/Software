/**
 * Six sets of observations, one row per supplier.
 *
 * The queries in lib/queries.ts say what happened. lib/supplier-metrics.ts
 * says what good looks like. This is the join between them: it does the
 * arithmetic each metric needs, hands the raw figure and its sample size to
 * scoreMetric, and returns rows the radar, the table and the CSV all read.
 * One path, so the three cannot disagree.
 *
 * Pure. Nothing here reaches the database, so every calculation can be
 * checked against numbers worked out by hand.
 */

import {
  METRICS, scoreMetric, DEFAULT_THRESHOLDS, DEFAULT_TARGETS,
  type MetricId, type MetricResult, type Thresholds, type Targets,
} from "./supplier-metrics";
import {
  resolveCommitments, scoreOnTime, totalOnTime, onTimePercent, averageDelay,
  type OnTimeResult,
} from "./supplier-commitments";

const num = (s: string | number | null | undefined) => Number(s ?? 0);

export type PerformanceInputs = {
  suppliers: { partner_id: string; code: string; name: string;
               spend: string; invoices: number }[];
  commitments: {
    partner_id: string; order_line_id: string; ordered_qty: string;
    order_open: boolean;
    partner_code?: string; partner_name?: string;
    confirmations: { id: string; qty: number; confirmedDate: string;
                     kind: string; recordedOn: string }[];
    receipts: { date: string; qty: number }[];
  }[];
  fulfilment: {
    partner_id: string; ordered: string; received: string; lines: number;
    partner_code?: string; partner_name?: string;
  }[];
  leadTimes: { partner_id: string; days: number; qty: string }[];
  prices: { partner_id: string; item_id: string; currency: string;
            qty: string; unit_price: string }[];
  completeness: { partner_id: string; completed_orders: number;
                  single_receipt_orders: number }[];
  variance: { partner_id: string; invoices: number; with_variance: number }[];
  /** End of the reporting period. Everything is judged as at this date. */
  cutoff: string;
  thresholds?: Thresholds;
  targets?: Targets;
};

/**
 * How much of a supplier's spend the price comparison could actually see.
 *
 * A supplier selling things nobody else sells has no competitiveness score,
 * and one where only a tenth of spend is comparable has a score about a
 * tenth of their business. Both are worth saying out loud rather than
 * leaving a confident-looking axis to imply otherwise.
 */
export type PriceCoverage = {
  /** Items bought from this supplier and at least one other. */
  comparableItems: number;
  /** Items bought from this supplier at all. */
  totalItems: number;
  /** Share of this supplier's purchase value the comparison covers, 0-1. */
  spendCovered: number;
};

export type SupplierPerformance = {
  partnerId: string;
  code: string;
  name: string;
  spend: number;
  metrics: Record<MetricId, MetricResult>;
  /** Operational figures for the KPI row, in their own units. */
  actuals: {
    onTime: OnTimeResult;
    onTimePct: number | null;
    averageDelayDays: number | null;
    fulfilmentPct: number | null;
    averageLeadDays: number | null;
    /** How often this supplier has moved a date they gave. */
    supplierRevisions: number;
  };
  priceCoverage: PriceCoverage;
};

/** Quantity-weighted mean, or null when there is no weight at all. */
function weightedMean(pairs: { value: number; weight: number }[]): number | null {
  const w = pairs.reduce((t, p) => t + p.weight, 0);
  if (w <= 0) return null;
  return pairs.reduce((t, p) => t + p.value * p.weight, 0) / w;
}

/**
 * Coefficient of variation of lead times, weighted by quantity.
 *
 * Null when the mean is zero or missing: a CV is a ratio to the mean, and
 * dividing by nothing would produce an infinity that clamps to a confident
 * zero — a supplier scored terrible because their data was unusable.
 */
function leadTimeCV(obs: { days: number; qty: number }[]): number | null {
  const mean = weightedMean(obs.map((o) => ({ value: o.days, weight: o.qty })));
  if (mean === null || mean <= 0) return null;
  const variance = weightedMean(
    obs.map((o) => ({ value: (o.days - mean) ** 2, weight: o.qty })));
  if (variance === null) return null;
  return Math.sqrt(variance) / mean;
}

export function buildPerformance(input: PerformanceInputs): SupplierPerformance[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const targets = input.targets ?? DEFAULT_TARGETS;

  // ------------------------------------------------------------- prices --
  // The reference price for an item is what everybody else paid for it, so
  // it has to be built across suppliers before any one supplier is scored.
  type PriceObs = { partner: string; item: string; qty: number; price: number };
  const priceObs: PriceObs[] = input.prices.map((p) => ({
    // Currency is folded into the item key rather than ignored: two prices
    // in different currencies are not comparable, and today they are all
    // MMK so this changes nothing and protects everything.
    partner: p.partner_id, item: `${p.item_id}:${p.currency}`,
    qty: num(p.qty), price: num(p.unit_price),
  }));

  const byItem = new Map<string, PriceObs[]>();
  for (const o of priceObs) {
    const list = byItem.get(o.item) ?? [];
    list.push(o);
    byItem.set(o.item, list);
  }

  // -------------------------------------------------------------- build --
  // The supplier list is assembled here rather than by the caller. It was
  // the caller's job, and the page and the CSV export did it differently:
  // the page added suppliers that had orders but no invoices, the export
  // did not, so a supplier who was ordered from and delivered nothing —
  // precisely the one this report exists to surface — appeared on screen
  // and was missing from the file somebody took to the meeting.
  // Their own name, carried on the rows that found them. It used to be a
  // placeholder dash, which put an anonymous row in the comparison table —
  // and the supplier most likely to appear this way is one who was ordered
  // from and invoiced nothing, which is exactly the row somebody needs to
  // be able to identify.
  const seen = new Map(input.suppliers.map((s) => [s.partner_id, s]));
  const add = (
    id: string, code: string | undefined, name: string | undefined,
  ) => {
    if (seen.has(id)) return;
    seen.set(id, {
      partner_id: id, code: code ?? "", name: name ?? "Unnamed supplier",
      spend: "0", invoices: 0,
    });
  };
  for (const c of input.commitments) add(c.partner_id, c.partner_code, c.partner_name);
  for (const f of input.fulfilment) add(f.partner_id, f.partner_code, f.partner_name);

  return [...seen.values()].map((s) => {
    const id = s.partner_id;

    // --- on-time delivery -------------------------------------------------
    const lines = input.commitments.filter((c) => c.partner_id === id);
    let revisions = 0;
    const perLine = lines.map((l) => {
      const resolved = resolveCommitments(
        l.confirmations as never, l.receipts, num(l.ordered_qty));
      revisions += resolved.supplierRevisions;
      return scoreOnTime(resolved.baseline, l.receipts, input.cutoff);
    });
    const onTime = totalOnTime(perLine);
    const onTimePct = onTimePercent(onTime);
    // Sample size is the number of committed lines that were actually due —
    // a supplier with one due line has a percentage, but not one worth
    // putting on a chart.
    const onTimeN = perLine.filter((p) => p.due > 0).length;

    // --- order fulfilment -------------------------------------------------
    const f = input.fulfilment.find((x) => x.partner_id === id);
    const fulfilmentPct = f && num(f.ordered) > 0
      ? (100 * num(f.received)) / num(f.ordered) : null;

    // --- lead-time consistency --------------------------------------------
    const lt = input.leadTimes
      .filter((x) => x.partner_id === id)
      .map((x) => ({ days: x.days, qty: num(x.qty) }));
    const cv = leadTimeCV(lt);
    const averageLeadDays = weightedMean(
      lt.map((o) => ({ value: o.days, weight: o.qty })));

    // --- price competitiveness --------------------------------------------
    const mine = priceObs.filter((o) => o.partner === id);
    const items = new Set(mine.map((o) => o.item));
    let comparableItems = 0;
    let coveredValue = 0;
    const premiums: { value: number; weight: number }[] = [];

    for (const item of items) {
      const all = byItem.get(item) ?? [];
      const others = all.filter((o) => o.partner !== id);
      if (others.length === 0) continue;

      const reference = weightedMean(
        others.map((o) => ({ value: o.price, weight: o.qty })));
      if (reference === null || reference <= 0) continue;

      const ours = mine.filter((o) => o.item === item);
      const ourPrice = weightedMean(
        ours.map((o) => ({ value: o.price, weight: o.qty })));
      if (ourPrice === null) continue;

      const value = ours.reduce((t, o) => t + o.qty * o.price, 0);
      comparableItems += 1;
      coveredValue += value;
      // Weighted by what we spend, so the item the business actually buys
      // decides the score rather than the one bought once by the box.
      // As a percentage, because premiumCeiling is one. Keeping the two in
      // different units is what scored a 20% premium as "0.2%".
      premiums.push({
        value: (100 * (ourPrice - reference)) / reference, weight: value,
      });
    }

    const myValue = mine.reduce((t, o) => t + o.qty * o.price, 0);
    const premium = premiums.length > 0 ? weightedMean(premiums) : null;

    // --- price stability ---------------------------------------------------
    // Against the supplier's own average for each item, not against anybody
    // else's: this is about whether their quote holds, not its level.
    const deviations: { value: number; weight: number }[] = [];
    let priceObservations = 0;
    for (const item of items) {
      const ours = mine.filter((o) => o.item === item);
      if (ours.length < 2) continue;
      const ref = weightedMean(ours.map((o) => ({ value: o.price, weight: o.qty })));
      if (ref === null || ref <= 0) continue;
      priceObservations += ours.length;
      const dev = weightedMean(ours.map((o) => ({
        value: (100 * Math.abs(o.price - ref)) / ref, weight: o.qty,
      })));
      if (dev === null) continue;
      deviations.push({ value: dev, weight: ours.reduce((t, o) => t + o.qty * o.price, 0) });
    }
    const deviation = deviations.length > 0 ? weightedMean(deviations) : null;

    // --- delivery completeness ---------------------------------------------
    const dc = input.completeness.find((x) => x.partner_id === id);
    const completenessPct = dc && dc.completed_orders > 0
      ? (100 * dc.single_receipt_orders) / dc.completed_orders : null;

    // --- matching variance --------------------------------------------------
    const mv = input.variance.find((x) => x.partner_id === id);
    const varianceShare = mv && mv.invoices > 0
      ? mv.with_variance / mv.invoices : null;

    const metrics = {
      on_time_delivery: scoreMetric("on_time_delivery", onTimePct, onTimeN, thresholds, targets),
      order_fulfillment: scoreMetric("order_fulfillment", fulfilmentPct, f?.lines ?? 0, thresholds, targets),
      lead_time_consistency: scoreMetric("lead_time_consistency", cv, lt.length, thresholds, targets),
      price_competitiveness: scoreMetric("price_competitiveness", premium, comparableItems, thresholds, targets),
      price_stability: scoreMetric("price_stability", deviation, priceObservations, thresholds, targets),
      delivery_completeness: scoreMetric("delivery_completeness", completenessPct, dc?.completed_orders ?? 0, thresholds, targets),
      matching_variance: scoreMetric("matching_variance", varianceShare === null ? null : varianceShare * 100, mv?.invoices ?? 0, thresholds, targets),
      return_performance: scoreMetric("return_performance", null, 0, thresholds, targets),
      quantity_accuracy: scoreMetric("quantity_accuracy", null, 0, thresholds, targets),
      quality_acceptance: scoreMetric("quality_acceptance", null, 0, thresholds, targets),
    } as Record<MetricId, MetricResult>;

    return {
      partnerId: id,
      code: s.code,
      name: s.name,
      spend: num(s.spend),
      metrics,
      actuals: {
        onTime,
        onTimePct,
        averageDelayDays: averageDelay(onTime),
        fulfilmentPct,
        averageLeadDays,
        supplierRevisions: revisions,
      },
      priceCoverage: {
        comparableItems,
        totalItems: items.size,
        spendCovered: myValue > 0 ? coveredValue / myValue : 0,
      },
    };
  });
}

/**
 * Raw measurements read differently per metric, so formatting lives beside
 * the definitions rather than in whichever component needed it first.
 */
export function formatRaw(id: MetricId, raw: number | null): string {
  if (raw === null) return "—";
  const def = METRICS[id];
  if (id === "lead_time_consistency") return raw.toFixed(2);
  return `${raw.toFixed(1)}${def.unit}`;
}

/**
 * One supplier, month by month.
 *
 * Three series, not seven. A price premium is measured against what other
 * suppliers charged for the same item, and a month in which nobody else
 * bought it has no reference price at all — the line would be mostly gaps
 * joined by straight segments that look like measurements. Metrics without
 * an honest monthly value get no trend rather than a decorative one.
 *
 * The same definitions as the headline figures, applied to a narrower
 * window: on-time re-scores each month's commitments with that month's end
 * as the cutoff, so a month reads as it read at the time rather than being
 * improved by deliveries that came later.
 */
export type TrendPoint = {
  month: string;
  onTimePct: number | null;
  fulfilmentPct: number | null;
  leadDays: number | null;
};

export function buildTrend(input: {
  commitments: PerformanceInputs["commitments"];
  leadTimes: { month: string; days: number; qty: string }[];
  fulfilment: { month: string; ordered: string; received: string }[];
  /** Inclusive month bounds, "YYYY-MM". */
  from: string;
  to: string;
}): TrendPoint[] {
  const months: string[] = [];
  {
    const [fy, fm] = input.from.split("-").map(Number);
    const [ty, tm] = input.to.split("-").map(Number);
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); ) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }

  // Resolve every line once, then ask each month what it owed.
  const resolved = input.commitments.map((l) => ({
    baseline: resolveCommitments(
      l.confirmations as never, l.receipts, num(l.ordered_qty)).baseline,
    receipts: l.receipts,
  }));

  const points = months.map((month) => {
    const end = monthEnd(month);

    const perLine = resolved.map((r) =>
      scoreOnTime(r.baseline.filter((b) => b.date.slice(0, 7) === month),
        r.receipts, end));
    const onTime = totalOnTime(perLine);

    const f = input.fulfilment.find((x) => x.month === month);
    const lt = input.leadTimes.filter((x) => x.month === month);
    const leadWeight = lt.reduce((t, x) => t + num(x.qty), 0);

    return {
      month,
      onTimePct: onTimePercent(onTime),
      fulfilmentPct: f && num(f.ordered) > 0
        ? (100 * num(f.received)) / num(f.ordered) : null,
      leadDays: leadWeight > 0
        ? lt.reduce((t, x) => t + x.days * num(x.qty), 0) / leadWeight : null,
    };
  });

  // Trim empty months off each end, keep the ones in the middle.
  //
  // They are different facts. Ten blank months before the first order are
  // "we had not started buying from them", which is not about the supplier
  // and squashes a year of history into the last inch of the axis. A blank
  // month between two busy ones is "we ordered nothing that month", which
  // is worth seeing and is why the lines break rather than joining across.
  const has = (p: TrendPoint) =>
    p.onTimePct !== null || p.fulfilmentPct !== null || p.leadDays !== null;
  const first = points.findIndex(has);
  if (first === -1) return [];
  let last = points.length - 1;
  while (last > first && !has(points[last])) last -= 1;
  return points.slice(first, last + 1);
}

/** Last day of a "YYYY-MM", without pulling in a date library. */
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
