import type { TransactionSql } from "postgres";
import { sql } from "./db";

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
  unitPrice: number;
  focReasonId?: string | null;

  /** Purchase side: which goods-receipt line this bills. Optional — when it
   *  is absent the receipt's lines for that item are matched oldest first —
   *  but naming it is what keeps two receipt lines of the same item at
   *  different costs from being settled at the wrong one. */
  sourceLineId?: string | null;
};

export type InvoiceInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  docDate: string;
  dueDate: string | null;
  memo?: string | null;
  reference?: string | null;
  lines: InvoiceLine[];
};

export type SalesInvoiceInput = InvoiceInput & {
  salesmanId?: string | null;
  paymentType?: "CASH" | "CREDIT";

  /** Goods leave later. When true, this invoice posts revenue only — no
   *  delivery is created, and stock doesn't move until one is. */
  toDeliver?: boolean;

  /** Taken at the counter. Creates a receipt document allocated to this invoice. */
  cashIn?: number;
  cashAccountId?: string | null;
};

/** An order commits nothing — no stock movement, no ledger entry. */
export type OrderLine = { itemId: string; qty: number; unitPrice?: number };
export type OrderInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
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
};
export type FulfillmentInput = {
  companyId: string;
  partnerId: string;
  locationId: string;
  docDate: string;
  memo?: string | null;
  reference?: string | null;
  sourceDocumentId?: string | null;
  /** When goods actually arrived, if more precise than docDate — receipts only, ignored for deliveries. */
  receivedAt?: string | null;
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

  if (opts.partnerId && src.partner_id && src.partner_id !== opts.partnerId) {
    throw new Error(
      `${src.doc_no} belongs to a different partner, so this document cannot continue it`
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
type FifoPlan = { totalCost: number; unitCost: number; draws: FifoDraw[] };

/**
 * Reads the open lots oldest-first and decides what this issue draws from
 * each, without writing anything yet — the stock_movement row this belongs
 * to doesn't exist until after this returns, and consumption rows need its
 * id. Locks the lots first, in a separate ungrouped statement, so two issues
 * can't both plan
 * against the same remaining quantity.
 */
async function planFifoConsumption(
  tx: TransactionSql, companyId: string, itemId: string, locationId: string, qty: number
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

  const lots = await tx`
    select sl.id, sl.unit_cost,
           sl.qty_received - coalesce(sum(c.qty), 0) as remaining
      from stock_lot sl
      left join stock_lot_consumption c on c.lot_id = sl.id
     where sl.company_id = ${companyId} and sl.item_id = ${itemId} and sl.location_id = ${locationId}
     group by sl.id, sl.unit_cost, sl.qty_received, sl.received_date, sl.created_at
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

  if (need > 0.0001) {
    throw new Error("Not enough stock in any lot at this location to cover the quantity requested");
  }

  totalCost = round4(totalCost);
  return { totalCost, unitCost: qty > 0 ? round4(totalCost / qty) : 0, draws };
}

/** Writes the consumption rows a plan decided on, against the movement it belongs to. */
async function recordFifoConsumption(
  tx: TransactionSql, companyId: string, stockMovementId: string, plan: FifoPlan
) {
  for (const d of plan.draws) {
    await tx`
      insert into stock_lot_consumption (company_id, lot_id, stock_movement_id, qty, unit_cost)
      values (${companyId}, ${d.lotId}, ${stockMovementId}, ${d.qty}, ${d.unitCost})`;
  }
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
async function resolveSaleCost(
  tx: TransactionSql, companyId: string, sourceDocumentId: string, itemId: string
): Promise<number | null> {
  const [src] = await tx`
    select doc_type, source_document_id from document
     where id = ${sourceDocumentId} and company_id = ${companyId}`;
  if (!src) return null;

  let deliveryId: string | null = null;
  if (src.doc_type === "DELIVERY") {
    deliveryId = sourceDocumentId;
  } else if (src.doc_type === "SALES_INVOICE" && src.source_document_id) {
    const [linked] = await tx`
      select doc_type from document where id = ${src.source_document_id} and company_id = ${companyId}`;
    if (linked?.doc_type === "DELIVERY") deliveryId = src.source_document_id;
  }
  if (!deliveryId) return null;

  const [agg] = await tx`
    select coalesce(sum(c.qty), 0) as qty, coalesce(sum(c.qty * c.unit_cost), 0) as cost
      from stock_movement sm
      join stock_lot_consumption c on c.stock_movement_id = sm.id
     where sm.company_id = ${companyId} and sm.document_id = ${deliveryId} and sm.item_id = ${itemId}`;

  const qty = Number(agg.qty);
  return qty > 0 ? round4(Number(agg.cost) / qty) : null;
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

async function writeJournal(
  tx: TransactionSql,
  companyId: string,
  entryDate: string,
  sourceType: string,
  sourceId: string,
  memo: string,
  lines: JournalLine[]
): Promise<string> {
  const consolidated = consolidate(lines);

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
    select fn_next_document_no(${companyId}, 'JOURNAL', ${fiscalYear}::uuid) as no`;

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
  if (input.lines.length === 0) throw new Error("An order needs at least one line");
  assertLines(input.lines);

  return sql.begin(async (tx) => {
    const { companyId, partnerId, locationId, docDate, dueDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`select fn_next_document_no(${companyId}, ${docType}, ${fiscalYear}::uuid) as no`;
    const docNo = noRows[0].no;

    const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
         partner_id, location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, posted_at, reference)
      values
        (${companyId}, ${docType}, ${docNo}, ${fiscalYear}, ${docDate}::date,
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
    return { id: doc.id as string, docNo: docNo as string };
  });
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

  const noRows = await tx`select fn_next_document_no(${companyId}, 'DELIVERY', ${fiscalYear}::uuid) as no`;
  const docNo = noRows[0].no;

  // A delivery continues either the order that asked for the goods or the
  // invoice that billed for them — never a purchase document, and never
  // another customer's.
  if (input.sourceDocumentId) {
    await requireSource(tx, {
      id: input.sourceDocumentId,
      companyId,
      partnerId,
      expect: ["SALES_ORDER", "SALES_INVOICE"],
      role: "document this delivery fulfils",
    });
    await assertSourceLines(tx, input.sourceDocumentId, input.lines);
  }

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, reference, source_document_id)
    values
      (${companyId}, 'DELIVERY', ${docNo}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       0, 0, 0, ${input.memo ?? null}, now(), ${input.reference ?? null}, ${input.sourceDocumentId ?? null})
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

    const onHandRows = await tx`
      select fn_qty_on_hand(${companyId}, ${line.itemId}, ${locationId}) as on_hand`;
    const onHand = Number(onHandRows[0].on_hand);

    if (onHand < line.qty) {
      throw new Error(
        `Not enough ${item.code} (${item.name}) at this location — ` +
          `${onHand} on hand, ${line.qty} requested`
      );
    }

    // FIFO: drawn from the oldest open lots at this location, frozen onto
    // the movement. Recomputing it later would silently restate closed
    // periods.
    const plan = await planFifoConsumption(tx, companyId, line.itemId, locationId, line.qty);
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
    await recordFifoConsumption(tx, companyId, movement.id, plan);

    const inventory = await tx`
      select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
    journal.push({ accountId: inventory[0].a, amount: -totalCost, locationId });

    if (line.focReasonId) {
      const [foc] = await tx`select account_id from foc_reason where id = ${line.focReasonId}`;
      journal.push({ accountId: foc.account_id, amount: totalCost, locationId });
    } else {
      const cogs = await tx`
        select fn_resolve_account_for_item(${companyId}, 'COGS', ${line.itemId}) as a`;
      journal.push({ accountId: cogs[0].a, amount: totalCost, locationId });
    }
  }

  deliveredValue = round4(deliveredValue);
  const entryId = await writeJournal(tx, companyId, docDate, "DELIVERY", doc.id, `${docNo} delivery`, journal);
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

  const cashIn = round4(input.cashIn ?? 0);
  if (cashIn > 0 && !input.cashAccountId) {
    throw new Error("Choose which cash or bank account the money went into");
  }

  const { companyId, partnerId, locationId, docDate, dueDate } = input;

  const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
  const fiscalYear = fyRows[0]?.fy ?? null;
  if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

  const noRows = await tx`
    select fn_next_document_no(${companyId}, 'SALES_INVOICE', ${fiscalYear}::uuid) as no`;
  const docNo = noRows[0].no;

  const netTotal = round4(
    input.lines.reduce((s, l) => s + (l.focReasonId ? 0 : l.qty * l.unitPrice), 0)
  );

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
  }

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at,
       payment_type, salesman_id, reference, to_deliver, source_document_id)
    values
      (${companyId}, 'SALES_INVOICE', ${docNo}, ${fiscalYear}, ${docDate}::date,
       ${docDate}::date, ${dueDate}, ${partnerId}, ${locationId}, 'MMK', 1, 'POSTED',
       ${netTotal}, 0, ${netTotal}, ${input.memo ?? null}, now(),
       ${input.paymentType ?? "CREDIT"}, ${input.salesmanId ?? null},
       ${input.reference ?? null}, ${input.toDeliver ?? false}, ${input.deliveryId ?? null})
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

    // Revenue only — stock and COGS belong to the delivery, not the invoice.
    if (net !== 0) {
      const revenue = await tx`
        select fn_resolve_account_for_item(${companyId}, 'REVENUE', ${line.itemId}) as a`;
      journal.push({ accountId: revenue[0].a, amount: -net });
    }
  }

  if (netTotal !== 0) {
    const ar = await tx`
      select fn_resolve_control_account(${companyId}, 'AR_CONTROL', ${partnerId}) as a`;
    journal.push({ accountId: ar[0].a, amount: netTotal, partnerId });
  }

  const entryId = await writeJournal(
    tx, companyId, docDate, "SALES_INVOICE", doc.id, `${docNo} sales invoice`, journal
  );

  await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

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
      select fn_next_document_no(${companyId}, 'CUSTOMER_RECEIPT', ${fiscalYear}::uuid) as no`;
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
      ]
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
        lines: toDeliver.map((l) => ({ itemId: l.itemId, qty: l.qty, focReasonId: l.focReasonId })),
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
    select fn_next_document_no(${companyId}, 'GOODS_RECEIPT', ${fiscalYear}::uuid) as no`;
  const docNo = noRows[0].no;

  const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * (l.unitCost ?? 0), 0));

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

  for (const line of input.lines) {
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
    await createFifoLot(tx, companyId, line.itemId, locationId, receivedAt, unitCost, line.qty, movement.id);

    const inventory = await tx`
      select fn_resolve_account_for_item(${companyId}, 'INVENTORY', ${line.itemId}) as a`;
    journal.push({ accountId: inventory[0].a, amount: net, locationId });
  }

  // Matched to an invoice that already arrived: the GR/IR line clears
  // against what that invoice already posted, not this receipt's own value
  // — the mirror image of how a purchase invoice matches an existing
  // receipt. Any difference is the same Purchase Price Variance account
  // either direction uses; the variance is a property of the pair, not of
  // whichever document happens to post second.
  let grirAmount = netTotal;
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
      // Matched line by line against the invoice, not against its total.
      // Taking the whole invoice meant half a shipment released all of it:
      // 50 of 100 units arriving cleared the entire 100,000, booked the
      // other 50,000 as price variance, and reported nothing still awaited.
      // The second half then cleared it again, leaving GR/IR at -100,000 —
      // a debit balance where a settled liability should be zero — and
      // 100,000 of invented expense in the P&L.
      const invoiceLines = await tx`
        select dl.id, dl.item_id, dl.base_qty as qty, dl.net_amount as net
          from document_line dl
         where dl.document_id = ${input.sourceDocumentId}
         order by dl.line_no`;

      const priorReceipts = await tx`
        select dl.item_id, dl.base_qty as qty, dl.source_line_id
          from document_line dl
          join document d on d.id = dl.document_id
         where d.company_id = ${companyId}
           and d.doc_type = 'GOODS_RECEIPT'
           and d.status = 'POSTED'
           and d.source_document_id = ${input.sourceDocumentId}
           and d.id <> ${doc.id}
         order by d.posting_date, d.doc_no, dl.line_no`;

      const draw = grirMatcher(invoiceLines as unknown as MatchableLine[]);

      // Earlier shipments against this same invoice first, so this one sees
      // only what is still outstanding.
      for (const prior of priorReceipts) {
        draw(prior.item_id, Number(prior.qty), prior.source_line_id);
      }

      // A receipt line's sourceLineId names an order line when the receipt
      // came from a purchase order, so it is only offered as a preference
      // here — grirMatcher ignores an id that is not one of these lines and
      // falls back to oldest first.
      let matched = 0;
      for (const line of input.lines) {
        matched += draw(line.itemId, line.qty, line.sourceLineId).value;
      }
      grirAmount = round4(matched);

      // Whatever this receipt is worth beyond what the invoice was holding
      // for it: a price difference, or goods the invoice never covered.
      const variance = round4(netTotal - grirAmount);
      if (variance !== 0) {
        const pv = await tx`select fn_system_account(${companyId}, 'PURCHASE_PRICE_VARIANCE') as a`;
        journal.push({ accountId: pv[0].a, amount: -variance, locationId });
      }
    }
  }

  const grir = await tx`select fn_system_account(${companyId}, 'GRIR_CLEARING') as a`;
  journal.push({ accountId: grir[0].a, amount: -grirAmount, partnerId });

  const entryId = await writeJournal(
    tx, companyId, docDate, "GOODS_RECEIPT", doc.id, `${docNo} goods receipt`, journal
  );
  await tx`update document set journal_entry_id = ${entryId} where id = ${doc.id}`;

  return { id: doc.id as string, docNo: docNo as string };
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

  const noRows = await tx`
    select fn_next_document_no(${companyId}, 'PURCHASE_INVOICE', ${fiscalYear}::uuid) as no`;
  const docNo = noRows[0].no;

  const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));

  const [doc] = await tx`
    insert into document
      (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
       partner_id, location_id, currency, exchange_rate, status,
       net_total, tax_total, gross_total, memo, posted_at, source_document_id)
    values
      (${companyId}, 'PURCHASE_INVOICE', ${docNo}, ${fiscalYear}, ${docDate}::date,
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

    const net = round4(line.qty * line.unitPrice);

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
      for (const line of input.lines) {
        if (!isStocked.get(line.itemId)) continue;
        relieved += draw(line.itemId, line.qty, line.sourceLineId).value;
      }
      grirAmount = round4(relieved);

      // Whatever the invoice charges beyond the cost of the goods it settles:
      // a price difference on the matched quantity, or a quantity the receipt
      // never covered.
      const variance = round4(stockedNet - grirAmount);
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
    tx, companyId, docDate, "PURCHASE_INVOICE", doc.id, `${docNo} purchase invoice`, journal
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
      select fn_next_document_no(${companyId}, 'SUPPLIER_PAYMENT', ${fiscalYear}::uuid) as no`;
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
      ]
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
export async function postStockAdjustment(input: AdjustmentInput) {
  const lines = input.lines.filter((l) => l.qty !== 0);
  if (lines.length === 0) throw new Error("An adjustment needs at least one line");
  // Signed: a stock loss is a negative quantity by design.
  assertLines(lines, { signedQty: true });

  return sql.begin(async (tx) => {
    const { companyId, locationId, docDate } = input;
    const receivedAt = input.receivedAt || docDate;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, 'STOCK_ADJUSTMENT', ${fiscalYear}::uuid) as no`;
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
        await recordFifoConsumption(tx, companyId, movement.id, plan);
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
      tx, companyId, docDate, "STOCK_ADJUSTMENT", doc.id, `${docNo} stock adjustment`, journal
    );

    const absValue = Math.abs(netValue);
    await tx`
      update document set journal_entry_id = ${entryId}, net_total = ${absValue}, gross_total = ${absValue}
       where id = ${doc.id}`;

    return { id: doc.id as string, docNo: docNo as string };
  });
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
      select fn_next_document_no(${companyId}, 'STOCK_TRANSFER', ${fiscalYear}::uuid) as no`;
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
      if (onHand < line.qty) {
        throw new Error(
          `Not enough ${item.code} (${item.name}) at the source location — ` +
            `${onHand} on hand, ${line.qty} requested`
        );
      }

      const plan = await planFifoConsumption(tx, companyId, line.itemId, fromLocationId, line.qty);
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
      if (fromAcct.a !== toAcct.a) {
        journal.push({ accountId: toAcct.a, amount: totalCost, locationId: toLocationId });
        journal.push({ accountId: fromAcct.a, amount: -totalCost, locationId: fromLocationId });
      }
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
      select fn_next_document_no(${companyId}, 'SALES_RETURN', ${fiscalYear}::uuid) as no`;
    const docNo = noRows[0].no;

    const netTotal = round4(
      input.lines.reduce((s, l) => s + (l.focReasonId ? 0 : l.qty * l.unitPrice), 0)
    );

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
        // Returned stock comes back in as a fresh lot. If the return names
        // the sale it came from, cost it at what those units actually sold
        // for; otherwise fall back to what stock here is worth right now.
        const unitCost =
          (input.sourceDocumentId
            ? await resolveSaleCost(tx, companyId, input.sourceDocumentId, line.itemId)
            : null) ?? (await estimateCurrentCost(tx, companyId, line.itemId, locationId));
        const totalCost = round4(unitCost * line.qty);

        const [movement] = await tx`
          insert into stock_movement
            (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
          values
            (${companyId}, ${line.itemId}, ${locationId}, ${docDate}::date,
             ${line.qty}, ${unitCost}, ${totalCost}, ${doc.id})
          returning id`;
        await createFifoLot(tx, companyId, line.itemId, locationId, receivedAt, unitCost, line.qty, movement.id);

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
      tx, companyId, docDate, "SALES_RETURN", doc.id, `${docNo} sales return`, journal
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
      select fn_next_document_no(${companyId}, 'PURCHASE_RETURN', ${fiscalYear}::uuid) as no`;
    const docNo = noRows[0].no;

    const netTotal = round4(input.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));

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
      tx, companyId, docDate, "PURCHASE_RETURN", doc.id, `${docNo} purchase return`, journal
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
  if (lines.length === 0) throw new Error("Enter an amount against at least one invoice");
  if (!input.cashAccountId) throw new Error("Choose which cash or bank account to use");

  const total = round4(lines.reduce((s, a) => s + a.amount, 0));
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

    // Check each invoice still owes what is being applied. Two people paying
    // the same bill at once would otherwise both succeed.
    for (const a of lines) {
      const [inv] = await tx`
        select d.doc_no, d.doc_type, d.status, d.partner_id, d.gross_total,
               coalesce((select sum(amount) from payment_allocation
                          where invoice_id = d.id), 0) as allocated
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
    }

    const noRows = await tx`
      select fn_next_document_no(${companyId}, ${kind}, ${fiscalYear}::uuid) as no`;
    const docNo = noRows[0].no;

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         partner_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, reference, payment_type, posted_at)
      values
        (${companyId}, ${kind}, ${docNo}, ${fiscalYear}, ${docDate}::date, ${docDate}::date,
         ${partnerId}, 'MMK', 1, 'POSTED',
         ${total}, 0, ${total}, ${input.memo ?? null}, ${input.reference ?? null},
         'CASH', now())
      returning id`;

    for (const a of lines) {
      await tx`
        insert into payment_allocation
          (company_id, payment_id, invoice_id, amount, base_amount)
        values (${companyId}, ${doc.id}, ${a.invoiceId}, ${a.amount}, ${a.amount})`;
    }

    const control = await tx`
      select fn_resolve_control_account(${companyId}, ${controlRole}, ${partnerId}) as a`;

    const journal: JournalLine[] = isPayment
      ? [
          { accountId: control[0].a, amount: total, partnerId },
          { accountId: input.cashAccountId, amount: -total },
        ]
      : [
          { accountId: input.cashAccountId, amount: total },
          { accountId: control[0].a, amount: -total, partnerId },
        ];

    const entryId = await writeJournal(
      tx, companyId, docDate, kind, doc.id,
      `${docNo} settling ${lines.length} invoice${lines.length === 1 ? "" : "s"}`,
      journal
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

async function postVoucher(
  input: VoucherInput,
  docType: "CASH_VOUCHER" | "BANK_VOUCHER" | "JOURNAL_VOUCHER" | "CASH_TRANSFER" | "OPENING_BALANCE"
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

  return sql.begin(async (tx) => {
    const { companyId, docDate } = input;

    const fyRows = await tx`select fn_fiscal_year_for(${companyId}, ${docDate}::date) as fy`;
    const fiscalYear = fyRows[0]?.fy ?? null;
    if (!fiscalYear) throw new Error(`No fiscal year covers ${docDate}`);

    const noRows = await tx`
      select fn_next_document_no(${companyId}, ${docType}, ${fiscalYear}::uuid) as no`;
    const docNo = noRows[0].no;

    // The document total is the debit side, which is what people expect a
    // voucher to be "for" — a 50,000 payment reads as 50,000, not 100,000.
    const total = round4(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));

    const [doc] = await tx`
      insert into document
        (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
         location_id, currency, exchange_rate, status,
         net_total, tax_total, gross_total, memo, reference, posted_at)
      values
        (${companyId}, ${docType}, ${docNo}, ${fiscalYear}, ${docDate}::date, ${docDate}::date,
         ${input.locationId ?? null}, 'MMK', 1, 'POSTED',
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
  });
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
      lines: net === 0 ? lines : [...lines, { accountId: equity.a, amount: -net }],
    },
    "OPENING_BALANCE"
  );
}
