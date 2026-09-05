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
export function priceLines(lines: DiscountedLine[], bands: VolumeBand[]): {
  lines: LineDiscounts[];
  subtotal: number;
  total: number;
  invoiceBand: VolumeBand | null;
} {
  const stage1 = lines.map((l) => {
    const gross = round4(l.qty * l.unitPrice);
    const itemPct = l.discountPct || 0;
    const itemAmount = round4(gross * (itemPct / 100));
    const afterItem = round4(gross - itemAmount);

    const band = bandFor(bands, "QUANTITY", l.qty, l.itemId, l.itemGroupId ?? null);
    const volPct = band ? num(band.discount_pct) : 0;
    const volAmount = round4(afterItem * (volPct / 100));

    return {
      line: l, gross, itemPct, itemAmount, band, volPct, volAmount,
      afterVolume: round4(afterItem - volAmount),
    };
  });

  const subtotal = round4(stage1.reduce((s, r) => s + r.afterVolume, 0));
  const invoiceBand = bandFor(bands, "INVOICE_TOTAL", subtotal);
  const invPct = invoiceBand ? num(invoiceBand.discount_pct) : 0;

  const priced: LineDiscounts[] = stage1.map((r) => {
    // Spread across the lines rather than held as one figure on the invoice,
    // so revenue per item stays right — an invoice-wide discount that only
    // existed on the header would leave every line overstating what it
    // actually earned.
    const invAmount = round4(r.afterVolume * (invPct / 100));
    return {
      gross: r.gross,
      itemDiscountPct: r.itemPct,
      itemDiscountAmount: r.itemAmount,
      volumeDiscountPct: r.volPct,
      volumeDiscountAmount: r.volAmount,
      volumeDiscountId: r.band?.id ?? null,
      volumeDiscountName: r.band?.name ?? null,
      invoiceDiscountPct: invPct,
      invoiceDiscountAmount: invAmount,
      invoiceDiscountId: invoiceBand?.id ?? null,
      invoiceDiscountName: invoiceBand?.name ?? null,
      net: round4(r.afterVolume - invAmount),
    };
  });

  return {
    lines: priced,
    subtotal,
    total: round4(priced.reduce((s, l) => s + l.net, 0)),
    invoiceBand,
  };
}
