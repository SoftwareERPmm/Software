import type { TransactionSql } from "postgres";
import { sql } from "./db";
import { planVoidIn, type VoidBlocker } from "./void";
import { priceLines, roundMoney, type VolumeBand, type LineDiscounts } from "./discount";

// The posting engine.
//
// A document describes what happened. This turns that into journal entries
// and stock movements, resolving every GL account from the item group, the
// partner, and the posting rules — never from anything the caller passed in.
//
// Everything for one document happens in a single transaction. If the ledger
// would not balance, or stock would go negative, or the period is closed, the
// whole thing rolls back and no document exists.

export type InvoiceLine = {
  itemId: string;
  qty: number;
  /**
   * The list price. Discounts are NOT netted into it by the caller — the
   * engine applies them, so the invoice can record which part of a reduction
   * was typed and which was earned. A browser that nets them first leaves the
   * server unable to tell the two apart, and unable to check either.
   */
  unitPrice: number;
  /** The discount typed on this line, in percent. */
  discountPct?: number;
  focReasonId?: string | null;

  /** Purchase side: which goods-receipt line this bills. Optional — when it
   *  is absent the receipt's lines for that item are matched oldest first —
   *  but naming it is what keeps two receipt lines of the same item at
   *  different costs from being settled at the wrong one. */
  sourceLineId?: string | null;

  /** Sales side: which pool this line's stock comes from. Owned and
   *  consigned stock are separate FIFO pools that never blend into one
   *  another — defaults to OWNED, and CONSIGNMENT never falls back to
   *  owned stock if there is not enough consigned to cover it. */
  source?: "OWNED" | "CONSIGNMENT";
  /** Whose consigned goods. Only read when source is CONSIGNMENT. */
  consignorId?: string | null;
};

export type InvoiceInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  /**
   * Set only when this posting is a new version of an existing document: it
   * keeps that document's number and takes the next version under it. Left
   * unset — which is every ordinary posting — the number comes from the
   * series as it always has.
   */
  amendOf?: AmendIdentity | null;
  docDate: string;
  dueDate: string | null;
  memo?: string | null;
  reference?: string | null;
  lines: InvoiceLine[];
};

export type SalesInvoiceInput = InvoiceInput & {
  salesmanId?: string | null;
  paymentType?: "CASH" | "CREDIT";

  /** Someone confirmed the goods physically exist though the ERP records
   *  none. Reaches the delivery this voucher posts alongside the invoice. */
  allowNegativeStock?: boolean;

  /** Goods leave later. When true, this invoice posts revenue only — no
   *  delivery is created, and stock doesn't move until one is. */
  toDeliver?: boolean;

  /** Taken at the counter. Creates a receipt document allocated to this invoice. */
  cashIn?: number;
  cashAccountId?: string | null;

  /**
   * Delivery charged to the customer, posted as Dr AR / Cr delivery income
   * rather than as revenue on the goods. Left undefined on an invoice that
   * bills a delivery, the delivery's own fee is billed instead, so the charge
   * entered when the goods went out is not silently dropped.
   */
  deliveryFee?: number;
};

/** An order commits nothing — no stock movement, no ledger entry. */
export type OrderLine = { itemId: string; qty: number; unitPrice?: number };
export type OrderInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  /**
   * Set only when this posting is a new version of an existing document: it
   * keeps that document's number and takes the next version under it. Left
   * unset — which is every ordinary posting — the number comes from the
   * series as it always has.
   */
  amendOf?: AmendIdentity | null;
  docDate: string;
  dueDate?: string | null;
  memo?: string | null;
  reference?: string | null;
  lines: OrderLine[];
};

/** A delivery or goods receipt line — unpriced on the sales side (the
 *  invoice carries price), priced on the purchase side (there is no
 *  separate purchase invoice line price to fall back on for valuation). */
export type FulfillmentLine = {
  itemId: string;
  qty: number;
  focReasonId?: string | null;
  unitCost?: number;
  sourceLineId?: string | null;

  /**
   * The order line these goods also fulfil, when the document itself names
   * something else. A receipt matched to the invoice that billed for it can
   * only name one source, and it names the invoice — so without this the
   * purchase order behind them stays at nothing received and goes overdue
   * with the goods on the shelf. Validated on the way in like any other
   * allocation: same partner, same item, and only what is still outstanding.
   */
  orderLineId?: string | null;

  /** Which stock pool a delivery line draws from. See InvoiceLine.source —
   *  same rule, same reason: never blend owned and consigned FIFO. */
  source?: "OWNED" | "CONSIGNMENT";
  /** Whose consigned goods, when more than one consignor holds this item
   *  here. Ignored unless the source is CONSIGNMENT. */
  consignorId?: string | null;
};
export type FulfillmentInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  docDate: string;
  /**
   * Someone confirmed the goods physically exist though the ERP records none.
   * Without it an issue exceeding recorded stock is refused, which is the
   * behaviour every caller gets by default.
   */
  allowNegativeStock?: boolean;
  memo?: string | null;
  reference?: string | null;
  sourceDocumentId?: string | null;
  /** When goods actually arrived, if more precise than docDate — receipts only, ignored for deliveries. */
  receivedAt?: string | null;
  /**
   * What the customer is charged for delivering the goods — deliveries only.
   * Recorded here because it is a fact about the delivery, but never posted
   * here: it becomes income on the sales invoice that bills this delivery.
   */
  deliveryFee?: number;
  lines: FulfillmentLine[];
};

type JournalLine = {
  accountId: string;
  amount: number; // positive debit, negative credit
  partnerId?: string | null;
  locationId?: string | null;
};

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

// ------------------------------------------------------------- guards --
//
// Every number a caller hands this engine is checked here, not only in the
// server actions. Those parsers do filter qty > 0, but they are one entry
// point of several — an import, a CSV load, a background job, a test, a
// future API all call these functions directly, and none of them should have
// to remember the rule.
//
// What got through before this existed, both proven against a real database:
// a sales line of 100 units at -5,000 posted Dr AR -500,000 / Cr Revenue
// 500,000, which is a credit note wearing an invoice's clothes with no
// reversal behind it. A goods receipt at -5,000 was worse — 100 units on hand
// carrying -500,000 of value, and that negative unit cost then fed FIFO and
// every COGS posting drawn from the lot.
//
// Infinity was already refused, but by Postgres numeric overflow rather than
// by anything here, so the user saw a driver error instead of a reason.

/** "PURCHASE_INVOICE" -> "purchase invoice", for messages people read. */
function readable(docType: string): string {
  return docType.toLowerCase().replace(/_/g, " ");
}

function assertFinite(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} must be a number`);
  }
}

/**
 * Quantities and money on stock-moving lines.
 *
 * `signedQty` is for stock adjustments alone, where the sign carries meaning —
 * positive is stock found, negative is stock lost — so there the rule is only
 * that it cannot be zero.
 *
 * Zero prices stay legal everywhere: a free-of-charge line is a real quantity
 * at no charge, and the posting matrix sends its cost to promotion expense
 * rather than COGS.
 */
function assertLines(
  lines: ReadonlyArray<{ qty: number; unitPrice?: number | null; unitCost?: number | null }>,
  { signedQty = false }: { signedQty?: boolean } = {}
): void {
  lines.forEach((line, i) => {
    const at = `Line ${i + 1}`;

    assertFinite(line.qty, `${at}: quantity`);
    if (signedQty) {
      if (line.qty === 0) throw new Error(`${at}: quantity cannot be zero`);
    } else if (line.qty <= 0) {
      throw new Error(`${at}: quantity must be more than zero`);
    }

    for (const [value, name] of [[line.unitPrice, "price"], [line.unitCost, "cost"]] as const) {
      if (value === undefined || value === null) continue;
      assertFinite(value, `${at}: ${name}`);
      if (value < 0) {
        throw new Error(
          `${at}: ${name} cannot be negative. Reverse a charge with a return or a credit note, ` +
            `so the correction is a document of its own rather than a sign flip inside this one.`
        );
      }
    }
  });
}

/** A single money figure. `signed` is for voucher lines, where negative is a credit. */
function assertAmount(value: number, what: string, { signed = false }: { signed?: boolean } = {}): void {
  assertFinite(value, what);
  if (!signed && value <= 0) throw new Error(`${what} must be more than zero`);
}

// ------------------------------------------------- source documents --
//
// A document that continues another one names it, and until this existed
// nothing checked that the thing named was what the caller said it was. The
// id was taken on trust, its lines were read, and money was posted against
// them. All of these posted cleanly:
//
//   a purchase invoice whose "goods receipt" was a sales invoice, relieving
//   GR/IR against a customer document's lines at sales prices
//   a purchase invoice for supplier A settling supplier B's receipt, so B's
//   goods looked billed while B was still owed for them
//   a sales invoice billing another customer's delivery
//   a delivery to a customer continuing a purchase receipt
//
// None of them are reachable from the UI, which passes ids it just looked
// up. They are reachable from anything else that calls these functions - an
// import, a script, a future API - which is the same reason the numeric
// guards live here rather than in the parsers.

type SourceDoc = {
  id: string;
  doc_no: string;
  doc_type: string;
  partner_id: string | null;
};

/**
 * Resolves the document this one is being posted against, and locks it.
 *
 * The lock is not incidental to the validation — matching reads how much of
 * the source is still open and then settles part of it, so it has to hold
 * still for the duration. Both concerns want the same row at the same
 * moment, so they are one query.
 */
async function requireSource(
  tx: TransactionSql,
  opts: {
    id: string;
    companyId: string;
    /** When both documents must belong to the same party. */
    partnerId?: string | null;
    expect: readonly string[];
    /** What the caller calls it, so the message names the field. */
    role: string;
  }
): Promise<SourceDoc> {
  const [src] = await tx`
    select id, doc_no, doc_type, partner_id, status
      from document
     where id = ${opts.id} and company_id = ${opts.companyId}
     for update`;

  if (!src) throw new Error(`The ${opts.role} does not exist`);

  if (!opts.expect.includes(src.doc_type)) {
    const wanted = opts.expect.map(readable).join(" or ");
    throw new Error(
      `${src.doc_no} is a ${readable(src.doc_type)}, not a ${wanted}, ` +
        `so it cannot be the ${opts.role}`
    );
  }

  if (src.status !== "POSTED") {
    throw new Error(`${src.doc_no} is ${src.status} and cannot be continued`);
  }

  // Deliberately not `src.partner_id && ...`: every type that can be
  // continued is created by a posting function that requires a partner, so a
  // null here means something wrote that row outside the engine. Treating
  // null as "matches anything" would let exactly that row through the one
  // check meant to catch it.
  if (opts.partnerId && src.partner_id !== opts.partnerId) {
    throw new Error(
      src.partner_id
        ? `${src.doc_no} belongs to a different partner, so this document cannot continue it`
        : `${src.doc_no} has no partner recorded, so this document cannot continue it`
    );
  }

  return src as SourceDoc;
}

/**
 * Every line that names a line of the source must name one that is actually
 * on it, and for the same item. grirMatcher tolerates an unknown id by
 * falling back to document order, which is right for replaying history
 * posted before the reference existed, and wrong for accepting new input:
 * a caller pointing at another document's line has made a mistake, and
 * quietly matching something else hides it.
 */
async function assertSourceLines(
  tx: TransactionSql,
  sourceId: string,
  lines: ReadonlyArray<{ itemId: string; sourceLineId?: string | null }>
): Promise<void> {
  const named = lines.filter((l) => l.sourceLineId);
  if (named.length === 0) return;

  const rows = await tx`
    select id, item_id from document_line
     where document_id = ${sourceId}
       and id = any(${named.map((l) => l.sourceLineId as string)})`;

  const byId = new Map(rows.map((r: any) => [r.id, r.item_id]));

  lines.forEach((line, i) => {
    if (!line.sourceLineId) return;
    const item = byId.get(line.sourceLineId);
    if (item === undefined) {
      throw new Error(`Line ${i + 1} refers to a line that is not on that document`);
    }
    if (item !== line.itemId) {
      throw new Error(`Line ${i + 1} refers to a line for a different item`);
    }
  });
}

/**
 * The number a posting should carry.
 *
 * Ordinarily the next one in the series. When a document is being edited it
 * is the number the previous version already has, at the next version — the
 * whole point of a versioned correction is that SI20260910001 stays
 * SI20260910001, because that is the number on the piece of paper the
 * customer is holding.
 */
async function documentNumberFor(
  tx: TransactionSql,
  companyId: string,
  docType: string,
  docDate: string,
  amend?: AmendIdentity | null,
  direction?: string | null
): Promise<{ docNo: string; version: number }> {
  if (amend) return { docNo: amend.docNo, version: amend.version };
  const rows = direction === undefined
    ? await tx`select fn_next_document_no(${companyId}, ${docType}, ${docDate}::date) as no`
    : await tx`select fn_next_document_no(${companyId}, ${docType}, ${docDate}::date,
                                          ${direction}) as no`;
  return { docNo: rows[0].no as string, version: 1 };
}

/** Which number and version a replacement is posting under. */
export type AmendIdentity = { docNo: string; version: number };

/**
 * An invoice cannot bill more of a document than that document contains.
 *
 * A tester put it plainly: "if the delivery is 100, the invoice may be
 * incorrectly opened as 90, 80, or 110, so I don't want to allow you to make
 * changes." She is right, and 110 was possible. An invoice raised from a
 * receipt or a delivery prefilled its quantities and then let them be typed
 * over; the excess posted, landing in price variance on the purchase side and
 * in nothing at all on the sales side, where the delivery's lines were never
 * checked against the invoice's.
 *
 * Quantity is not an opinion. What arrived, arrived; what went out, went out.
 * A price may legitimately differ from what the goods were valued at — that is
 * what variance is for, and a supplier's bill is external truth — but nobody
 * can bill for a hundred and ten boxes that a hundred boxes were received in.
 *
 * Billing less is fine and stays fine: a receipt can be invoiced in parts, and
 * this counts what earlier invoices already took.
 */
async function assertNotOverBilled(
  tx: TransactionSql,
  sourceId: string,
  lines: ReadonlyArray<{ itemId: string; qty: number; sourceLineId?: string | null }>,
  billType: "PURCHASE_INVOICE" | "SALES_INVOICE",
  /**
   * The invoice being posted, where its row already exists. The purchase side
   * runs this check after inserting its own document and lines — so without
   * excluding itself it reads its own quantity as already billed, and every
   * invoice refuses itself.
   */
  selfId?: string | null
): Promise<void> {
  const sourceLines = await tx`
    select dl.id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           i.code as item_code, d.doc_no
      from document_line dl
      join item i on i.id = dl.item_id
      join document d on d.id = dl.document_id
     where dl.document_id = ${sourceId}
     order by dl.line_no`;
  if (sourceLines.length === 0) return;

  const prior = await tx`
    select dl.item_id, dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.doc_type = ${billType} and d.status = 'POSTED'
       and d.source_document_id = ${sourceId}
       ${selfId ? tx`and d.id <> ${selfId}` : tx``}
     order by d.posting_date, d.doc_no, dl.line_no`;

  const draw = grirMatcher(sourceLines as unknown as MatchableLine[]);
  for (const p of prior) draw(p.item_id, Number(p.qty), p.source_line_id);

  lines.forEach((line, i) => {
    const onSource = sourceLines.find((l: any) => l.item_id === line.itemId);
    // An item the source never carried is not over-billing it; it is a line
    // about something else, and the caller's own rules decide whether that is
    // allowed here.
    if (!onSource) return;
    const taken = draw(line.itemId, line.qty, line.sourceLineId)
      .taken.reduce((t: number, x: any) => t + x.qty, 0);
    if (taken + 0.0001 < line.qty) {
      throw new Error(
        `Line ${i + 1}: ${onSource.doc_no} has ${taken} of ${onSource.item_code} left to ` +
        `bill, not ${line.qty}. Quantity comes from the document being billed — ` +
        `change that document if it is wrong.`
      );
    }
  });
}

/**
 * A delivery against an invoice cannot ship more of it than is left.
 *
 * The invoice row is locked by requireSource before this runs, which is the
 * point: the remaining quantity is read here, inside the transaction, rather
 * than on the screen that offered it. Two people pressing "deliver now" at
 * the same moment both saw 900 outstanding; the second used to post its 900
 * on top of the first, and 1,800 units left the building against a bill for
 * 1,000. The lock made them take turns without making the second look again.
 *
 * Items the invoice never billed are not capped — a delivery may carry
 * something extra, the same way a receipt may — but they are not invisible
 * either: they show up as still needing an invoice.
 */
async function assertNotOverDelivered(
  tx: TransactionSql,
  invoiceId: string,
  lines: ReadonlyArray<{ itemId: string; qty: number; sourceLineId?: string | null }>
): Promise<void> {
  const invLines = await tx`
    select dl.id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           i.code as item_code, d.doc_no
      from document_line dl
      join item i on i.id = dl.item_id
      join document d on d.id = dl.document_id
     where dl.document_id = ${invoiceId}
     order by dl.line_no`;
  if (invLines.length === 0) return;

  const prior = await tx`
    select dl.item_id, dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       and d.source_document_id = ${invoiceId}
     order by d.posting_date, d.doc_no, dl.line_no`;

  const draw = grirMatcher(invLines as unknown as MatchableLine[]);
  for (const p of prior) draw(p.item_id, Number(p.qty), p.source_line_id);

  lines.forEach((line, i) => {
    const billed = invLines.find((l: any) => l.item_id === line.itemId);
    if (!billed) return;
    const taken = draw(line.itemId, line.qty, line.sourceLineId)
      .taken.reduce((t: number, x: any) => t + x.qty, 0);
    if (taken + 0.0001 < line.qty) {
      throw new Error(
        `Line ${i + 1}: ${billed.doc_no} has ${taken} of ${billed.item_code} left ` +
        `to deliver, not ${line.qty}. Someone may have delivered against it already.`
      );
    }
  });
}

/**
 * A return that names what it reverses cannot exceed it.
 *
 * The source relationship was validated but never the quantity, so fifty
 * units could be returned against a sale of ten — and since the returned
 * goods come back into stock at the original sale's cost, that invented
 * inventory value out of a document that never carried it.
 *
 * Counted per item and net of returns already posted against the same
 * source, so two partial returns are fine and the pair of them cannot
 * exceed the whole. A return naming no source stays unlimited: goods do
 * come back with no paperwork behind them, and that is a different
 * situation from claiming a specific sale said something it did not.
 */
async function assertWithinSource(
  tx: TransactionSql,
  opts: {
    companyId: string;
    sourceId: string;
    sourceDocNo: string;
    returnType: "SALES_RETURN" | "PURCHASE_RETURN";
    lines: ReadonlyArray<{ itemId: string; qty: number }>;
  }
): Promise<Map<string, number>> {
  const original = await tx`
    select item_id, sum(base_qty) as qty
      from document_line where document_id = ${opts.sourceId}
     group by item_id`;

  const returned = await tx`
    select dl.item_id, coalesce(sum(dl.base_qty), 0) as qty
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${opts.companyId}
       and d.doc_type = ${opts.returnType}
       and d.status = 'POSTED'
       and d.source_document_id = ${opts.sourceId}
     group by dl.item_id`;

  const left = new Map<string, number>();
  for (const o of original) left.set(o.item_id, Number(o.qty));
  for (const r of returned) {
    left.set(r.item_id, round4((left.get(r.item_id) ?? 0) - Number(r.qty)));
  }

  // This return's own lines count together, so the same item split across
  // two lines cannot slip past by being under the limit twice.
  const wanted = new Map<string, number>();
  for (const line of opts.lines) {
    wanted.set(line.itemId, round4((wanted.get(line.itemId) ?? 0) + line.qty));
  }

  for (const [itemId, qty] of wanted) {
    const available = left.get(itemId) ?? 0;
    if (qty > available) {
      const [item] = await tx`select code, name from item where id = ${itemId}`;
      throw new Error(
        `${opts.sourceDocNo} has ${available} of ${item?.code ?? "that item"}` +
          `${item?.name ? ` (${item.name})` : ""} left to return; ${qty} was entered`
      );
    }
  }

  // How much of each item earlier returns already took, which is where this
  // one starts reading the cost layers.
  const done = new Map<string, number>();
  for (const r of returned) done.set(r.item_id, Number(r.qty));
  return done;
}

// ------------------------------------------------------- GR/IR matching --
//
// A goods receipt and a purchase invoice settle against each other through
// GR/IR clearing, and either can arrive first. Whichever posts second has to
// work out how much of the first one it actually covers — and at what rate.
//
// Two rules, both learned the hard way:
//
//   Per line, never per document. Clearing the whole counterpart meant half
//   a shipment released the entire invoice and dumped the rest into price
//   variance, leaving GR/IR holding a debit balance where a settled liability
//   should be zero.
//
//   Per line, never per item. Summing an item's lines averages their cost, so
//   a receipt of 50 at 1,000 and 50 at 2,000 holds every unit at 1,500 — a
//   rate nothing was received at. Billing either half then settles at the
//   wrong one and invents a variance on an invoice that matched exactly.

export type MatchableLine = { id: string; item_id: string; qty: unknown; net: unknown };

/** What a single draw took, and from which counterpart lines. */
export type Drawn = {
  value: number;
  taken: { lineId: string; qty: number; value: number }[];
};

/**
 * Opens a counterpart document for matching and returns a draw function.
 *
 * Each call takes a quantity of one item and returns what GR/IR was holding
 * it at. The named line goes first when the caller knows which one it is
 * settling; anything else is taken in document order, oldest layer first,
 * the same rule FIFO uses for the stock itself. A line id that does not
 * belong to this document is simply not found, and the draw falls back to
 * that order rather than failing.
 */
export function grirMatcher(lines: ReadonlyArray<MatchableLine>) {
  const remaining = new Map<string, number>();
  const rate = new Map<string, number>();

  for (const l of lines) {
    const qty = Number(l.qty);
    remaining.set(l.id, qty);
    rate.set(l.id, qty > 0 ? round4(Number(l.net) / qty) : 0);
  }

  // Returns the value drawn and the lines it came from. The posting code
  // needs only the value; the screens that show a receipt as partly invoiced
  // need the breakdown, and taking both from one function is what stops the
  // display and the ledger telling different stories.
  return function draw(itemId: string, qty: number, preferLineId?: string | null): Drawn {
    const forItem = lines.filter((l) => l.item_id === itemId);
    const order = preferLineId
      ? [
          ...forItem.filter((l) => l.id === preferLineId),
          ...forItem.filter((l) => l.id !== preferLineId),
        ]
      : forItem;

    let left = qty;
    let value = 0;
    const taken: Drawn["taken"] = [];

    for (const l of order) {
      if (left <= 0) break;
      const available = remaining.get(l.id) ?? 0;
      if (available <= 0) continue;
      const drawn = Math.min(available, left);
      const drawnValue = round4(drawn * (rate.get(l.id) ?? 0));
      remaining.set(l.id, round4(available - drawn));
      taken.push({ lineId: l.id, qty: drawn, value: drawnValue });
      value += drawnValue;
      left = round4(left - drawn);
    }

    return { value: round4(value), taken };
  };
}

// ------------------------------------------------------------------ FIFO --
//
// Costing is FIFO, per warehouse. Every receipt creates a lot; every issue
// draws down the oldest open lots at that item's own location until the
// quantity is covered. Nothing is ever updated — a lot's remaining quantity
// is always qty_received less the sum of what has been drawn from it.

type FifoDraw = { lotId: string; qty: number; unitCost: number };
type FifoPlan = {
  totalCost: number; unitCost: number; draws: FifoDraw[];
  /**
   * Quantity no layer covered. Zero unless the caller allowed a shortfall —
   * without permission this function still refuses, exactly as before, so no
   * existing path can drift negative by accident.
   */
  uncoveredQty: number;
  /** What the uncovered quantity was charged out at. */
  provisionalUnitCost: number;
  /** The document that price came from, so the screen can say where it got
   *  it rather than presenting a figure from nowhere. */
  priceSourceNo: string | null;
  /** PURCHASE_INVOICE, GOODS_RECEIPT, or NONE when never bought. */
  priceSource: string;
};

/**
 * Reads the open lots oldest-first and decides what this issue draws from
 * each, without writing anything yet — the stock_movement row this belongs
 * to doesn't exist until after this returns, and consumption rows need its
 * id. Locks the lots first, in a separate ungrouped statement, so two issues
 * can't both plan
 * against the same remaining quantity.
 */
async function planFifoConsumption(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string, qty: number,
  /**
   * Allow issuing more than the layers cover.
   *
   * Off by default and passed only where someone has confirmed the goods
   * physically exist. The refusal is the safe behaviour and stays the
   * default: a caller that forgets this argument cannot create negative
   * stock, which is the property worth keeping when the guard is relaxed
   * anywhere at all.
   */
  allowNegative = false
): Promise<FifoPlan> {
  // Take the lock first, on its own. Postgres refuses FOR UPDATE on a query
  // that groups, so the aggregate below cannot carry it — and without a lock
  // two concurrent issues would each read the same remaining quantity and
  // both draw against it, overdrawing the lot. The lock is held for the rest
  // of the transaction, so the aggregate that follows sees a stable picture.
  await tx`
    select sl.id from stock_lot sl
     where sl.company_id = ${companyId} and sl.item_id = ${itemId} and sl.location_id = ${locationId}
     order by sl.received_date, sl.created_at
       for update`;

  // At what the lot costs now, not at what the receipt first guessed. A bill
  // that disagreed with its receipt put the difference back onto the goods
  // still held (0057), and an issue after that has to relieve inventory at the
  // corrected figure — otherwise the correction sits in the inventory account
  // forever with no stock left behind it.
  const lots = await tx`
    select sl.id, sl.unit_cost + coalesce(a.delta, 0) as unit_cost,
           sl.qty_received - coalesce(sum(c.qty), 0) as remaining
      from stock_lot sl
      left join stock_lot_consumption c on c.lot_id = sl.id
      left join lateral (
            select sum(adj.delta_unit_cost) as delta
              from stock_lot_adjustment adj where adj.lot_id = sl.id
      ) a on true
     where sl.company_id = ${companyId} and sl.item_id = ${itemId} and sl.location_id = ${locationId}
     group by sl.id, sl.unit_cost, a.delta, sl.qty_received, sl.received_date, sl.created_at
    having sl.qty_received - coalesce(sum(c.qty), 0) > 0.0001
     order by sl.received_date, sl.created_at`;

  let need = round4(qty);
  const draws: FifoDraw[] = [];
  let totalCost = 0;

  for (const lot of lots) {
    if (need <= 0) break;
    const remaining = round4(Number(lot.remaining));
    const take = Math.min(remaining, need);
    if (take <= 0) continue;
    draws.push({ lotId: lot.id, qty: take, unitCost: Number(lot.unit_cost) });
    totalCost += take * Number(lot.unit_cost);
    need = round4(need - take);
  }

  let uncoveredQty = 0;
  let provisionalUnitCost = 0;
  let priceSourceNo: string | null = null;
  let priceSource = "NONE";

  if (need > 0.0001) {
    if (!allowNegative) {
      throw new Error("Not enough stock in any lot at this location to cover the quantity requested");
    }
    // Charged out at what this item last cost, so the sale carries a
    // believable margin rather than a free one. The figure is provisional and
    // is trued up against the receipt that eventually covers it — the
    // difference goes to variance, the same treatment a purchase price
    // difference already gets.
    uncoveredQty = need;
    const priced = await lastKnownCost(tx, companyId, itemId, locationId);
    provisionalUnitCost = priced.unitCost;
    priceSourceNo = priced.sourceNo;
    priceSource = priced.source;
    totalCost += uncoveredQty * provisionalUnitCost;
    need = 0;
  }

  totalCost = round4(totalCost);
  return {
    totalCost,
    unitCost: qty > 0 ? round4(totalCost / qty) : 0,
    draws,
    uncoveredQty: round4(uncoveredQty),
    provisionalUnitCost: round4(provisionalUnitCost),
    priceSourceNo,
    priceSource,
  };
}

export type StockPrice = { unitCost: number; sourceNo: string | null; source: string };

/**
 * What a unit of this item is worth, for goods leaving before any receipt
 * recorded them arriving.
 *
 * The supplier's purchase invoice first. That is the price actually agreed
 * and billed — the stock price, in the sense the business uses the term —
 * where a goods receipt's figure is what someone entered when the goods
 * turned up, before the bill confirmed it. Freight, customs and other landed
 * costs are deliberately not in it: this system does not capitalise them into
 * inventory, so including them here would value these units differently from
 * every other unit on the shelf.
 *
 * Falling back to the last cost layer when the item has been received but
 * never invoiced, and to zero only when it has never been bought at all — at
 * which point there is genuinely nothing to go on, and a zero that is visibly
 * zero beats a number invented to look plausible.
 */
async function lastKnownCost(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string
): Promise<StockPrice> {
  const [billed] = await tx`
    select dl.unit_price, d.doc_no from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId} and dl.item_id = ${itemId}
       and d.doc_type = 'PURCHASE_INVOICE' and d.status = 'POSTED'
       and dl.unit_price > 0
     order by d.doc_date desc, d.created_at desc limit 1`;
  if (billed) {
    return { unitCost: Number(billed.unit_price), sourceNo: billed.doc_no, source: "PURCHASE_INVOICE" };
  }

  const [here] = await tx`
    select sl.unit_cost, d.doc_no
      from stock_lot sl
      left join stock_movement sm on sm.id = sl.stock_movement_id
      left join document d on d.id = sm.document_id
     where sl.company_id = ${companyId} and sl.item_id = ${itemId}
       and sl.location_id = ${locationId}
     order by sl.received_date desc, sl.created_at desc limit 1`;
  if (here) {
    return { unitCost: Number(here.unit_cost), sourceNo: here.doc_no ?? null, source: "GOODS_RECEIPT" };
  }

  const [anywhere] = await tx`
    select sl.unit_cost, d.doc_no
      from stock_lot sl
      left join stock_movement sm on sm.id = sl.stock_movement_id
      left join document d on d.id = sm.document_id
     where sl.company_id = ${companyId} and sl.item_id = ${itemId}
     order by sl.received_date desc, sl.created_at desc limit 1`;
  if (anywhere) {
    return { unitCost: Number(anywhere.unit_cost), sourceNo: anywhere.doc_no ?? null, source: "GOODS_RECEIPT" };
  }

  return { unitCost: 0, sourceNo: null, source: "NONE" };
}

/**
 * Records what a plan could not cover, so it can be reconciled later.
 *
 * Written only when a shortfall actually happened, so the table is a worklist
 * of real cases rather than a log of every issue.
 */
async function recordNegativeStock(
  tx: TransactionSql, companyId: string, documentId: string,
  itemId: string, locationId: string, plan: FifoPlan
) {
  if (plan.uncoveredQty <= 0.0001) return;
  await tx`
    insert into negative_stock
      (company_id, item_id, location_id, document_id, qty, provisional_unit_cost,
       price_source, price_source_no)
    values (${companyId}, ${itemId}, ${locationId}, ${documentId},
            ${plan.uncoveredQty}, ${plan.provisionalUnitCost},
            ${plan.priceSource}, ${plan.priceSourceNo})`;
}

/**
 * Covers outstanding shortfalls with goods that have just arrived, and
 * returns the variance between what they were charged out at and what they
 * actually cost.
 *
 * Called before the receipt's own lot is created, and it reduces the quantity
 * that becomes a lot: goods that were already sold never sat on the shelf, so
 * making a layer for them and immediately consuming it would be a fiction
 * with a date on it.
 *
 * Oldest shortfall first, for the same reason FIFO draws oldest-first — the
 * earliest sale is the one these goods were really for.
 */
async function settleNegativeStock(
  tx: TransactionSql, companyId: string, documentId: string,
  itemId: string, locationId: string, qty: number, actualUnitCost: number,
  stockMovementId: string
): Promise<{ covered: number; variance: number }> {
  // The lock goes first, on its own: Postgres refuses FOR UPDATE on a query
  // that groups, so the aggregate below cannot carry it. Same shape, and the
  // same reason, as planFifoConsumption above — without it two receipts could
  // each read the same outstanding quantity and both settle against it.
  await tx`
    select ns.id from negative_stock ns
     where ns.company_id = ${companyId} and ns.item_id = ${itemId}
       and ns.location_id = ${locationId}
     order by ns.created_at
       for update`;

  const open = await tx`
    select ns.id, ns.qty, ns.provisional_unit_cost,
           ns.qty - coalesce(sum(s.qty), 0) as outstanding
      from negative_stock ns
      left join negative_stock_settlement s on s.negative_stock_id = ns.id
     where ns.company_id = ${companyId} and ns.item_id = ${itemId}
       and ns.location_id = ${locationId}
     group by ns.id, ns.qty, ns.provisional_unit_cost, ns.created_at
    having ns.qty - coalesce(sum(s.qty), 0) > 0.0001
     order by ns.created_at`;

  let left = round4(qty);
  let covered = 0;
  let variance = 0;

  for (const ns of open as unknown as {
    id: string; provisional_unit_cost: string; outstanding: string;
  }[]) {
    if (left <= 0.0001) break;
    const take = Math.min(round4(Number(ns.outstanding)), left);
    if (take <= 0.0001) continue;

    await tx`
      insert into negative_stock_settlement
        (company_id, negative_stock_id, document_id, stock_movement_id, qty, actual_unit_cost)
      values (${companyId}, ${ns.id}, ${documentId}, ${stockMovementId},
              ${take}, ${actualUnitCost})`;

    // Charged out at the provisional figure, actually cost this. The
    // difference is the same kind of thing as a purchase price variance and
    // goes to the same place.
    variance += take * (actualUnitCost - Number(ns.provisional_unit_cost));
    covered = round4(covered + take);
    left = round4(left - take);
  }

  return { covered, variance: round4(variance) };
}

/** Writes the consumption rows a plan decided on, against the movement it belongs to. */
async function recordFifoConsumption(
  tx: TransactionSql, companyId: string, stockMovementId: string, plan: FifoPlan,
  /**
   * The account this consumption charged the cost to — cost of sales, a
   * free-goods reason, stock adjustment. Recorded with the consumption (0060)
   * so a later correction to what these goods cost adjusts the account that
   * was actually used rather than whatever the item maps to by then. Null
   * where no expense was recognised: a transfer keeps the goods, and a
   * purchase return sends them back.
   */
  expenseAccountId?: string | null,
) {
  for (const d of plan.draws) {
    await tx`
      insert into stock_lot_consumption
        (company_id, lot_id, stock_movement_id, qty, unit_cost, expense_account_id)
      values (${companyId}, ${d.lotId}, ${stockMovementId}, ${d.qty}, ${d.unitCost},
              ${expenseAccountId ?? null})`;
  }
}

// ---------------------------------------------------- consignment FIFO --
//
// The consigned-stock mirror of planFifoConsumption above, over
// consignment_lot instead of stock_lot. Deliberately a separate function
// over a separate table rather than a flag added to the existing planner:
// owned and consigned stock are different pools by design (the user's
// explicit choice, after being shown what silently blending them under one
// FIFO draw would risk), and this never falls back to stock_lot if
// consigned stock runs short — it fails the same way planFifoConsumption
// fails when owned stock runs short, rather than reaching into the other
// pool to make up the difference.
//
// Carries no cost, because a consignment lot carries no cost yet — only the
// settlement rate (pricing_method/pricing_value) it will be valued at once
// it actually sells. That valuation happens later, in settleConsignmentSales,
// using the price the customer is actually being charged on the invoice
// that triggers it.

type ConsignmentDraw = {
  lotId: string; qty: number;
  pricingMethod: "PERCENTAGE" | "FIXED"; pricingValue: number;
  consignorId: string;
};
type ConsignmentPlan = { draws: ConsignmentDraw[] };

async function planConsignmentConsumption(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string, qty: number,
  // Whose goods. Left out, the draw runs FIFO across every consignor at this
  // location, which is right when there is only one and a coin toss when
  // there are two — and the consignor whose shirt left is the one who gets
  // paid for it, so it is not a detail the system should decide by date.
  consignorId?: string | null,
): Promise<ConsignmentPlan> {
  // Same lock-then-aggregate shape as planFifoConsumption, for the same
  // reason: Postgres refuses FOR UPDATE on a query that groups, so the lock
  // is taken on its own first and held for the rest of the transaction.
  await tx`
    select cl.id from consignment_lot cl
      join document d on d.id = cl.receipt_document_id
     where cl.company_id = ${companyId} and cl.item_id = ${itemId} and cl.location_id = ${locationId}
       ${consignorId ? tx`and d.partner_id = ${consignorId}` : tx``}
     order by cl.received_date, cl.created_at
       for update of cl`;

  const lots = await tx`
    select cl.id, cl.pricing_method, cl.pricing_value, d.partner_id as consignor_id,
           cl.qty_received - coalesce(sum(c.qty), 0) as remaining
      from consignment_lot cl
      join document d on d.id = cl.receipt_document_id
      left join consignment_lot_consumption c on c.lot_id = cl.id
     where cl.company_id = ${companyId} and cl.item_id = ${itemId} and cl.location_id = ${locationId}
       ${consignorId ? tx`and d.partner_id = ${consignorId}` : tx``}
     group by cl.id, cl.pricing_method, cl.pricing_value, d.partner_id, cl.qty_received,
              cl.received_date, cl.created_at
    having cl.qty_received - coalesce(sum(c.qty), 0) > 0.0001
     order by cl.received_date, cl.created_at`;

  let need = round4(qty);
  const draws: ConsignmentDraw[] = [];

  for (const lot of lots) {
    if (need <= 0) break;
    const remaining = round4(Number(lot.remaining));
    const take = Math.min(remaining, need);
    if (take <= 0) continue;
    draws.push({
      lotId: lot.id, qty: take,
      pricingMethod: lot.pricing_method, pricingValue: Number(lot.pricing_value),
      consignorId: lot.consignor_id,
    });
    need = round4(need - take);
  }

  if (need > 0.0001) {
    throw new Error(
      consignorId
        ? "Not enough of this consignor's stock at this location to cover the quantity requested"
        : "Not enough consigned stock in any lot at this location to cover the quantity requested"
    );
  }

  return { draws };
}

/**
 * Every receipt is its own lot — a goods receipt, a sales return, a found
 * adjustment. `receivedAt` is a full timestamp when the caller has one (the
 * actual time stock arrived, not just the document's date) — falls back to
 * midnight on the document date otherwise, same as before this existed.
 */
async function createFifoLot(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string,
  receivedAt: string, unitCost: number, qty: number, stockMovementId: string
) {
  await tx`
    insert into stock_lot (company_id, item_id, location_id, received_date, unit_cost, qty_received, stock_movement_id)
    values (${companyId}, ${itemId}, ${locationId}, ${receivedAt}::timestamptz, ${unitCost}, ${qty}, ${stockMovementId})`;
}

/**
 * The bill disagreed with the receipt, so the goods were worth something
 * different from what was first recorded.
 *
 * Splits that difference by where the goods actually are. What is still on the
 * shelf gets revalued — the stock is worth what was paid for it, and the next
 * issue relieves it at the corrected figure. What has already been sold cannot
 * be revalued, because it is gone: its share goes to cost of sales, in the
 * period the correction belongs to.
 *
 *     20 still held        →  600 onto the stock, nothing expensed
 *     8 issued, 12 held    →  360 onto the stock, 240 to cost of sales
 *     20 issued            →  nothing to add to, 600 to cost of sales
 *
 * The quantity added is zero. The receipt keeps its history and nothing is
 * received twice; only the value moves, which is the whole distinction between
 * a revaluation and a second delivery.
 *
 * The difference is spread over the lot's whole received quantity rather than
 * over the units this particular bill covers, because a lot's units are
 * fungible — there is no telling a billed box from an unbilled one on the same
 * pallet. Billing 12 of 20 at thirty more each puts 360 across all twenty, and
 * a later bill for the other 8 puts the remaining 240 across them too. Both
 * bills together land the lot exactly where paying 130 for all of it would
 * have.
 */
async function adjustReceiptCost(
  tx: TransactionSql,
  input: {
    companyId: string;
    documentId: string;
    docDate: string;
    locationId: string;
    reason?: string | null;
    /**
     * What this bill settles: the receipt line, how many of its units, and
     * what the bill charges for them. `heldValue` is what GR/IR gave up for
     * those units — the difference between the two is what has to go
     * somewhere.
     */
    billed: {
      receiptLineId: string; qty: number; newUnitCost: number; heldValue: number;
    }[];
  }
): Promise<{ journal: JournalLine[]; toInventory: number; toCogs: number }> {
  const journal: JournalLine[] = [];

  // Per item and location, because that is the grain a stock movement and an
  // inventory account both work at — several receipt lines of the same item
  // produce one revaluation between them, and goods that have moved warehouse
  // are revalued where they now sit.
  const inventoryAt = new Map<string, { itemId: string; locationId: string; amount: number }>();
  // Keyed by the account the original issue charged, so a correction lands
  // back where the cost went rather than wherever the item points today.
  // Null means the consumption predates that being recorded (0060), and falls
  // back to the item's current mapping — the best available answer, and the
  // only one for history.
  const expenseFor = new Map<string, { accountId: string | null; itemId: string; amount: number }>();

  const addInventory = (itemId: string, locationId: string, amount: number) => {
    if (amount === 0) return;
    const key = `${itemId}|${locationId}`;
    const at = inventoryAt.get(key) ?? { itemId, locationId, amount: 0 };
    at.amount = round4(at.amount + amount);
    inventoryAt.set(key, at);
  };
  const addExpense = (accountId: string | null, itemId: string, amount: number) => {
    if (amount === 0) return;
    const key = `${accountId ?? "-"}|${itemId}`;
    const at = expenseFor.get(key) ?? { accountId, itemId, amount: 0 };
    at.amount = round4(at.amount + amount);
    expenseFor.set(key, at);
  };

  /**
   * Put `value` onto this lot, and follow it wherever the goods went.
   *
   * The lot's units are fungible, so the value is spread across everything it
   * received and then split three ways by where those units are now:
   *
   *   still on this shelf   →  the inventory account for this location
   *   sold, or written off  →  cost of sales; they are gone and cannot be
   *                            revalued, only expensed
   *   moved to another      →  neither. They are still ours and still stock,
   *   warehouse                just somewhere else — so the value follows
   *                            them into the lot the transfer created, and
   *                            the same split happens again there.
   *
   * That third case is the one worth stating plainly: a transfer consumes the
   * source lot exactly as a sale does, so counting consumption alone expensed
   * goods that were sitting on a shelf two towns away, and left them costed at
   * the old figure for whoever sold them next.
   *
   * Conserves exactly at every level: remaining, sold and transferred add back
   * to what the lot received, so the three shares add back to `value`.
   */
  const placeOnLot = async (
    lotId: string, value: number, depth: number,
  ): Promise<void> => {
    if (value === 0) return;
    // Transfers only ever move value to a lot created later, so a cycle is not
    // reachable. The cap is here so that a future path which could cycle fails
    // loudly and finitely rather than hanging a posting transaction.
    if (depth > MAX_TRANSFER_DEPTH) {
      throw new Error(
        `Goods from this receipt have been moved between warehouses more than ` +
        `${MAX_TRANSFER_DEPTH} times, which is as far as a cost correction ` +
        `follows them. Correct the cost at the warehouse holding them now.`
      );
    }

    const [lot] = await tx`
      select sl.id, sl.item_id, sl.location_id, sl.qty_received
        from stock_lot sl where sl.id = ${lotId}
         for update`;
    if (!lot) return;

    const received = Number(lot.qty_received);
    if (received <= 0) return;

    // Everything that has come off this lot, and what took it.
    const draws = await tx`
      select c.qty, c.expense_account_id, d.doc_type, sm.document_id
        from stock_lot_consumption c
        join stock_movement sm on sm.id = c.stock_movement_id
        left join document d on d.id = sm.document_id
       where c.lot_id = ${lotId}`;

    let sold = 0;
    const spent: { accountId: string | null; qty: number }[] = [];
    const moved: { documentId: string; qty: number }[] = [];
    for (const d of draws) {
      const q = Number(d.qty);
      if (d.doc_type === "STOCK_TRANSFER" && d.document_id) {
        moved.push({ documentId: d.document_id as string, qty: q });
      } else {
        sold = round4(sold + q);
        spent.push({ accountId: (d.expense_account_id as string) ?? null, qty: q });
      }
    }
    const transferred = moved.reduce((t, m) => round4(t + m.qty), 0);
    const remaining = Math.max(0, round4(received - sold - transferred));

    // Rounded before it is used, not after, because this is the figure the lot
    // actually stores — numeric(18,4) would round it on the way in anyway.
    // Adding 100 across three units and later relieving 3 × 33.3333 leaves a
    // tenth of a cent behind forever; rounding here and letting the last share
    // absorb the remainder leaves nothing.
    const perUnit = round4(value / received);

    await tx`
      insert into stock_lot_adjustment
        (company_id, lot_id, document_id, delta_unit_cost,
         qty_remaining, qty_issued, reason)
      values
        (${input.companyId}, ${lot.id}, ${input.documentId}, ${perUnit},
         ${remaining}, ${round4(sold + transferred)}, ${input.reason ?? null})`;

    addInventory(lot.item_id as string, lot.location_id as string,
      round4(remaining * perUnit));
    for (const sp of spent) {
      addExpense(sp.accountId, lot.item_id as string, round4(sp.qty * perUnit));
    }

    for (const m of moved) {
      // The lot that transfer created at the other end. One inbound movement
      // per transfer line, so one lot — and this source lot may be only part
      // of what filled it, which is why the value carried is this lot's share
      // rather than the whole of it.
      const [dest] = await tx`
        select sl.id from stock_lot sl
          join stock_movement sm on sm.id = sl.stock_movement_id
         where sm.document_id = ${m.documentId}
           and sm.item_id = ${lot.item_id}
           and sm.qty > 0
         order by sl.created_at
         limit 1`;
      if (!dest) {
        // No lot at the far end — the transfer covered a negative balance
        // rather than landing on a shelf. Nothing to revalue, so it is spent,
        // and nothing recorded where, so the item's mapping decides.
        addExpense(null, lot.item_id as string, round4(m.qty * perUnit));
        continue;
      }
      await placeOnLot(dest.id as string, round4(m.qty * perUnit), depth + 1);
    }
  };

  for (const b of input.billed) {
    const difference = round4(b.qty * b.newUnitCost - b.heldValue);
    if (difference === 0) continue;

    // Which lots this receipt line put on the shelf. Matched by the receipt
    // and the item rather than by the line, because a receipt's stock movement
    // does not record which of its lines it came from — and reading it that
    // way also keeps working for stock received before any of this existed.
    const [receiptLine] = await tx`
      select document_id, item_id from document_line where id = ${b.receiptLineId}`;
    if (!receiptLine) continue;

    // Locked on its own first: Postgres refuses FOR UPDATE on a query that
    // groups, and everything below has to see a stable picture.
    await tx`
      select sl.id from stock_lot sl
        join stock_movement sm on sm.id = sl.stock_movement_id
       where sm.document_id = ${receiptLine.document_id}
         and sl.item_id = ${receiptLine.item_id}
       order by sl.created_at
         for update of sl`;

    const lots = await tx`
      select sl.id, sl.qty_received
        from stock_lot sl
        join stock_movement sm on sm.id = sl.stock_movement_id
       where sm.document_id = ${receiptLine.document_id}
         and sl.item_id = ${receiptLine.item_id}
       order by sl.created_at`;

    // Nothing to revalue: the goods never became a lot. A receipt from before
    // lot tracking, or one that only covered goods already sold. The caller
    // sends what is left to variance, which is where a difference with no
    // goods behind it belongs.
    if (lots.length === 0) continue;

    const received = lots.reduce((t: number, l: Record<string, unknown>) =>
      t + Number(l.qty_received), 0);
    if (received <= 0) continue;

    // A receipt with two lines of the same item shares the difference between
    // their lots in proportion to what each brought in, which is the right
    // answer for goods nobody can tell apart on the pallet.
    for (const lot of lots) {
      await placeOnLot(
        lot.id as string,
        round4(difference * (Number(lot.qty_received) / received)),
        0,
      );
    }
  }

  // The stock ledger has to move with the inventory account, or
  // v_check_inventory_reconciliation stops tying. Quantity zero: this is what
  // the goods are worth, not more of them.
  let toInventory = 0;
  for (const at of inventoryAt.values()) {
    if (at.amount === 0) continue;
    await tx`
      insert into stock_movement
        (company_id, item_id, location_id, movement_date, qty, unit_cost,
         total_cost, document_id)
      values
        (${input.companyId}, ${at.itemId}, ${at.locationId}, ${input.docDate}::date,
         0, 0, ${at.amount}, ${input.documentId})`;

    const inv = await tx`
      select fn_resolve_account_for_item(
        ${input.companyId}, 'INVENTORY', ${at.itemId}, null, ${at.locationId}) as a`;
    journal.push({ accountId: inv[0].a, amount: at.amount, locationId: at.locationId });
    toInventory = round4(toInventory + at.amount);
  }

  let toCogs = 0;
  for (const at of expenseFor.values()) {
    if (at.amount === 0) continue;
    const accountId = at.accountId ?? (await tx`
      select fn_resolve_account_for_item(
        ${input.companyId}, 'COGS', ${at.itemId}) as a`)[0].a as string;
    journal.push({ accountId, amount: at.amount, locationId: input.locationId });
    toCogs = round4(toCogs + at.amount);
  }

  return { journal, toInventory, toCogs };
}

/**
 * A return or a found-stock adjustment has no purchase price of its own —
 * it needs some cost to come back in at. Uses the cost of the newest open
 * lot at this location as the best available "what stock is worth right
 * now" estimate, falling back to the most recent lot ever received (even if
 * fully drawn down) if nothing is currently open, and zero only if this
 * item has never been received here at all.
 */
async function estimateCurrentCost(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string
): Promise<number> {
  const [open] = await tx`
    select unit_cost from v_stock_lot_open
     where company_id = ${companyId} and item_id = ${itemId} and location_id = ${locationId}
     order by received_date desc, unit_cost desc
     limit 1`;
  if (open) return Number(open.unit_cost);

  const [last] = await tx`
    select unit_cost from stock_lot
     where company_id = ${companyId} and item_id = ${itemId} and location_id = ${locationId}
     order by received_date desc, created_at desc
     limit 1`;
  return last ? Number(last.unit_cost) : 0;
}

/**
 * A return linked to the sale it came from should carry what those units
 * actually cost when they left, not today's cost. Sales invoices never move
 * stock themselves — postSaleWithDelivery always posts a separate DELIVERY
 * and points the invoice's source_document_id at it — so this walks that
 * one hop when given an invoice, then averages what the delivery's own FIFO
 * consumption paid for this item. Null if the link doesn't lead anywhere
 * costed (no delivery, or the item wasn't on it), so the caller can fall
 * back to estimateCurrentCost.
 */
/**
 * The cost layers a return brings back, in the order they were issued.
 *
 * A delivery can draw from several FIFO layers at once — five units at 100
 * and five at 900 — and averaging them values every returned unit at 500, a
 * price nothing was ever bought at. Instead the layers the original delivery
 * consumed are walked in the order they were consumed, the quantity earlier
 * returns already took is skipped, and this return takes the next slice.
 *
 * First issued is first returned. Which physical unit came back is
 * unknowable, so the rule is a convention rather than a discovery — but it
 * is the same convention FIFO already uses going out, it is deterministic,
 * and returning a whole delivery restores exactly what leaving it cost.
 */
type ReturnLayer = { qty: number; unitCost: number };

async function resolveReturnLayers(
  tx: TransactionSql,
  companyId: string,
  sourceDocumentId: string,
  itemId: string,
  qty: number,
  alreadyReturned: number
): Promise<ReturnLayer[] | null> {
  const deliveryId = await resolveDeliveryBehind(tx, companyId, sourceDocumentId);
  if (!deliveryId) return null;

  const consumed = await tx`
    select c.qty, c.unit_cost
      from stock_movement sm
      join stock_lot_consumption c on c.stock_movement_id = sm.id
      join stock_lot l on l.id = c.lot_id
     where sm.company_id = ${companyId} and sm.document_id = ${deliveryId}
       and sm.item_id = ${itemId}
     order by l.received_date, l.created_at, c.created_at`;

  if (consumed.length === 0) return null;

  let skip = alreadyReturned;
  let left = qty;
  const layers: ReturnLayer[] = [];

  for (const c of consumed) {
    if (left <= 0) break;
    let available = Number(c.qty);

    if (skip > 0) {
      const skipped = Math.min(skip, available);
      skip = round4(skip - skipped);
      available = round4(available - skipped);
      if (available <= 0) continue;
    }

    const take = Math.min(available, left);
    layers.push({ qty: take, unitCost: Number(c.unit_cost) });
    left = round4(left - take);
  }

  // More is being returned than that delivery ever issued. The quantity cap
  // in assertWithinSource is what normally prevents this; if it is reached
  // anyway, the remainder has no layer to come back to and the caller falls
  // back to a current-cost estimate rather than inventing one here.
  return left > 0 ? null : layers;
}

/** The delivery that actually moved the goods, given a sale or the delivery itself. */
async function resolveDeliveryBehind(
  tx: TransactionSql, companyId: string, sourceDocumentId: string
): Promise<string | null> {
  const [src] = await tx`
    select doc_type, source_document_id from document
     where id = ${sourceDocumentId} and company_id = ${companyId}`;
  if (!src) return null;

  if (src.doc_type === "DELIVERY") return sourceDocumentId;

  if (src.doc_type === "SALES_INVOICE" && src.source_document_id) {
    const [linked] = await tx`
      select doc_type from document where id = ${src.source_document_id} and company_id = ${companyId}`;
    if (linked?.doc_type === "DELIVERY") return src.source_document_id;
  }

  return null;
}

/** Collapses journal lines that hit the same account, dropping any that net to zero. */
function consolidate(lines: JournalLine[]): JournalLine[] {
  const byKey = new Map<string, JournalLine>();

  for (const l of lines) {
    const key = `${l.accountId}|${l.partnerId ?? ""}|${l.locationId ?? ""}`;
    const existing = byKey.get(key);
    if (existing) existing.amount = round4(existing.amount + l.amount);
    else byKey.set(key, { ...l, amount: round4(l.amount) });
  }

  return [...byKey.values()].filter((l) => l.amount !== 0);
}

/**
 * Writes one balanced journal entry.
 *
 * `defaultLocationId` is the branch dimension: the location of the document
 * being posted, stamped onto every line that does not name one of its own.
 * It is applied here rather than at each journal.push because there are
 * twenty-six of those and nine had silently omitted it — including revenue,
 * which made a per-branch profit report read zero everywhere. Defaulting at
 * the one choke point means a line has to opt out deliberately, and any
 * posting written later inherits the dimension without having to remember.
 *
 * The default is applied before consolidation so that a line carrying an
 * explicit location and a defaulted line at that same location still
 * collapse together, rather than surviving as two rows on one account.
 */
async function writeJournal(
  tx: TransactionSql,
  companyId: string,
  entryDate: string,
  sourceType: string,
  sourceId: string,
  memo: string,
  lines: JournalLine[],
  defaultLocationId?: string | null
): Promise<string> {
  const located = defaultLocationId
    ? lines.map((l) => (l.locationId ? l : { ...l, locationId: defaultLocationId }))
    : lines;
  const consolidated = consolidate(located);

  const total = round4(consolidated.reduce((s, l) => s + l.amount, 0));
  if (total !== 0) {
    // The database would reject this anyway; failing here gives a better message.
    throw new Error(`Posting does not balance — debits and credits differ by ${total}`);
  }

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${entryDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) {
    throw new Error(`No fiscal year covers ${entryDate}. Set one up before posting.`);
  }

  const noRows = await tx`
    select fn_next_document_no(${companyId}, 'JOURNAL', ${entryDate}::date) as no`;

  const [entry] = await tx`
    insert into journal_entry
      (company_id, entry_no, entry_date, fiscal_period_id, source_type, source_id, memo)
    values
      (${companyId}, ${noRows[0].no}, ${entryDate}::date, null,
       ${sourceType}, ${sourceId}, ${memo})
    returning id`;

  let lineNo = 0;
  for (const l of consolidated) {
    lineNo++;
    await tx`
      insert into journal_line
        (company_id, journal_entry_id, line_no, account_id, currency,
         amount, exchange_rate, base_amount, partner_id, location_id)
      values
        (${companyId}, ${entry.id}, ${lineNo}, ${l.accountId}, 'MMK',
         ${l.amount}, 1, ${l.amount}, ${l.partnerId ?? null}, ${l.locationId ?? null})`;
  }

  return entry.id;
}

/**
 * Sales order: a commitment, nothing more. No stock movement, no ledger
 * entry — it exists to be delivered against (and reported as "reserved"
 * demand on the stock position) until then.
 */
export async function postSalesOrder(input: OrderInput) {
  return postOrder(input, "SALES_ORDER");
}

/** Purchase order: the purchase-side mirror of postSalesOrder. */
export async function postPurchaseOrder(input: OrderInput) {
  return postOrder(input, "PURCHASE_ORDER");
}

async function postOrder(input: OrderInput, docType: "SALES_ORDER" | "PURCHASE_ORDER") {
  return sql.begin(async (tx) => postOrderIn(tx, input, docType));
}

async function postOrderIn(
  tx: TransactionSql,
  input: OrderInput,
  docType: "SALES_ORDER" | "PURCHASE_ORDER"
) {
  if (input.lines.length === 0) throw new Error("An order needs at least one line");
  assertLines(input.lines);

  {
    const { companyId, partnerId, locationId, docDate, dueDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const { docNo, version } = await documentNumberFor(
      tx, companyId, docType, docDate, input.amendOf);

    const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, version, fiscal_year_id, doc_date, posting_date, due_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference)
      values
        (${companyId}, ${docType}, ${docNo}, ${version}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${dueDate ?? null}, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
         ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(), ${input.reference ?? null})
      returning id`;

    let lineNo = 0;
    for (const line of input.lines) {
      lineNo++;
      const [item] = await tx`select base_uom_id from item where id = ${line.itemId}`;
      if (!item) throw new Error("Item not found");

      const net = round4(line.qty * (line.unitPrice ?? 0));
      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price, net_amount, tax_amount, gross_amount)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${line.unitPrice ?? 0}, ${net}, 0, ${net})`;
    }

    // Orders post nothing to the ledger — see docs/01-document-flow.md.
    return { id: doc.id as string, docNo: docNo as string, version };
  }
}

/**
 * Delivery: stock leaves at its FIFO cost — drawn from the oldest open lots
 * at this location — and that cost becomes COGS. This is the only
 * sales-side document that moves inventory.
 *
 *   Dr Cost of Goods Sold / Cr Inventory
 *
 * Free-of-charge lines move stock but post the cost to an expense account
 * instead of COGS.
 */
async function _postDelivery(tx: TransactionSql, input: FulfillmentInput) {
  if (input.lines.length === 0) throw new Error("A delivery needs at least one line");
  assertLines(input.lines);

  const { companyId, partnerId, locationId, docDate } = input;

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  const noRows = await tx`select fn_next_document_no(${companyId}, 'DELIVERY', ${docDate}::date) as no`;
  const docNo = noRows[0].no;

  // A delivery continues either the order that asked for the goods or the
  // invoice that billed for them — never a purchase document, and never
  // another customer's.
  if (input.sourceDocumentId) {
    const src = await requireSource(tx, {
      id: input.sourceDocumentId,
      companyId,
      partnerId,
      expect: ["SALES_ORDER", "SALES_INVOICE"],
      role: "document this delivery fulfils",
    });
    await assertSourceLines(tx, input.sourceDocumentId, input.lines);
    if (src?.doc_type === "SALES_INVOICE") {
      await assertNotOverDelivered(tx, input.sourceDocumentId, input.lines);
    }
  }

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, reference, source_document_id,
       delivery_fee, negative_stock_confirmed, negative_stock_confirmed_at)
    values
      (${companyId}, 'DELIVERY', ${docNo}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       0, 0, 0, ${input.memo ?? null}, now(), ${input.reference ?? null}, ${input.sourceDocumentId ?? null},
       ${round4(input.deliveryFee ?? 0)},
       -- Recorded on the document rather than inferred later from the fact
       -- that stock went negative: the question asked was whether the goods
       -- physically exist, and the answer belongs where it was given.
       ${input.allowNegativeStock === true},
       ${input.allowNegativeStock === true ? new Date().toISOString() : null})
    returning id`;

  const journal: JournalLine[] = [];
  let lineNo = 0;
  let deliveredValue = 0;

  for (const line of input.lines) {
    lineNo++;

    const [item] = await tx`
      select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
    if (!item) throw new Error("Item not found");
    if (!item.is_stocked) throw new Error(`${item.code} (${item.name}) is not stocked and cannot be delivered`);

    if (line.source === "CONSIGNMENT") {
      // A separate pool, never a fallback for owned stock running short —
      // that would be exactly the silent blending this design exists to
      // prevent. Carries no value: nothing owned moved, so nothing posts to
      // the ledger for this line. The document line still records the
      // quantity, at zero, the same reasoning FOC lines already use for
      // "the schema requires a zero here, and the real figure lives
      // elsewhere" — here, the real figure does not exist yet at all. It is
      // computed at settlement, from the price this customer is actually
      // being charged, not from anything decided at delivery.
      const plan = await planConsignmentConsumption(
        tx, companyId, line.itemId, locationId, line.qty, line.consignorId ?? null);

      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price, net_amount, gross_amount,
           source_line_id, is_consignment)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty}, 0, 0, 0,
           ${line.sourceLineId ?? null}, true)`;

      for (const d of plan.draws) {
        await tx`
          insert into consignment_lot_consumption (company_id, lot_id, delivery_document_id, qty)
          values (${companyId}, ${d.lotId}, ${doc.id}, ${d.qty})`;
      }

      continue;
    }

    const onHandRows = await tx`
      select fn_qty_on_hand(${companyId}, ${line.itemId}, ${locationId}) as on_hand`;
    const onHand = Number(onHandRows[0].on_hand);

    // Refused unless someone has confirmed the goods are physically there.
    // This check and the FIFO planner both have to agree about it: this one
    // reads the quantity, that one reads the cost layers, and relaxing only
    // one of them would either refuse a confirmed sale or let an unconfirmed
    // one through.
    if (onHand < line.qty && input.allowNegativeStock !== true) {
      throw new Error(
        `Not enough ${item.code} (${item.name}) at this location — ` +
          `${onHand} on hand, ${line.qty} requested`
      );
    }

    // FIFO: drawn from the oldest open lots at this location, frozen onto
    // the movement. Recomputing it later would silently restate closed
    // periods.
    // allowNegativeStock is set only when someone confirmed the goods
    // physically exist. Without it this still refuses, so no route reaches
    // negative stock without a person having said so.
    const plan = await planFifoConsumption(
      tx, companyId, line.itemId, locationId, line.qty, input.allowNegativeStock === true
    );
    const unitCost = plan.unitCost;
    const totalCost = plan.totalCost;
    deliveredValue += totalCost;

    // A delivery carries no price, so unit_price holds the cost the goods
    // left at — except on a free-of-charge line, where the schema requires a
    // zero (`foc_reason_id is null or unit_price = 0`): the customer is
    // charged nothing, and a figure sitting under the Price column of a
    // giveaway is exactly the confusion that check exists to prevent. The
    // cost is not lost. It stays in net_amount, which is what the document
    // total and the journal are both built from, and the stock movement
    // carries its own unit_cost for FIFO regardless.
    await tx`
      insert into document_line
        (company_id, document_id, line_no, item_id, location_id,
         entered_qty, entered_uom_id, base_qty, unit_price, net_amount, gross_amount,
         foc_reason_id, source_line_id)
      values
        (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
         ${line.qty}, ${item.base_uom_id}, ${line.qty},
         ${line.focReasonId ? 0 : unitCost}, ${totalCost},
         ${totalCost}, ${line.focReasonId ?? null}, ${line.sourceLineId ?? null})`;

    const [movement] = await tx`
      insert into stock_movement
        (company_id, item_id, location_id, movement_date, qty,
         unit_cost, total_cost, document_id)
      values
        (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
         ${-line.qty}, ${unitCost}, ${-totalCost}, ${doc.id})
      returning id`;
    // Resolved before the consumption is written, so the consumption can carry
    // it: the cost of these goods went here, and a correction to that cost has
    // to come back to the same place.
    let expenseAccountId: string;
    if (line.focReasonId) {
      const [foc] = await tx`select account_id from foc_reason where id = ${line.focReasonId}`;
      expenseAccountId = foc.account_id as string;
    } else {
      const cogs = await tx`
        select fn_resolve_account_for_item(${companyId}, 'COGS', ${line.itemId}) as a`;
      expenseAccountId = cogs[0].a as string;
    }

    await recordFifoConsumption(tx, companyId, movement.id, plan, expenseAccountId);
    // Whatever no layer covered goes on the reconciliation worklist, with the
    // cost it was charged out at, so the receipt that eventually arrives can
    // true it up rather than leaving an unexplained negative balance.
    await recordNegativeStock(tx, companyId, doc.id, line.itemId, locationId, plan);

    const inventory = await tx`
      select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
    journal.push({ accountId: inventory[0].a, amount: -totalCost, locationId });
    journal.push({ accountId: expenseAccountId, amount: totalCost, locationId });
  }

  deliveredValue = round4(deliveredValue);

  // A delivery moving only consigned stock has nothing owned to relieve —
  // no Inventory, no COGS, nothing to post — so an empty journal here is
  // correct rather than a sign something was skipped. journal_entry_id
  // stays null; fn_document_posting_required (0029) knows to permit that
  // specifically when every line on the document is consignment-sourced.
  const entryId = journal.length > 0
    ? await writeJournal(tx, companyId, docDate, "DELIVERY", doc.id, `${docNo} delivery`, journal, locationId)
    : null;

  await tx`
    update document set journal_entry_id = ${entryId}, net_total = ${deliveredValue},
           gross_total = ${deliveredValue}
     where id = ${doc.id}`;

  return { id: doc.id as string, docNo: docNo as string };
}

export async function postDelivery(input: FulfillmentInput) {
  return sql.begin((tx) => _postDelivery(tx, input));
}

/**
 * The consignment settlement: recognizes the purchase and the payable for
 * whatever consigned stock this sale's delivery drew on, at the moment the
 * customer is actually billed for it — the user's explicit choice, and the
 * reason this runs from the invoice rather than the delivery.
 *
 *   Dr Cost of Goods Sold / Cr Accounts Payable (the consignor)
 *
 * No Inventory line: these goods were never the company's asset, so there
 * is nothing to relieve. Posted as a real PURCHASE_INVOICE document rather
 * than a bare journal entry — reusing that doc_type, not inventing a third
 * one, so the amount owed shows up in AP aging and payables through
 * infrastructure that already exists. Deliberately its own small function
 * rather than a call into _postPurchaseInvoice: that function carries this
 * session's GR/IR matching and source validation, built for a completely
 * different GL shape, and bolting a second shape onto it risks exactly what
 * that hardening protects.
 *
 * Idempotent by construction: it only ever looks at consumption rows with
 * settlement_document_id still null, so calling it twice for the same
 * delivery (which cannot happen through the normal posting paths, but this
 * is cheap insurance) settles nothing a second time.
 *
 * Percentage settles against the price THIS customer is actually being
 * charged, read from the invoice's own lines rather than any reference
 * price — the same qty of the same item can sell for different amounts to
 * different customers, and the consignor's share follows whatever the sale
 * actually realized.
 */
async function settleConsignmentSales(
  tx: TransactionSql,
  companyId: string,
  docDate: string,
  salesInvoiceId: string,
  salesInvoiceNo: string,
  deliveryId: string,
  saleLines: ReadonlyArray<{ itemId: string; unitPrice: number }>,
  locationId: string
): Promise<void> {
  // Consumed, with no settlement standing against them — never settled, or
  // settled by a document since voided. The view carries that rule so the
  // screens and this agree on what is still owed.
  const consumed = await tx`
    select u.consumption_id, u.lot_id, u.qty, u.item_id, u.consignor_id,
           l.pricing_method, l.pricing_value
      from v_consignment_unsettled u
      join consignment_lot l on l.id = u.lot_id
     where u.delivery_document_id = ${deliveryId}`;

  if (consumed.length === 0) return;

  const byConsignor = new Map<string, any[]>();
  for (const row of consumed) {
    const list = byConsignor.get(row.consignor_id) ?? [];
    list.push(row);
    byConsignor.set(row.consignor_id, list);
  }

  for (const [consignorId, rows] of byConsignor) {
    const priced = rows.map((row: any) => {
      const salePrice = saleLines.find((l) => l.itemId === row.item_id)?.unitPrice ?? 0;
      const amount = row.pricing_method === "PERCENTAGE"
        ? round4(salePrice * Number(row.qty) * (Number(row.pricing_value) / 100))
        : round4(Number(row.pricing_value) * Number(row.qty));
      return { ...row, amount };
    });

    const total = round4(priced.reduce((s: number, r: any) => s + r.amount, 0));
    if (total <= 0) continue;

    const [consignor] = await tx`
      select code, payment_terms_days from business_partner where id = ${consignorId}`;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'PURCHASE_INVOICE', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    // Same convention the sales/purchase vouchers use to prefill a due date
    // from a partner's terms — computed here because there is no UI caller
    // to supply one for a document nobody typed in.
    const terms = Number(consignor.payment_terms_days ?? 0);
    let dueDate: string | null = null;
    if (terms > 0) {
      const d = new Date(`${docDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + terms);
      dueDate = d.toISOString().slice(0, 10);
    }

    const [settleDoc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, source_document_id)
      values
        (${companyId}, 'PURCHASE_INVOICE', ${docNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${dueDate}, ${consignorId}, ${locationId}, 'MMK', 1, 'POSTED',
         ${total}, 0, ${total},
         ${"Consignment settlement for " + salesInvoiceNo}, now(), ${salesInvoiceId})
      returning id`;

    const journal: JournalLine[] = [];
    let lineNo = 0;

    // One line per item, its own amount aggregated across however many lots
    // of it were drawn — the account a given item's COGS resolves to can
    // differ by item group, so these are not collapsed into one figure.
    const byItem = new Map<string, { qty: number; amount: number }>();
    for (const r of priced) {
      const cur = byItem.get(r.item_id) ?? { qty: 0, amount: 0 };
      cur.qty = round4(cur.qty + Number(r.qty));
      cur.amount = round4(cur.amount + r.amount);
      byItem.set(r.item_id, cur);
    }

    for (const [itemId, agg] of byItem) {
      lineNo++;
      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id,
           entered_qty, base_qty, unit_price, net_amount, tax_amount, gross_amount)
        values
          (${companyId}, ${settleDoc.id}, ${lineNo}, ${itemId},
           ${agg.qty}, ${agg.qty}, ${round4(agg.amount / agg.qty)}, ${agg.amount}, 0, ${agg.amount})`;

      const cogs = await tx`
        select fn_resolve_account_for_item(${companyId}, 'COGS', ${itemId}) as a`;
      journal.push({ accountId: cogs[0].a, amount: agg.amount });
    }

    const ap = await tx`
      select fn_resolve_control_account(${companyId}, 'AP_CONTROL', ${consignorId}) as a`;
    journal.push({ accountId: ap[0].a, amount: -total, partnerId: consignorId });

    const entryId = await writeJournal(
      tx, companyId, docDate, "PURCHASE_INVOICE", settleDoc.id,
      `${docNo} consignment settlement`, journal, locationId
    );
    await tx`update document set journal_entry_id = ${entryId} where id = ${settleDoc.id}`;

    for (const r of priced) {
      await tx`
        insert into consignment_settlement_line
          (company_id, consumption_id, settlement_document_id, qty, amount)
        values (${companyId}, ${r.consumption_id}, ${settleDoc.id}, ${r.qty}, ${r.amount})`;

      // The original column, only while it is still empty. 0030 lets it go
      // from nothing to a first settlement and never change again, which is
      // exactly right for what it records; a replacement is a new attempt in
      // the table above, not an edit to this.
      await tx`
        update consignment_lot_consumption
           set settlement_document_id = ${settleDoc.id}
         where id = ${r.consumption_id} and settlement_document_id is null`;
    }
  }
}

/**
 * Sales invoice: revenue is recognised and the customer owes money. Stock
 * does not move here — that already happened on delivery (or happens in the
 * same breath via postSaleWithDelivery, for the common "sell it and it
 * leaves right now" case).
 *
 *   Dr Accounts Receivable / Cr Sales Revenue
 */
async function _postSalesInvoice(
  tx: TransactionSql,
  input: SalesInvoiceInput & { deliveryId?: string | null }
) {
  if (input.lines.length === 0) throw new Error("An invoice needs at least one line");
  assertLines(input.lines);

  // An amendment is the sanctioned way to change an agreed price and carries
  // its own reason and version; every other posting bills what was agreed.
  if (!input.amendOf) {
    await assertAgreedPriceKept(tx, input.companyId, input.lines);
  }

  const cashIn = round4(input.cashIn ?? 0);
  if (cashIn > 0 && !input.cashAccountId) {
    throw new Error("Choose which cash or bank account the money went into");
  }

  const { companyId, partnerId, locationId, docDate, dueDate } = input;

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  const { docNo, version } = await documentNumberFor(
    tx, companyId, "SALES_INVOICE", docDate, input.amendOf);

  // Priced here rather than trusting figures the browser worked out. The
  // bands are company data, the arithmetic is the same pure function the
  // voucher previews with, and doing it server-side is what lets the line
  // record which part of the reduction was typed and which was earned.
  //
  // Free-of-charge lines are left out of it entirely: they carry no revenue
  // to discount, and letting them count towards an invoice-total band would
  // have a giveaway earning the customer a discount on everything else.
  const bands = await tx`
    select id, code, name, basis, item_id, item_group_id,
           min_value, max_value, discount_pct
      from volume_discount
     where company_id = ${companyId} and is_active
       and valid_from <= ${docDate}::date
       and (valid_to is null or valid_to >= ${docDate}::date)`;

  const charged = input.lines.filter((l) => !l.focReasonId);
  const itemGroups = new Map<string, string | null>();
  for (const l of charged) {
    if (itemGroups.has(l.itemId)) continue;
    const [g] = await tx`select item_group_id from item where id = ${l.itemId}`;
    itemGroups.set(l.itemId, g?.item_group_id ?? null);
  }

  const scale = await currencyScale(tx, companyId);
  const priced = priceLines(
    charged.map((l) => ({
      itemId: l.itemId,
      itemGroupId: itemGroups.get(l.itemId) ?? null,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct ?? 0,
    })),
    bands as unknown as VolumeBand[],
    scale
  );

  const pricedFor = new Map<InvoiceLine, LineDiscounts>();
  charged.forEach((l, i) => pricedFor.set(l, priced.lines[i]));

  // The goods total is what the pricing arrived at, not the list prices it
  // started from. Computing it separately is how the receivable and the
  // revenue came to disagree by exactly one volume discount.
  const goodsTotal = priced.total;

  // The fee comes from the delivery unless this invoice states its own. A
  // charge entered when the goods went out must not be lost just because
  // whoever raised the invoice did not retype it.
  let deliveryFee = roundMoney(input.deliveryFee ?? 0, scale);
  if (input.deliveryFee === undefined && input.deliveryId) {
    const [d] = await tx`
      select delivery_fee from document where id = ${input.deliveryId} and company_id = ${companyId}`;
    deliveryFee = roundMoney(Number(d?.delivery_fee ?? 0), scale);
  }
  if (deliveryFee < 0) throw new Error("Delivery fee cannot be negative");

  // The receivable is the goods plus the carriage; the two reach different
  // accounts on the credit side but the customer owes one sum.
  const netTotal = round4(goodsTotal + deliveryFee);

  // An invoice that bills nothing has no journal entry to write, and until
  // now it failed several steps later with "Journal entry JE-000005 has no
  // lines" — true, and useless to whoever is standing at the counter.
  //
  // Refusing is the right answer rather than posting a zero document: a
  // giveaway is already fully accounted for on the delivery, where the cost
  // leaves inventory for the promotion account. An invoice on top of that
  // adds no entry, and a posted document that touched no ledger is a thing
  // to explain later.
  if (netTotal === 0) {
    const allFree = input.lines.every((l) => l.focReasonId);
    throw new Error(
      allFree
        ? "Every line here is free of charge, so there is nothing to invoice. " +
          "Deliver the goods instead — the delivery is what records a giveaway, " +
          "and it sends the cost to the promotion account rather than to sales."
        : "This invoice comes to zero, so there is nothing to bill. Enter a price, " +
          "or mark the lines free of charge and deliver them instead."
    );
  }

  // An invoice that bills a delivery has to be billing this customer's
  // delivery, and a delivery at that.
  if (input.deliveryId) {
    await requireSource(tx, {
      id: input.deliveryId,
      companyId,
      partnerId,
      expect: ["DELIVERY"],
      role: "delivery this invoice bills",
    });
    // Until now this checked the partner and the status and nothing else: an
    // invoice could name a delivery and then bill a different item, or ten
    // times the quantity that went out, and post. The purchase side had at
    // least the line check; the sales side had neither.
    await assertSourceLines(tx, input.deliveryId, input.lines);
    await assertNotOverBilled(tx, input.deliveryId, input.lines, "SALES_INVOICE");
  }

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, version, fiscal_year_id, doc_date, posting_date, due_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at,
       payment_type, salesman_id, reference, to_deliver, source_document_id, delivery_fee)
    values
      (${companyId}, 'SALES_INVOICE', ${docNo}, ${version}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${dueDate}, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(),
       ${input.paymentType ?? "CREDIT"}, ${input.salesmanId ?? null},
       ${input.reference ?? null}, ${input.toDeliver ?? false}, ${input.deliveryId ?? null},
       ${deliveryFee})
    returning id`;

  const journal: JournalLine[] = [];
  let lineNo = 0;

  for (const line of input.lines) {
    lineNo++;

    const [item] = await tx`
      select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
    if (!item) throw new Error("Item not found");

    const d = pricedFor.get(line);
    const net = line.focReasonId ? 0 : round4(d?.net ?? line.qty * line.unitPrice);

    await tx`
      insert into document_line
        (company_id, document_id, line_no, item_id, location_id,
         entered_qty, entered_uom_id, base_qty, unit_price,
         discount_pct, discount_amount,
         volume_discount_pct, volume_discount_amount, volume_discount_id,
         invoice_discount_pct, invoice_discount_amount, invoice_discount_id,
         net_amount, tax_amount, gross_amount, foc_reason_id)
      values
        (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
         ${line.qty}, ${item.base_uom_id}, ${line.qty},
         ${line.focReasonId ? 0 : line.unitPrice},
         ${d?.itemDiscountPct ?? 0}, ${d?.itemDiscountAmount ?? 0},
         ${d?.volumeDiscountPct ?? 0}, ${d?.volumeDiscountAmount ?? 0}, ${d?.volumeDiscountId ?? null},
         ${d?.invoiceDiscountPct ?? 0}, ${d?.invoiceDiscountAmount ?? 0}, ${d?.invoiceDiscountId ?? null},
         ${net}, 0, ${net}, ${line.focReasonId ?? null})`;

    // Revenue only — stock and COGS belong to the delivery, not the invoice.
    if (net !== 0) {
      const revenue = await tx`
        select fn_resolve_account_for_item(${companyId}, 'REVENUE', ${line.itemId}) as a`;
      journal.push({ accountId: revenue[0].a, amount: -net });
    }
  }

  // Carriage is income the company earns for delivering, not part of what the
  // goods sold for. Sending it to Sales would inflate revenue and quietly
  // flatter gross margin on the products themselves, which is the number the
  // business is actually judged on.
  if (deliveryFee !== 0) {
    const [income] = await tx`
      select account_id from system_account
       where company_id = ${companyId} and role = 'DELIVERY_INCOME'`;
    if (!income) {
      throw new Error(
        "No account is set for delivery income. Point the DELIVERY_INCOME role " +
        "at an income account before charging a delivery fee."
      );
    }
    journal.push({ accountId: income.account_id, amount: -deliveryFee });
  }

  if (netTotal !== 0) {
    const ar = await tx`
      select fn_resolve_control_account(${companyId}, 'AR_CONTROL', ${partnerId}) as a`;
    journal.push({ accountId: ar[0].a, amount: netTotal, partnerId });
  }

  const entryId = await writeJournal(
    tx, companyId, docDate, "SALES_INVOICE", doc.id, `${docNo} sales invoice`, journal, locationId
  );

  await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

  // If the delivery behind this invoice drew any consigned stock, this is
  // the moment — recognized at the invoice, not the delivery, at the price
  // this customer is actually being charged. A sale with no consigned lines
  // finds nothing to settle and returns immediately.
  if (input.deliveryId) {
    await settleConsignmentSales(
      tx, companyId, docDate, doc.id, docNo, input.deliveryId,
      input.lines.map((l) => ({ itemId: l.itemId, unitPrice: l.unitPrice })),
      locationId
    );
  }

  // Money taken at the counter becomes a real receipt document allocated to
  // this invoice, rather than a number on the invoice header. That is what
  // keeps the receivable an open item: a part payment leaves the balance
  // attached to this specific invoice instead of vanishing into a total.
  let receiptNo: string | null = null;

  if (cashIn > 0) {
    if (cashIn > netTotal) {
      throw new Error(
        `Cash in (${cashIn}) is more than the invoice total (${netTotal})`
      );
    }

    const rcNoRows = await tx`
      select fn_next_document_no(${companyId}, 'CUSTOMER_RECEIPT', ${docDate}::date) as no`;
    receiptNo = rcNoRows[0].no;

    const [receipt] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at,
         source_document_id, payment_type, salesman_id)
      values
        (${companyId}, 'CUSTOMER_RECEIPT', ${receiptNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
         ${cashIn}, 0, ${cashIn}, ${`Cash received against ${docNo}`}, now(),
         ${doc.id}, 'CASH', ${input.salesmanId ?? null})
      returning id`;

    await tx`
      insert into payment_allocation
        (company_id, payment_id, invoice_id, amount, base_amount)
      values (${companyId}, ${receipt.id}, ${doc.id}, ${cashIn}, ${cashIn})`;

    const ar = await tx`
      select fn_resolve_control_account(${companyId}, 'AR_CONTROL', ${partnerId}) as a`;

    const receiptEntry = await writeJournal(
      tx, companyId, docDate, "CUSTOMER_RECEIPT", receipt.id,
      `${receiptNo} against ${docNo}`,
      [
        { accountId: input.cashAccountId as string, amount: cashIn },
        { accountId: ar[0].a, amount: -cashIn, partnerId },
      ],
      locationId
    );

    await tx`update document set journal_entry_id = ${receiptEntry} where id = ${receipt.id}`;
  }

  return { id: doc.id as string, docNo: docNo as string, receiptNo };
}

export async function postSalesInvoice(input: SalesInvoiceInput & { deliveryId?: string | null }) {
  return sql.begin((tx) => _postSalesInvoice(tx, input));
}

/**
 * The common case: sell it and it leaves right now. Posts a delivery for
 * every stocked line and the invoice in the same transaction, so the two
 * documents that theory says are separate never exist independently of one
 * another for a counter sale — either both post or neither does.
 */
export async function postSaleWithDelivery(input: SalesInvoiceInput) {
  if (input.lines.length === 0) throw new Error("An invoice needs at least one line");
  assertLines(input.lines);

  return sql.begin(async (tx) => {
    const itemIds = input.lines.map((l) => l.itemId);
    const flags = await tx`select id, is_stocked from item where id = any(${itemIds})`;
    const stocked = new Set(flags.filter((r: any) => r.is_stocked).map((r: any) => r.id));
    const toDeliver = input.lines.filter((l) => stocked.has(l.itemId));

    let deliveryId: string | undefined;
    if (toDeliver.length > 0) {
      const delivery = await _postDelivery(tx, {
        companyId: input.companyId,
        partnerId: input.partnerId,
        locationId: input.locationId,
        docDate: input.docDate,
        memo: input.memo,
        reference: input.reference,
        // Recorded on the delivery as a fact about it; the invoice below
        // posts it. Passing it to both cannot double count — the delivery
        // writes no journal, and the invoice uses its own value rather than
        // reading the delivery's back.
        deliveryFee: input.deliveryFee,
        // The sales voucher posts invoice and delivery together, so the
        // confirmation given on the voucher has to reach the half that
        // actually moves the stock.
        allowNegativeStock: input.allowNegativeStock,
        lines: toDeliver.map((l) => ({
          itemId: l.itemId, qty: l.qty, focReasonId: l.focReasonId,
          // The invoice's choice of pool travels to the delivery it creates,
          // which is the document that actually moves the goods.
          source: l.source, consignorId: l.consignorId,
        })),
      });
      deliveryId = delivery.id;
    }

    return _postSalesInvoice(tx, { ...input, deliveryId });
  });
}

/**
 * Goods receipt: stock arrives at the price paid. This is the only
 * purchase-side document that moves inventory.
 *
 *   Dr Inventory / Cr GR/IR Clearing
 *
 * The bill hasn't necessarily arrived yet — that's exactly what GR/IR
 * clearing holds open until it does.
 */
async function _postGoodsReceipt(tx: TransactionSql, input: FulfillmentInput) {
  if (input.lines.length === 0) throw new Error("A goods receipt needs at least one line");
  assertLines(input.lines);

  const { companyId, partnerId, locationId, docDate } = input;
  const receivedAt = input.receivedAt || docDate;

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  const noRows = await tx`
    select fn_next_document_no(${companyId}, 'GOODS_RECEIPT', ${docDate}::date) as no`;
  const docNo = noRows[0].no;

  /**
   * Matched to a bill that has already arrived: the bill is what these goods
   * cost, so the bill is what they are valued at.
   *
   * A receipt normally carries an estimate — the PO price, or whatever the
   * warehouse was told — and the invoice settles it later, which is the
   * difference Purchase Price Variance exists to hold. When the invoice came
   * first there is nothing to estimate. Valuing the goods at a figure typed
   * on the receipt instead put the gap in the P&L: received 200 at a typed
   * 120 against a bill of 80 credited 8,000 to variance, which reads as a
   * profit on buying something, and carried the stock 8,000 above what was
   * actually owed for it.
   *
   * The invoice price is the starting point, not the whole of the cost —
   * freight and duties belong in inventory too under IAS 2. Those are actual
   * costs with documents behind them and are not this: they are added by
   * landed-cost allocation, not by overtyping a receipt.
   *
   * Quantity stays the receiver's to state. Receiving more than was billed is
   * a real event; the excess is valued at the same price and stays in GR/IR
   * as goods not yet invoiced, which is what it is.
   */
  const billed = new Map<string, number>();
  if (input.sourceDocumentId) {
    const [maybe] = await tx`
      select doc_type from document
       where id = ${input.sourceDocumentId} and company_id = ${companyId}`;
    if (maybe?.doc_type === "PURCHASE_INVOICE") {
      // Quantity-weighted where an item is billed on more than one line, so
      // one receipt line takes one cost and it is the cost of those goods.
      const prices = await tx`
        select dl.item_id, sum(dl.net_amount) as net, sum(dl.base_qty) as qty
          from document_line dl
         where dl.document_id = ${input.sourceDocumentId}
         group by dl.item_id
        having sum(dl.base_qty) > 0`;
      for (const r of prices) billed.set(r.item_id, Number(r.net) / Number(r.qty));
    }
  }

  const lines = input.lines.map((l) =>
    billed.has(l.itemId) ? { ...l, unitCost: billed.get(l.itemId)! } : l);

  const netTotal = round4(lines.reduce((s, l) => s + l.qty * (l.unitCost ?? 0), 0));

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, reference, source_document_id)
    values
      (${companyId}, 'GOODS_RECEIPT', ${docNo}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(), ${input.reference ?? null},
       ${input.sourceDocumentId ?? null})
    returning id`;

  const journal: JournalLine[] = [];
  let lineNo = 0;

  for (const line of lines) {
    lineNo++;

    const [item] = await tx`select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
    if (!item) throw new Error("Item not found");
    if (!item.is_stocked) throw new Error(`${item.code} (${item.name}) is not stocked and cannot be received`);

    const unitCost = line.unitCost ?? 0;
    const net = round4(line.qty * unitCost);

    await tx`
      insert into document_line
        (company_id, document_id, line_no, item_id, location_id,
         entered_qty, entered_uom_id, base_qty, unit_price,
         net_amount, tax_amount, gross_amount, source_line_id)
      values
        (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
         ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${unitCost},
         ${net}, 0, ${net}, ${line.sourceLineId ?? null})`;

    const [movement] = await tx`
      insert into stock_movement
        (company_id, item_id, location_id, movement_date, qty,
         unit_cost, total_cost, document_id)
      values
        (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
         ${line.qty}, ${unitCost}, ${net}, ${doc.id})
      returning id`;

    // Goods already sold before anyone recorded them arriving are covered
    // first, at what this receipt says they really cost. They never sat on
    // the shelf, so no layer is made for them — a lot created and instantly
    // consumed would be a fiction with a date on it. Only the remainder
    // becomes stock.
    const { covered, variance } = await settleNegativeStock(
      tx, companyId, doc.id, line.itemId, locationId, line.qty, unitCost, movement.id
    );
    const toShelf = round4(line.qty - covered);
    if (toShelf > 0.0001) {
      await createFifoLot(tx, companyId, line.itemId, locationId, receivedAt, unitCost, toShelf, movement.id);
    }

    const inventory = await tx`
      select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
    journal.push({ accountId: inventory[0].a, amount: net, locationId });

    // The sale charged the provisional figure; this receipt says what the
    // goods actually cost. The difference belongs on the same account a
    // purchase price difference goes to — it is the same kind of thing, a
    // cost known later than the entry that needed it.
    if (Math.abs(variance) > 0.0001) {
      const v = await tx`select fn_system_account(${companyId}, 'PURCHASE_PRICE_VARIANCE') as a`;
      journal.push({ accountId: v[0].a, amount: variance, locationId });
      journal.push({ accountId: inventory[0].a, amount: -variance, locationId });
    }
  }

  // GR/IR carries what arrived, priced as above. Matched or not, the credit
  // is the value of the goods themselves, so a receipt can never release more
  // of a bill than it actually brought in.
  const grirAmount = netTotal;
  if (input.sourceDocumentId) {
    // Locked, not merely read: the matching below decides how much of this
    // invoice is still unreceived, and two receipts arriving at once must
    // not both settle the same outstanding quantity. Same reasoning as the
    // invoice side, and the same reason the FIFO consumption planner locks
    // the lots it is about to draw from.
    //
    // A receipt continues either the order that asked for the goods or the
    // invoice that billed for them, and nothing else.
    const src = await requireSource(tx, {
      id: input.sourceDocumentId,
      companyId,
      partnerId,
      expect: ["PURCHASE_ORDER", "PURCHASE_INVOICE"],
      role: "document this receipt fulfils",
    });
    await assertSourceLines(tx, input.sourceDocumentId, input.lines);
    if (src?.doc_type === "PURCHASE_INVOICE") {
      // Nothing to apportion any more. The lines were priced from this
      // invoice above, so what the goods are worth and what the invoice was
      // holding for them are the same number by construction, and GR/IR
      // clears by exactly what arrived.
      //
      // This used to draw line by line from the invoice and book the
      // remainder as variance, which was the only way to keep the two sides
      // honest while the receipt was free to name its own price. Half a
      // shipment releasing the whole invoice — the bug that matcher was
      // written for — cannot happen when the credit is the receipt's own
      // value: 50 of 100 units credit 50 units' worth, and the other 50
      // stay in GR/IR because they have not arrived.
      //
      // Received beyond what was billed lands here too, as a credit balance
      // on the invoice: goods held and not yet invoiced, awaiting a bill.
    }
  }

  // Goods that answer an order the document does not name — the invoice-first
  // case, where source_document_id is already spoken for. Recorded here, with
  // the same checks a link made afterwards goes through.
  await linkNamedOrderLines(tx, companyId, doc.id as string, lines);

  const grir = await tx`select fn_system_account(${companyId}, 'GRIR_CLEARING') as a`;
  journal.push({ accountId: grir[0].a, amount: -grirAmount, partnerId });

  const entryId = await writeJournal(
    tx, companyId, docDate, "GOODS_RECEIPT", doc.id, `${docNo} goods receipt`, journal, locationId
  );
  await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

  return { id: doc.id as string, docNo: docNo as string };
}

/**
 * Order lines a fulfilment names on the way in.
 *
 * The document's own lines have just been written, so each input line is
 * matched back to the row it created — by item and quantity, in order, which
 * is how they were inserted. Everything else is the same validation a manual
 * link goes through, because a link made at posting time is no more
 * trustworthy than one made afterwards.
 */
async function linkNamedOrderLines(
  tx: TransactionSql,
  companyId: string,
  documentId: string,
  lines: ReadonlyArray<{ itemId: string; qty: number; orderLineId?: string | null }>
): Promise<void> {
  const named = lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.orderLineId);
  if (named.length === 0) return;

  const rows = await tx`
    select id, line_no, item_id, base_qty from document_line
     where document_id = ${documentId} order by line_no`;

  const allocations = named.map((l) => {
    const row = rows[l.i];
    if (!row || row.item_id !== l.itemId) {
      throw new Error(`Line ${l.i + 1}: could not tell which line fulfils that order`);
    }
    return { fulfilmentLineId: row.id as string, orderLineId: l.orderLineId as string, qty: l.qty };
  });

  await linkFulfilmentIn(tx, { companyId, lines: allocations, source: "POSTING" });
}

/**
 * These goods answered that order.
 *
 * The relationship a receipt cannot always carry on its own. A receipt raised
 * with no order chosen, or matched to the invoice that billed for it, leaves
 * the order at nothing received — the goods are on the shelf and the order
 * turns overdue behind them. Nothing can be inferred afterwards from the item
 * alone: two orders for the same product, and a guess closes the wrong one.
 * So someone says which, and this records that they said it.
 *
 * Every allocation is checked, not trusted:
 *
 *   - both documents belong to this company and the same partner
 *   - the fulfilment is POSTED, and is a receipt against a purchase order or
 *     a delivery against a sales order — never the two crossed
 *   - the lines are for the same item
 *   - the order line has that much still outstanding
 *   - the receipt line has that much not already allocated elsewhere
 *
 * The last two are why this locks the order first: two people linking the
 * same receipt to the same order at once would otherwise both read "10 still
 * outstanding" and both allocate it.
 */
export async function linkFulfilmentToOrder(input: {
  companyId: string;
  /** Allocations: which receipt/delivery line answers which order line, and how much. */
  lines: { fulfilmentLineId: string; orderLineId: string; qty: number }[];
  reason?: string | null;
  linkedBy?: string | null;
  source?: "POSTING" | "MANUAL";
}) {
  if (input.lines.length === 0) throw new Error("Nothing to link");
  return sql.begin(async (tx) => linkFulfilmentIn(tx, input));
}

async function linkFulfilmentIn(
  tx: TransactionSql,
  input: {
    companyId: string;
    lines: { fulfilmentLineId: string; orderLineId: string; qty: number }[];
    reason?: string | null;
    linkedBy?: string | null;
    source?: "POSTING" | "MANUAL";
  }
) {
  const { companyId } = input;
  const written: { fulfilmentLineId: string; orderLineId: string; qty: number }[] = [];

  for (const [i, l] of input.lines.entries()) {
    if (!(l.qty > 0)) throw new Error(`Line ${i + 1}: quantity must be more than nothing`);

    // Locked before it is read, so two people cannot allocate the same
    // outstanding quantity at the same moment.
    const [order] = await tx`
      select ol.id, ol.item_id, ol.base_qty as ordered,
             o.id as document_id, o.doc_no, o.doc_type, o.partner_id, o.status
        from document_line ol
        join document o on o.id = ol.document_id
       where ol.id = ${l.orderLineId} and o.company_id = ${companyId}
       for update of o`;
    if (!order) throw new Error(`Line ${i + 1}: that order line does not exist`);
    if (order.status !== "POSTED") {
      throw new Error(`Line ${i + 1}: ${order.doc_no} is ${order.status} and cannot be fulfilled`);
    }

    const [got] = await tx`
      select dl.id, dl.item_id, dl.base_qty as qty,
             d.doc_no, d.doc_type, d.partner_id, d.status
        from document_line dl
        join document d on d.id = dl.document_id
       where dl.id = ${l.fulfilmentLineId} and d.company_id = ${companyId}`;
    if (!got) throw new Error(`Line ${i + 1}: that receipt line does not exist`);
    if (got.status !== "POSTED") {
      throw new Error(`Line ${i + 1}: ${got.doc_no} is ${got.status} and cannot fulfil anything`);
    }

    const pairs: Record<string, string> = {
      PURCHASE_ORDER: "GOODS_RECEIPT",
      SALES_ORDER: "DELIVERY",
    };
    if (pairs[order.doc_type as string] !== got.doc_type) {
      throw new Error(
        `Line ${i + 1}: ${got.doc_no} is a ${readable(got.doc_type)} and cannot fulfil ` +
        `${order.doc_no}, which is a ${readable(order.doc_type)}`
      );
    }
    if (order.partner_id !== got.partner_id) {
      throw new Error(`Line ${i + 1}: ${got.doc_no} and ${order.doc_no} are for different partners`);
    }
    if (order.item_id !== got.item_id) {
      throw new Error(`Line ${i + 1}: those two lines are for different items`);
    }

    // What the order still expects, counting what already answers it either
    // way — the same reckoning every screen uses.
    const [outstanding] = await tx`
      select coalesce(sum(v.outstanding), 0) as v
        from v_order_outstanding v
       where v.order_id = ${order.document_id} and v.item_id = ${order.item_id}`;
    if (Number(outstanding.v) + 0.0001 < l.qty) {
      throw new Error(
        `Line ${i + 1}: ${order.doc_no} has ${Number(outstanding.v)} of that item still ` +
        `outstanding, not ${l.qty}`
      );
    }

    // And what this receipt line has left to give. Allocating the same units
    // to two orders is how one shipment closes two.
    const [used] = await tx`
      select coalesce(sum(qty), 0) as v from fulfilment_link
       where fulfilment_line_id = ${l.fulfilmentLineId}`;
    const spare = round4(Number(got.qty) - Number(used.v));
    if (spare + 0.0001 < l.qty) {
      throw new Error(
        `Line ${i + 1}: ${got.doc_no} has ${spare} of that item not already allocated ` +
        `to an order, not ${l.qty}`
      );
    }

    await tx`
      insert into fulfilment_link
        (company_id, fulfilment_line_id, order_line_id, qty, reason, linked_by, source)
      values
        (${companyId}, ${l.fulfilmentLineId}, ${l.orderLineId}, ${l.qty},
         ${input.reason ?? null}, ${input.linkedBy ?? null}, ${input.source ?? "MANUAL"})`;

    written.push({ fulfilmentLineId: l.fulfilmentLineId, orderLineId: l.orderLineId, qty: l.qty });
  }

  return { linked: written };
}

/**
 * The rest is not coming.
 *
 * A different statement from linking, and kept separate on purpose. Linking
 * says the goods arrived and answer this order; closing says whatever is left
 * will never arrive. Closing an order whose goods did arrive would silence
 * the overdue warning and leave the received quantity wrong — a report that
 * looks tidy and is false.
 */
export async function closeOrderRemaining(input: {
  companyId: string;
  documentId: string;
  reason: string;
  closedBy?: string | null;
}) {
  if (!input.reason?.trim()) throw new Error("Say why the rest is not expected");
  return sql.begin(async (tx) => {
    const [order] = await tx`
      select id, doc_no, doc_type, status from document
       where id = ${input.documentId} and company_id = ${input.companyId}
       for update`;
    if (!order) throw new Error("That order does not exist");
    if (!["PURCHASE_ORDER", "SALES_ORDER"].includes(order.doc_type as string)) {
      throw new Error(`${order.doc_no} is not an order`);
    }
    if (order.status !== "POSTED") {
      throw new Error(`${order.doc_no} is ${order.status}`);
    }
    await tx`
      insert into order_closure (company_id, document_id, reason, closed_by, is_open)
      values (${input.companyId}, ${input.documentId}, ${input.reason.trim()},
              ${input.closedBy ?? null}, false)`;
    return { docNo: order.doc_no as string };
  });
}

/** Undo a closure: the goods are expected after all. */
export async function reopenOrder(input: {
  companyId: string; documentId: string; reason: string; closedBy?: string | null;
}) {
  if (!input.reason?.trim()) throw new Error("Say why it is expected again");
  return sql.begin(async (tx) => {
    const [order] = await tx`
      select id, doc_no from document
       where id = ${input.documentId} and company_id = ${input.companyId} for update`;
    if (!order) throw new Error("That order does not exist");
    await tx`
      insert into order_closure (company_id, document_id, reason, closed_by, is_open)
      values (${input.companyId}, ${input.documentId}, ${input.reason.trim()},
              ${input.closedBy ?? null}, true)`;
    return { docNo: order.doc_no as string };
  });
}

export async function postGoodsReceipt(input: FulfillmentInput) {
  return sql.begin((tx) => _postGoodsReceipt(tx, input));
}

/**
 * Purchase invoice: the supplier is owed. Stock does not move here.
 *
 * Matched to a receipt: Dr GR/IR Clearing for what the receipt valued the
 * goods at, plus/minus a price variance for whatever the bill disagrees
 * with that by, Cr Accounts Payable for the full bill.
 *
 * Not matched to any receipt (the bill arrived first): Dr GR/IR Clearing for
 * the full amount, which then sits there — same as an unmatched receipt —
 * until a receipt eventually clears it.
 */
async function _postPurchaseInvoice(
  tx: TransactionSql,
  input: InvoiceInput & { goodsReceiptId?: string | null; cashOut?: number; cashAccountId?: string | null }
) {
  if (input.lines.length === 0) throw new Error("An invoice needs at least one line");
  assertLines(input.lines);

  const cashOut = round4(input.cashOut ?? 0);
  if (cashOut > 0 && !input.cashAccountId) {
    throw new Error("Choose which cash or bank account the money came from");
  }

  const { companyId, partnerId, locationId, docDate, dueDate } = input;

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  const { docNo, version } = await documentNumberFor(
    tx, companyId, "PURCHASE_INVOICE", docDate, input.amendOf);

  // Each line rounded to what the currency can express, and the total summed
  // from those — not the exact arithmetic rounded afterwards, which would
  // leave the document total and its own lines disagreeing by a fraction.
  const scale = await currencyScale(tx, companyId);
  const lineNets = input.lines.map((l) => roundMoney(l.qty * l.unitPrice, scale));
  const netTotal = roundMoney(lineNets.reduce((t, v) => t + v, 0), scale);

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, version, fiscal_year_id, doc_date, posting_date, due_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, source_document_id)
    values
      (${companyId}, 'PURCHASE_INVOICE', ${docNo}, ${version}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${dueDate}, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(), ${input.goodsReceiptId ?? null})
    returning id`;

  const journal: JournalLine[] = [];
  let lineNo = 0;
  let stockedNet = 0;
  const isStocked = new Map<string, boolean>();

  for (const line of input.lines) {
    lineNo++;

    const [item] = await tx`
      select id, is_stocked, base_uom_id from item where id = ${line.itemId}`;
    if (!item) throw new Error("Item not found");

    const net = lineNets[lineNo - 1];

    await tx`
      insert into document_line
        (company_id, document_id, line_no, item_id, location_id,
         entered_qty, entered_uom_id, base_qty, unit_price,
         net_amount, tax_amount, gross_amount, source_line_id)
      values
        (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
         ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${line.unitPrice},
         ${net}, 0, ${net}, ${line.sourceLineId ?? null})`;

    isStocked.set(line.itemId, !!item.is_stocked);

    if (item.is_stocked) {
      // Cleared against GR/IR below, once for the whole invoice — a single
      // matched or unmatched settlement reads far clearer than one per line.
      stockedNet += net;
    } else {
      // A service or charge line goes straight to expense via its item group.
      const cogs = await tx`
        select fn_resolve_account_for_item(${companyId}, 'COGS', ${line.itemId}) as a`;
      journal.push({ accountId: cogs[0].a, amount: net, locationId });
    }
  }
  stockedNet = round4(stockedNet);

  if (stockedNet !== 0) {
    let grirAmount = stockedNet;

    if (input.goodsReceiptId) {
      // GR/IR is relieved by what this invoice actually bills for, not by the
      // whole receipt. Taking the receipt's full value meant a supplier
      // billing 30 of 100 received units cleared all 100: the 70 still
      // genuinely unbilled were written off to price variance, the payable
      // that was still owed vanished, and the dashboard reported nothing
      // awaiting an invoice. A later invoice for the rest then had no receipt
      // left to match.
      //
      // Lock the receipt for the duration of the match. Everything below
      // reads how much of it is still unbilled and then bills some of it,
      // which is only correct if nothing else is doing the same thing at the
      // same moment: two invoices reading "100 unbilled" before either
      // commits would each relieve the full 100, taking twice out of GR/IR
      // what the goods were received at.
      //
      // That does not happen today, but only by accident. fn_next_document_no
      // takes a row lock on the number series before any of this runs, and
      // holds it to commit, so purchase invoices already queue behind one
      // another. That lock exists for gapless numbering and is keyed by
      // fiscal year — it protects this by coincidence, and stops protecting
      // it the moment numbering changes. An invariant about money should not
      // rest on a lock taken for document numbering.
      // Resolves the receipt, proves it is one, proves it is this supplier's,
      // and locks it — all of which this match depends on.
      await requireSource(tx, {
        id: input.goodsReceiptId,
        companyId,
        partnerId,
        expect: ["GOODS_RECEIPT"],
        role: "goods receipt this invoice bills",
      });
      await assertSourceLines(tx, input.goodsReceiptId, input.lines);
      await assertNotOverBilled(tx, input.goodsReceiptId, input.lines,
        "PURCHASE_INVOICE", doc.id as string);

      // Matched against the receipt's individual lines by grirMatcher above,
      // which is the same code the receipt side uses coming the other way.
      const receiptLines = await tx`
        select dl.id, dl.item_id, dl.base_qty as qty, dl.net_amount as net
          from document_line dl
         where dl.document_id = ${input.goodsReceiptId}
         order by dl.line_no`;

      // What earlier invoices already took off this receipt. One that names
      // the receipt line it bills comes off that line; one that does not —
      // anything posted before invoices carried the reference — names only
      // the item, and is drained oldest first.
      const priorLines = await tx`
        select dl.item_id, dl.base_qty as qty, dl.source_line_id
          from document_line dl
          join document d on d.id = dl.document_id
         where d.company_id = ${companyId}
           and d.doc_type = 'PURCHASE_INVOICE'
           and d.status = 'POSTED'
           and d.source_document_id = ${input.goodsReceiptId}
           and d.id <> ${doc.id}
         order by d.posting_date, d.doc_no, dl.line_no`;

      const draw = grirMatcher(receiptLines as unknown as MatchableLine[]);

      // Replay what has already been billed, so this invoice sees only what
      // is genuinely left. Derived from the posted invoices rather than
      // stored, same as every other figure here.
      for (const prior of priorLines) {
        draw(prior.item_id, Number(prior.qty), prior.source_line_id);
      }

      // Billing more than was received relieves only what is actually held
      // in GR/IR; the excess falls into variance below, where it shows up
      // rather than silently balancing.
      let relieved = 0;
      // Which receipt lines this bill settles and how many units of each, so
      // the difference between what they were received at and what the
      // supplier is charging can be put where those goods actually are.
      const billed: {
        receiptLineId: string; qty: number; newUnitCost: number; heldValue: number;
      }[] = [];
      for (const line of input.lines) {
        if (!isStocked.get(line.itemId)) continue;
        const got = draw(line.itemId, line.qty, line.sourceLineId);
        relieved += got.value;

        for (const t of got.taken) {
          billed.push({
            receiptLineId: t.lineId,
            qty: t.qty,
            newUnitCost: line.unitPrice,
            heldValue: t.value,
          });
        }
      }
      grirAmount = round4(relieved);

      // A price that turned out to be wrong is a cost, not an expense. It goes
      // back onto the goods it was wrong about — split between the ones still
      // on the shelf and the ones already sold, which is the whole of decision
      // D1 and the reason PPV is no longer the catch-all it was.
      const revalued = await adjustReceiptCost(tx, {
        companyId,
        documentId: doc.id as string,
        docDate,
        locationId,
        reason: `${docNo} billed at a different price from the receipt`,
        billed,
      });
      for (const jl of revalued.journal) journal.push(jl);

      // What is left has no goods behind it: either the bill charges for more
      // than ever arrived, or the goods never became a lot. Variance is
      // exactly right for that, and now means only that.
      const variance = round4(stockedNet - grirAmount - revalued.toInventory - revalued.toCogs);
      if (variance !== 0) {
        const pv = await tx`select fn_system_account(${companyId}, 'PURCHASE_PRICE_VARIANCE') as a`;
        journal.push({ accountId: pv[0].a, amount: variance, locationId });
      }
    }

    const grir = await tx`select fn_system_account(${companyId}, 'GRIR_CLEARING') as a`;
    journal.push({ accountId: grir[0].a, amount: grirAmount, partnerId });
  }

  const ap = await tx`
    select fn_resolve_control_account(${companyId}, 'AP_CONTROL', ${partnerId}) as a`;
  journal.push({ accountId: ap[0].a, amount: -netTotal, partnerId });

  const entryId = await writeJournal(
    tx, companyId, docDate, "PURCHASE_INVOICE", doc.id, `${docNo} purchase invoice`, journal, locationId
  );

  await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

  // Cash paid at the counter becomes a real payment document allocated to
  // this invoice, rather than a number on the invoice header — the purchase
  // mirror of how a sales invoice handles cash taken in.
  let paymentNo: string | null = null;

  if (cashOut > 0) {
    if (cashOut > netTotal) {
      throw new Error(`Cash paid (${cashOut}) is more than the invoice total (${netTotal})`);
    }

    const pmtNoRows = await tx`
      select fn_next_document_no(${companyId}, 'SUPPLIER_PAYMENT', ${docDate}::date) as no`;
    paymentNo = pmtNoRows[0].no;

    const [payment] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at,
         source_document_id, payment_type)
      values
        (${companyId}, 'SUPPLIER_PAYMENT', ${paymentNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${partnerId}, 'MMK', 1, 'POSTED',
         ${cashOut}, 0, ${cashOut}, ${`Cash paid against ${docNo}`}, now(),
         ${doc.id}, 'CASH')
      returning id`;

    await tx`
      insert into payment_allocation
        (company_id, payment_id, invoice_id, amount, base_amount)
      values (${companyId}, ${payment.id}, ${doc.id}, ${cashOut}, ${cashOut})`;

    const ap = await tx`
      select fn_resolve_control_account(${companyId}, 'AP_CONTROL', ${partnerId}) as a`;

    const paymentEntry = await writeJournal(
      tx, companyId, docDate, "SUPPLIER_PAYMENT", payment.id,
      `${paymentNo} against ${docNo}`,
      [
        { accountId: ap[0].a, amount: cashOut, partnerId },
        { accountId: input.cashAccountId as string, amount: -cashOut },
      ],
      locationId
    );

    await tx`update document set journal_entry_id = ${paymentEntry} where id = ${payment.id}`;
  }

  return { id: doc.id as string, docNo: docNo as string, paymentNo };
}

export async function postPurchaseInvoice(
  input: InvoiceInput & { goodsReceiptId?: string | null; cashOut?: number; cashAccountId?: string | null }
) {
  return sql.begin((tx) => _postPurchaseInvoice(tx, input));
}

/** The purchase-side mirror of postSaleWithDelivery: receive it and bill it in one step. */
export async function postPurchaseWithReceipt(
  input: InvoiceInput & { cashOut?: number; cashAccountId?: string | null }
) {
  if (input.lines.length === 0) throw new Error("An invoice needs at least one line");
  assertLines(input.lines);

  return sql.begin(async (tx) => {
    const itemIds = input.lines.map((l) => l.itemId);
    const flags = await tx`select id, is_stocked from item where id = any(${itemIds})`;
    const stocked = new Set(flags.filter((r: any) => r.is_stocked).map((r: any) => r.id));
    const toReceive = input.lines.filter((l) => stocked.has(l.itemId));

    let goodsReceiptId: string | undefined;
    if (toReceive.length > 0) {
      const gr = await _postGoodsReceipt(tx, {
        companyId: input.companyId,
        partnerId: input.partnerId,
        locationId: input.locationId,
        docDate: input.docDate,
        // "Received now" means now — the actual moment this posts, not
        // midnight on the document date.
        receivedAt: new Date().toISOString(),
        memo: input.memo,
        reference: input.reference,
        lines: toReceive.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitPrice })),
      });
      goodsReceiptId = gr.id;
    }

    return _postPurchaseInvoice(tx, { ...input, goodsReceiptId });
  });
}

// =========================================================================
// Stock adjustments
// =========================================================================
//
// Neither a sale nor a purchase — a correction. Damage, shrinkage, or a
// physical count that disagrees with the ledger.

export type AdjustmentLine = {
  itemId: string;
  /** Signed: positive is stock found, negative is stock lost. */
  qty: number;
  /** Only meaningful for an increase — a decrease always leaves at its carried cost. */
  unitCost?: number;
};
export type AdjustmentInput = {
  companyId: string;
  locationId: string;
  docDate: string;
  memo?: string | null;
  reference?: string | null;
  /** When a found-stock line actually arrived, if more precise than docDate. */
  receivedAt?: string | null;
  lines: AdjustmentLine[];
};

/**
 *   Increase: Dr Inventory / Cr Stock Adjustment
 *   Decrease: Dr Stock Adjustment / Cr Inventory
 */
/**
 * Split from postStockAdjustment so a caller that is already inside a
 * transaction can post one without opening a second. The spreadsheet import
 * needs that: it writes stock into several warehouses in one act, and an
 * import that half-succeeded — some warehouses stocked, others not, the file
 * apparently accepted — is worse than one that failed outright.
 *
 * `importBatchId` marks the document as something an import produced, so
 * "what did that spreadsheet do?" stays answerable afterwards.
 */
async function _postStockAdjustment(
  tx: TransactionSql,
  input: AdjustmentInput & { importBatchId?: string | null }
) {
  const lines = input.lines.filter((l) => l.qty !== 0);
  if (lines.length === 0) throw new Error("An adjustment needs at least one line");
  // Signed: a stock loss is a negative quantity by design.
  assertLines(lines, { signedQty: true });

  {
    const { companyId, locationId, docDate } = input;
    const receivedAt = input.receivedAt || docDate;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'STOCK_ADJUSTMENT', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference)
      values
        (${companyId}, 'STOCK_ADJUSTMENT', ${docNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${locationId}, 'MMK', 1, 'POSTED',
         0, 0, 0, ${input.memo ?? null}, now(), ${input.reference ?? null})
      returning id`;

    const journal: JournalLine[] = [];
    let lineNo = 0;
    let netValue = 0;

    for (const line of lines) {
      lineNo++;

      const [item] = await tx`
        select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
      if (!item) throw new Error("Item not found");
      if (!item.is_stocked) throw new Error(`${item.code} (${item.name}) is not stocked and cannot be adjusted`);

      let unitCost: number;
      let totalCost: number;
      let plan: FifoPlan | null = null;

      if (line.qty < 0) {
        const onHandRows = await tx`
          select fn_qty_on_hand(${companyId}, ${line.itemId}, ${locationId}) as on_hand`;
        const onHand = Number(onHandRows[0].on_hand);
        if (onHand < -line.qty) {
          throw new Error(
            `Not enough ${item.code} (${item.name}) at this location — ` +
              `${onHand} on hand, ${-line.qty} requested`
          );
        }
        plan = await planFifoConsumption(tx, companyId, line.itemId, locationId, -line.qty);
        unitCost = plan.unitCost;
        totalCost = -plan.totalCost;
      } else {
        unitCost = line.unitCost ?? await estimateCurrentCost(tx, companyId, line.itemId, locationId);
        totalCost = round4(unitCost * line.qty);
      }

      netValue += totalCost;

      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price, net_amount, gross_amount)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${unitCost}, ${totalCost}, ${totalCost})`;

      const [movement] = await tx`
        insert into stock_movement
          (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
        values
          (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
           ${line.qty}, ${unitCost}, ${totalCost}, ${doc.id})
        returning id`;

      if (plan) {
        {
          const adjAcct = await tx`
            select fn_system_account(${companyId}, 'STOCK_ADJUSTMENT') as a`;
          await recordFifoConsumption(
            tx, companyId, movement.id, plan, adjAcct[0].a as string);
        }
      } else {
        await createFifoLot(tx, companyId, line.itemId, locationId, receivedAt, unitCost, line.qty, movement.id);
      }

      const inventory = await tx`
        select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
      journal.push({ accountId: inventory[0].a, amount: totalCost, locationId });
    }

    netValue = round4(netValue);
    const adj = await tx`select fn_system_account(${companyId}, 'STOCK_ADJUSTMENT') as a`;
    journal.push({ accountId: adj[0].a, amount: -netValue, locationId });

    const entryId = await writeJournal(
      tx, companyId, docDate, "STOCK_ADJUSTMENT", doc.id, `${docNo} stock adjustment`, journal, locationId
    );

    const absValue = Math.abs(netValue);
    await tx`
      update document set journal_entry_id = ${entryId}, net_total = ${absValue}, gross_total = ${absValue},
             import_batch_id = ${input.importBatchId ?? null}
       where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string };
  }
}

/** Dr Inventory / Cr Stock Adjustment, in a transaction of its own. */
export async function postStockAdjustment(input: AdjustmentInput) {
  return sql.begin((tx) => _postStockAdjustment(tx, input));
}

// =========================================================================
// Stock transfers
// =========================================================================
//
// A move, not a transaction — no partner, no price. document.location_id is
// the source and to_location_id the destination (see migration 0005). Stock
// leaves at whatever it was already carried at, FIFO-consumed from the
// source same as any other issue, and reopens as a fresh lot at the
// destination at that same cost — a transfer moves stock, it doesn't
// reprice it. Normally posts nothing to the ledger: the default is one
// company-wide Inventory account regardless of location, so Dr and Cr would
// hit the same account and cancel out (same reasoning as Orders posting
// nothing — see the check constraint on document.status in migration
// 0005). Only when account_determination actually splits Inventory by
// location does moving value between warehouses need an entry to keep the
// balance sheet in step with where it physically sits.

export type TransferLine = { itemId: string; qty: number };
export type TransferInput = {
  companyId: string;
  fromLocationId: string;
  toLocationId: string;
  docDate: string;
  /**
   * Someone confirmed the goods physically exist at the source though the ERP
   * records fewer. Same rule as a delivery: without it a transfer of stock
   * that is not recorded is refused.
   */
  allowNegativeStock?: boolean;
  memo?: string | null;
  reference?: string | null;
  /** When stock actually arrived at the destination, if more precise than docDate. */
  receivedAt?: string | null;
  lines: TransferLine[];
};

export async function postStockTransfer(input: TransferInput) {
  const lines = input.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new Error("A transfer needs at least one line");
  assertLines(lines);
  if (input.fromLocationId === input.toLocationId) throw new Error("Choose two different locations");

  return sql.begin(async (tx) => {
    const { companyId, fromLocationId, toLocationId, docDate } = input;
    const receivedAt = input.receivedAt || docDate;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'STOCK_TRANSFER', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         location_id, to_location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference)
      values
        (${companyId}, 'STOCK_TRANSFER', ${docNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${fromLocationId}, ${toLocationId}, 'MMK', 1, 'POSTED',
         0, 0, 0, ${input.memo ?? null}, now(), ${input.reference ?? null})
      returning id`;

    const journal: JournalLine[] = [];
    let lineNo = 0;
    let totalValue = 0;

    for (const line of lines) {
      lineNo++;

      const [item] = await tx`
        select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
      if (!item) throw new Error("Item not found");
      if (!item.is_stocked) throw new Error(`${item.code} (${item.name}) is not stocked and cannot be transferred`);

      const onHandRows = await tx`
        select fn_qty_on_hand(${companyId}, ${line.itemId}, ${fromLocationId}) as on_hand`;
      const onHand = Number(onHandRows[0].on_hand);
      // Both guards have to agree, as on a delivery: this one reads the
      // quantity, the planner reads the cost layers, and relaxing one without
      // the other either refuses a confirmed transfer or lets an unconfirmed
      // one through.
      if (onHand < line.qty && input.allowNegativeStock !== true) {
        throw new Error(
          `Not enough ${item.code} (${item.name}) at the source location — ` +
            `${onHand} on hand, ${line.qty} requested`
        );
      }

      const plan = await planFifoConsumption(
        tx, companyId, line.itemId, fromLocationId, line.qty,
        input.allowNegativeStock === true
      );
      const unitCost = plan.unitCost;
      const totalCost = plan.totalCost;
      totalValue += totalCost;

      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price, net_amount, gross_amount)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${fromLocationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${unitCost}, ${totalCost}, ${totalCost})`;

      const [outMovement] = await tx`
        insert into stock_movement
          (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
        values
          (${companyId}, ${line.itemId}, ${fromLocationId}, ${docDate}::date,
           ${-line.qty}, ${unitCost}, ${-totalCost}, ${doc.id})
        returning id`;
      await recordFifoConsumption(tx, companyId, outMovement.id, plan);
      // The source warehouse goes negative exactly as it would on a delivery,
      // so the shortfall lands on the same worklist and is reconciled the
      // same way.
      await recordNegativeStock(tx, companyId, doc.id, line.itemId, fromLocationId, plan);

      const [inMovement] = await tx`
        insert into stock_movement
          (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
        values
          (${companyId}, ${line.itemId}, ${toLocationId}, ${docDate}::date,
           ${line.qty}, ${unitCost}, ${totalCost}, ${doc.id})
        returning id`;
      await createFifoLot(tx, companyId, line.itemId, toLocationId, receivedAt, unitCost, line.qty, inMovement.id);

      const [fromAcct] = await tx`
        select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}, null, ${fromLocationId}) as a`;
      const [toAcct] = await tx`
        select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}, null, ${toLocationId}) as a`;
      // Both sides are always posted, even when the two warehouses share one
      // Inventory account. On a company-wide ledger that pair is a genuine
      // no-op — debit and credit the same account — and it used to be skipped
      // for exactly that reason. It stopped being a no-op when journal lines
      // started carrying the branch: the value really does leave one branch's
      // inventory and arrive in another's, and skipping the entry left the
      // sending branch's balance sheet holding stock it no longer has while
      // the receiving branch showed none of what it received.
      //
      // The two lines cannot collapse into nothing: consolidate() keys on
      // location as well as account, and postStockTransfer refuses a transfer
      // whose two locations are the same, so they always survive as a pair.
      journal.push({ accountId: toAcct.a, amount: totalCost, locationId: toLocationId });
      journal.push({ accountId: fromAcct.a, amount: -totalCost, locationId: fromLocationId });
    }

    const entryId = journal.length > 0
      ? await writeJournal(tx, companyId, docDate, "STOCK_TRANSFER", doc.id, `${docNo} stock transfer`, journal)
      : null;

    const absValue = round4(Math.abs(totalValue));
    await tx`
      update document set journal_entry_id = ${entryId}, net_total = ${absValue}, gross_total = ${absValue}
       where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string };
  });
}

// =========================================================================
// Returns
// =========================================================================
//
// One document each, not a receipt plus a separate credit note — goods and
// money move back together, since that is how a small distributor's return
// actually happens. Cost and price are reversed independently, exactly
// mirroring how the original sale posted them independently: the stock side
// moves at the newest open lot's cost (estimateCurrentCost — a return has
// no purchase price of its own to draw on), the revenue/payable side moves
// at whatever this return says the price was. They are allowed to differ.

export type ReturnLine = {
  itemId: string;
  qty: number;
  unitPrice: number;
  focReasonId?: string | null;
};
export type ReturnInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  docDate: string;
  memo?: string | null;
  reference?: string | null;
  /** The original sales/purchase invoice, if this return is against one. */
  sourceDocumentId?: string | null;
  /** When returned stock actually came back in, if more precise than docDate — purchase returns ignore this, they only remove stock. */
  receivedAt?: string | null;
  lines: ReturnLine[];
};

/**
 * Goods come back in, and the customer owes less.
 *
 *   Dr Inventory     / Cr Cost of Goods Sold  (stock returns, at today's cost)
 *   Dr Sales Returns / Cr Accounts Receivable (revenue reversed, at the line price)
 */
export async function postSalesReturn(input: ReturnInput) {
  if (input.lines.length === 0) throw new Error("A return needs at least one line");
  assertLines(input.lines);

  return sql.begin(async (tx) => {
    const { companyId, partnerId, locationId, docDate } = input;
    const receivedAt = input.receivedAt || docDate;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'SALES_RETURN', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const netTotal = round4(
      input.lines.reduce((s, l) => s + (l.focReasonId ? 0 : l.qty * l.unitPrice), 0)
    );

    // How much of each item has already come back against this sale, so a
    // second return reads the cost layers after the ones the first took —
    // and so two lines for one item inside a single return do the same.
    let returnedSoFar = new Map<string, number>();

    // The sale being reversed decides what the returned goods cost, because
    // resolveSaleCost reads the FIFO layers the original delivery consumed.
    // So naming someone else's sale is not a tidiness problem: the same ten
    // units come back into stock at that sale's cost instead of this one's.
    // Proven — a customer whose goods cost 900 each returning against a
    // cheaper customer's delivery brought them back at 100, understating
    // inventory by 8,000 and over-reversing cost of sales by the same,
    // while the credit to the customer looked identical either way.
    if (input.sourceDocumentId) {
      const source = await requireSource(tx, {
        id: input.sourceDocumentId,
        companyId,
        partnerId,
        expect: ["SALES_INVOICE", "DELIVERY"],
        role: "sale this return reverses",
      });
      returnedSoFar = await assertWithinSource(tx, {
        companyId,
        sourceId: input.sourceDocumentId,
        sourceDocNo: source.doc_no,
        returnType: "SALES_RETURN",
        lines: input.lines,
      });
    }

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference, source_document_id)
      values
        (${companyId}, 'SALES_RETURN', ${docNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
         ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(), ${input.reference ?? null},
         ${input.sourceDocumentId ?? null})
      returning id`;

    const journal: JournalLine[] = [];
    let lineNo = 0;

    for (const line of input.lines) {
      lineNo++;

      const [item] = await tx`
        select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
      if (!item) throw new Error("Item not found");

      const net = line.focReasonId ? 0 : round4(line.qty * line.unitPrice);

      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price,
           net_amount, tax_amount, gross_amount, foc_reason_id)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty},
           ${line.focReasonId ? 0 : line.unitPrice},
           ${net}, 0, ${net}, ${line.focReasonId ?? null})`;

      if (item.is_stocked) {
        // Returned stock comes back as fresh lots at the cost the original
        // sale drew it out at — layer by layer, not averaged across the
        // delivery, so a unit that left at 900 comes back at 900. Each layer
        // becomes its own lot, which keeps the distinction alive for
        // whatever consumes this stock next instead of blending it away on
        // the way back in.
        //
        // With no source named there is nothing to read, so it falls back to
        // what stock here is worth right now.
        const taken = returnedSoFar.get(line.itemId) ?? 0;
        const layers = input.sourceDocumentId
          ? await resolveReturnLayers(
              tx, companyId, input.sourceDocumentId, line.itemId, line.qty, taken
            )
          : null;
        returnedSoFar.set(line.itemId, round4(taken + line.qty));

        const slices: ReturnLayer[] = layers ?? [
          {
            qty: line.qty,
            unitCost: await estimateCurrentCost(tx, companyId, line.itemId, locationId),
          },
        ];

        let totalCost = 0;
        for (const slice of slices) {
          const sliceCost = round4(slice.unitCost * slice.qty);
          totalCost = round4(totalCost + sliceCost);

          const [movement] = await tx`
            insert into stock_movement
              (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
            values
              (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
               ${slice.qty}, ${slice.unitCost}, ${sliceCost}, ${doc.id})
            returning id`;
          await createFifoLot(
            tx, companyId, line.itemId, locationId, receivedAt,
            slice.unitCost, slice.qty, movement.id
          );
        }

        const inventory = await tx`
          select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
        journal.push({ accountId: inventory[0].a, amount: totalCost, locationId });

        if (line.focReasonId) {
          const [foc] = await tx`select account_id from foc_reason where id = ${line.focReasonId}`;
          journal.push({ accountId: foc.account_id, amount: -totalCost, locationId });
        } else {
          const cogs = await tx`
            select fn_resolve_account_for_item(${companyId}, 'COGS', ${line.itemId}) as a`;
          journal.push({ accountId: cogs[0].a, amount: -totalCost, locationId });
        }
      }

      if (net !== 0) {
        const returns = await tx`
          select fn_resolve_account_for_item(${companyId}, 'SALES_RETURN', ${line.itemId}) as a`;
        journal.push({ accountId: returns[0].a, amount: net, locationId });
      }
    }

    if (netTotal !== 0) {
      const ar = await tx`
        select fn_resolve_control_account(${companyId}, 'AR_CONTROL', ${partnerId}) as a`;
      journal.push({ accountId: ar[0].a, amount: -netTotal, partnerId });
    }

    const entryId = await writeJournal(
      tx, companyId, docDate, "SALES_RETURN", doc.id, `${docNo} sales return`, journal, locationId
    );

    await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string };
  });
}

/**
 * Goods go back to the supplier, and what's owed drops.
 *
 *   Dr Accounts Payable / Cr Inventory (at today's carried cost)
 *
 * The credit the supplier agrees to and the cost the stock was carried at
 * are allowed to differ — the same price-variance account a purchase
 * invoice uses absorbs the difference.
 */
export async function postPurchaseReturn(input: ReturnInput) {
  if (input.lines.length === 0) throw new Error("A return needs at least one line");
  assertLines(input.lines);

  return sql.begin(async (tx) => {
    const { companyId, partnerId, locationId, docDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'PURCHASE_RETURN', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));

    // Goods go back to the supplier they came from, against the receipt that
    // brought them in or the invoice that billed for them — the mirror of
    // the sales return above.
    if (input.sourceDocumentId) {
      const source = await requireSource(tx, {
        id: input.sourceDocumentId,
        companyId,
        partnerId,
        expect: ["PURCHASE_INVOICE", "GOODS_RECEIPT"],
        role: "purchase this return sends back",
      });
      await assertWithinSource(tx, {
        companyId,
        sourceId: input.sourceDocumentId,
        sourceDocNo: source.doc_no,
        returnType: "PURCHASE_RETURN",
        lines: input.lines,
      });
    }

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference, source_document_id)
      values
        (${companyId}, 'PURCHASE_RETURN', ${docNo}, ${fiscalYear}, ${docDate}::date,
         ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
         ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(), ${input.reference ?? null},
         ${input.sourceDocumentId ?? null})
      returning id`;

    const journal: JournalLine[] = [];
    let lineNo = 0;

    for (const line of input.lines) {
      lineNo++;

      const [item] = await tx`
        select id, code, name, is_stocked, base_uom_id from item where id = ${line.itemId}`;
      if (!item) throw new Error("Item not found");
      if (!item.is_stocked) throw new Error(`${item.code} (${item.name}) is not stocked and cannot be returned`);

      const net = round4(line.qty * line.unitPrice);

      const onHandRows = await tx`
        select fn_qty_on_hand(${companyId}, ${line.itemId}, ${locationId}) as on_hand`;
      const onHand = Number(onHandRows[0].on_hand);
      if (onHand < line.qty) {
        throw new Error(
          `Not enough ${item.code} (${item.name}) at this location — ` +
            `${onHand} on hand, ${line.qty} requested`
        );
      }

      const plan = await planFifoConsumption(tx, companyId, line.itemId, locationId, line.qty);
      const unitCost = plan.unitCost;
      const totalCost = plan.totalCost;

      await tx`
        insert into document_line
          (company_id, document_id, line_no, item_id, location_id,
           entered_qty, entered_uom_id, base_qty, unit_price,
           net_amount, tax_amount, gross_amount)
        values
          (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
           ${line.qty}, ${item.base_uom_id}, ${line.qty}, ${line.unitPrice},
           ${net}, 0, ${net})`;

      const [movement] = await tx`
        insert into stock_movement
          (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
        values
          (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
           ${-line.qty}, ${unitCost}, ${-totalCost}, ${doc.id})
        returning id`;
      await recordFifoConsumption(tx, companyId, movement.id, plan);

      const inventory = await tx`
        select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
      journal.push({ accountId: inventory[0].a, amount: -totalCost, locationId });

      const variance = round4(net - totalCost);
      if (variance !== 0) {
        const pv = await tx`select fn_system_account(${companyId}, 'PURCHASE_PRICE_VARIANCE') as a`;
        journal.push({ accountId: pv[0].a, amount: -variance, locationId });
      }
    }

    const ap = await tx`
      select fn_resolve_control_account(${companyId}, 'AP_CONTROL', ${partnerId}) as a`;
    journal.push({ accountId: ap[0].a, amount: netTotal, partnerId });

    const entryId = await writeJournal(
      tx, companyId, docDate, "PURCHASE_RETURN", doc.id, `${docNo} purchase return`, journal, locationId
    );

    await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string };
  });
}

// =========================================================================
// Settling invoices
// =========================================================================
//
// Paying does not touch the invoice. The invoice is a record of what was
// agreed and never changes; a payment is its own document, allocated against
// the invoices it settles. Outstanding is then derived, which is what makes
// "partially paid" answerable and aging trustworthy.

export type Allocation = { invoiceId: string; amount: number };

export type SettlementInput = {
  companyId: string;
  partnerId: string;
  docDate: string;
  cashAccountId: string;
  allocations: Allocation[];
  memo?: string | null;
  reference?: string | null;
  /**
   * Which branch's cash or bank this settles through. Optional: left unset it
   * follows the invoices being settled, which is right whenever a payment
   * covers one branch's bills. The control side never uses this — see
   * postSettlement.
   */
  locationId?: string | null;
  /**
   * Money taken or paid with no invoice to put it against.
   *
   * Set instead of allocations, never alongside them: a receipt is either
   * settling bills or sitting on account, and one that tried to be both would
   * need a rule about which part of it the next invoice may claim. It goes to
   * the advances account rather than to receivables — an advance has no open
   * item, so parking it in the control account would put the ledger and the
   * subledger out of step the moment it posted, and it is not a receivable
   * anyway. It is owed back until the goods go.
   */
  advance?: number;
};

async function postSettlement(
  input: SettlementInput,
  kind: "SUPPLIER_PAYMENT" | "CUSTOMER_RECEIPT"
) {
  // Checked before the filter, not by it. A negative allocation used to be
  // dropped silently here, so a payment carrying one posted for less than was
  // entered and said nothing about it. Zero still just means an untouched row.
  input.allocations.forEach((a, i) => {
    assertFinite(a.amount, `Allocation ${i + 1}: amount`);
    if (a.amount < 0) {
      throw new Error(`Allocation ${i + 1}: amount cannot be negative`);
    }
  });

  const lines = input.allocations.filter((a) => a.amount > 0);
  const advance = round4(input.advance ?? 0);
  if (advance < 0) throw new Error("An advance cannot be negative");
  if (advance > 0 && lines.length > 0) {
    throw new Error(
      "This is either settling invoices or money on account, not both. Post " +
      "the advance on its own and apply it to the invoice afterwards."
    );
  }
  if (advance === 0 && lines.length === 0) {
    throw new Error("Enter an amount against at least one invoice, or record it as an advance");
  }
  if (!input.cashAccountId) throw new Error("Choose which cash or bank account to use");
  // An advance settles nothing, so there are no invoice branches for the cash
  // side to follow. Left unattributed it would sit in no branch at all and
  // reappear as an unexplained difference the first time anyone reads the
  // branch reports, so it is asked for rather than guessed.
  if (advance > 0 && !input.locationId) {
    throw new Error("Choose which branch is taking this money — an advance has no invoice to follow");
  }

  const total = advance > 0 ? advance : round4(lines.reduce((s, a) => s + a.amount, 0));
  const isPayment = kind === "SUPPLIER_PAYMENT";
  const controlRole = isPayment ? "AP_CONTROL" : "AR_CONTROL";

  return sql.begin(async (tx) => {
    const { companyId, partnerId, docDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    // A payment settles one kind of invoice and no other. Nothing checked
    // that, and the two subledgers are resolved from the payment's own kind
    // rather than from what it is paying — so a supplier payment could be
    // allocated to a sales invoice, and it posted: AR control kept the
    // 100,000 the customer still owed, AP control took a 100,000 debit for a
    // supplier who was never involved, v_open_item showed the invoice
    // settled, and the cash went out of the door to collect a debt owed to
    // us. Everything balanced. Every figure was wrong.
    const settles = isPayment ? "PURCHASE_INVOICE" : "SALES_INVOICE";

    // Amount being settled per invoice branch. "" stands for an invoice that
    // carries no branch — entries posted before the dimension existed — and
    // is deliberately kept null rather than defaulted, so relieving old AP
    // does not invent a branch balance that was never raised in one.
    const controlByLocation = new Map<string, number>();

    // Check each invoice still owes what is being applied. Two people paying
    // the same bill at once would otherwise both succeed.
    for (const a of lines) {
      const [inv] = await tx`
        select d.doc_no, d.doc_type, d.status, d.partner_id, d.gross_total, d.location_id,
               -- Only allocations whose payment still stands. A voided
               -- payment must stop reserving room against the invoice, or a
               -- bill whose payment was voided could never be settled again.
               coalesce((select sum(pa.amount) from payment_allocation pa
                           join document pay on pay.id = pa.payment_id
                          where pa.invoice_id = d.id
                            and pay.status = 'POSTED'), 0) as allocated
          from document d
         where d.id = ${a.invoiceId} and d.company_id = ${companyId}
         for update of d`;

      if (!inv) throw new Error("That invoice no longer exists");

      if (inv.doc_type !== settles) {
        throw new Error(
          `${inv.doc_no} is a ${readable(inv.doc_type)}. A ${readable(kind)} can only ` +
            `settle a ${readable(settles)}`
        );
      }
      if (inv.status !== "POSTED") {
        throw new Error(`${inv.doc_no} is ${inv.status} and cannot be settled`);
      }
      if (inv.partner_id !== partnerId) {
        throw new Error(`Invoice ${inv.doc_no} belongs to a different partner`);
      }

      const outstanding = round4(Number(inv.gross_total) - Number(inv.allocated));
      if (a.amount > outstanding) {
        throw new Error(
          `${inv.doc_no} only has ${outstanding} outstanding; ${a.amount} was applied`
        );
      }

      // The branch that raised the payable is the branch it has to be
      // relieved in. Clearing a Yangon bill against no branch, or against
      // Mandalay, leaves Yangon's payables showing money it no longer owes
      // for ever — the invoice credited AP there and nothing ever debits it
      // back. Grouped so one payment covering several bills from the same
      // branch still posts a single control line.
      const key = (inv.location_id as string | null) ?? "";
      controlByLocation.set(key, round4((controlByLocation.get(key) ?? 0) + a.amount));
    }

    // Which branch's cash moves. Explicit choice wins; otherwise it follows
    // the invoices, which is right whenever a payment covers one branch's
    // bills and is the overwhelmingly common case. Genuinely mixed payments
    // with no choice made stay unattributed on the cash side rather than
    // being assigned to whichever branch happened to sort first.
    const settledLocations = [...controlByLocation.keys()].filter((k) => k !== "");
    const cashLocationId =
      input.locationId ?? (settledLocations.length === 1 ? settledLocations[0] : null);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, ${kind}, ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, reference, payment_type, posted_at)
      values
        (${companyId}, ${kind}, ${docNo}, ${fiscalYear}, ${docDate}::date, ${docDate}::date,
         ${partnerId}, ${cashLocationId}, 'MMK', 1, 'POSTED',
         ${total}, 0, ${total}, ${input.memo ?? null}, ${input.reference ?? null},
         'CASH', now())
      returning id`;

    for (const a of lines) {
      await tx`
        insert into payment_allocation
          (company_id, payment_id, invoice_id, amount, base_amount)
        values (${companyId}, ${doc.id}, ${a.invoiceId}, ${a.amount}, ${a.amount})`;
    }

    const sign = isPayment ? 1 : -1;
    const journal: JournalLine[] = [];

    if (advance > 0) {
      // Nothing is being relieved, so nothing touches the control account.
      // The other side is the advances account: what the customer has paid us
      // and we still owe them in goods, or what we have paid a supplier and
      // they still owe us. It carries the partner so the balance can be read
      // per customer rather than as one company-wide figure.
      const holding = await tx`
        select fn_system_account(${companyId},
          ${isPayment ? "SUPPLIER_ADVANCE" : "CUSTOMER_ADVANCE"}) as a`;
      journal.push({
        accountId: holding[0].a, amount: round4(sign * advance), partnerId,
        locationId: cashLocationId,
      });
    } else {
      const control = await tx`
        select fn_resolve_control_account(${companyId}, ${controlRole}, ${partnerId}) as a`;
      for (const [key, amount] of controlByLocation) {
        journal.push({
          accountId: control[0].a, amount: round4(sign * amount), partnerId,
          locationId: key === "" ? null : key,
        });
      }
    }
    journal.push({
      accountId: input.cashAccountId, amount: round4(-sign * total), locationId: cashLocationId,
    });

    // No default branch is passed. Every line here already states its own,
    // and a default would overwrite the deliberate null on control lines
    // relieving invoices that never had a branch.
    const entryId = await writeJournal(
      tx, companyId, docDate, kind, doc.id,
      advance > 0
        ? `${docNo} on account`
        : `${docNo} settling ${lines.length} invoice${lines.length === 1 ? "" : "s"}`,
      journal
    );

    await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string, total };
  });
}

/**
 * Put money already received against an invoice.
 *
 * No cash moves. The money came in when the advance was taken; all this does
 * is stop it being owed back and start it settling a bill:
 *
 *   customer   Dr Customer Advances   Cr Accounts Receivable
 *   supplier   Dr Accounts Payable    Cr Supplier Advances
 *
 * The invoice's outstanding falls through `payment_allocation`, the same rows
 * an ordinary settlement writes, so every screen that reads what an invoice
 * still owes keeps working without being told about advances at all. That is
 * the reason this is an allocation against the original receipt rather than a
 * new payment: recording the money twice is exactly what somebody reaching for
 * this feature is trying to avoid.
 */
export async function applyAdvance(input: {
  companyId: string;
  /** The bill being settled. */
  invoiceId: string;
  /** Which advances to draw on, and how much of each. */
  allocations: { paymentId: string; amount: number }[];
  docDate: string;
  memo?: string | null;
}) {
  const lines = input.allocations.filter((a) => a.amount > 0);
  if (lines.length === 0) throw new Error("Choose an advance to apply");
  lines.forEach((a, i) => assertFinite(a.amount, `Advance ${i + 1}: amount`));

  return sql.begin(async (tx) => {
    const { companyId, docDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    // Locked, because everything below reads what the invoice still owes and
    // what each advance still has, and then spends both.
    const [inv] = await tx`
      select id, doc_no, doc_type, partner_id, location_id, status, gross_total
        from document
       where id = ${input.invoiceId} and company_id = ${companyId}
         for update`;
    if (!inv) throw new Error("That invoice no longer exists");
    if (inv.status !== "POSTED") {
      throw new Error(`${inv.doc_no} is ${String(inv.status).toLowerCase()} and cannot be settled`);
    }
    const isPayment = inv.doc_type === "PURCHASE_INVOICE";
    if (!isPayment && inv.doc_type !== "SALES_INVOICE") {
      throw new Error(`${inv.doc_no} is not an invoice`);
    }

    const [owed] = await tx`
      select outstanding from v_open_item where document_id = ${inv.id}`;
    const outstanding = Number(owed?.outstanding ?? 0);
    const total = round4(lines.reduce((t, a) => t + a.amount, 0));
    if (total > outstanding + 0.0001) {
      throw new Error(
        `${inv.doc_no} has ${outstanding} outstanding, so ${total} cannot be applied to it. ` +
        `Whatever is left over stays on account for the next invoice.`
      );
    }

    for (const a of lines) {
      const [adv] = await tx`
        select d.doc_no, d.partner_id, d.doc_type,
               v.available
          from document d
          left join v_partner_advance v on v.payment_id = d.id
         where d.id = ${a.paymentId} and d.company_id = ${companyId}
           for update of d`;
      if (!adv) throw new Error("That advance no longer exists");
      if (adv.partner_id !== inv.partner_id) {
        throw new Error(
          `${adv.doc_no} belongs to a different partner. Money taken from one ` +
          `customer cannot settle another's bill.`
        );
      }
      // A receipt settles sales invoices, a payment settles purchase ones —
      // the same rule ordinary settlement follows, for the same reason.
      const settles = adv.doc_type === "CUSTOMER_RECEIPT" ? "SALES_INVOICE" : "PURCHASE_INVOICE";
      if (settles !== inv.doc_type) {
        throw new Error(
          `${adv.doc_no} cannot settle ${inv.doc_no} — one is money from a ` +
          `customer and the other is a bill from a supplier.`
        );
      }
      const available = Number(adv.available ?? 0);
      if (a.amount > available + 0.0001) {
        throw new Error(
          `${adv.doc_no} has ${available} left on account, so ${a.amount} cannot be applied.`
        );
      }
    }

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'ADVANCE_APPLICATION', ${docDate}::date) as no`;
    const docNo = noRows[0].no;

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, source_document_id, posted_at)
      values
        (${companyId}, 'ADVANCE_APPLICATION', ${docNo}, ${fiscalYear},
         ${docDate}::date, ${docDate}::date, ${inv.partner_id}, ${inv.location_id},
         'MMK', 1, 'POSTED', ${total}, 0, ${total},
         ${input.memo ?? `Applied to ${inv.doc_no}`}, ${inv.id}, now())
      returning id`;

    // Against the original receipt, not against this document: the money is
    // that receipt's, and this is only the act of pointing it at a bill.
    for (const a of lines) {
      await tx`
        insert into payment_allocation
          (company_id, payment_id, invoice_id, amount, base_amount)
        values (${companyId}, ${a.paymentId}, ${inv.id}, ${a.amount}, ${a.amount})`;
    }

    const holding = await tx`
      select fn_system_account(${companyId},
        ${isPayment ? "SUPPLIER_ADVANCE" : "CUSTOMER_ADVANCE"}) as a`;
    const control = await tx`
      select fn_resolve_control_account(${companyId},
        ${isPayment ? "AP_CONTROL" : "AR_CONTROL"}, ${inv.partner_id}) as a`;

    // Customer: the advance stops being owed back (debit) and the receivable
    // is relieved (credit). Supplier: the reverse.
    const sign = isPayment ? -1 : 1;
    const entryId = await writeJournal(
      tx, companyId, docDate, "ADVANCE_APPLICATION", doc.id,
      `${docNo} applying ${total} to ${inv.doc_no}`,
      [
        { accountId: holding[0].a, amount: round4(sign * total),
          partnerId: inv.partner_id as string, locationId: inv.location_id as string | null },
        { accountId: control[0].a, amount: round4(-sign * total),
          partnerId: inv.partner_id as string, locationId: inv.location_id as string | null },
      ]
    );
    await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string, total };
  });
}

/** Dr Accounts Payable / Cr Bank. */
export async function postSupplierPayment(input: SettlementInput) {
  return postSettlement(input, "SUPPLIER_PAYMENT");
}

/** Dr Bank / Cr Accounts Receivable. */
export async function postCustomerReceipt(input: SettlementInput) {
  return postSettlement(input, "CUSTOMER_RECEIPT");
}

// =========================================================================
// Finance vouchers
// =========================================================================
//
// Cash, bank, journal, interbranch transfer and opening balances. None of
// these move stock; they are the ledger being written directly, and they all
// go through the same balanced-entry path as everything else.

export type VoucherLine = {
  accountId: string;
  /** Positive debit, negative credit. */
  amount: number;
  locationId?: string | null;
  costCenterId?: string | null;
  memo?: string | null;
};

export type VoucherInput = {
  companyId: string;
  docDate: string;
  lines: VoucherLine[];
  memo?: string | null;
  reference?: string | null;
  locationId?: string | null;
};

type VoucherDocType =
  "CASH_VOUCHER" | "BANK_VOUCHER" | "JOURNAL_VOUCHER" | "CASH_TRANSFER" | "OPENING_BALANCE";

/**
 * Split from postVoucher so a caller already inside a transaction can post
 * one without opening a second. The receipt importer posts a whole file of
 * them and needs all or none, not one transaction per row.
 */
async function _postVoucher(
  tx: TransactionSql,
  input: VoucherInput,
  docType: VoucherDocType
) {
  // Voucher amounts are signed on purpose — positive debit, negative credit —
  // so only finiteness is checked here. The balance trigger catches the rest.
  input.lines.forEach((l, i) => assertAmount(l.amount, `Line ${i + 1}: amount`, { signed: true }));

  const lines = input.lines.filter((l) => l.accountId && l.amount !== 0);
  if (lines.length < 2) throw new Error("A voucher needs at least two lines");

  const net = round4(lines.reduce((s, l) => s + l.amount, 0));
  if (net !== 0) {
    throw new Error(`Debits and credits differ by ${net}`);
  }

  {
    const { companyId, docDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    // Which way the money went, decided once and recorded, rather than left
    // to be re-derived from the sign of a journal line every time something
    // asks. A cash voucher that debits cash is money in; one that credits it
    // is money out. Only cash and bank vouchers carry it — a journal voucher
    // or an opening balance is neither.
    const direction =
      docType === "CASH_VOUCHER" || docType === "BANK_VOUCHER"
        ? await (async () => {
            const cashRows = await tx`
              select id from account
               where company_id = ${companyId}
                 and id in ${tx(lines.map((l) => l.accountId))}
                 and ${docType === "CASH_VOUCHER"
                        ? tx`is_cash_account`
                        : tx`is_bank_account`}`;
            const ids = new Set((cashRows as unknown as { id: string }[]).map((r) => r.id));
            const moneySide = round4(
              lines.filter((l) => ids.has(l.accountId)).reduce((s, l) => s + l.amount, 0)
            );
            // Debit to the till is money arriving. A voucher touching no cash
            // account at all leaves it unset rather than guessing.
            return moneySide > 0 ? "IN" : moneySide < 0 ? "OUT" : null;
          })()
        : null;

    const noRows = await tx`
      select fn_next_document_no(${companyId}, ${docType}, ${docDate}::date,
                                 ${direction}) as no`;
    const docNo = noRows[0].no;

    // The document total is the debit side, which is what people expect a
    // voucher to be "for" — a 50,000 payment reads as 50,000, not 100,000.
    const total = round4(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         location_id, currency, exchange_rate, status, voucher_direction,
         net_total, tax_total, gross_total, memo, reference, posted_at)
      values
        (${companyId}, ${docType}, ${docNo}, ${fiscalYear}, ${docDate}::date, ${docDate}::date,
         ${input.locationId ?? null}, 'MMK', 1, 'POSTED', ${direction},
         ${total}, 0, ${total}, ${input.memo ?? null}, ${input.reference ?? null}, now())
      returning id`;

    const entryId = await writeJournal(
      tx, companyId, docDate, docType, doc.id, `${docNo} ${input.memo ?? ""}`.trim(),
      lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        locationId: l.locationId ?? input.locationId ?? null,
      }))
    );

    await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string, total };
  }
}

/** A voucher in a transaction of its own. */
async function postVoucher(input: VoucherInput, docType: VoucherDocType) {
  return sql.begin((tx) => _postVoucher(tx, input, docType));
}

/** Money in or out of a till. */
export async function postCashVoucher(input: VoucherInput) {
  return postVoucher(input, "CASH_VOUCHER");
}

/** Money in or out of a bank account. */
export async function postBankVoucher(input: VoucherInput) {
  return postVoucher(input, "BANK_VOUCHER");
}

/** Free-form, any accounts. Control accounts are still refused by the database. */
export async function postJournalVoucher(input: VoucherInput) {
  return postVoucher(input, "JOURNAL_VOUCHER");
}

/**
 * Money between two accounts, typically one branch's till to another's.
 * Written as its own type so branch cash movements are not mistaken for
 * income or expense.
 */
export async function postCashTransfer(input: {
  companyId: string;
  docDate: string;
  fromAccountId: string;
  toAccountId: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  amount: number;
  memo?: string | null;
  reference?: string | null;
}) {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error("Choose two different accounts");
  }
  if (!(input.amount > 0)) throw new Error("Enter an amount");

  return postVoucher(
    {
      companyId: input.companyId,
      docDate: input.docDate,
      memo: input.memo,
      reference: input.reference,
      lines: [
        { accountId: input.toAccountId, amount: input.amount, locationId: input.toLocationId },
        { accountId: input.fromAccountId, amount: -input.amount, locationId: input.fromLocationId },
      ],
    },
    "CASH_TRANSFER"
  );
}

/**
 * Opening balances. Each line is what an account starts at; the difference
 * goes to Opening Balance Equity so the entry balances without anyone having
 * to work the figure out by hand.
 */
export async function postAccountOpening(input: {
  companyId: string;
  docDate: string;
  lines: { accountId: string; amount: number }[];
  memo?: string | null;
  /**
   * Which branch these opening figures belong to. Without it every opening
   * balance is stamped with no branch at all, so a company that reports by
   * branch starts every account from a figure that belongs to none of them.
   */
  locationId?: string | null;
}) {
  const lines = input.lines.filter((l) => l.accountId && l.amount !== 0);
  if (lines.length === 0) throw new Error("Enter at least one opening balance");

  const [equity] = await sql`
    select fn_system_account(${input.companyId}, 'OPENING_BALANCE_EQUITY') as a`;

  const net = round4(lines.reduce((s, l) => s + l.amount, 0));

  return postVoucher(
    {
      companyId: input.companyId,
      docDate: input.docDate,
      memo: input.memo ?? "Opening balances",
      locationId: input.locationId ?? null,
      lines: net === 0 ? lines : [...lines, { accountId: equity.a, amount: -net }],
    },
    "OPENING_BALANCE"
  );
}

// ------------------------------------------------------- consignment --
//
// Goods that arrive but are not yet owned. See db/migrations/0028_consignment
// for the schema and the reasoning behind the two trigger amendments this
// document type needed.
//
// A consignment receipt records custody, not value: no journal entry, no
// GR/IR, no Accounts Payable. The purchase - and the payable - is recognized
// later, when a specific unit actually sells, at the rate the receiving lot
// was agreed to settle at. That later step is a separate piece of work; this
// function only gets the goods onto the shelf.

export type ConsignmentReceiptLine = {
  itemId: string;
  qty: number;
  /** Which agreement line this receipt draws its settlement rate from. */
  agreementLineId?: string | null;
  /**
   * The terms for an item this consignor has not sent before, agreed as the
   * shipment arrives. An agreement that has to be complete before the first
   * delivery can be booked describes a negotiation that finished, and these
   * do not: a consignor turns up with something new and the rate for it is
   * agreed then. Supplying these adds the item to the agreement as part of
   * receiving it, in the same transaction, so the rate is on file before any
   * of it can be sold.
   */
  pricingMethod?: "PERCENTAGE" | "FIXED" | null;
  pricingValue?: number | null;
};

export type ConsignmentReceiptInput = {
  companyId: string;
  /** The consignor. Must be a supplier with an agreement on file. */
  partnerId: string;
  locationId: string;
  docDate: string;
  memo?: string | null;
  reference?: string | null;
  lines: ConsignmentReceiptLine[];
};

async function _postConsignmentReceipt(tx: TransactionSql, input: ConsignmentReceiptInput) {
  if (input.lines.length === 0) throw new Error("A consignment receipt needs at least one line");
  assertLines(input.lines);

  const { companyId, partnerId, locationId, docDate } = input;

  const [partner] = await tx`
    select is_supplier, code from business_partner where id = ${partnerId} and company_id = ${companyId}`;
  if (!partner) throw new Error("Partner not found");
  if (!partner.is_supplier) throw new Error("Consigned goods can only be received from a supplier");

  const [agreement] = await tx`
    select id from consignment_agreement where company_id = ${companyId} and partner_id = ${partnerId}`;
  if (!agreement) throw new Error(`${partner.code} has no consignment agreement on file`);

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  // No journal entry will exist for this document, so fn_journal_entry_period
  // never runs for it and the usual period lock never fires. Checked
  // directly instead: a closed period should refuse every document dated
  // into it, not only the ones that happen to touch the ledger.
  const [period] = await tx`
    select status from fiscal_period
     where company_id = ${companyId} and ${docDate}::date between start_date and end_date`;
  if (!period) throw new Error(`No fiscal period covers ${docDate}`);
  if (period.status !== "OPEN") {
    throw new Error(`Fiscal period is ${period.status}; cannot post on ${docDate}`);
  }

  const noRows = await tx`
    select fn_next_document_no(${companyId}, 'CONSIGNMENT_RECEIPT', ${docDate}::date) as no`;
  const docNo = noRows[0].no;

  // net_total/gross_total are 0 deliberately, not a $0 sale wearing a real
  // one's clothes (the free-of-charge bug fixed earlier). This document
  // genuinely has nothing to total: nothing here is owned yet.
  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, reference)
    values
      (${companyId}, 'CONSIGNMENT_RECEIPT', ${docNo}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       0, 0, 0, ${input.memo ?? null}, now(), ${input.reference ?? null})
    returning id`;

  let lineNo = 0;
  for (const line of input.lines) {
    lineNo++;

    const [item] = await tx`
      select id, code, name, base_uom_id, is_stocked from item
       where id = ${line.itemId} and company_id = ${companyId}`;
    if (!item) throw new Error(`Line ${lineNo}: item not found`);
    if (!item.is_stocked) {
      throw new Error(`Line ${lineNo}: ${item.code} (${item.name}) is not stocked and cannot be received`);
    }

    type AgreementLine = {
      id: string; item_id: string; pricing_method: string; pricing_value: number;
    };
    const findLine = async (where: ReturnType<typeof tx>) =>
      (await where)[0] as AgreementLine | undefined;

    let al: AgreementLine | undefined;

    if (line.agreementLineId) {
      al = await findLine(tx`
        select id, item_id, pricing_method, pricing_value from consignment_agreement_line
         where id = ${line.agreementLineId} and agreement_id = ${agreement.id} and is_active`);
      if (!al) throw new Error(`Line ${lineNo}: that agreement line does not exist or is not active`);
    } else {
      // Not named on the receipt. Either the item is already on the agreement
      // — in which case use that, rather than making a second line for the
      // same item — or the terms arrived with the shipment and go on file now.
      al = await findLine(tx`
        select id, item_id, pricing_method, pricing_value from consignment_agreement_line
         where agreement_id = ${agreement.id} and item_id = ${line.itemId} and is_active`);

      if (!al) {
        const method = line.pricingMethod;
        const value = Number(line.pricingValue);
        if (method !== "PERCENTAGE" && method !== "FIXED") {
          throw new Error(
            `Line ${lineNo}: ${item.code} is not on this consignor's agreement. `
            + `Say how it settles — a percentage of the sale, or a fixed amount a unit.`
          );
        }
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`Line ${lineNo}: enter what ${item.code} settles at`);
        }
        if (method === "PERCENTAGE" && value > 100) {
          throw new Error(`Line ${lineNo}: a percentage cannot exceed 100`);
        }
        al = await findLine(tx`
          insert into consignment_agreement_line
            (company_id, agreement_id, item_id, pricing_method, pricing_value)
          values (${companyId}, ${agreement.id}, ${line.itemId}, ${method}, ${value})
          returning id, item_id, pricing_method, pricing_value`);
      }
    }
    if (!al) throw new Error(`Line ${lineNo}: could not resolve the settlement terms`);
    if (al.item_id !== line.itemId) {
      throw new Error(`Line ${lineNo}: names an agreement line for a different item`);
    }

    await tx`
      insert into document_line
        (company_id, document_id, line_no, item_id, location_id,
         entered_qty, entered_uom_id, base_qty, unit_price, net_amount, tax_amount, gross_amount)
      values
        (${companyId}, ${doc.id}, ${lineNo}, ${line.itemId}, ${locationId},
         ${line.qty}, ${item.base_uom_id}, ${line.qty}, 0, 0, 0, 0)`;

    await tx`
      insert into consignment_lot
        (company_id, item_id, location_id, agreement_line_id, receipt_document_id,
         pricing_method, pricing_value, received_date, qty_received)
      values
        (${companyId}, ${line.itemId}, ${locationId}, ${al.id}, ${doc.id},
         ${al.pricing_method}, ${al.pricing_value}, ${docDate}::date, ${line.qty})`;
  }

  // No writeJournal call and journal_entry_id stays null. See the migration
  // for how fn_document_immutable and fn_document_line_immutable were
  // amended to still freeze this document once it is POSTED.
  return { id: doc.id as string, docNo: docNo as string };
}

export async function postConsignmentReceipt(input: ConsignmentReceiptInput) {
  return sql.begin((tx) => _postConsignmentReceipt(tx, input));
}

// =========================================================================
// Item import
// =========================================================================

export type ImportRow = {
  row: number;
  barcode: string;
  name: string;
  itemId: string | null;
  categoryId: string;
  brandId: string | null;
  uomId: string;
  /** The item's own piece of the code. `code` is composed from it by trigger
   *  and is never written here — see migration 0012. */
  serial: string;
};

/**
 * Creates the items a spreadsheet describes, as one act.
 *
 * The whole import is a single transaction. That is the point rather than a
 * detail: an import that created four hundred items and failed on the four
 * hundred and first would leave a half-populated catalogue that looks
 * imported, and the only way to find out which half arrived is to read it.
 * Either all of it lands or none of it does.
 *
 * It writes nothing to the ledger and moves no stock, because an item is not
 * a quantity. A new item exists with no stock and no cost until a goods
 * receipt or an opening stock adjustment gives it both — those are documents,
 * they post, and they are entered as themselves rather than as columns on a
 * setup sheet.
 *
 * Rows arrive already validated. This function deliberately re-checks nothing
 * except what only the database can know at the moment of writing, because a
 * second, differently-worded copy of the rules would eventually disagree with
 * the first.
 */
export async function importItems(input: {
  companyId: string;
  filename: string;
  rowCount: number;
  rows: ImportRow[];
}) {
  const { companyId, filename, rows } = input;
  if (rows.length === 0) throw new Error("There is nothing to import");

  return sql.begin(async (tx) => {
    const [{ next }] = await tx`
      select coalesce(max(substring(ref from '[0-9]+$')::int), 0) + 1 as next
        from import_batch where company_id = ${companyId}`;
    const ref = `IMP-${String(next).padStart(6, "0")}`;

    const [batch] = await tx`
      insert into import_batch (company_id, ref, filename, row_count)
      values (${companyId}, ${ref}, ${filename}, ${input.rowCount})
      returning id`;

    let created = 0;
    let matched = 0;

    for (const r of rows) {
      // A barcode already in the catalogue is left exactly as it is. An
      // import that quietly rewrote an item's category, brand or code would
      // edit master data as a side effect of a file someone uploaded to add
      // something else, which is not what "import items" says it does.
      if (r.itemId) { matched++; continue; }

      // The serial the sheet asked for, and the trigger composes the code
      // from it and the category. A blank Stock ID column was already turned
      // into the next free number by the validator, which is also what the
      // preview showed — so this writes what was approved rather than
      // deciding it a second time and possibly differently.
      await tx`
        insert into item (company_id, item_group_id, serial, name, barcode,
                          brand_id, base_uom_id, is_stocked, import_batch_id)
        values (${companyId}, ${r.categoryId}, ${r.serial}, ${r.name}, ${r.barcode},
                ${r.brandId}, ${r.uomId}, true, ${batch.id})`;

      created++;
    }

    return {
      ref,
      batchId: batch.id as string,
      itemsCreated: created,
      itemsMatched: matched,
    };
  });
}

// -------------------------------------------- negative stock reconcile --

/**
 * Brings recorded stock back up to what is physically there, at the price the
 * goods were charged out at.
 *
 * The user confirms; they do not type a figure. The price was decided when
 * the goods left — from the supplier's purchase invoice where there is one —
 * and is stored on the shortfall, so the adjustment values the returning
 * units at exactly what the sale charged for them. Letting someone key a
 * different number here would put the correction and the cost of sale out of
 * step, which is the whole thing this is fixing.
 *
 * It posts a real stock adjustment: a movement, a FIFO layer at that price,
 * and Dr Inventory / Cr Stock Adjustment. Then it settles the shortfall
 * against that document, so the same units cannot be reconciled twice.
 */
export async function reconcileNegativeStock(input: {
  companyId: string;
  /** Which shortfalls to clear. Each is settled in full. */
  negativeStockIds: string[];
  docDate: string;
  memo?: string | null;
}) {
  const { companyId, negativeStockIds } = input;
  if (negativeStockIds.length === 0) throw new Error("Nothing selected to reconcile");

  return sql.begin(async (tx) => {
    // Locked before reading, so two people reconciling the same shortfall
    // cannot both find it outstanding and both post an adjustment for it.
    await tx`
      select id from negative_stock
       where company_id = ${companyId} and id in ${tx(negativeStockIds)}
         for update`;

    const rows = await tx`
      select ns.id, ns.item_id, ns.location_id, ns.provisional_unit_cost,
             ns.qty - coalesce(sum(s.qty), 0) as outstanding
        from negative_stock ns
        left join negative_stock_settlement s on s.negative_stock_id = ns.id
       where ns.company_id = ${companyId} and ns.id in ${tx(negativeStockIds)}
       group by ns.id, ns.item_id, ns.location_id, ns.provisional_unit_cost
      having ns.qty - coalesce(sum(s.qty), 0) > 0.0001`;

    if (rows.length === 0) throw new Error("Those shortfalls have already been reconciled");

    // One adjustment per location: a stock adjustment belongs to a warehouse,
    // and lumping two warehouses into one document would post movements at a
    // location the document does not name.
    const byLocation = new Map<string, {
      id: string; itemId: string; qty: number; unitCost: number;
    }[]>();
    for (const r of rows as unknown as {
      id: string; item_id: string; location_id: string;
      provisional_unit_cost: string; outstanding: string;
    }[]) {
      const list = byLocation.get(r.location_id) ?? [];
      list.push({
        id: r.id, itemId: r.item_id,
        qty: round4(Number(r.outstanding)),
        unitCost: Number(r.provisional_unit_cost),
      });
      byLocation.set(r.location_id, list);
    }

    const documents: string[] = [];
    for (const [locationId, list] of byLocation) {
      const doc = await _postStockAdjustment(tx, {
        companyId,
        locationId,
        docDate: input.docDate,
        memo: input.memo ?? "Negative stock reconciliation",
        lines: list.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost })),
      });
      documents.push(doc.docNo);

      // Settled at the same price it was charged out at, so there is no
      // variance here by construction — unlike a receipt arriving later,
      // where the supplier's real figure may differ from what was assumed.
      for (const l of list) {
        const [mv] = await tx`
          select id from stock_movement
           where document_id = ${doc.id} and item_id = ${l.itemId}
           limit 1`;
        await tx`
          insert into negative_stock_settlement
            (company_id, negative_stock_id, document_id, stock_movement_id, qty, actual_unit_cost)
          values (${companyId}, ${l.id}, ${doc.id}, ${mv?.id ?? null}, ${l.qty}, ${l.unitCost})`;
      }
    }

    return {
      documents,
      reconciled: rows.length,
      units: round4(rows.reduce((t: number, r: any) => t + Number(r.outstanding), 0)),
    };
  });
}

// ------------------------------------------------------------------ void --

/**
 * Voids a posted document by posting its mirror image.
 *
 * Every line of the original entry is negated into a new entry, so the two
 * together net to zero on every account, in every currency, at every branch.
 * Nothing is edited: the original keeps its number, its lines and its entry,
 * and gains a link to the reversal. The subledgers and the control accounts
 * therefore move together, which is the whole reason this is a reversal
 * rather than a flag.
 *
 * The reversal is its own document, numbered in its own right, so it appears
 * in the ledger and on reports as the event it is. It carries the same
 * partner and totals as the original — negated — because a reversal that
 * looked like nothing in particular would be impossible to read six months
 * later.
 */
export async function voidDocument(input: {
  documentId: string;
  reason?: string | null;
}) {
  return sql.begin(async (tx) => voidDocumentIn(tx, input));
}

/**
 * The same void, inside a transaction the caller already owns.
 *
 * A correction is a void and a re-posting that must both happen or neither:
 * a void with no replacement is a deletion, and a replacement with no void is
 * a duplicate. Neither is what anybody asked for, and the only way to
 * guarantee it is one transaction — which means the void cannot open its own.
 */
async function voidDocumentIn(
  tx: TransactionSql,
  input: { documentId: string; reason?: string | null }
) {
  const { documentId } = input;
  {
    // Locked before anything is read, so two people voiding the same document
    // at once cannot both find it un-voided and both post a reversal.
    const [doc] = await tx`
      select id, company_id, doc_type, doc_no, partner_id, location_id, currency,
             exchange_rate, net_total, tax_total, gross_total, journal_entry_id,
             status, reversed_by_document_id, fiscal_year_id, voucher_direction,
             to_char(doc_date, 'YYYY-MM-DD') as doc_date,
             to_char(posting_date, 'YYYY-MM-DD') as posting_date
        from document where id = ${documentId} for update`;
    if (!doc) throw new Error("That document no longer exists");
    if (doc.status === "DRAFT") {
      throw new Error(`${doc.doc_no} is a draft — delete it rather than voiding it`);
    }
    if (doc.status !== "POSTED" || doc.reversed_by_document_id) {
      throw new Error(`${doc.doc_no} is already ${String(doc.status).toLowerCase()}`);
    }

    // The same analysis the confirmation screen showed, re-run against the
    // database as it is now rather than as it was when the screen was drawn.
    // Something downstream can be posted between looking and confirming, and
    // that is exactly the case worth catching.
    const plan = await planVoidIn(tx, documentId);
    if (!plan.canVoid) {
      throw new Error(plan.blockers.map((b: VoidBlocker) => b.reason).join(" "));
    }

    const lines = await tx`
      -- Cost centre and project are deliberately not read: writeJournal has
      -- nowhere to put them, and nothing in this system has ever set one, so
      -- reading them would imply a fidelity the reversal does not have.
      select account_id, amount, location_id, partner_id
        from journal_line where journal_entry_id = ${doc.journal_entry_id}
       order by line_no`;
    if (lines.length === 0) {
      throw new Error(`${doc.doc_no} has no entry to reverse`);
    }

    // The original's own direction, so a voided cash receipt is numbered on
    // the receipt series rather than starting a second one. 0038 keys the
    // counter on the prefix, so this can no longer collide either way — but
    // passing it keeps the reversal filed where a reader would look for it.
    const docNoRows = await tx`
      select fn_next_document_no(${doc.company_id}, ${doc.doc_type},
                                 ${plan.reversalDate}::date,
                                 ${doc.voucher_direction ?? null}) as no`;
    const reversalNo = docNoRows[0].no;

    const [reversal] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, reverses_document_id,
         voucher_direction, posted_at)
      values
        (${doc.company_id}, ${doc.doc_type}, ${reversalNo},
         fn_fiscal_year_for(${doc.company_id}, ${plan.reversalDate}::date),
         ${plan.reversalDate}::date, ${plan.reversalDate}::date,
         ${doc.partner_id}, ${doc.location_id}, ${doc.currency}, ${doc.exchange_rate},
         'POSTED',
         ${-Number(doc.net_total)}, ${-Number(doc.tax_total)}, ${-Number(doc.gross_total)},
         ${`Void of ${doc.doc_no}${input.reason ? ` — ${input.reason}` : ""}`},
         ${doc.id}, ${doc.voucher_direction ?? null}, now())
      returning id`;

    // Negated one for one rather than recomputed. A reversal derived by
    // re-running the posting rules would follow today's rules, and those may
    // have been edited since — the point is to undo what was actually posted.
    const entryId = await writeJournal(
      tx, doc.company_id, plan.reversalDate, doc.doc_type, reversal.id,
      `${reversalNo} void of ${doc.doc_no}`,
      (lines as unknown as {
        account_id: string; amount: string;
        location_id: string | null; partner_id: string | null;
      }[]).map((l) => ({
        accountId: l.account_id,
        amount: -Number(l.amount),
        locationId: l.location_id,
        partnerId: l.partner_id,
      }))
    );
    await tx`update document set journal_entry_id = ${entryId} where id = ${reversal.id}`;

    // The original may only move to REVERSED with the reversal attached —
    // 0037 refuses the status change on its own, so this single statement is
    // the only way a document can become voided.
    await tx`
      update document
         set status = 'REVERSED',
             reversed_by_document_id = ${reversal.id},
             void_reason = ${input.reason ?? null}
       where id = ${doc.id}`;


    // The journal reversal above put the inventory account back. The stock
    // side has to follow it, or the two stop tying — and the lot has to go
    // back to what it cost before this bill had an opinion about it, or the
    // next issue would relieve at a price no document supports any more.
    //
    // Negated one for one, like the entry: another adjustment row rather than
    // deleting the first, because a cost that was believed and then withdrawn
    // is part of the history of that lot. planVoidIn has already refused the
    // case where goods went out at the corrected figure in between, which is
    // the only case this could not honestly undo.
    const revaluations = await tx`
      select lot_id, delta_unit_cost, qty_remaining, qty_issued
        from stock_lot_adjustment where document_id = ${doc.id}`;
    for (const r of revaluations) {
      await tx`
        insert into stock_lot_adjustment
          (company_id, lot_id, document_id, delta_unit_cost,
           qty_remaining, qty_issued, reason)
        values
          (${doc.company_id}, ${r.lot_id}, ${reversal.id},
           ${-Number(r.delta_unit_cost)},
           ${Number(r.qty_remaining)}, ${Number(r.qty_issued)},
           ${`Void of ${doc.doc_no}`})`;
    }

    const valueOnly = await tx`
      select item_id, location_id, total_cost
        from stock_movement where document_id = ${doc.id} and qty = 0`;
    for (const m of valueOnly) {
      await tx`
        insert into stock_movement
          (company_id, item_id, location_id, movement_date, qty, unit_cost,
           total_cost, document_id)
        values
          (${doc.company_id}, ${m.item_id}, ${m.location_id},
           ${plan.reversalDate}::date, 0, 0, ${-Number(m.total_cost)}, ${reversal.id})`;
    }

    await tx`
      insert into document_history (company_id, document_id, action, reason, related_id, detail)
      values (${doc.company_id}, ${doc.id}, 'VOID', ${input.reason ?? null}, ${reversal.id},
              ${tx.json({
                doc_no: doc.doc_no,
                doc_type: doc.doc_type,
                gross_total: Number(doc.gross_total),
                posting_date: doc.posting_date,
                reversal_no: reversalNo,
                reversal_date: plan.reversalDate,
              })})`;

    return {
      id: doc.id as string,
      docNo: doc.doc_no as string,
      reversalId: reversal.id as string,
      reversalNo: reversalNo as string,
      reversalDate: plan.reversalDate,
    };
  }
}

/**
 * Edit a posted document: the next version, under the same number.
 *
 * One transaction does all of it — reverse what was posted, post the
 * correction, join the two as versions of one document, and write the
 * history. If any part fails, the original is still standing and still live;
 * there is no state in which a company has two invoices numbered
 * SI20260910001, or one that has been voided with nothing put in its place.
 *
 * What it will not do, deliberately:
 *
 * It will not edit a document whose goods have moved. A receipt or delivery
 * created cost layers that other documents have since consumed, and unpicking
 * that is a return, not an edit. Same rule as voiding, and for the same
 * reason.
 *
 * It will not edit anything downstream is built on: an invoice with a payment
 * against it must have the payment voided first, because the correction would
 * otherwise leave money allocated to a document that no longer exists. The
 * check is the same one the void screen shows, re-run here against the
 * database as it is at the moment of confirming rather than as it was when
 * the screen was drawn.
 *
 * And it will not quietly change quantities that other documents depend on.
 * The caller decides what the new version says; the posting functions apply
 * their own rules to it, so an invoice still cannot bill more than its
 * receipt holds, whichever version it is.
 */
export type AmendInput<T> = {
  companyId: string;
  documentId: string;
  reason: string;
  /**
   * Posts the corrected document inside the same transaction. It is handed
   * the identity to post under — the original's number, at the next version.
   */
  repost: (tx: TransactionSql, identity: AmendIdentity) => Promise<T & { id: string }>;
};

export async function amendDocument<T>(input: AmendInput<T>) {
  return sql.begin(async (tx) => amendDocumentIn(tx, input));
}

/**
 * The same correction, inside a transaction the caller already owns — which
 * is how correcting an order carries its invoices with it. Every version in
 * that chain is replaced together or none of them is.
 */
export async function amendDocumentIn<T>(tx: TransactionSql, input: AmendInput<T>) {
  if (!input.reason?.trim()) {
    throw new Error("Say why this is being corrected — the reason is kept with the version");
  }

  {
    // Locked first. Two people editing the same invoice at once would
    // otherwise both read it as live, both void it, and both post a
    // replacement — two v2s of one number, which the unique index would then
    // refuse at commit with an error nobody could act on.
    const [orig] = await tx`
      select id, company_id, doc_no, doc_type, version, status, gross_total,
             superseded_by_document_id, journal_entry_id
        from document
       where id = ${input.documentId} and company_id = ${input.companyId}
       for update`;
    if (!orig) throw new Error("That document no longer exists");
    if (orig.status !== "POSTED") {
      throw new Error(
        `${orig.doc_no} is ${String(orig.status).toLowerCase()} and is not the live version. ` +
        `Edit the version that is.`
      );
    }
    if (orig.superseded_by_document_id) {
      throw new Error(`${orig.doc_no} has already been replaced`);
    }

    // Only where a reversal is possible at all. An order has no entry to
    // reverse and is superseded directly; everything else goes through the
    // void rules, which is what keeps stock and settled money out of reach.
    const isOrder = ["PURCHASE_ORDER", "SALES_ORDER"].includes(orig.doc_type as string);
    if (!isOrder) {
      const plan = await planVoidIn(tx, input.documentId);
      if (!plan.canVoid) {
        throw new Error(
          `${orig.doc_no} cannot be corrected yet. ` +
          plan.blockers.map((b: VoidBlocker) => b.reason).join(" ")
        );
      }
    }

    const identity: AmendIdentity = {
      docNo: orig.doc_no as string,
      version: Number(orig.version) + 1,
    };

    // The original stops standing before the replacement takes its number:
    // one live version at any instant, enforced by the unique index either
    // way, but this order means the index never has to be the thing that
    // catches it.
    if (isOrder) {
      await tx`update document set status = 'CANCELLED' where id = ${orig.id}`;
    } else {
      await voidDocumentIn(tx, { documentId: input.documentId, reason: input.reason });
    }

    const replacement = await input.repost(tx, identity);

    await tx`
      update document
         set supersedes_document_id = ${orig.id}
       where id = ${replacement.id}`;
    await tx`
      update document
         set superseded_by_document_id = ${replacement.id}
       where id = ${orig.id}`;

    const [after] = await tx`
      select gross_total from document where id = ${replacement.id}`;

    await tx`
      insert into document_history (company_id, document_id, action, reason, related_id, detail)
      values (${input.companyId}, ${orig.id}, 'AMEND', ${input.reason.trim()},
              ${replacement.id},
              ${tx.json({
                doc_no: orig.doc_no,
                from_version: Number(orig.version),
                to_version: identity.version,
                total_before: Number(orig.gross_total),
                total_after: Number(after?.gross_total ?? 0),
              })})`;

    return {
      docNo: identity.docNo,
      version: identity.version,
      previousId: orig.id as string,
      replacementId: replacement.id,
      totalBefore: Number(orig.gross_total),
      totalAfter: Number(after?.gross_total ?? 0),
      result: replacement,
    };
  }
}

/**
 * The documents a correction to this order would carry with it.
 *
 * An order is a promise about price and quantity, and an invoice raised
 * through it inherited that promise. Correct the promise and the invoice is
 * wrong until it is corrected too — which is the whole of the tester's rule:
 * edit at the order, and the rest follows.
 *
 * Found by following the chain the documents themselves record: an invoice
 * raised straight from the order, or from the delivery or receipt that
 * answered it, or one whose lines name the order's lines. Only live, posted
 * invoices — an already-superseded version is history and stays as it was.
 */
async function invoicesBuiltOn(tx: TransactionSql, orderId: string) {
  return tx`
    select distinct inv.id, inv.doc_no, inv.doc_type, inv.version,
           inv.gross_total, inv.source_document_id
      from document inv
      left join document src on src.id = inv.source_document_id
     where inv.status = 'POSTED'
       and inv.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
       and (
         inv.source_document_id = ${orderId}
         or src.source_document_id = ${orderId}
         or exists (
              select 1 from document_line il
                join document_line ol on ol.id = il.source_line_id
               where il.document_id = inv.id and ol.document_id = ${orderId})
         or exists (
              select 1 from document_line il
                join document_line fl on fl.id = il.source_line_id
                join fulfilment_link k on k.fulfilment_line_id = fl.id
                join document_line ol on ol.id = k.order_line_id
               where il.document_id = inv.id and ol.document_id = ${orderId})
       )
     order by inv.doc_no`;
}

/** One document a correction would touch, as the confirmation screen shows it. */
export type AffectedDocument = {
  id: string;
  docNo: string;
  docType: string;
  version: number;
  totalBefore: number;
  totalAfter: number;
  /** Why this one cannot be carried along, in words a user can act on. */
  blocked: string | null;
};

export type AmendmentPlan = {
  order: AffectedDocument;
  affected: AffectedDocument[];
};

/**
 * How many warehouse moves a cost correction follows.
 *
 * A revaluation walks from the receipt's lot into whatever lot a transfer
 * created, and again from there, so goods that have been moved repeatedly
 * still end up revalued where they actually sit. This is the supported depth,
 * not a safety net against a loop: transfers only ever move value into a lot
 * created later, so a cycle is unreachable. Goods moved more often than this
 * are corrected at the warehouse now holding them, and the message says so.
 *
 * Twenty is far beyond anything a trading company does to one delivery; it is
 * stated as a number rather than left implicit so that the limit is a
 * documented property rather than a surprise.
 */
const MAX_TRANSFER_DEPTH = 20;

/** Thrown to unwind a dry run. Never escapes the function that throws it. */
const DRY_RUN = Symbol("dry run");

/**
 * What correcting this document would do — by doing it and rolling it back.
 *
 * The obvious implementation is to recompute the totals: quantity times the
 * corrected price, summed. That is a second implementation of the posting
 * rules, and it drifted from the first one immediately — it multiplied
 * quantity by price while the posting applied the line discount, so a
 * discounted invoice previewed one figure and posted another. Anything else
 * the engine does on the way through, now or later, would drift the same way.
 *
 * So the preview runs the real correction inside a transaction and throws at
 * the end, which unwinds every write. What it reports is therefore not an
 * estimate of the posting; it is the posting, read back before it is undone.
 * Refusals come out the same way: if the engine would refuse, the dry run
 * refuses, and its message is what the screen shows.
 *
 * Nothing survives it — not the documents, not the ledger, not the document
 * numbers, which come from a row that rolls back with everything else.
 */
async function dryRun<T>(
  body: (tx: TransactionSql) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let captured: T | undefined;
  try {
    await sql.begin(async (tx) => {
      captured = await body(tx);
      throw DRY_RUN;
    });
  } catch (e) {
    if (e !== DRY_RUN) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, value: captured as T };
}

/** The document as it stands, for the "now" column of a preview. */
async function currentFigures(
  tx: TransactionSql, companyId: string, documentId: string,
): Promise<AffectedDocument & { status: string }> {
  const [d] = await tx`
    select id, doc_no, doc_type, version, gross_total, status
      from document where id = ${documentId} and company_id = ${companyId}`;
  if (!d) throw new Error("That document no longer exists");
  return {
    id: d.id as string,
    docNo: d.doc_no as string,
    docType: d.doc_type as string,
    version: Number(d.version),
    totalBefore: Number(d.gross_total),
    totalAfter: Number(d.gross_total),
    blocked: null,
    status: d.status as string,
  };
}

/**
 * A short, stable description of what a plan says.
 *
 * The preview is a picture of a moment. Between looking at it and confirming
 * it, somebody else can pay one of those invoices, ship the rest of the order,
 * or correct it first — and the confirmation would then post something the
 * reader never saw. So the screen sends back the plan it was shown, the
 * confirmation re-runs the plan against the database as it is now, and the two
 * are compared. Different means show it again rather than post it.
 */
export function amendmentFingerprint(plan: AmendmentPlan): string {
  const one = (a: AffectedDocument) =>
    `${a.docNo}@${a.version}:${round4(a.totalBefore)}>${round4(a.totalAfter)}` +
    `${a.blocked ? "!" : ""}`;
  return [one(plan.order), ...plan.affected.map(one).sort()].join("|");
}

/**
 * What editing this order would change, without changing anything.
 *
 * Takes the whole corrected order rather than just its lines, because it posts
 * it — and the input it posts has to be the input the confirmation will post,
 * or the preview is answering a different question from the one being asked.
 */
export async function planOrderAmendment(input: {
  companyId: string;
  documentId: string;
  order: Omit<OrderInput, "amendOf">;
  reason?: string;
}): Promise<AmendmentPlan> {
  const run = await dryRun(async (tx) => {
    const before = await currentFigures(tx, input.companyId, input.documentId);
    if (before.status !== "POSTED") {
      throw new Error(
        `${before.docNo} is ${before.status.toLowerCase()} and cannot be corrected`);
    }
    const res = await amendOrderIn(tx, {
      companyId: input.companyId,
      documentId: input.documentId,
      reason: input.reason?.trim() || "preview",
      order: input.order,
      cascade: true,
    });
    return {
      order: { ...before, totalAfter: res.totalAfter, blocked: null },
      affected: res.affected,
    };
  });

  if (run.ok) return { order: stripStatus(run.value.order), affected: run.value.affected };

  // The engine refused. That refusal is the answer — shown before anyone
  // confirms, rather than as a failure afterwards.
  const [d] = await sql`
    select id, doc_no, doc_type, version, gross_total
      from document where id = ${input.documentId} and company_id = ${input.companyId}`;
  if (!d) throw new Error("That order no longer exists");
  return {
    order: {
      id: d.id as string,
      docNo: d.doc_no as string,
      docType: d.doc_type as string,
      version: Number(d.version),
      totalBefore: Number(d.gross_total),
      totalAfter: Number(d.gross_total),
      blocked: run.error,
    },
    affected: [],
  };
}

function stripStatus(a: AffectedDocument & { status?: string }): AffectedDocument {
  const { status, ...rest } = a;
  void status;
  return rest;
}

/**
 * What editing this invoice would change — the same dry run, for the document
 * type that has nothing downstream inheriting from it.
 */
export async function planInvoiceAmendment(input: {
  companyId: string;
  documentId: string;
  invoice: Parameters<typeof amendInvoice>[0]["invoice"];
  reason?: string;
}): Promise<AmendmentPlan> {
  const run = await dryRun(async (tx) => {
    const before = await currentFigures(tx, input.companyId, input.documentId);
    if (before.status !== "POSTED") {
      throw new Error(
        `${before.docNo} is ${before.status.toLowerCase()} and cannot be corrected`);
    }
    const res = await amendDocumentIn(tx, {
      companyId: input.companyId,
      documentId: input.documentId,
      reason: input.reason?.trim() || "preview",
      repost: async (t, identity) => {
        const [orig] = await t`
          select doc_type from document where id = ${input.documentId}`;
        const next = { ...input.invoice, amendOf: identity };
        return orig.doc_type === "SALES_INVOICE"
          ? _postSalesInvoice(t, next as never)
          : _postPurchaseInvoice(t, next as never);
      },
    });
    return { ...before, totalAfter: res.totalAfter };
  });

  if (run.ok) return { order: stripStatus(run.value), affected: [] };

  const [d] = await sql`
    select id, doc_no, doc_type, version, gross_total
      from document where id = ${input.documentId} and company_id = ${input.companyId}`;
  if (!d) throw new Error("That invoice no longer exists");
  return {
    order: {
      id: d.id as string,
      docNo: d.doc_no as string,
      docType: d.doc_type as string,
      version: Number(d.version),
      totalBefore: Number(d.gross_total),
      totalAfter: Number(d.gross_total),
      blocked: run.error,
    },
    affected: [],
  };
}

/**
 * What this order has already been answered by, per item.
 *
 * Read from the documents rather than from `v_order_outstanding`, which only
 * counts POSTED orders — during an amendment the version being replaced has
 * already been cancelled, so the view would report nothing fulfilled and
 * every check against it would pass.
 */
async function fulfilledByItem(tx: TransactionSql, orderId: string) {
  return tx`
    select item_id, sum(qty) as fulfilled from (
      select dl.item_id, dl.base_qty as qty
        from document_line dl
        join document dd on dd.id = dl.document_id
        left join document_line ol on ol.id = dl.source_line_id
       where dd.doc_type in ('GOODS_RECEIPT', 'DELIVERY') and dd.status = 'POSTED'
         and coalesce(ol.document_id, dd.source_document_id) = ${orderId}
      union all
      select ol.item_id, fl.qty
        from fulfilment_link fl
        join document_line ol on ol.id = fl.order_line_id
       where ol.document_id = ${orderId}
    ) answered
     group by item_id`;
}

/**
 * Why these quantities cannot stand, or null if they can.
 *
 * An order for a hundred with sixty already received cannot be corrected down
 * to fifty: sixty of them are on the shelf, and the ten that vanished would
 * be pointing at a line that no longer holds them. Returned as a sentence
 * rather than thrown, so the preview can show it before anyone confirms and
 * the engine can refuse with the same words afterwards.
 */
async function cutBelowFulfilled(
  tx: TransactionSql, orderId: string, lines: { itemId: string; qty: number }[],
): Promise<string | null> {
  for (const row of await fulfilledByItem(tx, orderId)) {
    const done = Number(row.fulfilled);
    if (done <= 0.0001) continue;
    const now = lines
      .filter((l) => l.itemId === row.item_id)
      .reduce((t, l) => t + l.qty, 0);
    if (now + 0.0001 < done) {
      const [item] = await tx`select code from item where id = ${row.item_id}`;
      return `${done} of ${item?.code ?? "that item"} has already been fulfilled against ` +
        `this order, so it cannot be corrected to ${now}. Return the goods first, ` +
        `or correct it to at least what has arrived.`;
    }
  }
  return null;
}

/**
 * Edit an order, keeping its number.
 *
 * An order posts nothing to the ledger and moves no stock, so correcting one
 * is the simplest case there is: the old version is cancelled, the new one
 * takes its number at the next version, and nothing needs reversing. What it
 * still has to respect is what has already happened against it — an order for
 * a hundred with sixty received cannot be corrected down to fifty, because
 * sixty of them are on the shelf.
 */
export async function amendOrder(input: {
  companyId: string;
  documentId: string;
  reason: string;
  order: Omit<OrderInput, "amendOf">;
  /**
   * Carry the correction into what was built on this order. An invoice raised
   * through it inherited its prices, so correcting the order and leaving the
   * invoice alone leaves the customer billed at the old figure — which is the
   * whole point of correcting at the order.
   *
   * Quantities are not carried. Goods that moved, moved: a delivery keeps its
   * quantity and its cost, and an invoice billing it keeps the quantity it
   * billed. What travels is price.
   */
  cascade?: boolean;
  /** What the reader was shown — see amendOrderIn. */
  expect?: string | null;
}) {
  return sql.begin((tx) => amendOrderIn(tx, input));
}

/**
 * The same correction inside a transaction the caller already owns.
 *
 * Exposed so the preview can run the real thing and roll it back. A preview
 * that recomputes the totals a second way is a second implementation of the
 * posting rules, and the two drift — which is exactly what happened: the
 * preview multiplied quantity by price and the posting applied the discount,
 * so a discounted invoice previewed one figure and posted another.
 */
export async function amendOrderIn(tx: TransactionSql, input: {
  companyId: string;
  documentId: string;
  reason: string;
  order: Omit<OrderInput, "amendOf">;
  cascade?: boolean;
  /**
   * The plan the reader was shown, as a fingerprint. Checked against what this
   * amendment actually did, inside the same transaction — so a correction that
   * would do something other than what was on the screen rolls back instead of
   * committing.
   *
   * Checked here rather than before starting, because before starting means
   * running the whole correction twice: once to see, once to do. On a slow
   * link that made confirming take a minute, most of it spent proving that
   * nothing had changed since a moment ago. Inside the transaction there is
   * also no window between the checking and the acting for anything to change
   * in.
   */
  expect?: string | null;
}): Promise<{
  docNo: string; version: number; previousId: string; replacementId: string;
  totalBefore: number; totalAfter: number;
  /** Every document the cascade carried along, before and after. */
  affected: AffectedDocument[];
}> {
  const affected: AffectedDocument[] = [];

  // What the order says now, read before anything moves, so the comparison is
  // against the same "before" the preview reported.
  const before = input.expect
    ? await currentFigures(tx, input.companyId, input.documentId)
    : null;
  const result = await amendDocumentIn(tx, {
    companyId: input.companyId,
    documentId: input.documentId,
    reason: input.reason,
    repost: async (tx, identity) => {
      // What the order has already been answered by, per item. The corrected
      // order has to cover it: cancelling a line that goods arrived against
      // would leave those goods pointing at nothing.
      //
      // Read from the documents rather than from v_order_outstanding, which
      // only counts POSTED orders — by the time this runs the version being
      // replaced has been cancelled, so the view would report nothing
      // fulfilled and the check would pass on every order.
      const short = await cutBelowFulfilled(tx, input.documentId, input.order.lines);
      if (short) throw new Error(short);

      const docType = (await tx`
        select doc_type from document where id = ${input.documentId}`)[0].doc_type as
        "SALES_ORDER" | "PURCHASE_ORDER";

      const replacement = await postOrderIn(
        tx, { ...input.order, amendOf: identity }, docType);

      if (input.cascade) {
        const priceFor = new Map(
          input.order.lines.map((l) => [l.itemId, Number(l.unitPrice ?? 0)]));

        for (const inv of await invoicesBuiltOn(tx, input.documentId)) {
          // Everything the void rules refuse, this refuses — an invoice with
          // a payment against it is not quietly re-posted underneath the
          // money. The correction stops, whole, and says which document is in
          // the way.
          const plan = await planVoidIn(tx, inv.id as string);
          if (!plan.canVoid) {
            throw new Error(
              `${inv.doc_no} inherits from this order and cannot be corrected with it. ` +
              plan.blockers.map((b: VoidBlocker) => b.reason).join(" ")
            );
          }

          const stored = await tx`
            select dl.item_id, dl.base_qty as qty, dl.unit_price, dl.foc_reason_id,
                   dl.source_line_id, dl.discount_pct, dl.is_consignment,
                   d.location_id, d.partner_id, d.source_document_id,
                   d.doc_type, d.to_deliver, d.salesman_id, d.payment_type,
                   d.delivery_fee,
                   to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
                   to_char(d.due_date, 'YYYY-MM-DD') as due_date
              from document_line dl
              join document d on d.id = dl.document_id
             where dl.document_id = ${inv.id}
             order by dl.line_no`;
          if (stored.length === 0) continue;
          const head = stored[0];

          const lines = stored.map((l: any) => ({
            itemId: l.item_id as string,
            qty: Number(l.qty),
            // The corrected price where this order has one for the item, and
            // whatever the line already said where it does not — an invoice
            // may carry lines the order never mentioned.
            unitPrice: priceFor.has(l.item_id)
              ? priceFor.get(l.item_id)!
              : Number(l.unit_price),
            focReasonId: l.foc_reason_id as string | null,
            sourceLineId: l.source_line_id as string | null,
            // The discount was agreed separately from the price and is not
            // what the order corrected. Dropping it here re-posted the invoice
            // at full price and billed the customer more than the original.
            discountPct: Number(l.discount_pct ?? 0),
          }));

          if (stored.some((l: Record<string, unknown>) => l.is_consignment)) {
            throw new Error(
              `${inv.doc_no} sells consigned goods and cannot be corrected with ` +
              `this order — correcting it would have to restate whose goods ` +
              `were sold. Void it and raise a replacement.`
            );
          }

          const isSales = head.doc_type === "SALES_INVOICE";
          const carried = await amendDocumentIn<{ id: string; docNo: string }>(tx, {
            companyId: input.companyId,
            documentId: inv.id as string,
            reason: `${input.reason} — carried from ${identity.docNo} v${identity.version}`,
            repost: (t: TransactionSql, ident: AmendIdentity) => {
              const next = {
                companyId: input.companyId,
                partnerId: head.partner_id as string,
                locationId: head.location_id as string,
                docDate: head.doc_date as string,
                dueDate: (head.due_date as string) ?? null,
                lines,
                amendOf: ident,
                ...(isSales
                  ? { toDeliver: head.to_deliver as boolean,
                      deliveryId: head.source_document_id as string | null,
                      salesmanId: (head.salesman_id as string) ?? null,
                      paymentType: (head.payment_type as "CASH" | "CREDIT") ?? undefined,
                      // Carried, not recharged: a corrected price on the goods
                      // does not give the customer their delivery for nothing.
                      deliveryFee: head.delivery_fee === null
                        || head.delivery_fee === undefined
                        ? undefined : Number(head.delivery_fee) }
                  : { goodsReceiptId: head.source_document_id as string | null }),
              };
              // Both return an id and a number; the extra field each carries
              // differs, and nothing here reads it.
              return (isSales
                ? _postSalesInvoice(t, next as never)
                : _postPurchaseInvoice(t, next as never)) as Promise<{
                  id: string; docNo: string;
                }>;
            },
          });

          affected.push({
            id: inv.id as string,
            docNo: carried.docNo,
            docType: head.doc_type as string,
            version: Number(inv.version),
            totalBefore: carried.totalBefore,
            totalAfter: carried.totalAfter,
            blocked: null,
          });
        }
      }

      return replacement;
    },
  });

  if (before && input.expect) {
    const actual = amendmentFingerprint({
      order: { ...stripStatus(before), totalAfter: result.totalAfter },
      affected,
    });
    if (actual !== input.expect) {
      // Rolls the whole correction back. The caller turns this into the
      // revised plan on screen rather than an error — nothing was wrong, the
      // world simply moved.
      throw new StalePlan(actual);
    }
  }

  return { ...result, affected };
}

/**
 * The correction would not have done what the screen said it would.
 *
 * Thrown inside the transaction, so nothing is committed. Carries what the
 * amendment actually came to, which is what the reader is shown next.
 */
export class StalePlan extends Error {
  constructor(public readonly fingerprint: string) {
    super("This changed while you were looking at it");
    this.name = "StalePlan";
  }
}

/**
 * How many decimal places this company's money has.
 *
 * The kyat has none. Every amount that becomes a receivable or a payable is
 * rounded to this, so the figure on the invoice is a figure somebody can hand
 * over — a total of 1,601,071.471 left 0.471 outstanding that no payment could
 * ever clear, and that is not a rounding curiosity but a debt the books carry
 * for ever.
 *
 * Costs and unit prices are deliberately not rounded to it. A box that cost
 * 106,071.4314 really did, and inventory is a book value rather than something
 * anyone pays in coins.
 */
async function currencyScale(tx: TransactionSql, companyId: string): Promise<number> {
  const [row] = await tx`
    select c.decimal_places
      from company co join currency c on c.code = co.base_currency
     where co.id = ${companyId}`;
  return row ? Number(row.decimal_places) : 2;
}

/**
 * A price agreed on an order is the price billed.
 *
 * The tester's rule: creating an invoice from a source takes the source's
 * quantity and the order's price, and neither is typed over. The screen locks
 * the field; this is what makes the lock a rule rather than a suggestion,
 * because a request that reaches the posting engine has not been past any
 * screen.
 *
 * Deliberately not applied to a correction. An amendment *is* the sanctioned
 * way to change an agreed price — it runs from the order, carries the new
 * figure into the bill, and records why. Applying this there would make the
 * one authorised path the only forbidden one.
 */
async function assertAgreedPriceKept(
  tx: TransactionSql, companyId: string,
  lines: { itemId: string; unitPrice?: number; sourceLineId?: string | null }[],
) {
  for (const line of lines) {
    if (!line.sourceLineId) continue;

    // The order line behind the delivery line this invoice bills, resolved to
    // whichever version of that order stands now — the delivery names the
    // version it answered, and the agreed price is whatever the order says
    // today.
    const [agreed] = await tx`
      select ol.unit_price, o.doc_no
        from document_line dl
        join document_line ol on ol.id = dl.source_line_id
        join document o on o.id = fn_current_document(ol.document_id)
        join document_line cur on cur.document_id = o.id and cur.item_id = ol.item_id
       where dl.id = ${line.sourceLineId}
         and o.doc_type = 'SALES_ORDER'
         and o.company_id = ${companyId}
       limit 1`;
    if (!agreed) continue;

    const was = Number(agreed.unit_price);
    const now = Number(line.unitPrice ?? 0);
    if (Math.abs(now - was) > 0.0001) {
      throw new Error(
        `${agreed.doc_no} agreed ${was} for these goods, so the invoice bills ` +
        `${was} and not ${now}. Correct the agreed price on ${agreed.doc_no} ` +
        `— it carries into this bill and both keep their number.`
      );
    }
  }
}

/**
 * The order an invoice traces back to, if any.
 *
 * The tester's rule needs this on the server, not only in the browser: an
 * order-based invoice is corrected at the order, and hiding the button is not
 * enforcement — a crafted request reaches the action directly. The rule is
 * about where a price may be changed, which makes it a rule about the ledger,
 * which puts it here.
 *
 * Three ways an invoice can belong to an order, matching the three ways one
 * gets raised: straight from the order, from the delivery or receipt that
 * answered it, or line by line against its lines. Version-resolved, so an
 * invoice raised against v1 still belongs to the order after it becomes v2.
 */
async function orderBehindInvoice(
  tx: TransactionSql, documentId: string,
): Promise<{ id: string; docNo: string } | null> {
  const [found] = await tx`
    with src as (
      select d.id, d.source_document_id
        from document d where d.id = ${documentId}
    ),
    candidates as (
      select s.source_document_id as id from src s
      union
      select p.source_document_id from src s
        join document p on p.id = s.source_document_id
      union
      select ol.document_id
        from document_line il
        join document_line ol on ol.id = il.source_line_id
       where il.document_id = ${documentId}
      union
      select ol.document_id
        from document_line il
        join document_line fl on fl.id = il.source_line_id
        join fulfilment_link k on k.fulfilment_line_id = fl.id
        join document_line ol on ol.id = k.order_line_id
       where il.document_id = ${documentId}
    )
    select o.id, o.doc_no
      from candidates c
      join document o on o.id = fn_current_document(c.id)
     where o.doc_type in ('SALES_ORDER', 'PURCHASE_ORDER')
     limit 1`;
  return found ? { id: found.id as string, docNo: found.doc_no as string } : null;
}

/**
 * Edit an invoice, keeping its number.
 *
 * The version that was posted is reversed and the corrected one posted in its
 * place, both inside one transaction, so the ledger is never holding half an
 * edit. Everything the void rules refuse, this refuses: an invoice with a
 * payment allocated against it has to have the payment voided first, because
 * a correction would otherwise leave money pointing at a document that no
 * longer stands.
 */
export async function amendInvoice(input: {
  companyId: string;
  documentId: string;
  reason: string;
  invoice: SalesInvoiceInput & InvoiceInput & {
    deliveryId?: string | null;
    goodsReceiptId?: string | null;
    cashOut?: number;
    cashIn?: number;
    cashAccountId?: string | null;
  };
}) {
  return amendDocument({
    companyId: input.companyId,
    documentId: input.documentId,
    reason: input.reason,
    repost: async (tx, identity) => {
      const [orig] = await tx`
        select doc_type, source_document_id from document where id = ${input.documentId}`;

      // Where an order is behind this invoice, the order is where the price
      // was agreed and the only place it may be changed. Enforced here rather
      // than by hiding a button, because a request that reaches this function
      // has not been past any button.
      const order = await orderBehindInvoice(tx, input.documentId);
      if (order) {
        throw new Error(
          `This invoice was raised through ${order.docNo}, so it is corrected ` +
          `there — correcting the bill on its own would leave the two ` +
          `disagreeing with nothing recording which is right.`
        );
      }

      // What moved, moved. An invoice that bills a receipt or a delivery takes
      // its quantities from that document; a correction may change what was
      // charged for the goods and never how many there were. The screen locks
      // the field, and this is what makes the lock mean something.
      if (orig.source_document_id) {
        await assertQuantitiesUnchanged(
          tx, input.documentId, input.invoice.lines ?? []);
      }

      const next = { ...input.invoice, amendOf: identity };
      return orig.doc_type === "SALES_INVOICE"
        ? _postSalesInvoice(tx, next)
        : _postPurchaseInvoice(tx, next);
    },
  });
}

/**
 * The corrected lines carry the same quantities as the document being
 * corrected, per item.
 *
 * Per item rather than per line, because a correction rebuilds the lines and
 * their ids are new by the time this runs. Two lines of one item are compared
 * as their total, which is the figure that matters: the goods that moved.
 */
async function assertQuantitiesUnchanged(
  tx: TransactionSql, documentId: string,
  lines: { itemId: string; qty: number }[],
) {
  const stored = await tx`
    select item_id, sum(base_qty) as qty
      from document_line where document_id = ${documentId}
     group by item_id`;

  const now = new Map<string, number>();
  for (const l of lines) {
    now.set(l.itemId, round4((now.get(l.itemId) ?? 0) + Number(l.qty)));
  }

  for (const was of stored) {
    const before = Number(was.qty);
    const after = now.get(was.item_id as string) ?? 0;
    if (Math.abs(after - before) > 0.0001) {
      const [item] = await tx`select code from item where id = ${was.item_id}`;
      throw new Error(
        `This invoice bills goods that have already moved, so the quantity of ` +
        `${item?.code ?? "that item"} cannot be corrected from ${before} to ` +
        `${after}. Correct the price here, or raise a return for the goods.`
      );
    }
    now.delete(was.item_id as string);
  }
  for (const [itemId, qty] of now) {
    if (qty <= 0.0001) continue;
    const [item] = await tx`select code from item where id = ${itemId}`;
    throw new Error(
      `${item?.code ?? "An item"} is not on the invoice being corrected. A ` +
      `correction changes what was charged, not what was billed for — raise a ` +
      `separate invoice for goods this one never covered.`
    );
  }
}

/**
 * Links a freshly posted document to the one it replaces, and records the
 * edit.
 *
 * An edit is a void plus a re-entry, and the re-entry has to go through the
 * posting function for its own type — a sales invoice knows things about
 * itself that nothing generic does. So this is deliberately not a
 * `amendDocument(id, newValues)` that would have to re-implement every
 * document type: the caller voids, posts the corrected document however that
 * type is posted, and then says here that the two are versions of one thing.
 *
 * Both halves in one transaction is the caller's job, and matters: a void
 * with no replacement is a delete, and a replacement with no void is a
 * duplicate. Neither is what was asked for.
 */
export async function linkAmendment(input: {
  companyId: string;
  /** The document that was voided. */
  originalId: string;
  /** Its replacement, already posted. */
  replacementId: string;
  reason?: string | null;
}) {
  return sql.begin(async (tx) => {
    const [orig] = await tx`
      select id, doc_no, status, gross_total, reversed_by_document_id
        from document where id = ${input.originalId} and company_id = ${input.companyId}`;
    if (!orig) throw new Error("The document being replaced no longer exists");
    if (orig.status !== "REVERSED" || !orig.reversed_by_document_id) {
      throw new Error(
        `${orig.doc_no} has not been voided. An edit is a void followed by a ` +
        `replacement — posting the replacement without voiding the original ` +
        `would leave both standing`
      );
    }

    const [repl] = await tx`
      select id, doc_no, gross_total, supersedes_document_id
        from document where id = ${input.replacementId} and company_id = ${input.companyId}`;
    if (!repl) throw new Error("The replacement document no longer exists");
    if (repl.supersedes_document_id) {
      throw new Error(`${repl.doc_no} already replaces something else`);
    }

    await tx`
      update document set supersedes_document_id = ${orig.id}
       where id = ${repl.id}`;

    await tx`
      insert into document_history (company_id, document_id, action, reason, related_id, detail)
      values (${input.companyId}, ${orig.id}, 'AMEND', ${input.reason ?? null}, ${repl.id},
              ${tx.json({
                replaced_by: repl.doc_no,
                total_before: Number(orig.gross_total),
                total_after: Number(repl.gross_total),
              })})`;

    return { originalNo: orig.doc_no as string, replacementNo: repl.doc_no as string };
  });
}

export type ImportedVoucher = {
  docDate: string;
  moneyAccountId: string;
  otherAccountId: string;
  amount: number;
  locationId: string | null;
  reference: string | null;
  memo: string | null;
};

/**
 * Posts a spreadsheet of cash or bank receipts as one act.
 *
 * Each row becomes its own voucher — they are separate receipts from
 * different people on different days, and merging them would lose the
 * reference that identifies each one. What they share is the transaction:
 * a file of two hundred receipts either posts entirely or not at all, because
 * "which of these went in?" is not a question anyone should have to answer by
 * reading the ledger afterwards.
 *
 * Dr the cash or bank account, Cr where the money came from — the same two
 * lines the receipt screen writes, through the same postVoucher path, so an
 * imported receipt and a typed one are indistinguishable once posted.
 */
export async function importVouchers(input: {
  companyId: string;
  kind: "cash" | "bank";
  filename: string;
  rowCount: number;
  rows: ImportedVoucher[];
}) {
  const { companyId, kind, filename, rows } = input;
  if (rows.length === 0) throw new Error("There is nothing to import");

  const docType = kind === "cash" ? "CASH_VOUCHER" : "BANK_VOUCHER";

  return sql.begin(async (tx) => {
    const [{ next }] = await tx`
      select coalesce(max(substring(ref from '[0-9]+$')::int), 0) + 1 as next
        from import_batch where company_id = ${companyId}`;
    const ref = `IMP-${String(next).padStart(6, "0")}`;

    const [batch] = await tx`
      insert into import_batch (company_id, ref, filename, row_count)
      values (${companyId}, ${ref}, ${filename}, ${input.rowCount})
      returning id`;

    const posted: string[] = [];
    for (const v of rows) {
      const doc = await _postVoucher(
        tx,
        {
          companyId,
          docDate: v.docDate,
          memo: v.memo,
          reference: v.reference,
          locationId: v.locationId,
          lines: [
            { accountId: v.moneyAccountId, amount: v.amount },
            { accountId: v.otherAccountId, amount: -v.amount },
          ],
        },
        docType
      );
      await tx`update document set import_batch_id = ${batch.id} where id = ${doc.id}`;
      posted.push(doc.docNo);
    }

    return {
      ref,
      batchId: batch.id as string,
      posted: posted.length,
      total: round4(rows.reduce((s, r) => s + r.amount, 0)),
      documents: posted,
    };
  });
}

// ------------------------------------------------------------- cutover --

export type OpeningStockLine = {
  itemId: string;
  locationId: string;
  qty: number;
  unitCost: number;
};

export type OpeningPartnerLine = {
  partnerId: string;
  /** The customer's or supplier's own invoice number, not one of ours. */
  reference: string;
  amount: number;
  dueDate?: string | null;
};

export type OpeningBatchInput = {
  companyId: string;
  /** The day the business starts using this system. */
  cutoverDate: string;
  memo?: string | null;
  stock?: OpeningStockLine[];
  receivables?: OpeningPartnerLine[];
  payables?: OpeningPartnerLine[];
  /** Everything a subledger does not own: cash, bank, loans, capital. */
  accounts?: { accountId: string; amount: number; locationId?: string | null }[];
};

/**
 * The cutover, posted once.
 *
 * Everything here balances against Opening Balance Equity, which nets to nil
 * when the whole position is in. Nothing touches revenue, cost of sales or
 * GR/IR: none of it was earned, spent or received in this system, and a
 * cutover that moves those accounts reports last year's trading as this
 * year's.
 *
 *   stock        Dr Inventory     / Cr Opening Balance Equity, with the
 *                quantity and a FIFO layer, so a later sale draws real cost
 *   receivables  Dr Receivables   / Cr Opening Balance Equity, as an open
 *                item carrying the customer's own reference and due date
 *   payables     Cr Payables      / Dr Opening Balance Equity, likewise
 *   accounts     whatever they are / balanced against the same equity account
 *
 * One transaction, one batch, and the database allows one posted batch per
 * company — a second cutover silently doubling stock and debts is the kind
 * of mistake found months later, so it is a constraint rather than a check
 * somewhere in a form.
 *
 * Documents are dated the day before the cutover: the opening position is
 * what was true when trading began, and day one's own transactions should
 * not compete with it for the same date.
 */
export async function postOpeningBatch(input: OpeningBatchInput) {
  const stock = (input.stock ?? []).filter((l) => l.itemId && l.qty > 0);
  const receivables = (input.receivables ?? []).filter((l) => l.partnerId && l.amount !== 0);
  const payables = (input.payables ?? []).filter((l) => l.partnerId && l.amount !== 0);
  const accounts = (input.accounts ?? []).filter((l) => l.accountId && l.amount !== 0);

  if (stock.length + receivables.length + payables.length + accounts.length === 0) {
    throw new Error("An opening batch needs at least one balance");
  }
  // Quantity and cost together, through the same check every stock document
  // uses: a negative opening quantity is a correction, not an opening.
  assertLines(stock.map((l) => ({ qty: l.qty, unitCost: l.unitCost })));
  receivables.forEach((l, i) => assertAmount(l.amount, `Customer line ${i + 1}: amount`));
  payables.forEach((l, i) => assertAmount(l.amount, `Supplier line ${i + 1}: amount`));
  accounts.forEach((l, i) => assertAmount(l.amount, `Account line ${i + 1}: amount`, { signed: true }));

  // The day before trading starts in this system.
  const asAt = new Date(input.cutoverDate);
  if (Number.isNaN(asAt.getTime())) throw new Error("Cutover date is not a date");
  asAt.setDate(asAt.getDate() - 1);
  const docDate = asAt.toISOString().slice(0, 10);

  return sql.begin(async (tx) => {
    const { companyId } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) {
      throw new Error(
        `No fiscal year covers ${docDate}. Opening balances are dated the day `
        + `before the cutover, so that day has to fall in a fiscal year.`
      );
    }

    const [equityRow] = await tx`
      select fn_system_account(${companyId}, 'OPENING_BALANCE_EQUITY') as a`;
    const equity = equityRow.a as string;
    if (!equity) throw new Error("No Opening Balance Equity account is set");

    // The unique index is the real guard; this turns its message into one
    // that says what happened and what to do about it.
    const existing = await tx`
      select cutover_date from opening_batch
       where company_id = ${companyId} and status = 'POSTED'`;
    if (existing.length > 0) {
      throw new Error(
        `Opening balances were already posted for this company, as at `
        + `${String(existing[0].cutover_date).slice(0, 10)}. A second set would `
        + `double the stock and the debts. Void the first batch to replace it.`
      );
    }

    const [batch] = await tx`
      insert into opening_batch (company_id, cutover_date, status, memo, posted_at)
      values (${companyId}, ${input.cutoverDate}::date, 'POSTED', ${input.memo ?? null}, now())
      returning id`;

    const documents: { id: string; docNo: string; kind: string }[] = [];

    const newDoc = async (
      docType: string, partnerId: string | null, locationId: string | null,
      total: number, memo: string, reference: string | null, dueDate: string | null,
    ) => {
      const [{ no }] = await tx`
        select fn_next_document_no(${companyId}, ${docType}, ${docDate}::date, null) as no`;
      const [d] = await tx`
        insert into document
          (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
           due_date, partner_id, location_id, currency, exchange_rate, status,
           net_total, tax_total, gross_total, memo, reference, opening_batch_id, posted_at)
        values
          (${companyId}, ${docType}, ${no}, ${fiscalYear}, ${docDate}::date, ${docDate}::date,
           ${dueDate}, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
           ${total}, 0, ${total}, ${memo}, ${reference}, ${batch.id}, now())
        returning id`;
      return { id: d.id as string, docNo: no as string };
    };

    // ---- stock ------------------------------------------------------------
    // One document per warehouse: a stock document belongs to the place its
    // goods are, and the journal line carries that branch with it.
    const byLocation = new Map<string, OpeningStockLine[]>();
    for (const l of stock) {
      const list = byLocation.get(l.locationId) ?? [];
      list.push(l);
      byLocation.set(l.locationId, list);
    }

    for (const [locationId, lines] of byLocation) {
      const total = round4(lines.reduce((s, l) => s + round4(l.qty * l.unitCost), 0));
      const doc = await newDoc("OPENING_BALANCE", null, locationId, total,
        "Opening stock", null, null);
      const journal: JournalLine[] = [];
      let lineNo = 0;

      for (const l of lines) {
        lineNo += 1;
        const value = round4(l.qty * l.unitCost);
        const [item] = await tx`
          select base_uom_id, is_stocked from item
           where id = ${l.itemId} and company_id = ${companyId}`;
        if (!item) throw new Error("Opening stock names an item that does not exist");
        if (!item.is_stocked) {
          throw new Error("Opening stock names an item that is not stocked");
        }

        await tx`
          insert into document_line
            (company_id, document_id, line_no, item_id, location_id,
             entered_qty, entered_uom_id, base_qty, unit_price,
             net_amount, tax_amount, gross_amount)
          values
            (${companyId}, ${doc.id}, ${lineNo}, ${l.itemId}, ${locationId},
             ${l.qty}, ${item.base_uom_id}, ${l.qty}, ${l.unitCost},
             ${value}, 0, ${value})`;

        const [movement] = await tx`
          insert into stock_movement
            (company_id, item_id, location_id, movement_date, qty,
             unit_cost, total_cost, document_id)
          values
            (${companyId}, ${l.itemId}, ${locationId}, ${docDate}::date,
             ${l.qty}, ${l.unitCost}, ${value}, ${doc.id})
          returning id`;

        // A real layer at a real cost, so the first sale out of opening stock
        // draws what the goods actually cost rather than a guess.
        await createFifoLot(tx, companyId, l.itemId, locationId, docDate,
                            l.unitCost, l.qty, movement.id);

        const [inv] = await tx`
          select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${l.itemId}) as a`;
        journal.push({ accountId: inv.a, amount: value, locationId });
      }

      journal.push({ accountId: equity, amount: -total, locationId });
      const entryId = await writeJournal(tx, companyId, docDate, "OPENING_BALANCE",
        doc.id, `${doc.docNo} opening stock`, journal, locationId);
      await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;
      documents.push({ ...doc, kind: "stock" });
    }

    // ---- what customers owe, and what is owed to suppliers ----------------
    // Posted as invoices because that is what an open item is here: it ages,
    // it settles against an ordinary receipt or payment, and every screen
    // that reads receivables already understands it. What makes it an
    // opening balance rather than a sale is the journal — equity, not
    // revenue — and the batch id it carries.
    const openItems = async (
      lines: OpeningPartnerLine[], docType: "SALES_INVOICE" | "PURCHASE_INVOICE",
      role: "AR_CONTROL" | "AP_CONTROL", sign: 1 | -1, label: string,
    ) => {
      for (const l of lines) {
        const amount = round4(Math.abs(l.amount));
        const doc = await newDoc(docType, l.partnerId, null, amount,
          `${label} — ${l.reference}`, l.reference, l.dueDate ?? null);
        const [ctrl] = await tx`
          select fn_resolve_control_account(${companyId}, ${role}, ${l.partnerId}) as a`;
        const entryId = await writeJournal(tx, companyId, docDate, docType, doc.id,
          `${doc.docNo} ${label}`, [
            { accountId: ctrl.a, amount: sign * amount, partnerId: l.partnerId },
            { accountId: equity, amount: -sign * amount },
          ]);
        await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;
        documents.push({ ...doc, kind: label });
      }
    };

    await openItems(receivables, "SALES_INVOICE", "AR_CONTROL", 1, "Opening receivable");
    await openItems(payables, "PURCHASE_INVOICE", "AP_CONTROL", -1, "Opening payable");

    // ---- everything else --------------------------------------------------
    if (accounts.length > 0) {
      const total = round4(accounts.reduce((s, l) => s + l.amount, 0));
      const gross = round4(accounts.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
      const doc = await newDoc("OPENING_BALANCE", null, null, gross,
        "Opening balances", null, null);
      const journal: JournalLine[] = accounts.map((l) => ({
        accountId: l.accountId, amount: l.amount, locationId: l.locationId ?? null,
      }));
      // Whatever the listed balances do not account for is the remainder, and
      // it belongs in equity where it can be looked at rather than spread
      // silently across the accounts that were entered.
      if (total !== 0) journal.push({ accountId: equity, amount: -total });
      const entryId = await writeJournal(tx, companyId, docDate, "OPENING_BALANCE",
        doc.id, `${doc.docNo} opening balances`, journal);
      await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;
      documents.push({ ...doc, kind: "accounts" });
    }

    return { batchId: batch.id as string, docDate, documents };
  });
}

/**
 * Raise a replacement settlement for a sale whose settlement was voided.
 *
 * Settlement normally happens once, when the sale is invoiced. Voiding it
 * left no way back: the goods were sold, the consignor's payable reversed,
 * and the only thing that could have settled them ran during a posting that
 * had already happened. So there has to be a way to raise it again, and it
 * has to be an action someone takes deliberately rather than something that
 * quietly re-runs.
 *
 * Idempotent by construction: it settles what has no settlement standing
 * against it, so a second call after a successful one finds nothing and
 * posts nothing. Prices from the invoice's own lines, which is what the
 * customer was actually charged — the same figure the first settlement used.
 */
export async function resettleConsignmentSale(input: {
  companyId: string;
  /** The sales invoice whose delivery drew consigned stock. */
  salesInvoiceId: string;
  docDate?: string;
}) {
  return sql.begin(async (tx) => {
    const [inv] = await tx`
      select id, doc_no, doc_type, status, source_document_id, location_id,
             to_char(doc_date, 'YYYY-MM-DD') as doc_date
        from document
       where id = ${input.salesInvoiceId} and company_id = ${input.companyId}`;
    if (!inv) throw new Error("That sales invoice does not exist");
    if (inv.doc_type !== "SALES_INVOICE") throw new Error("That document is not a sales invoice");
    if (inv.status !== "POSTED") {
      throw new Error("That invoice is not posted, so there is nothing to settle against it");
    }
    if (!inv.source_document_id) {
      throw new Error("That invoice has no delivery behind it, so it moved no consigned stock");
    }

    const outstanding = await tx`
      select 1 from v_consignment_unsettled
       where delivery_document_id = ${inv.source_document_id} limit 1`;
    if (outstanding.length === 0) {
      throw new Error(
        "Everything this sale took from consignment is already settled by a "
        + "settlement that still stands."
      );
    }

    const lines = await tx`
      select item_id, unit_price from document_line
       where document_id = ${inv.id} and item_id is not null`;

    const before = await tx`
      select id from document
       where company_id = ${input.companyId} and doc_type = 'PURCHASE_INVOICE'`;

    await settleConsignmentSales(
      tx, input.companyId, input.docDate ?? String(inv.doc_date), inv.id, inv.doc_no,
      inv.source_document_id,
      (lines as unknown as { item_id: string; unit_price: string }[])
        .map((l) => ({ itemId: l.item_id, unitPrice: Number(l.unit_price) })),
      inv.location_id
    );

    const seen = new Set((before as unknown as { id: string }[]).map((r) => r.id));
    const raised = await tx`
      select id, doc_no, gross_total from document
       where company_id = ${input.companyId} and doc_type = 'PURCHASE_INVOICE'
         and status = 'POSTED'`;
    return (raised as unknown as { id: string; doc_no: string; gross_total: string }[])
      .filter((r) => !seen.has(r.id))
      .map((r) => ({ id: r.id, docNo: r.doc_no, amount: Number(r.gross_total) }));
  });
}
