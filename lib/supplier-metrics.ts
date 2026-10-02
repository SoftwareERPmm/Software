/**
 * What "a good supplier" means, written down once.
 *
 * A radar chart is five numbers on one scale, and the scale is the whole
 * argument: whoever decides that 85% on-time becomes a 70 has decided what
 * the picture says. Scattering those decisions across the page that draws
 * the chart, the table under it and the export beside it guarantees the
 * three eventually disagree, and a supplier review turns into an argument
 * about which screen is right.
 *
 * So every metric is declared here — what it measures, in what unit, which
 * direction is good, how many observations it needs before it will speak,
 * and how its raw measurement becomes a 0-100 axis. The calculation lives
 * in lib/queries.ts because it is SQL over posted documents; everything
 * about *meaning* lives here.
 *
 * Pure: no database, no React. It takes raw measurements and returns scored
 * ones, so the normalization can be tested against known numbers.
 *
 * Three rules this file exists to enforce
 * ---------------------------------------
 * 1. **An unavailable metric is null, never zero.** Zero is a score; null is
 *    the absence of one. A supplier with no comparable prices is not a
 *    supplier with terrible prices, and a radar that fills the gap with 0
 *    accuses them of something the data never said.
 * 2. **A business target is not a normalization boundary.** "We want 95%
 *    fulfilment" is a goal. "0% fulfilment scores 0 and 100% scores 100" is
 *    a scale. Conflating them means moving the target silently redraws
 *    history, so they are separate fields and stay separate.
 * 3. **There is no overall score.** Averaging five axes invents a sixth
 *    number with no unit, no owner and no defensible weighting, and it is
 *    the first number anyone quotes. The comparison table sorts by real
 *    measurements instead.
 */

/** Which way is good. Used for sorting and for reading a raw figure aloud. */
export type Direction = "higher" | "lower";

export type MetricId =
  | "on_time_delivery"
  | "order_fulfillment"
  | "lead_time_consistency"
  | "price_competitiveness"
  | "price_stability"
  | "delivery_completeness"
  | "matching_variance"
  | "return_performance"
  | "quantity_accuracy"
  | "quality_acceptance";

/**
 * Why a metric cannot be calculated here yet. Surfaced to the user verbatim:
 * "not enough data" invites a support ticket, "nothing records supplier
 * inspections" tells them what would have to change.
 */
export type Unsupported = {
  supported: false;
  /** The missing ingredient, in the user's terms. */
  requires: string;
};

export type Supported = {
  supported: true;
  /** Fewest observations before the metric will report rather than abstain. */
  minObservations: number;
  /**
   * Raw measurement to a 0-100 axis value.
   *
   * `thresholds` carries the normalization boundaries — never the business
   * target. Returns null when the raw figure cannot be scored at all.
   */
  normalize: (raw: number, thresholds: Thresholds) => number | null;
};

export type MetricDefinition = {
  id: MetricId;
  name: string;
  /** One line, shown under the name. What it measures, not how. */
  description: string;
  /** How the raw measurement reads: "%", " days". Concatenated, so it
   *  carries its own leading space where one is wanted. */
  unit: string;
  direction: Direction;
  /** The formula and its caveats, shown in the methodology panel and in the
   *  tooltip. Written for the person being asked to act on the number. */
  methodology: string;
  /** Which documents it reads, so a wrong-looking figure can be traced. */
  dataSource: string;
} & (Supported | Unsupported);

/**
 * The boundaries that turn a measurement into an axis value.
 *
 * Every one of these is an illustrative default, not a discovered truth.
 * They are here so the first chart draws; a company is expected to set its
 * own, and the settings page says so in as many words.
 */
export type Thresholds = {
  /** Lead-time consistency: the coefficient of variation scoring 0. A CV of
   *  0.5 means the spread of delivery times is half the average delivery
   *  time, which is a supplier nobody can plan around. */
  cvLimit: number;
  /** Price competitiveness: the premium over the reference price scoring 0,
   *  as a percentage. 20 = paying a fifth over the going rate. */
  premiumCeiling: number;
  /** Price stability: the deviation from a supplier's own average price
   *  scoring 0, as a percentage. */
  deviationCeiling: number;
  /** Matching variance: the share of invoices carrying a variance that
   *  scores 0, as a percentage. */
  varianceCeiling: number;
};

/**
 * Percentages, not fractions — except cvLimit, which is a ratio because a
 * coefficient of variation is one.
 *
 * They were fractions, and the raw measurements handed to them were
 * percentages. A supplier paying a 20% premium displayed as "0.2%" and
 * scored 0, which read as a formatting quirk beside a broken score and was
 * in fact one bug: two units for one quantity. Everything measured in
 * percent is now in percent on both sides of the division.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  cvLimit: 0.5,
  premiumCeiling: 20,
  deviationCeiling: 15,
  varianceCeiling: 20,
};

/**
 * Business targets — what the company wants, shown beside the score as a
 * line to clear. Deliberately a different shape and a different object from
 * Thresholds: these move when the business decides to expect more, and
 * nothing about the scale moves with them.
 */
export type Targets = Partial<Record<MetricId, number>>;

export const DEFAULT_TARGETS: Targets = {
  on_time_delivery: 90,
  order_fulfillment: 95,
  delivery_completeness: 80,
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** A percentage that is already on the right scale. Capped, because an
 *  over-receipt must not score above 100 and call it excellence. */
const asPercent = (raw: number) => clamp(raw);

export const METRICS: Record<MetricId, MetricDefinition> = {
  on_time_delivery: {
    id: "on_time_delivery",
    name: "On-time delivery",
    description:
      "Quantity that arrived by the date the supplier confirmed.",
    unit: "%",
    direction: "higher",
    methodology:
      "100 × quantity received on or before the confirmed date ÷ quantity "
      + "due in the period. Scored against the earliest date the supplier "
      + "confirmed for the line, not the latest — a supplier who moves the "
      + "date twice and then hits it has still missed the promise they made. "
      + "Quantities not yet due are excluded; overdue and unreceived counts "
      + "against the supplier. Lines the supplier never confirmed are out of "
      + "the cohort entirely: 'Needed by' on the order is our requirement, "
      + "not their commitment, and scoring against it would measure the "
      + "buyer.",
    dataSource: "Purchase orders, their confirmations, and goods receipts",
    supported: true,
    minObservations: 3,
    normalize: asPercent,
  },

  order_fulfillment: {
    id: "order_fulfillment",
    name: "Order fulfillment",
    description: "Share of the quantity due that actually arrived.",
    unit: "%",
    direction: "higher",
    methodology:
      "100 × quantity received against due order lines ÷ quantity ordered "
      + "and due. Receipts are allocated line by line through the same "
      + "fulfilment links the order screens use, so a receipt raised against "
      + "the invoice rather than the order is still counted. Over-receipts "
      + "are capped at the quantity ordered. Lines on an order closed with a "
      + "reason leave the denominator from the date it was closed — a "
      + "cancellation the buyer asked for is not a supplier failure — and "
      + "an amended order is measured at the version standing now.",
    dataSource: "Purchase orders, fulfilment links, goods receipts",
    supported: true,
    minObservations: 3,
    normalize: asPercent,
  },

  lead_time_consistency: {
    id: "lead_time_consistency",
    name: "Lead-time consistency",
    description: "How predictable this supplier's delivery times are.",
    unit: "",
    direction: "lower",
    methodology:
      "Actual lead time is counted in days from the order's document date to "
      + "each goods receipt's document date, weighted by the quantity on that "
      + "receipt so a large late shipment counts for more than a token early "
      + "one. The spread is the coefficient of variation — standard deviation "
      + "÷ mean — and the score is 100 × max(0, 1 − CV ÷ limit). "
      + "This measures predictability, not punctuality: a supplier who always "
      + "takes exactly 30 days scores 100 here even if they promised 10. "
      + "On-time delivery is the metric that judges the promise.",
    dataSource: "Purchase orders and goods receipts",
    supported: true,
    minObservations: 4,
    normalize: (cv, t) =>
      !Number.isFinite(cv) || cv < 0 ? null : clamp(100 * (1 - cv / t.cvLimit)),
  },

  price_competitiveness: {
    id: "price_competitiveness",
    name: "Price competitiveness",
    description: "What this supplier charges against everyone else selling it.",
    unit: "%",
    direction: "lower",
    methodology:
      "For each item bought from more than one supplier in the period, the "
      + "reference price is the quantity-weighted average unit price paid to "
      + "the other suppliers. Premium = (this supplier's price − reference) ÷ "
      + "reference, aggregated by purchase value so the items you actually "
      + "spend on dominate. Score = 100 × (1 − premium ÷ ceiling), clamped, "
      + "so meeting or beating the reference scores 100. Only identical items "
      + "in the same base unit and currency are compared; an item only ever "
      + "bought from one supplier contributes nothing, because there is "
      + "nothing to compare it with.",
    dataSource: "Posted purchase invoice lines",
    supported: true,
    minObservations: 2,
    normalize: (premium, t) =>
      !Number.isFinite(premium) ? null : clamp(100 * (1 - premium / t.premiumCeiling)),
  },

  price_stability: {
    id: "price_stability",
    name: "Price stability",
    description: "How much this supplier's own prices move.",
    unit: "%",
    direction: "lower",
    methodology:
      "For each item, the reference is this supplier's quantity-weighted "
      + "average unit price for it across the period. Deviation is the "
      + "quantity-weighted mean absolute difference from that reference, as "
      + "a fraction, aggregated across items by purchase value. "
      + "Score = 100 × (1 − deviation ÷ ceiling), clamped. A supplier who is "
      + "expensive but never changes scores well here: this is about whether "
      + "a quote can be relied on, and price competitiveness is where the "
      + "level is judged.",
    dataSource: "Posted purchase invoice lines",
    supported: true,
    minObservations: 4,
    normalize: (dev, t) =>
      !Number.isFinite(dev) || dev < 0
        ? null
        : clamp(100 * (1 - dev / t.deviationCeiling)),
  },

  delivery_completeness: {
    id: "delivery_completeness",
    name: "Delivery completeness",
    description: "Orders that arrived in one shipment rather than several.",
    unit: "%",
    direction: "higher",
    methodology:
      "100 × orders fully received in a single goods receipt ÷ orders fully "
      + "received in the period. Only completed orders are eligible: an order "
      + "still arriving has not yet failed to arrive at once. This measures "
      + "the shipping pattern, not the quantity — an order that eventually "
      + "arrives complete across four receipts scores 100 on fulfilment and "
      + "0 here, and both are true. Nothing in the schema records that a "
      + "split shipment was agreed in advance, so an agreed split is "
      + "indistinguishable from an unplanned one and counts against the "
      + "supplier; read this one with that in mind.",
    dataSource: "Purchase orders and goods receipts",
    supported: true,
    minObservations: 3,
    normalize: asPercent,
  },

  matching_variance: {
    id: "matching_variance",
    name: "Matching variance",
    description:
      "Invoices whose price or quantity disagreed with the order or receipt.",
    unit: "%",
    direction: "lower",
    methodology:
      "Share of posted purchase invoices where an invoiced quantity exceeds "
      + "what was received against the same order, or an invoiced unit price "
      + "differs from the ordered unit price. Score = 100 × (1 − share ÷ "
      + "ceiling), clamped. "
      + "Deliberately NOT called invoice accuracy: nothing in the schema "
      + "distinguishes a supplier overcharging from our own buyer keying the "
      + "order wrong, or from a price change both sides agreed and nobody "
      + "wrote down. A variance here is a flag to go and look, not a finding "
      + "of fault, and it should not be shown to a supplier as one.",
    dataSource: "Purchase orders, goods receipts and purchase invoices",
    supported: true,
    minObservations: 3,
    normalize: (share, t) =>
      !Number.isFinite(share) || share < 0
        ? null
        : clamp(100 * (1 - share / t.varianceCeiling)),
  },

  // ---------------------------------------------------------------- absent --
  // Three metrics the spec asks for that this database cannot answer. They
  // are declared rather than omitted so the page can name what is missing
  // and what would have to exist, instead of silently offering four axes
  // where the customer was promised seven.

  return_performance: {
    id: "return_performance",
    name: "Return performance",
    description: "Goods sent back because the supplier got them wrong.",
    unit: "%",
    direction: "lower",
    methodology:
      "100 × (1 − returned quantity attributable to the supplier ÷ received "
      + "quantity). Cannot be calculated: a purchase return records what went "
      + "back and to whom, but not why. Returning goods because the customer "
      + "cancelled, because the buyer over-ordered, and because the supplier "
      + "shipped the wrong thing are the same row. Treating every return as a "
      + "supplier defect would penalise suppliers for our own decisions.",
    dataSource: "Purchase returns — present, but with no reason recorded",
    supported: false,
    requires:
      "A reason on each purchase return line, distinguishing supplier fault "
      + "from a change of mind on our side.",
  },

  quantity_accuracy: {
    id: "quantity_accuracy",
    name: "Quantity accuracy",
    description:
      "Whether what the supplier said they shipped matched what arrived.",
    unit: "%",
    direction: "higher",
    methodology:
      "100 × correctly declared quantity ÷ declared quantity. Cannot be "
      + "calculated: a goods receipt records the quantity counted on arrival "
      + "and nothing else. There is no second figure to compare it against, "
      + "so any score would be comparing the receipt with itself and would "
      + "read 100% for every supplier forever.",
    dataSource: "Nothing records a supplier-declared shipment quantity",
    supported: false,
    requires:
      "A declared quantity captured from the supplier's packing note, stored "
      + "separately from the quantity counted at the door.",
  },

  quality_acceptance: {
    id: "quality_acceptance",
    name: "Quality acceptance",
    description: "Share of inspected goods accepted.",
    unit: "%",
    direction: "higher",
    methodology:
      "100 × accepted inspected quantity ÷ inspected quantity. Cannot be "
      + "calculated: there are no inspection records of any kind. Inferring "
      + "quality from the absence of complaints would score a supplier nobody "
      + "has checked identically to one checked and found perfect.",
    dataSource: "No inspection records exist",
    requires:
      "Goods inspection: quantity inspected, quantity accepted, and the "
      + "receipt it belongs to.",
    supported: false,
  },
};

/**
 * The radar as it opens.
 *
 * Not the five the brief named. Three of those — return performance, quality
 * and invoice accuracy as such — have no honest data behind them, and a
 * default that leaves two axes permanently blank teaches people to ignore
 * blanks. These five all measure something real today.
 */
export const DEFAULT_RADAR: MetricId[] = [
  "on_time_delivery",
  "order_fulfillment",
  "lead_time_consistency",
  "price_competitiveness",
  "delivery_completeness",
];

export const MIN_RADAR_AXES = 3;
export const MAX_RADAR_AXES = 6;

/** Every metric that can be put on a chart today. */
export const supportedMetrics = (): MetricDefinition[] =>
  Object.values(METRICS).filter((m) => m.supported);

/**
 * One metric, measured for one supplier.
 *
 * `raw` and `score` are both kept: the axis needs the score, and the person
 * arguing with the axis needs the measurement it came from.
 */
export type MetricResult = {
  id: MetricId;
  /** The measurement in its own unit. Null when it could not be measured. */
  raw: number | null;
  /** 0-100. Null when unavailable, insufficient, or unsupported — never 0. */
  score: number | null;
  /** How many observations stood behind it. */
  n: number;
  /** Why there is no score, in the user's terms. Null when there is one. */
  unavailable: string | null;
  /** The target in force, for the "against" column. Null when none is set. */
  target: number | null;
};

/**
 * Score one raw measurement, or explain why it cannot be scored.
 *
 * The one place a null becomes a reason. Everything that draws or exports a
 * metric goes through here, so the chart, the table and the CSV cannot
 * develop different opinions about what counts as enough data.
 */
export function scoreMetric(
  id: MetricId,
  raw: number | null,
  n: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  targets: Targets = DEFAULT_TARGETS,
): MetricResult {
  const def = METRICS[id];
  const target = targets[id] ?? null;

  if (!def.supported) {
    return { id, raw: null, score: null, n: 0, unavailable: def.requires, target };
  }
  if (raw === null || !Number.isFinite(raw)) {
    return {
      id, raw: null, score: null, n,
      unavailable: "No transactions in this period could be measured.",
      target,
    };
  }
  if (n < def.minObservations) {
    return {
      id, raw, score: null, n,
      unavailable:
        `Needs ${def.minObservations} comparable observations to be meaningful; `
        + `this period has ${n}.`,
      target,
    };
  }

  const score = def.normalize(raw, thresholds);
  return {
    id, raw, score,
    n,
    unavailable: score === null ? "Could not be scored from this measurement." : null,
    target,
  };
}

/**
 * Identifies which rules produced a stored figure.
 *
 * Bumped when a formula or a default boundary changes, so a saved preset or
 * an exported file can say which version of the arithmetic it came from
 * rather than being silently reinterpreted by the next one.
 */
export const CALC_VERSION = 1;

/**
 * A company's stored settings laid over the defaults.
 *
 * Partial by design. A company that has set only an on-time target keeps
 * picking up later changes to every boundary it has not opinions about,
 * and a stored row full of copied defaults would freeze them at whatever
 * they happened to be the day somebody first opened the settings page.
 *
 * Unknown keys are dropped and out-of-range numbers are ignored rather
 * than clamped: a threshold of zero would score every supplier zero, and
 * silently turning it into something sensible would hide the mistake from
 * whoever made it.
 */
export function resolveThresholds(
  stored: Record<string, unknown> | null | undefined,
): Thresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!stored) return out;
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const v = stored[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

export function resolveTargets(
  stored: Record<string, unknown> | null | undefined,
): Targets {
  const out: Targets = { ...DEFAULT_TARGETS };
  if (!stored) return out;
  for (const id of Object.keys(METRICS) as MetricId[]) {
    const v = stored[id];
    // Null is meaningful and distinct from absent: it is a company saying
    // "we have no target for this", which clears the default rather than
    // falling back to it.
    if (v === null) delete out[id];
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[id] = v;
  }
  return out;
}

/** Only ids that exist and are measurable, in the order given. */
export function sanitizeAxes(raw: unknown): MetricId[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: MetricId[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || seen.has(v)) continue;
    const def = (METRICS as Record<string, MetricDefinition>)[v];
    if (!def || !def.supported) continue;
    seen.add(v);
    out.push(def.id);
  }
  return out.length >= MIN_RADAR_AXES ? out.slice(0, MAX_RADAR_AXES) : null;
}
