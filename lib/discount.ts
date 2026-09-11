/**
 * Working out which discounts a sale has earned.
 *
 * Three things get called "discount" and only one of them is typed by a
 * person. Keeping them apart is the whole point — an invoice showing 8% off
 * with nothing to say why is the thing this replaces:
 *
 *   Item discount    typed on the line, for this sale
 *   Volume discount  earned by the quantity bought (a QUANTITY band)
 *                    or by the invoice total (an INVOICE_TOTAL band)
 *   FOC              not a discount: extra goods at zero revenue, which
 *                    still leave the warehouse and still cost something
 *
 * Pure, and shared by the screen and the posting engine on purpose. A voucher
 * that previews one figure and posts another is worse than one that does not
 * preview at all, and two implementations of "which band applies" is exactly
 * how that happens.
 */

export type VolumeBand = {
  id: string;
  code: string;
  name: string;
  basis: "QUANTITY" | "INVOICE_TOTAL";
  item_id: string | null;
  item_group_id: string | null;
  min_value: string | number;
  max_value: string | number | null;
  discount_pct: string | number;
};

export type DiscountedLine = {
  itemId: string;
  itemGroupId?: string | null;
  qty: number;
  unitPrice: number;
  /** Typed on the line by whoever raised it. */
  discountPct: number;
};

export type LineDiscounts = {
  gross: number;
  /** Typed on the line. */
  itemDiscountPct: number;
  itemDiscountAmount: number;
  /** Earned by this line's quantity. */
  volumeDiscountPct: number;
  volumeDiscountAmount: number;
  volumeDiscountId: string | null;
  volumeDiscountName: string | null;
  /** Earned by the invoice's total, spread onto this line. */
  invoiceDiscountPct: number;
  invoiceDiscountAmount: number;
  invoiceDiscountId: string | null;
  invoiceDiscountName: string | null;
  /** What the customer is actually charged for this line. */
  net: number;
};

const num = (v: string | number | null | undefined) => Number(v ?? 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Money, rounded to what the currency can actually express.
 *
 * The kyat has no subunit, so an amount of 1,591,071.471 is not a smaller
 * amount than 1,591,071 — it is the same amount written in a way nobody can
 * pay. Left at four decimal places it became a receivable of 0.471 that no
 * payment could ever clear and that sat on the dashboard asking for action.
 *
 * Applied to amounts, never to rates. A unit price of 106,071.4314 per box is
 * legitimate and stays exact; what has to land on a whole kyat is the figure
 * somebody is asked to hand over.
 */
export const roundMoney = (n: number, scale: number) => {
  const f = Math.pow(10, scale);
  return Math.round(n * f) / f;
};

/**
 * The band a value falls in, narrowest scope first.
 *
 * A rule naming this item beats one naming its category, which beats one
 * naming neither — so a general "100+ gets 5%" can be overridden for one
 * product without deleting it. Among equally specific bands the highest
 * discount wins, because a customer who qualifies for two should get the
 * better of them rather than whichever happened to be created first.
 */
export function bandFor(
  bands: VolumeBand[],
  basis: "QUANTITY" | "INVOICE_TOTAL",
  value: number,
  itemId?: string,
  itemGroupId?: string | null
): VolumeBand | null {
  const matches = bands.filter((b) => {
    if (b.basis !== basis) return false;
    if (value < num(b.min_value)) return false;
    if (b.max_value !== null && value > num(b.max_value)) return false;
    if (basis === "INVOICE_TOTAL") return true;
    if (b.item_id) return b.item_id === itemId;
    if (b.item_group_id) return b.item_group_id === itemGroupId;
    return true;
  });
  if (matches.length === 0) return null;

  const rank = (b: VolumeBand) => (b.item_id ? 0 : b.item_group_id ? 1 : 2);
  return matches.sort(
    (a, b) => rank(a) - rank(b) || num(b.discount_pct) - num(a.discount_pct)
  )[0];
}

/**
 * Every discount on every line, in the order they apply.
 *
 * Sequential rather than added together: the volume discount comes off what
 * the item discount left, and the invoice discount off what both left. So
 * 10% and 5% is 14.5% off, not 15% — each is a discount on the price being
 * charged at that point, which is what "another 3% because the bill passed
 * ten million" means.
 *
 * The invoice band is chosen from the subtotal *after* line discounts, since
 * that is the figure the customer is being asked for.
 */
export function priceLines(
  lines: DiscountedLine[],
  bands: VolumeBand[],
  /**
   * Decimal places the currency can express — 0 for the kyat, 2 for the
   * dollar. Every amount below lands on one of those, so the figures that
   * reach the ledger are figures somebody can pay. Defaults to four for
   * callers reasoning about the discount arithmetic itself rather than about
   * money; every posting passes the real one.
   */
  scale = 4,
): {
  lines: LineDiscounts[];
  subtotal: number;
  total: number;
  invoiceBand: VolumeBand | null;
} {
  const r = (n: number) => roundMoney(n, scale);

  const stage1 = lines.map((l) => {
    const gross = r(l.qty * l.unitPrice);
    const itemPct = l.discountPct || 0;
    const itemAmount = r(gross * (itemPct / 100));
    const afterItem = r(gross - itemAmount);

    const band = bandFor(bands, "QUANTITY", l.qty, l.itemId, l.itemGroupId ?? null);
    const volPct = band ? num(band.discount_pct) : 0;
    const volAmount = r(afterItem * (volPct / 100));

    return {
      line: l, gross, itemPct, itemAmount, band, volPct, volAmount,
      afterVolume: r(afterItem - volAmount),
    };
  });

  const subtotal = r(stage1.reduce((s, x) => s + x.afterVolume, 0));
  const invoiceBand = bandFor(bands, "INVOICE_TOTAL", subtotal);
  const invPct = invoiceBand ? num(invoiceBand.discount_pct) : 0;

  const priced: LineDiscounts[] = stage1.map((row) => {
    // Spread across the lines rather than held as one figure on the invoice,
    // so revenue per item stays right — an invoice-wide discount that only
    // existed on the header would leave every line overstating what it
    // actually earned.
    const invAmount = r(row.afterVolume * (invPct / 100));
    return {
      gross: row.gross,
      itemDiscountPct: row.itemPct,
      itemDiscountAmount: row.itemAmount,
      volumeDiscountPct: row.volPct,
      volumeDiscountAmount: row.volAmount,
      volumeDiscountId: row.band?.id ?? null,
      volumeDiscountName: row.band?.name ?? null,
      invoiceDiscountPct: invPct,
      invoiceDiscountAmount: invAmount,
      invoiceDiscountId: invoiceBand?.id ?? null,
      invoiceDiscountName: invoiceBand?.name ?? null,
      net: r(row.afterVolume - invAmount),
    };
  });

  return {
    lines: priced,
    subtotal,
    // Summed from the rounded lines, so the total is exactly what the lines
    // say — not the exact arithmetic rounded afterwards, which would leave the
    // two disagreeing by a fraction.
    total: r(priced.reduce((s, l) => s + l.net, 0)),
    invoiceBand,
  };
}
