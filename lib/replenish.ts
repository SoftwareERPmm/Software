/**
 * What to buy, worked out once.
 *
 * The replenishment page and the dashboard card both answer "what needs
 * ordering", and two copies of that arithmetic would eventually disagree —
 * which is worse than either answer alone, because then neither can be
 * trusted. So the rule lives here and both call it.
 *
 * Pure: it takes rows that the caller has already fetched and returns rows.
 * Nothing here reaches the database, so it can be reasoned about and tested
 * without one.
 */

export type ReplenishInputs = {
  /** Items that can actually be bought and held — no products-with-variants. */
  items: { id: string; code: string; name: string; uom_code: string; variant: unknown }[];
  stockByLocation: { item_id: string; location_id: string; qty_on_hand: string }[];
  reserved: { item_id: string; location_id: string; reserved_qty: string }[];
  incoming: { item_id: string; location_id: string; incoming_qty: string }[];
  reorderPoints: { item_id: string; location_id: string; min_qty: string }[];
  consumption: { item_id: string; location_id: string; issued: string }[];
  supply: {
    item_id: string; supplier_id: string | null; supplier_name: string | null;
    /** This supplier's usual speed, if anybody recorded one. */
    supplier_days: number | null;
    /** The exception for this item from them, where one exists. */
    item_days: number | null;
  }[];
  /** What each supplier has actually taken — quantity-weighted over their
   *  recent receipts. Advisory: it never sets the figure a suggestion uses. */
  observed: { partner_id: string; observed_days: number; sample: number }[];
  windowDays: number;
  coverDays: number;
  /** Which warehouses count — all of them, or the one being looked at. */
  here: (locationId: string) => boolean;
  /** Assumed when an item has never been bought, so has no supplier to ask. */
  fallbackLeadDays: number;
};

export type ReplenishRow = {
  id: string; code: string; name: string; variant: unknown; uom: string;
  supplier: string | null; supplierId: string | null;
  /** The expected lead time, and only ever that: what somebody configured.
   *  This is the number the suggestion is built from. */
  leadTime: number;
  /** Which level of the hierarchy answered, so a screen can say so. */
  leadSource: "item" | "supplier" | "default";
  /** What the receipts say actually happened, and how much that rests on.
   *  Null when this supplier has no measurable history. */
  measuredDays: number | null;
  measuredSample: number;
  /** Reality has drifted far enough from the plan to be worth a look.
   *  Never acted on automatically — somebody decides. */
  reviewSuggested: boolean;
  onHand: number; reserved: number; incoming: number;
  available: number; projected: number;
  perDay: number; daysLeft: number | null;
  orderBy: string | null; suggest: number;
  urgency: "now" | "soon" | "ok";
};

/** Short of a minimum somebody set, but nothing has sold, so the run rate
 *  has nothing to say. Reported apart rather than suggested as nought. */
export type QuietRow = {
  id: string; code: string; name: string; variant: unknown;
  short: number; uom: string;
};

const round = (n: number) => Math.round(n * 100) / 100;

export function replenishment(input: ReplenishInputs): {
  rows: ReplenishRow[]; quiet: QuietRow[];
} {
  const {
    items, stockByLocation, reserved, incoming, reorderPoints, consumption,
    supply, observed, windowDays, coverDays, here, fallbackLeadDays,
  } = input;

  const supplyOf = new Map(supply.map((s) => [s.item_id, s]));
  const seenOf = new Map(observed.map((o) => [o.partner_id, o]));

  /** Across the warehouses in scope — all of them, or the one chosen. */
  const sum = (rows: { item_id: string; location_id: string }[],
               itemId: string, field: string) =>
    rows.filter((r) => r.item_id === itemId && here(r.location_id))
        .reduce((t, r) => t + Number((r as never as Record<string, string>)[field]), 0);

  /**
   * The expected lead time: most specific setting wins.
   *
   *   supplier_item  this item from this supplier is an exception
   *   supplier       what they usually take
   *   company        what to assume knowing nothing
   *
   * Each level is nullable and falls through, so a row is only worth
   * creating where something genuinely differs. Null is "no exception",
   * never "zero days".
   *
   * What the receipts say is deliberately not in this chain. Measured
   * performance is returned alongside so a manager can see the plan
   * drifting from reality, but it does not quietly replace a figure
   * somebody chose — or the suggestion stops being explainable, and
   * nobody can say why the system ordered what it ordered.
   */
  const leadOf = (supplierId: string | null,
                  itemDays: number | null, supplierDays: number | null) => {
    const seen = supplierId ? seenOf.get(supplierId) : undefined;
    const measuredDays = seen ? Number(seen.observed_days) : null;
    const measuredSample = seen?.sample ?? 0;

    const expected =
      itemDays !== null && itemDays !== undefined
        ? { leadTime: Number(itemDays), leadSource: "item" as const }
        : supplierDays !== null && supplierDays !== undefined
          ? { leadTime: Number(supplierDays), leadSource: "supplier" as const }
          : { leadTime: fallbackLeadDays, leadSource: "default" as const };

    /*
     * Worth a look when the gap is both material and believable: three
     * days or more, on at least two receipts. One late container is not a
     * trend, and flagging every day of noise trains people to ignore it.
     */
    const reviewSuggested =
      measuredDays !== null && measuredSample >= 2 &&
      Math.abs(measuredDays - expected.leadTime) >= 3;

    return { ...expected, measuredDays, measuredSample, reviewSuggested };
  };

  const rows: ReplenishRow[] = [];
  const quiet: QuietRow[] = [];

  for (const i of items) {
    const issued = sum(consumption, i.id, "issued");
    const onHand = sum(stockByLocation, i.id, "qty_on_hand");
    const res = sum(reserved, i.id, "reserved_qty");
    const inc = sum(incoming, i.id, "incoming_qty");
    const available = onHand - res;
    const projected = available + inc;

    const sup = supplyOf.get(i.id);
    const lead = leadOf(sup?.supplier_id ?? null,
                        sup?.item_days ?? null, sup?.supplier_days ?? null);
    const leadTime = lead.leadTime;

    if (issued <= 0) {
      const rp = reorderPoints.find((r) => r.item_id === i.id && here(r.location_id));
      if (rp && projected < Number(rp.min_qty)) {
        quiet.push({ id: i.id, code: i.code, name: i.name, variant: i.variant,
                     short: round(Number(rp.min_qty) - projected), uom: i.uom_code });
      }
      continue;
    }

    const perDay = issued / windowDays;
    const target = perDay * (coverDays + leadTime);
    const suggest = Math.max(0, Math.ceil(target - projected));
    if (suggest <= 0) continue;

    /*
     * When does what is actually available run out, and how much slack is
     * there before an order must go in to beat it?
     *
     * The slack stays unrounded for the urgency test and is only floored
     * for the date. Flooring first made a line read "order by today" while
     * the count of things to order today stayed at nought — 0.9 days of
     * slack floors to 0 but is not <= 0.
     */
    const daysLeft = available / perDay;
    const slack = daysLeft - leadTime;

    rows.push({
      id: i.id, code: i.code, name: i.name, variant: i.variant, uom: i.uom_code,
      supplier: sup?.supplier_name ?? null, supplierId: sup?.supplier_id ?? null,
      leadTime, leadSource: lead.leadSource,
      measuredDays: lead.measuredDays, measuredSample: lead.measuredSample,
      reviewSuggested: lead.reviewSuggested,
      onHand, reserved: res, incoming: inc, available, projected,
      perDay: round(perDay), daysLeft: round(daysLeft),
      orderBy: new Date(Date.now() + Math.max(0, Math.floor(slack)) * 86400000)
        .toISOString().slice(0, 10),
      suggest,
      // Less than a day of slack is today's problem.
      urgency: slack < 1 ? "now" : slack < 8 ? "soon" : "ok",
    });
  }

  const rank = { now: 0, soon: 1, ok: 2 } as const;
  rows.sort((a, b) => rank[a.urgency] - rank[b.urgency]
                   || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  return { rows, quiet };
}
