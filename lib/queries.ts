import { sql } from "./db";
import { grirMatcher, type MatchableLine } from "./posting";

export type Company = { id: string; code: string; name: string; name_my: string | null; base_currency: string };

export async function getCompany(): Promise<Company | null> {
  const rows = await sql<Company[]>`
    select id, code, name, name_my, base_currency from company order by created_at limit 1`;
  return rows[0] ?? null;
}

export async function getKpis(companyId: string) {
  const [stock] = await sql`
    select coalesce(sum(value_on_hand), 0) as value, coalesce(sum(qty_on_hand), 0) as qty
      from v_stock_on_hand where company_id = ${companyId}`;

  const [ar] = await sql`
    select coalesce(sum(outstanding), 0) as total, count(*)::int as n
      from v_open_item where company_id = ${companyId} and doc_type = 'SALES_INVOICE'`;

  const [ap] = await sql`
    select coalesce(sum(outstanding), 0) as total, count(*)::int as n
      from v_open_item where company_id = ${companyId} and doc_type = 'PURCHASE_INVOICE'`;

  const [cash] = await sql`
    select coalesce(sum(jl.base_amount), 0) as total
      from journal_line jl
      join account a on a.id = jl.account_id
     where jl.company_id = ${companyId} and a.code in ('1110', '1120')`;

  /**
   * Money that has changed hands with no invoice against it yet — customers'
   * deposits and what we have paid suppliers up front. Worth its own figure
   * because it is neither receivable nor payable and would otherwise be
   * invisible: cash that is in the bank but already spoken for, and cash that
   * has left but bought nothing yet.
   */
  const [advances] = await sql`
    select
      coalesce(sum(available) filter (where doc_type = 'CUSTOMER_RECEIPT'), 0) as customer,
      coalesce(sum(available) filter (where doc_type = 'SUPPLIER_PAYMENT'), 0) as supplier,
      count(*) filter (where doc_type = 'CUSTOMER_RECEIPT')::int as customer_n,
      count(*) filter (where doc_type = 'SUPPLIER_PAYMENT')::int as supplier_n
      from v_partner_advance where company_id = ${companyId}`;

  return { stock, ar, ap, cash, advances };
}

/**
 * Counts of open commitments, for the dashboard's "action required" summary
 * — how many orders/receipts are still waiting on something, not the line-
 * level detail getOpenSalesOrders/getOpenPurchaseOrders/getPendingDeliveries
 * return for the fulfilment forms themselves.
 */
/**
 * "Open" and "overdue" are different questions. An order with no items
 * delivered yet is completely normal mid-workflow — the customer or
 * supplier may just not want it until later. It only becomes something to
 * act on once its own "Needed by" date has actually passed, still with
 * something outstanding. Same split for GR/IR: sitting open a few days is
 * how the pattern is supposed to work, not a problem — GRIR_AGE_DAYS is
 * where the dashboard draws the line into "this has been open too long."
 */
const GRIR_AGE_DAYS = 7;

export async function getActionItems(companyId: string) {
  /**
   * What each order still expects, from v_order_outstanding — the one
   * reckoning every screen now shares. It counts goods that name the order,
   * goods linked to it afterwards, and nothing at all once the order is
   * closed as no longer expected. This file used to carry its own copy of
   * that sum, which is how the dashboard and the order lists came to
   * disagree about the same order.
   */
  const orderStats = (docType: "SALES_ORDER" | "PURCHASE_ORDER") => sql`
    with per_order as (
      select order_id, due_date,
             sum(fulfilled) as done,
             sum(outstanding) as remaining
        from v_order_outstanding
       where company_id = ${companyId} and doc_type = ${docType}
       group by order_id, due_date
    )
    select
      count(*)::int as open,
      count(*) filter (where done < 0.0001)::int as not_started,
      count(*) filter (where done >= 0.0001)::int as partial,
      count(*) filter (where due_date is not null and due_date < current_date)::int as overdue
      from per_order
     where remaining > 0.0001`;

  const [so] = await orderStats("SALES_ORDER");
  const [po] = await orderStats("PURCHASE_ORDER");


  // Counted the same way the delivery screen counts, or the dashboard says
  // nothing is waiting while that page lists an invoice with 900 units still
  // to ship. "Any delivery exists" was never the question; "anything left to
  // deliver" is.
  const pd = { n: (await getPendingDeliveryLines(companyId)).length };

  // Same both-directions check as getOpenDeliveries — a delivery already
  // linked to an invoice either way (composed atomically, or fulfilling a
  // "deliver later" invoice afterward) isn't waiting on anything.
  const [openDeliv] = await sql`
    select count(*)::int as n
      from document d
     where d.company_id = ${companyId} and d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       and not exists (
         select 1 from document si
          where si.doc_type = 'SALES_INVOICE' and si.status = 'POSTED'
            and (si.source_document_id = d.id or d.source_document_id = si.id)
       )`;

  /**
   * Money somebody could actually pay.
   *
   * An invoice for 1,601,071.471 settled with 1,601,071 leaves 0.471 kyat
   * outstanding, and the kyat has no subunit — nobody can pay it, ever. It
   * stays in the ledger because it really is in the receivables control
   * account and the reconciliation check ties the two together; what it must
   * not do is stand at the top of the dashboard asking for action. It was
   * doing exactly that, as "1 customer invoice overdue" with an amount that
   * rendered as "0", which reads as a bug in the figure rather than a
   * half-kyat nobody will ever collect.
   *
   * Half the currency's smallest unit is the line, taken from the currency
   * rather than assumed: 0.5 for the kyat, 0.005 for the dollar.
   */
  const overdueFor = (docType: "SALES_INVOICE" | "PURCHASE_INVOICE") => sql`
    select coalesce(sum(oi.outstanding), 0) as total, count(*)::int as n
      from v_open_item oi
      join currency c on c.code = oi.currency
     where oi.company_id = ${companyId}
       and oi.doc_type = ${docType}
       and oi.aging_bucket <> 'CURRENT'
       and abs(oi.outstanding) >= 0.5 / power(10, c.decimal_places)`;

  const [custOverdue] = await overdueFor("SALES_INVOICE");
  const [supOverdue] = await overdueFor("PURCHASE_INVOICE");

  const grirRows = await sql`
    select d.doc_type,
           count(*)::int as open,
           coalesce(sum(g.balance), 0) as open_total,
           count(*) filter (where g.days_open > ${GRIR_AGE_DAYS})::int as aged,
           coalesce(sum(g.balance) filter (where g.days_open > ${GRIR_AGE_DAYS}), 0) as aged_total,
           coalesce(max(g.days_open), 0)::int as oldest_days
      from v_grir_balance g
      join document d on d.id = g.document_id
     where g.company_id = ${companyId}
     group by d.doc_type`;
  const grirRow = (t: string) => {
    const r = grirRows.find((x: any) => x.doc_type === t);
    return {
      open: Number(r?.open ?? 0), openTotal: Math.abs(Number(r?.open_total ?? 0)),
      aged: Number(r?.aged ?? 0), agedTotal: Math.abs(Number(r?.aged_total ?? 0)),
      oldestDays: Number(r?.oldest_days ?? 0),
    };
  };

  return {
    // open counts every order with something still to come; notStarted and
    // partial split that same set the way the order lists label it, so the
    // dashboard and the list can never appear to disagree.
    salesOrders: {
      open: Number(so.open), overdue: Number(so.overdue),
      notStarted: Number(so.not_started), partial: Number(so.partial),
    },
    purchaseOrders: {
      open: Number(po.open), overdue: Number(po.overdue),
      notStarted: Number(po.not_started), partial: Number(po.partial),
    },
    pendingDeliveryInvoices: pd.n as number,
    openDeliveries: openDeliv.n as number,
    customerInvoicesOverdue: { n: Number(custOverdue.n), total: Number(custOverdue.total) },
    supplierBillsOverdue: { n: Number(supOverdue.n), total: Number(supOverdue.total) },
    goodsReceipts: grirRow("GOODS_RECEIPT"),
    purchaseInvoicesAwaitingGoods: grirRow("PURCHASE_INVOICE"),
  };
}

/**
 * Where a brand-new company is in its setup, for the dashboard's getting
 * started checklist. Categories, items and a partner are hard prerequisites
 * — nothing can post without them. Opening balances and opening stock are
 * not required to trade, but skipping them is what makes a mid-year takeover
 * come out wrong, so they are shown as steps rather than left to be
 * discovered later.
 *
 * Deliberately no "opening receivables" step: AR/AP are control accounts and
 * the ledger guard refuses a lump-sum balance on them. Carried-over invoices
 * have to be entered as real invoices, one per partner, which is what keeps
 * aging and payment matching meaningful.
 */
export async function getOnboardingStatus(companyId: string) {
  const [r] = await sql`
    select
      (select count(*)::int from item_group where company_id = ${companyId}) as categories,
      (select count(*)::int from item where company_id = ${companyId}) as items,
      (select count(*)::int from business_partner
        where company_id = ${companyId} and is_customer) as customers,
      (select count(*)::int from business_partner
        where company_id = ${companyId} and is_supplier) as suppliers,
      (select count(*)::int from document
        where company_id = ${companyId} and doc_type = 'OPENING_BALANCE') as openings,
      (select count(*)::int from v_stock_on_hand where company_id = ${companyId}) as stock_rows,
      (select count(*)::int from document
        where company_id = ${companyId} and doc_type <> 'OPENING_BALANCE') as documents`;

  return {
    categories: Number(r.categories),
    items: Number(r.items),
    customers: Number(r.customers),
    suppliers: Number(r.suppliers),
    openings: Number(r.openings),
    stockRows: Number(r.stock_rows),
    documents: Number(r.documents),
  };
}

// The invariants, run live. Every one of these should come back clean.
export async function getHealth(companyId: string) {
  const unbalanced = await sql`
    select * from v_check_unbalanced_entries where company_id = ${companyId}`;
  const inventory = await sql`
    select * from v_check_inventory_reconciliation where company_id = ${companyId}`;
  const [tb] = await sql`
    select coalesce(sum(balance), 0) as total from v_trial_balance where company_id = ${companyId}`;

  return {
    unbalanced: unbalanced.length,
    inventoryBreaks: inventory.length,
    trialBalance: Number(tb?.total ?? 0),
  };
}

export async function getAging(companyId: string) {
  return sql`
    select aging_bucket,
           count(*)::int          as invoices,
           sum(outstanding)       as total
      from v_open_item
     where company_id = ${companyId} and doc_type = 'SALES_INVOICE'
     group by aging_bucket
     order by case aging_bucket
       when 'CURRENT' then 0 when '1-30' then 1 when '31-60' then 2
       when '61-90' then 3 else 4 end`;
}

/**
 * Every invoice of one type, posted or not, for a management list screen —
 * distinct from getOpenItems, which only returns what is still owed.
 * Posted rows come from v_invoice_status (paid, outstanding, payment_status,
 * days_overdue all precomputed there); draft/cancelled/reversed rows carry
 * zero paid/outstanding, since neither ever had a ledger effect, but their
 * gross_total is still shown for reference. Nothing in the app leaves an
 * invoice in those states today, so this half of the union returns nothing
 * in practice -- it is here so the list stays correct if that changes.
 */
export async function getInvoiceList(companyId: string, docType: "SALES_INVOICE" | "PURCHASE_INVOICE") {
  return sql`
    select document_id, doc_no, posting_date, due_date,
           partner_id, partner_code, partner_name,
           gross_total, paid, outstanding, 'POSTED' as doc_status,
           payment_status, days_overdue
      from v_invoice_status
     where company_id = ${companyId} and doc_type = ${docType}

     union all

     select d.id as document_id, d.doc_no, d.posting_date, d.due_date,
            d.partner_id, p.code as partner_code, p.name as partner_name,
            d.gross_total, 0::numeric as paid, 0::numeric as outstanding,
            d.status as doc_status, null as payment_status, null::int as days_overdue
       from document d
       join business_partner p on p.id = d.partner_id
      where d.company_id = ${companyId} and d.doc_type = ${docType} and d.status <> 'POSTED'

     order by posting_date desc, doc_no desc`;
}

/** What each customer/supplier owes or is owed, for a per-partner rollup. */
export async function getPartnerBalances(companyId: string, docType: "SALES_INVOICE" | "PURCHASE_INVOICE") {
  return sql`
    select b.partner_id, b.partner_code, b.partner_name,
           b.open_invoices, b.invoiced, b.paid, b.outstanding, b.overdue,
           b.due_soon, b.credit_limit,
           -- Whether what is left is enough for anyone to pay. A balance
           -- below the currency's smallest unit is a rounding remnant, not a
           -- debt, and listing it under "Overdue" beside a figure that prints
           -- as 0 tells the reader their screen is broken.
           (abs(b.overdue) >= 0.5 / power(10, c.decimal_places)) as overdue_material,
           (abs(b.outstanding) >= 0.5 / power(10, c.decimal_places)) as outstanding_material
      from v_partner_balance b
      join company co on co.id = b.company_id
      join currency c on c.code = co.base_currency
     where b.company_id = ${companyId} and b.doc_type = ${docType}
     order by b.outstanding desc`;
}

export async function getOpenItems(companyId: string, docType: string) {
  return sql`
    select document_id, doc_no, partner_name, posting_date, due_date,
           gross_total, allocated, outstanding, aging_bucket, days_overdue
      from v_open_item
     where company_id = ${companyId} and doc_type = ${docType}
     order by due_date nulls last`;
}

export async function getDocuments(companyId: string, docType?: string, openGrirOnly?: boolean) {
  return sql`
    select d.id, d.doc_type, d.doc_no, d.doc_date, d.posting_date, d.due_date,
           d.status, d.gross_total, d.currency, d.posted_at,
           p.name  as partner_name,
           l.code  as location_code,
           src.doc_no as source_doc_no,
           je.entry_no
      from document d
      left join business_partner p  on p.id = d.partner_id
      left join location         l  on l.id = d.location_id
      left join document        src on src.id = d.source_document_id
      left join journal_entry   je  on je.id = d.journal_entry_id
     where d.company_id = ${companyId}
       ${docType ? sql`and d.doc_type = ${docType}` : sql``}
       ${openGrirOnly ? sql`and exists (select 1 from v_grir_balance g where g.document_id = d.id)` : sql``}
     order by d.posting_date desc, d.doc_no desc`;
}

/**
 * Sales invoices and deliveries a customer return can be posted against, so
 * the return can be costed at what those units actually sold for instead of
 * an estimate. Only what a return could plausibly reference — posted,
 * customer-facing, stock-moving document types.
 */
export async function getReturnableSales(companyId: string) {
  return sql`
    select d.id, d.doc_type, d.doc_no, d.doc_date, d.partner_id
      from document d
     where d.company_id = ${companyId}
       and d.doc_type in ('SALES_INVOICE', 'DELIVERY')
       and d.status = 'POSTED'
     order by d.doc_date desc, d.doc_no desc
     limit 500`;
}

/**
 * Goods receipts a purchase invoice can match against — only the ones
 * still sitting unresolved in GR/IR clearing (v_grir_balance), each with
 * its own lines so the invoice form can pre-fill and compare quantities.
 */
/**
 * Whether this specific document still has an outstanding GR/IR clearing
 * balance — the only documents "create the matching invoice/receipt" should
 * ever offer. Documents predating this clearing-account pattern (an old
 * purchase invoice that posted straight to Inventory instead of GR/IR
 * Clearing, say) never touch v_grir_balance at all and must not be offered
 * a match: there's nothing to clear, and matching one to a fresh receipt
 * would double the stock it already recorded.
 */
export async function isGrirOutstanding(documentId: string): Promise<boolean> {
  const [row] = await sql`select 1 from v_grir_balance where document_id = ${documentId}`;
  return !!row;
}

/**
 * How much of its source each answering document actually took.
 *
 * One invoice can be answered by several shipments and they share it: 50 then
 * 80 against a bill for 100 is 100 answered and 30 left over, not 130 twice.
 * So the source is drawn down once, in the order the answers were posted, and
 * each answer is told only what was still there for it.
 *
 * Every answer is replayed, not only the ones a caller happens to be showing.
 * A list capped at the newest 200 documents would otherwise credit a later
 * shipment with quantity an earlier one had already taken.
 */
async function sharedSourceLines(
  companyId: string,
  answeringType: "GOODS_RECEIPT" | "DELIVERY",
  sourceIds: readonly (string | null)[]
): Promise<Map<string, { itemId: string; qty: number }[]>> {
  const out = new Map<string, { itemId: string; qty: number }[]>();
  const ids = [...new Set(sourceIds.filter(Boolean) as string[])];
  if (ids.length === 0) return out;

  const srcLines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net
      from document_line dl
     where dl.document_id = any(${ids})
     order by dl.line_no`;

  const answers = await sql`
    select d.id, d.source_document_id as src_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId}
       and d.doc_type = ${answeringType} and d.status = 'POSTED'
       and d.source_document_id = any(${ids})
     order by d.posting_date, d.doc_no, dl.line_no`;

  for (const srcId of ids) {
    const draw = grirMatcher(
      srcLines.filter((l: any) => l.document_id === srcId) as unknown as MatchableLine[]);
    for (const a of answers.filter((x: any) => x.src_id === srcId)) {
      const got = draw(a.item_id, Number(a.qty), a.source_line_id)
        .taken.reduce((t: number, x: any) => t + x.qty, 0);
      if (got > 0) {
        const list = out.get(a.id) ?? [];
        list.push({ itemId: a.item_id, qty: got });
        out.set(a.id, list);
      }
    }
  }
  return out;
}

/** One side of a suspected double: goods waiting on a bill, or a bill waiting on goods. */
export type GrirCollisionLine = {
  partner_id: string;
  side: "GOODS" | "BILL";
  document_id: string;
  doc_no: string;
  doc_date: string;
  item_id: string;
  item_name: string;
  uom_code: string;
  qty: number;
};

/**
 * Goods waiting on a bill and a bill waiting on goods, for the same items
 * from the same supplier — which is usually one purchase entered twice.
 *
 * A purchase invoice can only name a goods receipt, never an order. So a bill
 * that arrives before the goods is an orphan: nothing connects it to the
 * order it pays for, the order still reads as owed the goods, and each door
 * then produces a receipt of its own. Two receipts, twice the stock, two
 * payables, and every document individually correct.
 *
 * The receive form already warns while an order is still owed goods. This is
 * the state *after* that warning goes quiet — the order has just been
 * satisfied, so nothing is outstanding on it, and what is left is a receipt
 * holding a credit in GR/IR and a bill holding a debit for the same goods.
 * The ledger cannot net them: GR/IR is matched by the link documents record
 * about each other, and these two never named each other.
 *
 * Read from the clearing account, not from names or dates: a receipt awaiting
 * a bill credits GR/IR, a bill awaiting goods debits it, and a pair that did
 * find each other nets to zero and drops out of v_grir_balance by itself.
 * Restricted to items appearing on both sides, because a supplier who is
 * genuinely owed a bill for one thing while billing ahead for another is
 * doing nothing wrong and must not be told they are.
 */
export async function getGrirCollisions(companyId: string) {
  const rows = await sql`
    with open_grir as (
        select g.partner_id, g.document_id, d.doc_type, d.doc_no, d.doc_date
          from v_grir_balance g
          join document d on d.id = g.document_id
         where g.company_id = ${companyId}
           and d.doc_type in ('GOODS_RECEIPT', 'PURCHASE_INVOICE')
           and g.partner_id is not null
    ),
    named as (
        select o.partner_id, o.document_id, o.doc_type, o.doc_no,
               to_char(o.doc_date, 'YYYY-MM-DD') as doc_date,
               dl.item_id, i.name as item_name, u.code as uom_code,
               sum(dl.base_qty) as qty
          from open_grir o
          join document_line dl on dl.document_id = o.document_id
          join item i on i.id = dl.item_id
          join uom u on u.id = i.base_uom_id
         group by o.partner_id, o.document_id, o.doc_type, o.doc_no, o.doc_date,
                  dl.item_id, i.name, u.code
    ),
    -- Only where the same item is on both sides. One of each is the whole
    -- signal; a bill for paint and goods for cement are two purchases.
    both_sides as (
        select partner_id, item_id
          from named
         group by partner_id, item_id
        having count(distinct doc_type) = 2
    )
    select n.partner_id,
           case when n.doc_type = 'GOODS_RECEIPT' then 'GOODS' else 'BILL' end as side,
           n.document_id, n.doc_no, n.doc_date,
           n.item_id, n.item_name, n.uom_code, n.qty::float as qty
      from named n
      join both_sides b on b.partner_id = n.partner_id and b.item_id = n.item_id
     order by n.partner_id, side, n.doc_date, n.doc_no`;

  return rows as unknown as GrirCollisionLine[];
}

/**
 * Goods receipts that still have something to bill, with each line's
 * remaining quantity rather than its original one.
 *
 * Offering the full received quantity was wrong the moment any of it had
 * been invoiced: prefilling an invoice from a receipt already half billed
 * would bill the same goods twice. Remaining is replayed through the same
 * matcher the ledger settles with, so what the form offers and what GR/IR
 * still holds are the same figure.
 */
export async function getOpenGoodsReceipts(companyId: string, limit: number | null = 200) {
  const docs = await sql`
    select d.id, d.doc_no, d.doc_date, d.partner_id,
           -- Where the goods went. An invoice raised from this receipt bills
           -- for stock in that warehouse, so the form should not make somebody
           -- pick it again from a list they cannot get wrong.
           d.location_id,
           -- The purchase order this receipt came in against, so an invoice
           -- billing it can show which of our orders it belongs to.
           src.doc_no as source_no,
           case when src.doc_type = 'PURCHASE_INVOICE' then src.id end as billed_by_id
      from document d
      left join v_grir_balance g on g.document_id = d.id and g.company_id = d.company_id
      left join document src on src.id = d.source_document_id
     where d.company_id = ${companyId} and d.doc_type = 'GOODS_RECEIPT' and d.status = 'POSTED'
       -- Either the receipt anchors its own clearing balance, or it was
       -- matched to an invoice and cleared through that invoice's anchor.
       -- Receipts from before GR/IR clearing existed have neither, and must
       -- not be offered a match: there is nothing of theirs to clear.
       and (g.document_id is not null or src.doc_type = 'PURCHASE_INVOICE')
     order by d.doc_date desc, d.doc_no desc
     ${limit === null ? sql`` : sql`limit ${limit}`}`;
  if (docs.length === 0) return [];

  const ids = docs.map((d: any) => d.id);

  const lines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           dl.unit_price, i.code as item_code, i.name as item_name,
           -- What the order said this would cost, where the receipt came in
           -- against one. Carried so the bill can be checked against the
           -- agreement, not only against the quantity that arrived: a
           -- supplier billing 1,300 for goods ordered at 1,000 is the case
           -- the three-way match exists to catch, and it is invisible if the
           -- form only ever shows the receipt's own figure.
           ol.unit_price as order_price,
           ord.id as order_id, ord.doc_no as order_no
      from document_line dl
      join item i on i.id = dl.item_id
      left join document_line ol on ol.id = dl.source_line_id
      left join document ord on ord.id = ol.document_id
                            and ord.doc_type = 'PURCHASE_ORDER'
     where dl.document_id = any(${ids})
     order by dl.line_no`;

  const invoiced = await sql`
    select d.source_document_id as receipt_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId}
       and d.doc_type = 'PURCHASE_INVOICE'
       and d.status = 'POSTED'
       and d.source_document_id = any(${ids})
     order by d.posting_date, d.doc_no, dl.line_no`;

  // The other direction: a receipt matched to a bill that came first is
  // billed by that bill, for whatever it covers. What it covers is not
  // necessarily everything on the receipt — a mixed receipt brings in items
  // the invoice never mentioned, and those are still waiting to be billed.
  const share = await sharedSourceLines(
    companyId, "GOODS_RECEIPT", docs.map((d: any) => d.billed_by_id));

  return docs
    .map((d: any) => {
      const own = lines.filter((l: any) => l.document_id === d.id);
      const draw = grirMatcher(own as unknown as MatchableLine[]);
      const billed = new Map<string, number>();

      for (const inv of invoiced.filter((i: any) => i.receipt_id === d.id)) {
        for (const t of draw(inv.item_id, Number(inv.qty), inv.source_line_id).taken) {
          billed.set(t.lineId, (billed.get(t.lineId) ?? 0) + t.qty);
        }
      }
      for (const bl of share.get(d.id) ?? []) {
        for (const t of draw(bl.itemId, bl.qty, null).taken) {
          billed.set(t.lineId, (billed.get(t.lineId) ?? 0) + t.qty);
        }
      }

      const open = own
        .map((l: any) => ({
          lineId: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          qty: Math.round((Number(l.qty) - (billed.get(l.id) ?? 0)) * 10000) / 10000,
          unitPrice: Number(l.unit_price),
          orderPrice: l.order_price === null ? null : Number(l.order_price),
          orderId: (l.order_id as string) ?? null,
          orderNo: (l.order_no as string) ?? null,
        }))
        .filter((l) => l.qty > 0);

      return { ...d, lines: open };
    })
    // A receipt whose every line is billed has nothing left to offer, even if
    // GR/IR still carries a rounding or price difference against it.
    .filter((d: any) => d.lines.length > 0);
}

/**
 * Purchase invoices a goods receipt can match against — the mirror of
 * getOpenGoodsReceipts, for when the bill arrived before the goods did.
 *
 * With each line's remaining quantity, not its original one. Offering the
 * whole invoice was wrong the moment any of it had arrived: a bill for 1,000
 * units with 100 already received went on offering 1,000, and the receipt
 * form fills its lines from what is offered — so the obvious next action was
 * to receive the same 1,000 again. The other direction was given remaining
 * quantities when the same mistake was found there; this is the same fix on
 * the side that did not get it.
 */
export async function getOpenPurchaseInvoices(companyId: string, limit: number | null = 200) {
  const docs = await sql`
    select d.id, d.doc_no, d.doc_date, d.partner_id, d.location_id
      from document d
      join v_grir_balance g on g.document_id = d.id and g.company_id = d.company_id
     where d.company_id = ${companyId} and d.doc_type = 'PURCHASE_INVOICE' and d.status = 'POSTED'
     order by d.doc_date desc, d.doc_no desc
     ${limit === null ? sql`` : sql`limit ${limit}`}`;
  if (docs.length === 0) return [];

  const ids = docs.map((d: any) => d.id);

  const lines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           dl.unit_price, i.code as item_code, i.name as item_name
      from document_line dl
      join item i on i.id = dl.item_id
     where dl.document_id = any(${ids})
     order by dl.line_no`;

  // Everything already received against these invoices, oldest first, so the
  // same matcher the ledger settles with decides which line each shipment
  // came off — not an assumption that quantities line up in order.
  const received = await sql`
    select d.source_document_id as invoice_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId}
       and d.doc_type = 'GOODS_RECEIPT'
       and d.status = 'POSTED'
       and d.source_document_id = any(${ids})
     order by d.posting_date, d.doc_no, dl.line_no`;

  return docs
    .map((d: any) => {
      const own = lines.filter((l: any) => l.document_id === d.id);
      const draw = grirMatcher(own as unknown as MatchableLine[]);
      const arrived = new Map<string, number>();

      for (const r of received.filter((x: any) => x.invoice_id === d.id)) {
        for (const t of draw(r.item_id, Number(r.qty), r.source_line_id).taken) {
          arrived.set(t.lineId, (arrived.get(t.lineId) ?? 0) + t.qty);
        }
      }

      const open = own
        .map((l: any) => ({
          lineId: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          qty: Math.round((Number(l.qty) - (arrived.get(l.id) ?? 0)) * 10000) / 10000,
          unitPrice: Number(l.unit_price),
        }))
        .filter((l) => l.qty > 0);

      return { ...d, lines: open };
    })
    // Fully received, even if GR/IR still carries a difference against it.
    .filter((d: any) => d.lines.length > 0);
}

/**
 * Deliveries no sales invoice has been written against yet — the sales-side
 * mirror of getOpenGoodsReceipts, for when stock left before the bill did.
 * Unlike a goods receipt, a delivery carries no price (it moves stock at
 * cost, not at what the customer is charged), so lines here have no
 * unitPrice — the invoice looks that up the normal way, from item_price.
 *
 * The link runs in whichever direction each path actually wrote it: a
 * delivery composed atomically with its invoice (postSaleWithDelivery) has
 * the invoice's source_document_id point at the delivery, but one fulfilling
 * a "deliver later" invoice (deliverPendingInvoice) has the delivery's own
 * source_document_id point at the invoice instead — checking only one
 * direction would wrongly offer to re-invoice an already-billed delivery.
 */
export async function getOpenDeliveries(companyId: string, limit: number | null = 200) {
  const docs = limit === null
    ? await sql`
      select d.id, d.doc_no, d.doc_date, d.partner_id, d.location_id,
             src.doc_no as source_no,
             case when src.doc_type = 'SALES_INVOICE' then src.id end as billed_by_id
        from document d
        left join document src on src.id = d.source_document_id
       where d.company_id = ${companyId} and d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       order by d.doc_date desc, d.doc_no desc`
    : await sql`
      select d.id, d.doc_no, d.doc_date, d.partner_id, d.location_id,
             -- The order this delivery was raised from, so an invoice made
             -- from it can show which of our orders it belongs to rather
             -- than making someone go and look it up.
             src.doc_no as source_no,
             case when src.doc_type = 'SALES_INVOICE' then src.id end as billed_by_id
        from document d
        left join document src on src.id = d.source_document_id
       where d.company_id = ${companyId} and d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       order by d.doc_date desc, d.doc_no desc
       limit ${limit}`;
  if (docs.length === 0) return [];

  const ids = docs.map((d: any) => d.id);

  const lines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           i.code as item_code, i.name as item_name,
           -- What the sales order agreed for these goods, where the delivery
           -- came out of one. A delivery moves stock at cost and carries no
           -- selling price of its own, so without this the invoice falls back
           -- to the price list — and an order agreed at 1,200 bills at
           -- whatever the list happens to say today. What was agreed is what
           -- is billed.
           ol.unit_price as order_price,
           ord.id as order_id, ord.doc_no as order_no
      from document_line dl
      join item i on i.id = dl.item_id
      left join document_line ol on ol.id = dl.source_line_id
      left join document ord on ord.id = ol.document_id
                            and ord.doc_type = 'SALES_ORDER'
     where dl.document_id = any(${ids})
     order by dl.line_no`;

  // Invoices raised from a delivery, and invoices a delivery was raised for:
  // both directions bill it, and checking only one would offer to invoice
  // goods already billed.
  const billed = await sql`
    select d.source_document_id as delivery_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId}
       and d.doc_type = 'SALES_INVOICE' and d.status = 'POSTED'
       and d.source_document_id = any(${ids})
     order by d.posting_date, d.doc_no, dl.line_no`;

  const share = await sharedSourceLines(
    companyId, "DELIVERY", docs.map((d: any) => d.billed_by_id));

  return docs
    .map((d: any) => {
      const own = lines.filter((l: any) => l.document_id === d.id);
      const draw = grirMatcher(own as unknown as MatchableLine[]);
      const gone = new Map<string, number>();

      for (const b of billed.filter((x: any) => x.delivery_id === d.id)) {
        for (const t of draw(b.item_id, Number(b.qty), b.source_line_id).taken) {
          gone.set(t.lineId, (gone.get(t.lineId) ?? 0) + t.qty);
        }
      }
      for (const b of share.get(d.id) ?? []) {
        for (const t of draw(b.itemId, b.qty, null).taken) {
          gone.set(t.lineId, (gone.get(t.lineId) ?? 0) + t.qty);
        }
      }

      const open = own
        .map((l: any) => ({
          lineId: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          qty: Math.round((Number(l.qty) - (gone.get(l.id) ?? 0)) * 10000) / 10000,
          orderPrice: l.order_price === null ? null : Number(l.order_price),
          orderId: (l.order_id as string) ?? null,
          orderNo: (l.order_no as string) ?? null,
        }))
        .filter((l) => l.qty > 0);

      return { ...d, lines: open };
    })
    // Fully billed — including a delivery raised to fulfil an invoice that
    // covered everything on it.
    .filter((d: any) => d.lines.length > 0);
}

export async function getDocument(id: string) {
  const [doc] = await sql`
    select d.*, p.name as partner_name, p.code as partner_code,
           -- Where to send it. The printed document is the one place these
           -- are read, so they travel with the document rather than needing
           -- a second query from the print view.
           p.address as partner_address, p.township as partner_township,
           p.phone as partner_phone,
           l.code as location_code, l.name as location_name,
           src.doc_no as source_doc_no, src.id as source_id,
           je.entry_no,
           sm.name as salesman_name, sm.code as salesman_code
      from document d
      left join business_partner p  on p.id = d.partner_id
      left join location         l  on l.id = d.location_id
      left join document        src on src.id = d.source_document_id
      left join journal_entry   je  on je.id = d.journal_entry_id
      left join salesman        sm  on sm.id = d.salesman_id
     where d.id = ${id}`;
  return doc ?? null;
}

export async function getDocumentLines(id: string) {
  return sql`
    select dl.*, i.code as item_code, i.name as item_name,
           u.code as uom_code, f.name as foc_reason
      from document_line dl
      left join item i on i.id = dl.item_id
      left join uom  u on u.id = dl.entered_uom_id
      left join foc_reason f on f.id = dl.foc_reason_id
     where dl.document_id = ${id}
     order by dl.line_no`;
}

export async function getJournalForDocument(journalEntryId: string | null) {
  if (!journalEntryId) return [];
  return sql`
    select line_no, account_code, account_name, account_type,
           debit, credit, currency, memo
      from v_journal_line
     where journal_entry_id = ${journalEntryId}
     order by line_no`;
}

export async function getDownstream(documentId: string) {
  return sql`
    select id, doc_type, doc_no, posting_date, status, gross_total
      from document
     where source_document_id in (${versionsOf(documentId)})
     order by posting_date`;
}

/** What's still unpaid on an invoice — 0 for anything that isn't one. */
export async function getDocumentOutstanding(documentId: string): Promise<number> {
  const [row] = await sql`select outstanding from v_open_item where document_id = ${documentId}`;
  return row ? Number(row.outstanding) : 0;
}

/**
 * Every version of the document this id belongs to, as a subquery.
 *
 * A correction keeps the number and posts the next version, so "raised
 * against this order" has to mean "raised against any version of it" — a
 * receipt that named v1 still answers the order after it becomes v2, and the
 * link it recorded is deliberately never rewritten.
 *
 * Written as a family of ids rather than as `fn_current_document(...) =
 * fn_current_document(...)`, which says the same thing and cannot use an
 * index: wrapping the column in a function makes every such lookup a
 * sequential scan of `document`. This form reads (company, doc_no) through
 * the unique index and then `source_document_id` through its own.
 */
function versionsOf(documentId: string) {
  return sql`
    select v.id from document v
      join document self on self.id = ${documentId}
     where v.company_id = self.company_id and v.doc_no = self.doc_no`;
}

/**
 * Every document in this one's own chain — the real documents behind a
 * diagram like PO → GR → PI → Payment, so the detail page can link each
 * stage to whatever actually exists instead of just labelling the stage
 * names. Two separate walks, not one connected-component search: upward
 * via source_document_id is always a single deterministic path (a document
 * has at most one source), but a shared ancestor can have more than one
 * child — a purchase order with two receipts, say. Expanding outward from
 * that ancestor would surface a *sibling's* invoice as if it belonged to
 * the receipt actually being viewed. Walking down only from the document
 * itself, never through an ancestor found along the way, rules that out.
 */
export async function getChainDocuments(documentId: string) {
  type Row = { id: string; doc_type: string; doc_no: string; source_document_id: string | null };
  const seen = new Map<string, Row>();

  const [self] = (await sql`
    select id, doc_type, doc_no, source_document_id from document where id = ${documentId}`) as Row[];
  if (!self) return [];
  seen.set(self.id, self);

  let cursor = self.source_document_id;
  for (let hop = 0; hop < 3 && cursor; hop++) {
    const [row] = (await sql`
      select id, doc_type, doc_no, source_document_id
        from document where id = fn_current_document(${cursor})`) as Row[];
    if (!row || seen.has(row.id)) break;
    seen.set(row.id, row);
    cursor = row.source_document_id;
  }

  let frontier = [self.id];
  for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
    const rows = (await sql`
      select id, doc_type, doc_no, source_document_id
        from document
       where source_document_id in (
               select v.id from document v
                 join document self on self.company_id = v.company_id
                                   and self.doc_no = v.doc_no
                where self.id = any(${frontier}::uuid[]))`) as Row[];
    const next: string[] = [];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.set(r.id, r);
        next.push(r.id);
      }
    }
    frontier = next;
  }

  return [...seen.values()];
}

export type RelatedDoc = {
  id: string;
  docType: string;
  docNo: string;
  docDate: string;
  status: string;
  amount: number;
  /** Units on that document. A delivery against an order is read as "6
   *  units" long before anyone reads its value, so the quantity is the more
   *  useful figure on a link between two stock documents. */
  qty: number;
  /** How it is related, in the words the screen shows. */
  note?: string | null;
};
export type RelatedDocuments = {
  /** What this document came from. */
  source: { label: string; docs: RelatedDoc[] }[];
  /** What was raised from it, or settled against it. */
  downstream: { label: string; docs: RelatedDoc[] }[];
};

const REL_LABEL: Record<string, string> = {
  SALES_ORDER: "Sales order",
  DELIVERY: "Delivery",
  SALES_INVOICE: "Sales invoice",
  CUSTOMER_RECEIPT: "Receive payment",
  SALES_RETURN: "Customer return",
  PURCHASE_ORDER: "Purchase order",
  GOODS_RECEIPT: "Goods receipt",
  PURCHASE_INVOICE: "Purchase invoice",
  SUPPLIER_PAYMENT: "Supplier payment",
  PURCHASE_RETURN: "Purchase return",
};

/**
 * What this document is actually linked to, in both directions.
 *
 * Distinct from the workflow pipeline above it, which draws the shape a sale
 * or a purchase usually takes. This states only what exists: a heading with
 * nothing under it says "None", because a document raised without an order is
 * an ordinary thing here and must not read as an incomplete one. A missing
 * link is not an error unless some particular operation needs it.
 *
 * Two kinds of link, deliberately kept apart. `source_document_id` is the
 * document this was raised from; `payment_allocation` is money settled
 * against an invoice, which is not a parent-child relationship at all — a
 * payment is not "made from" an invoice, it is applied to one, and several
 * payments can be applied to the same bill.
 */
export async function getRelatedDocuments(documentId: string): Promise<RelatedDocuments> {
  const [doc] = await sql`
    select id, company_id, doc_type, source_document_id, to_deliver
      from document where id = ${documentId}`;
  if (!doc) return { source: [], downstream: [] };

  const shape = (rows: readonly unknown[]): RelatedDoc[] =>
    ([...rows] as {
      id: string; doc_type: string; doc_no: string; doc_date: string;
      status: string; gross_total: string; qty?: string; note?: string;
    }[]).map((r) => ({
      id: r.id, docType: r.doc_type, docNo: r.doc_no, docDate: String(r.doc_date),
      status: r.status, amount: Number(r.gross_total), qty: Number(r.qty ?? 0),
      note: r.note ?? null,
    }));


  // Resolved to the version that stands, both ways. The stored link still
  // names the version it was raised against — that record is never rewritten
  // — but a panel headed "what this is linked to" that offers a cancelled
  // document reads as a broken link rather than as history. History is
  // reached from the version trail on the document itself.
  const parent = doc.source_document_id
    ? shape(await sql`
        -- The document this was raised from, and the one that was raised
        -- from — an invoice billing a delivery that answered an order is
        -- linked to that order, one hop further up. Saying "Sales order:
        -- None" beside a chain strip naming the order was the panel
        -- contradicting the rest of the page about the same fact.
        with lineage as (
          select fn_current_document(${doc.source_document_id}) as id
          union
          select fn_current_document(p.source_document_id)
            from document p
           where p.id = fn_current_document(${doc.source_document_id})
             and p.source_document_id is not null
        )
        select d.id, d.doc_type, d.doc_no, to_char(d.doc_date,'YYYY-MM-DD') as doc_date,
               d.status, d.gross_total,
               coalesce((select sum(dl.base_qty) from document_line dl
                          where dl.document_id = d.id), 0) as qty
          from lineage l join document d on d.id = l.id
         order by d.posting_date, d.doc_no`)
    : [];

  const children = shape(await sql`
    select d.id, d.doc_type, d.doc_no, to_char(d.doc_date,'YYYY-MM-DD') as doc_date,
           d.status, d.gross_total,
           coalesce((select sum(dl.base_qty) from document_line dl
                      where dl.document_id = d.id), 0) as qty
      from document d
     where d.company_id = ${doc.company_id}
       and d.source_document_id in (${versionsOf(documentId)})
     order by d.doc_date, d.doc_no`);

  // Money applied to this invoice, or the invoices this payment was applied
  // to — whichever way round this document sits.
  const isInvoice = doc.doc_type === "SALES_INVOICE" || doc.doc_type === "PURCHASE_INVOICE";
  const settlements = shape(
    isInvoice
      ? await sql`
          select d.id, d.doc_type, d.doc_no, to_char(d.doc_date,'YYYY-MM-DD') as doc_date,
                 d.status, pa.amount as gross_total
            from payment_allocation pa
            join document d on d.id = pa.payment_id
           where pa.invoice_id = ${documentId} and d.status = 'POSTED'
           order by d.doc_date, d.doc_no`
      : await sql`
          select d.id, d.doc_type, d.doc_no, to_char(d.doc_date,'YYYY-MM-DD') as doc_date,
                 d.status, pa.amount as gross_total
            from payment_allocation pa
            join document d on d.id = pa.invoice_id
           where pa.payment_id = ${documentId} and d.status = 'POSTED'
           order by d.doc_date, d.doc_no`
  );

  // Headings are listed even when empty, so the answer to "was there an
  // order?" is visible rather than absent. Which headings belong depends on
  // the document: an invoice can come from an order or a delivery, a payment
  // comes from neither.
  const group = (label: string, docs: RelatedDoc[]) => ({ label, docs });
  const byType = (docs: RelatedDoc[], type: string) => docs.filter((d) => d.docType === type);

  const sales = ["SALES_ORDER", "DELIVERY", "SALES_INVOICE", "CUSTOMER_RECEIPT", "SALES_RETURN"]
    .includes(doc.doc_type);

  const source: RelatedDocuments["source"] = [];
  const downstream: RelatedDocuments["downstream"] = [];

  if (doc.doc_type === "SALES_INVOICE" || doc.doc_type === "PURCHASE_INVOICE") {
    const orderType = sales ? "SALES_ORDER" : "PURCHASE_ORDER";
    const moveType = sales ? "DELIVERY" : "GOODS_RECEIPT";
    source.push(group(REL_LABEL[orderType], byType(parent, orderType)));
    source.push(group(REL_LABEL[moveType], byType(parent, moveType)));
    downstream.push(group(sales ? "Payments" : "Payments made", settlements));
    downstream.push(group(REL_LABEL[sales ? "SALES_RETURN" : "PURCHASE_RETURN"],
      byType(children, sales ? "SALES_RETURN" : "PURCHASE_RETURN")));
    // Only where goods are still owed. An invoice that already names its
    // delivery as a source has nothing pending, and a "Delivery — None" under
    // Downstream would read as something missing rather than something that
    // already happened further up the panel.
    // `to_deliver` says how the invoice was raised, not whether the goods
    // have since gone: a deliver-later invoice that has since been delivered
    // still carries the flag, so the source link has to be checked too or the
    // heading contradicts the one printed above it.
    if (byType(children, moveType).length > 0
        || (doc.to_deliver && byType(parent, moveType).length === 0)) {
      downstream.push(group(REL_LABEL[moveType], byType(children, moveType)));
    }
  } else if (doc.doc_type === "DELIVERY" || doc.doc_type === "GOODS_RECEIPT") {
    const orderType = sales ? "SALES_ORDER" : "PURCHASE_ORDER";
    const invType = sales ? "SALES_INVOICE" : "PURCHASE_INVOICE";
    source.push(group(REL_LABEL[orderType], byType(parent, orderType)));
    source.push(group(REL_LABEL[invType], byType(parent, invType)));
    downstream.push(group(REL_LABEL[invType], byType(children, invType)));
    downstream.push(group(REL_LABEL[sales ? "SALES_RETURN" : "PURCHASE_RETURN"],
      byType(children, sales ? "SALES_RETURN" : "PURCHASE_RETURN")));
  } else if (doc.doc_type === "SALES_ORDER" || doc.doc_type === "PURCHASE_ORDER") {
    const moveType = sales ? "DELIVERY" : "GOODS_RECEIPT";
    const invType = sales ? "SALES_INVOICE" : "PURCHASE_INVOICE";
    downstream.push(group(REL_LABEL[moveType], byType(children, moveType)));
    downstream.push(group(REL_LABEL[invType], byType(children, invType)));
  } else if (doc.doc_type === "CUSTOMER_RECEIPT" || doc.doc_type === "SUPPLIER_PAYMENT") {
    // A payment is applied to invoices; it is not raised from one. Shown as
    // "applied to" rather than as a parent, because calling an invoice the
    // payment's source would be the wrong relationship.
    source.push(group("Applied to", settlements));
  } else {
    if (parent.length) source.push(group("Raised from", parent));
    if (children.length) downstream.push(group("Raised from this", children));
  }

  return { source, downstream };
}

/**
 * The payment that settled this invoice, if any — payments allocate against
 * invoices via payment_allocation, not source_document_id, so they sit
 * outside the chain getChainDocuments walks and need their own lookup.
 */
export async function getSettlingPayment(invoiceId: string) {
  const [row] = await sql`
    select d.id, d.doc_type, d.doc_no
      from payment_allocation pa
      join document d on d.id = pa.payment_id
     where pa.invoice_id = ${invoiceId}
       -- A voided payment no longer settles anything, so it must not be
       -- offered as the one that did.
       and d.status = 'POSTED'
     order by d.posting_date desc
     limit 1`;
  return row ?? null;
}

export async function getStock(companyId: string) {
  return sql`
    select item_code, item_name, location_code,
           qty_on_hand, value_on_hand,
           case when qty_on_hand <> 0
                then value_on_hand / qty_on_hand else 0 end as unit_cost
      from v_stock_on_hand
     where company_id = ${companyId}
     order by item_code`;
}

/** Raw item×location on-hand and value, for pages that filter a company-wide view down to one warehouse. */
export async function getStockByLocation(companyId: string) {
  return sql`
    select item_id, location_id, qty_on_hand, value_on_hand
      from v_stock_on_hand
     where company_id = ${companyId}`;
}

export async function getPartners(companyId: string) {
  return sql`
    select bp.id, bp.code, bp.name, bp.name_my, bp.company_name,
           bp.is_customer, bp.is_supplier, bp.is_active,
           bp.township, bp.address, bp.phone,
           bp.payment_terms_days, bp.credit_limit,
           coalesce(oi.outstanding, 0) as outstanding
      from business_partner bp
      left join (
            select partner_id, sum(outstanding) as outstanding
              from v_open_item group by partner_id
      ) oi on oi.partner_id = bp.id
     where bp.company_id = ${companyId}
     order by bp.code`;
}

export async function getItems(companyId: string) {
  return sql`
    select i.id, i.code, i.name, i.name_my, i.item_group_id, i.brand_id,
           i.base_uom_id, i.is_stocked, i.is_active,
           g.name as group_name, g.parent_id as group_parent_id,
           pg.id as parent_group_id, pg.name as parent_group_name,
           b.name as brand_name,
           u.code as uom_code,
           coalesce(s.qty, 0) as qty_on_hand, coalesce(s.val, 0) as value_on_hand,
           sp.price as sale_price,
           lp.unit_price as last_purchase_price,
           lp.doc_no    as last_purchase_doc_no,
           to_char(lp.doc_date, 'YYYY-MM-DD') as last_purchase_date
      from item i
      join item_group g on g.id = i.item_group_id
      left join item_group pg on pg.id = g.parent_id
      left join brand b on b.id = i.brand_id
      join uom u on u.id = i.base_uom_id
      left join (
            select item_id, sum(qty_on_hand) as qty, sum(value_on_hand) as val
              from v_stock_on_hand group by item_id
      ) s on s.item_id = i.id

      -- The default selling price: the first price level by sort_order, which
      -- is the same "first level wins" rule the item form writes with, and its
      -- most recent price that has actually come into effect.
      --
      -- Laterally, and limited to one row. A plain join on item_price has no
      -- such limit: an item priced at both Retail and Wholesale would come
      -- back twice and appear twice in the catalogue, with whichever price the
      -- planner happened to reach first. Two price levels already exist, so
      -- that was waiting for the first item to be given a second price.
      left join lateral (
            select ip.price
              from item_price ip
              join price_level pl on pl.id = ip.price_level_id
             where ip.company_id = i.company_id
               and ip.item_id = i.id
               and ip.valid_from <= current_date
             order by pl.sort_order, ip.valid_from desc
             limit 1
      ) sp on true

      -- What was last paid for it, read from the supplier's invoice rather
      -- than the receipt: the invoice is what the supplier actually charged,
      -- and where the two differ it is the invoice that is the price. It is
      -- deliberately null for goods received but not yet billed — that gap is
      -- real, it is what GR/IR holds, and inventing a figure for it would hide
      -- exactly the thing worth noticing.
      --
      -- Never stored. A purchase price kept on the item master is a second
      -- source of truth that goes stale the next time the supplier changes it.
      left join lateral (
            select dl.unit_price, d.doc_no, d.doc_date
              from document_line dl
              join document d on d.id = dl.document_id
             where dl.item_id = i.id
               and d.company_id = i.company_id
               and d.doc_type = 'PURCHASE_INVOICE'
               and d.status = 'POSTED'
             order by d.doc_date desc, d.created_at desc, dl.line_no desc
             limit 1
      ) lp on true

     where i.company_id = ${companyId}
     order by i.code`;
}

// ------------------------------------------------------ chart of accounts --

/**
 * The whole chart, with everything the admin screen needs to know before it
 * lets someone change an account: whether the posting engine resolves it by
 * role, whether a determination rule points at it, whether anything has been
 * posted to it, and whether it has children. All four are reasons to refuse
 * a delete or a deactivation.
 */
export async function getChartOfAccounts(companyId: string) {
  return sql`
    select a.id, a.code, a.name, a.name_my, a.account_type, a.parent_id,
           a.is_postable, a.is_control, a.is_active, a.currency,
           a.is_cash_account, a.is_bank_account,
           coalesce(sa.roles, array[]::text[])  as system_roles,
           coalesce(ad.roles, array[]::text[])  as rule_roles,
           coalesce(jl.n, 0)::int               as posting_count,
           coalesce(kids.n, 0)::int             as child_count
      from account a
      left join (
        select account_id, array_agg(role order by role) as roles
          from system_account where company_id = ${companyId} group by account_id
      ) sa on sa.account_id = a.id
      left join (
        select account_id, array_agg(distinct role order by role) as roles
          from account_determination where company_id = ${companyId} group by account_id
      ) ad on ad.account_id = a.id
      left join (
        select account_id, count(*) as n
          from journal_line where company_id = ${companyId} group by account_id
      ) jl on jl.account_id = a.id
      left join (
        select parent_id, count(*) as n
          from account where company_id = ${companyId} and parent_id is not null
         group by parent_id
      ) kids on kids.parent_id = a.id
     where a.company_id = ${companyId}
     order by a.code`;
}

// --------------------------------------------------- orders & fulfilment --

/** Open sales order lines — ordered less delivered so far, only where that's still positive. */
/**
 * Every order of one type, at whatever stage of fulfilment, for a
 * management list -- distinct from getOpenSalesOrders/getOpenPurchaseOrders,
 * which return only the still-open lines a delivery/receipt worklist needs.
 * ordered_qty and fulfilled_qty are summed once per order here (rather than
 * left per line) so orderDisplayStatus can classify the whole document.
 */
export async function getOrderList(
  companyId: string,
  docType: "SALES_ORDER" | "PURCHASE_ORDER"
) {
  // One reckoning, shared with the dashboard and the fulfilment forms: goods
  // that name the order, goods linked to it afterwards, and nothing left
  // outstanding once it is closed as no longer expected.
  return sql`
    select o.id as document_id, o.doc_no, o.posting_date, o.due_date,
           o.partner_id, p.code as partner_code, p.name as partner_name,
           o.gross_total, o.status as doc_status,
           coalesce(x.ordered, 0)   as ordered_qty,
           coalesce(x.fulfilled, 0) as fulfilled_qty,
           coalesce(x.is_closed, false) as is_closed
      from document o
      join business_partner p on p.id = o.partner_id
      left join (
            select order_id,
                   sum(ordered) as ordered,
                   sum(fulfilled) as fulfilled,
                   bool_or(is_closed) as is_closed
              from v_order_outstanding
             where company_id = ${companyId} and doc_type = ${docType}
             group by order_id
      ) x on x.order_id = o.id
     where o.company_id = ${companyId} and o.doc_type = ${docType}
     order by o.posting_date desc, o.doc_no desc`;
}

export async function getOpenSalesOrders(companyId: string) {
  return sql`
    select o.id as order_id, o.doc_no as order_no, o.partner_id, p.name as partner_name,
           o.location_id,
           ol.id as line_id, ol.item_id, i.code as item_code, i.name as item_name,
           u.code as uom_code,
           ol.base_qty as ordered_qty,
           coalesce(d.delivered_qty, 0) as delivered_qty,
           ol.base_qty - coalesce(d.delivered_qty, 0) - coalesce(fl.linked_qty, 0) as remaining_qty
      from document o
      join document_line ol on ol.document_id = o.id
      join item i on i.id = ol.item_id
      join uom u on u.id = i.base_uom_id
      join business_partner p on p.id = o.partner_id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as delivered_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'DELIVERY' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) d on d.source_line_id = ol.id
      left join (
            select order_line_id, sum(qty) as linked_qty
              from fulfilment_link group by order_line_id
      ) fl on fl.order_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'SALES_ORDER' and o.status = 'POSTED'
       -- Goods linked to this order line after the fact count as arrived,
       -- and a closed order is expecting nothing at all.
       and (ol.base_qty - coalesce(d.delivered_qty, 0) - coalesce(fl.linked_qty, 0)) > 0
       and not exists (
             select 1 from v_order_outstanding v
              where v.order_id = o.id and v.is_closed
       )
     order by o.doc_no, ol.line_no`;
}

/** Open purchase order lines — ordered less received so far. */
export async function getOpenPurchaseOrders(companyId: string) {
  return sql`
    select o.id as order_id, o.doc_no as order_no, o.partner_id, p.name as partner_name,
           o.location_id,
           ol.id as line_id, ol.item_id, i.code as item_code, i.name as item_name,
           ol.unit_price as expected_price,
           ol.base_qty as ordered_qty,
           coalesce(r.received_qty, 0) as received_qty,
           ol.base_qty - coalesce(r.received_qty, 0) - coalesce(fl.linked_qty, 0) as remaining_qty
      from document o
      join document_line ol on ol.document_id = o.id
      join item i on i.id = ol.item_id
      join uom u on u.id = i.base_uom_id
      join business_partner p on p.id = o.partner_id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as received_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'GOODS_RECEIPT' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) r on r.source_line_id = ol.id
      left join (
            select order_line_id, sum(qty) as linked_qty
              from fulfilment_link group by order_line_id
      ) fl on fl.order_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'PURCHASE_ORDER' and o.status = 'POSTED'
       -- Goods linked to this order line after the fact count as arrived,
       -- and a closed order is expecting nothing at all.
       and (ol.base_qty - coalesce(r.received_qty, 0) - coalesce(fl.linked_qty, 0)) > 0
       and not exists (
             select 1 from v_order_outstanding v
              where v.order_id = o.id and v.is_closed
       )
     order by o.doc_no, ol.line_no`;
}

/** One order and one item on it, still awaited and untouched. */
export type AwaitingLine = {
  order_id: string;
  doc_no: string;
  partner_id: string;
  posting_date: string;
  due_date: string | null;
  item_id: string;
  item_code: string;
  item_name: string;
  uom_code: string;
  outstanding: number;
};

/**
 * Orders already out to this partner that nothing has happened to yet.
 *
 * The mistake this exists to prevent — ordering goods that are already
 * coming — is made at one moment, by someone who has no reason to suspect
 * it: the supplier is chosen on a blank order and the last one, placed nine
 * days ago by somebody else, is nowhere on the screen. So the answer has to
 * arrive unasked, at that moment, and it has to be specific: not "this
 * supplier has open orders" but "100 BOX of Item A is already coming".
 *
 * "Untouched" is deliberately strict. Goods still outstanding, not closed,
 * nothing received against any line of it, and no posted document naming the
 * order or anything raised from it. An order that is half received, or
 * already billed, is a different conversation — it has a receipt or an
 * invoice to answer to, and re-ordering the missing half may be exactly the
 * right thing to do. Listing those too would make a reminder that fires on
 * orders nobody can act on, which is how a reminder stops being read.
 *
 * Outstanding comes from v_order_outstanding, the same reckoning the
 * dashboard and the receive form use, so this cannot disagree with them
 * about what is still owed.
 */
async function ordersStillAwaited(
  companyId: string,
  docType: "SALES_ORDER" | "PURCHASE_ORDER",
  onlyUntouched: boolean
) {
  const rows = await sql`
    with touched as (
        -- Anything posted that names the order, resolved to the version
        -- standing now, then one hop further for whatever names that.
        -- Today only a receipt or a delivery names an order — an invoice
        -- names the receipt, never the order — so this is wider than the
        -- paths that exist. Deliberately: the list prints the sentence
        -- "nothing has been received, invoiced or paid against these", and
        -- that has to stay true the day something bills an order directly.
        select fn_current_document(c.source_document_id) as order_id
          from document c
         where c.company_id = ${companyId}
           and c.status = 'POSTED'
           and c.source_document_id is not null
        union
        select fn_current_document(s.source_document_id) as order_id
          from document c
          join document s on s.id = c.source_document_id
         where c.company_id = ${companyId}
           and c.status = 'POSTED'
           and s.source_document_id is not null
    )
    select v.order_id, o.doc_no, o.partner_id,
           to_char(o.posting_date, 'YYYY-MM-DD') as posting_date,
           to_char(o.due_date, 'YYYY-MM-DD') as due_date,
           v.item_id, i.code as item_code, i.name as item_name,
           u.code as uom_code,
           v.outstanding::float as outstanding
      from v_order_outstanding v
      join document o on o.id = v.order_id
      join item i on i.id = v.item_id
      join uom u on u.id = i.base_uom_id
     where v.company_id = ${companyId}
       and v.doc_type = ${docType}
       and v.outstanding > 0
       and not v.is_closed
       ${onlyUntouched
      ? sql`-- Nothing arrived against any line of it, named or linked after.
            and not exists (
                  select 1 from v_order_outstanding f
                   where f.order_id = v.order_id and f.fulfilled > 0)
            and v.order_id not in (
                  select order_id from touched where order_id is not null)`
      : sql``}
     order by o.due_date nulls last, o.posting_date, o.doc_no, i.name`;

  return rows as unknown as AwaitingLine[];
}

/**
 * For the form that would place another order: only orders nothing has
 * happened to. See above for why a part-received one is left out.
 */
export async function getUntouchedOpenOrders(
  companyId: string,
  docType: "SALES_ORDER" | "PURCHASE_ORDER"
) {
  return ordersStillAwaited(companyId, docType, true);
}

/**
 * For the form that would bill or ship without going through the order:
 * every order with goods still owed, part-received ones included.
 *
 * A different question, so a different set. Placing a second order for goods
 * already half arrived can be exactly right — the other half is late, and the
 * order it belongs to is the one to chase. But billing outside the order, or
 * shipping outside it, is how the same goods get recorded twice: the bill
 * raises its own receipt, the order is still owed the goods, and both then
 * look unfinished to the screen that reads them. That risk does not care
 * whether some of the goods have already landed.
 *
 * Fully received orders are out — outstanding > 0 — because the answer there
 * is to match the receipt waiting on a bill, which the form says already, and
 * two hints for one situation is how a reader learns to skip both.
 */
export async function getOpenOrdersAwaitingGoods(
  companyId: string,
  docType: "SALES_ORDER" | "PURCHASE_ORDER"
) {
  return ordersStillAwaited(companyId, docType, false);
}

/**
 * Goods receipts already posted, newest first.
 *
 * A receiving screen that only lists what is still owed shows nothing at all
 * on the ordinary day when every order has arrived — and nothing is also what
 * it shows when something has gone wrong, so the two are indistinguishable.
 * What has been received is the answer to both.
 *
 * Whether the supplier has billed for each one comes from the same GR/IR
 * balance the ledger settles against, not from a flag: goods received and not
 * yet invoiced are exactly a non-zero clearing balance anchored on the
 * receipt. A receipt raised against an invoice that came first anchors on
 * that invoice instead, and correctly reads as billed.
 */
export async function getGoodsReceiptHistory(companyId: string) {
  return sql`
    select d.id, d.doc_no, d.doc_date, d.status, d.gross_total,
           d.partner_id, p.name as partner_name,
           l.code as location_code,
           src.id as source_id, src.doc_no as source_no, src.doc_type as source_type,
           (select count(*)::int from document_line dl where dl.document_id = d.id) as line_count,
           coalesce(g.balance, 0) as grir_open
      from document d
      left join business_partner p on p.id = d.partner_id
      left join location l on l.id = d.location_id
      left join document src on src.id = d.source_document_id
      left join v_grir_balance g
             on g.document_id = d.id and g.company_id = d.company_id
     where d.company_id = ${companyId} and d.doc_type = 'GOODS_RECEIPT'
     order by d.doc_date desc, d.doc_no desc
     limit 300`;
}

/**
 * The two sides of GR/IR, separately.
 *
 * The account nets, and a net balance hides which way each part of it points.
 * A bill for 70,000 with 7,000 of it received, plus 40 of goods nobody billed
 * for, leaves 62,960 — a number that looks like an odd version of 63,000
 * until it is split:
 *
 *     invoiced, not yet received    63,000
 *     received, not yet invoiced        40
 *     net                           62,960
 *
 * Both are derived from the documents, never stored. Awaited is what invoice
 * lines still have quantity outstanding; unbilled is receipt lines answering
 * no invoice line — the ones a mixed receipt brought in alongside.
 */
export async function getGrirPositions(companyId: string) {
  // Read off the same two functions the forms offer from, so what a screen
  // says is outstanding and what a form lets you receive or bill cannot
  // disagree. Both are derived from documents; neither is stored.
  // Every open document, not the newest page of them. A form can show the
  // most recent 200 and still be useful; a total that quietly stops at 200
  // is a total that stops reconciling to the account it claims to explain.
  const [invoices, receipts] = await Promise.all([
    getOpenPurchaseInvoices(companyId, null) as unknown as Promise<
      { lines: { qty: number; unitPrice: number }[] }[]>,
    getOpenGoodsReceipts(companyId, null) as unknown as Promise<
      { lines: { qty: number; unitPrice: number }[] }[]>,
  ]);
  const total = (ds: { lines: { qty: number; unitPrice: number }[] }[]) =>
    ds.reduce((s, d) => s + d.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0), 0);

  return { awaited: total(invoices), unbilled: total(receipts) };
}

/**
 * What this receipt or delivery could still be said to have fulfilled, and
 * which order lines are waiting for it.
 *
 * Both halves in one place because they are one question: these goods, that
 * order. A line offers only what it has not already allocated — the same
 * units answering two orders would close both — and only orders from the same
 * partner, for the same item, that still expect something.
 */
export async function getLinkableOrders(companyId: string, documentId: string) {
  const [doc] = await sql`
    select id, doc_type, partner_id, status from document
     where id = ${documentId} and company_id = ${companyId}`;
  if (!doc || doc.status !== "POSTED") return { lines: [], openLines: [] };
  const orderType =
    doc.doc_type === "GOODS_RECEIPT" ? "PURCHASE_ORDER"
    : doc.doc_type === "DELIVERY" ? "SALES_ORDER"
    : null;
  if (!orderType) return { lines: [], openLines: [] };

  const lines = await sql`
    select dl.id as "lineId", dl.item_id as "itemId",
           i.code as "itemCode", i.name as "itemName",
           dl.base_qty::float as qty,
           coalesce((select sum(fl.qty) from fulfilment_link fl
                      where fl.fulfilment_line_id = dl.id), 0)::float as allocated
      from document_line dl
      join item i on i.id = dl.item_id
     where dl.document_id = ${documentId}
     order by dl.line_no`;

  const openLines = await sql`
    select o.id as "orderId", o.doc_no as "orderNo", ol.id as "orderLineId",
           ol.item_id as "itemId",
           (ol.base_qty
            - coalesce((select sum(dl.base_qty) from document_line dl
                          join document dd on dd.id = dl.document_id
                         where dl.source_line_id = ol.id and dd.status = 'POSTED'), 0)
            - coalesce((select sum(fl.qty) from fulfilment_link fl
                         where fl.order_line_id = ol.id), 0))::float as outstanding,
           to_char(o.due_date, 'YYYY-MM-DD') as "dueDate"
      from document o
      join document_line ol on ol.document_id = o.id
     where o.company_id = ${companyId} and o.doc_type = ${orderType}
       and o.status = 'POSTED' and o.partner_id = ${doc.partner_id}
       and not exists (
             select 1 from v_order_outstanding v
              where v.order_id = o.id and v.is_closed
       )
     order by o.doc_no, ol.line_no`;

  return { lines, openLines: (openLines as any[]).filter((o) => o.outstanding > 0.0001) };
}

/**
 * Goods already recorded that could answer this order — the same question as
 * getLinkableOrders, asked from the order's side.
 *
 * Somebody standing on an order that reads "40 of 100 received" wants to say
 * "the other sixty came in on that receipt", and the receipt is where they
 * would otherwise have to go to say it. Offered here: every posted receipt
 * (or delivery, for a sales order) from the same partner, for an item this
 * order still expects, with whatever it has not already allocated elsewhere.
 */
export async function getLinkableFulfilments(companyId: string, orderId: string) {
  const [order] = await sql`
    select id, doc_type, partner_id, status from document
     where id = ${orderId} and company_id = ${companyId}`;
  if (!order || order.status !== "POSTED") return { orderLines: [], candidates: [] };
  const fulfilmentType =
    order.doc_type === "PURCHASE_ORDER" ? "GOODS_RECEIPT"
    : order.doc_type === "SALES_ORDER" ? "DELIVERY"
    : null;
  if (!fulfilmentType) return { orderLines: [], candidates: [] };

  // What each line still expects, by the reckoning every screen shares.
  const orderLines = await sql`
    select ol.id as "orderLineId", ol.item_id as "itemId",
           i.code as "itemCode", i.name as "itemName",
           (ol.base_qty
            - coalesce((select sum(dl.base_qty) from document_line dl
                          join document dd on dd.id = dl.document_id
                         where dl.source_line_id = ol.id and dd.status = 'POSTED'), 0)
            - coalesce((select sum(fl.qty) from fulfilment_link fl
                         where fl.order_line_id = ol.id), 0))::float as outstanding
      from document_line ol
      join item i on i.id = ol.item_id
     where ol.document_id = ${orderId}
     order by ol.line_no`;
  const open = (orderLines as any[]).filter((l) => l.outstanding > 0.0001);
  if (open.length === 0) return { orderLines: [], candidates: [] };

  // Lines on documents that moved those goods, less anything already spoken
  // for. A receipt that named this order on the way in is excluded by the
  // source_line_id test: it is not spare, it is already counted.
  const candidates = await sql`
    select dl.id as "lineId", dl.item_id as "itemId",
           d.id as "documentId", d.doc_no as "docNo",
           to_char(d.doc_date, 'YYYY-MM-DD') as "docDate",
           src.doc_no as "relatedNo",
           (dl.base_qty
            - coalesce((select sum(fl.qty) from fulfilment_link fl
                         where fl.fulfilment_line_id = dl.id), 0))::float as spare
      from document_line dl
      join document d on d.id = dl.document_id
      left join document src on src.id = d.source_document_id
     where d.company_id = ${companyId} and d.doc_type = ${fulfilmentType}
       and d.status = 'POSTED' and d.partner_id = ${order.partner_id}
       and dl.item_id = any(${open.map((l) => l.itemId)})
       and coalesce(dl.source_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
             not in (select ol2.id from document_line ol2 where ol2.document_id = ${orderId})
     order by d.doc_date desc, d.doc_no desc`;

  return {
    orderLines: open,
    candidates: (candidates as any[]).filter((c) => c.spare > 0.0001),
  };
}

/** Whether an order has been closed, and what it is still owed. */
export async function getOrderOutstanding(companyId: string, documentId: string) {
  const [r] = await sql`
    select coalesce(sum(outstanding), 0)::float as outstanding,
           bool_or(is_closed) as is_closed
      from v_order_outstanding
     where company_id = ${companyId} and order_id = ${documentId}`;
  return { outstanding: Number(r?.outstanding ?? 0), isClosed: !!r?.is_closed };
}

/** Why an order was closed, and when — shown on the order itself. */
export async function getOrderClosure(documentId: string) {
  const [r] = await sql`
    select reason, closed_by, closed_at, is_open from order_closure
     where document_id = ${documentId} order by closed_at desc limit 1`;
  return r ?? null;
}

/**
 * The people side of a document: who raised it, who posted it, what is still
 * owed on it and by whom, and what has happened to it since.
 *
 * One query rather than four, because every document screen shows all of it
 * together in the same rail, and four round trips for one panel is three too
 * many.
 */
export async function getDocumentPeople(documentId: string) {
  const [doc] = await sql`
    select d.id,
           cu.name as created_by, cu.initials as created_initials,
           pu.name as posted_by,  pu.initials as posted_initials,
           d.posted_at, d.created_at
      from document d
      left join app_user cu on cu.id = d.created_by_id
      left join app_user pu on pu.id = d.posted_by_id
     where d.id = ${documentId}`;

  const tasks = await sql`
    select t.id, t.task, t.due_date, t.done_at, t.aspect,
           u.name as responsible, u.initials,
           (t.done_at is null and t.due_date is not null and t.due_date < current_date)
             as overdue,
           (current_date - t.due_date) as days_late
      from document_task t
      left join app_user u on u.id = t.responsible_id
     -- Across versions. A task is an obligation about the thing — chase the
     -- delivery, get the bill approved — not about the piece of paper it was
     -- written on, so correcting the document must not take it off somebody's
     -- list. Before this, an overdue chase silently moved to the retired
     -- version the moment the price was corrected, and nobody saw it again.
     where t.document_id in (${versionsOf(documentId)})
     order by t.due_date nulls last, t.created_at`;

  const activity = await sql`
    select a.kind, a.note, a.happened_at, u.name as actor, u.initials
      from document_activity a
      left join app_user u on u.id = a.actor_id
     -- Across versions too: this panel says "who did what, and when" about
     -- this document, and a correction does not start the story over. Shown
     -- on v2, the posting of v1 is exactly the history somebody is looking
     -- for; the version trail above says which version each belongs to.
     where a.document_id in (${versionsOf(documentId)})
     order by a.happened_at desc, a.created_at desc
     limit 20`;

  return { doc: doc ?? null, tasks, activity };
}

/** Payments somebody planned against this supplier, which are not payments. */
export async function getPaymentSchedules(companyId: string, partnerId: string | null) {
  if (!partnerId) return [];
  return sql`
    select s.schedule_no, s.planned_date, s.amount, s.executed, s.overdue,
           d.doc_no as executed_by
      from v_payment_schedule_status s
      left join document d on d.id = s.executed_by_document_id
     where s.company_id = ${companyId} and s.partner_id = ${partnerId}
     order by s.planned_date`;
}

/**
 * The two halves of a purchase invoice, which run independently.
 *
 * Goods can be outstanding while the money is settled, and the money can be
 * outstanding while every box has arrived. Reading one number for "the
 * invoice" hides whichever of the two is the problem — which is exactly how
 * an invoice paid in full sat looking finished with sixty boxes never
 * delivered.
 *
 * Goods are counted through the same matcher the ledger settles GR/IR with,
 * so what this calls outstanding is what the clearing account still holds.
 * Money comes from the allocations against it. Neither is re-derived here
 * with a rule of its own.
 *
 * The sales side is the same document read the other way round: goods still
 * to go out rather than come in, money still to collect rather than pay. One
 * function, because they are one shape — and a customer invoice that is paid
 * in full with nothing delivered is exactly as wrong as the purchase case.
 */
export async function getInvoiceProgress(companyId: string, documentId: string) {
  const [doc] = await sql`
    select d.id, d.doc_type, d.due_date, d.gross_total, d.partner_id
      from document d where d.id = ${documentId} and d.company_id = ${companyId}`;
  if (!doc) return null;

  const match = await getMatchStatus(documentId);
  const matchLines = match?.lines ?? [];
  const billed = matchLines.reduce((t, l) => t + Number(l.qty), 0);
  const arrived = matchLines.reduce((t, l) => t + Number(l.settled), 0);
  const goodsOutstanding = Math.max(Math.round((billed - arrived) * 10000) / 10000, 0);
  const [unit] = await sql`
    select u.code from document_line dl
      join item i on i.id = dl.item_id
      join uom u on u.id = i.base_uom_id
     where dl.document_id = ${documentId} limit 1`;

  const paid = await getDocumentOutstanding(documentId);

  /**
   * When the goods were expected. An invoice has no delivery date of its own,
   * so this is the order's, where the goods were ordered — and nothing at all
   * where they were not. An invented date would make a supplier look late on
   * a promise nobody recorded them making.
   */
  const orderType = doc.doc_type === "SALES_INVOICE" ? "SALES_ORDER" : "PURCHASE_ORDER";
  const [anyOrder] = await sql`
    select o.doc_no, o.due_date from document o
     where o.company_id = ${companyId} and o.doc_type = ${orderType}
       and o.partner_id = ${doc.partner_id} and o.status = 'POSTED'
       and exists (select 1 from v_order_outstanding v
                    where v.order_id = o.id and v.outstanding > 0)
     order by o.due_date nulls last limit 1`;

  const tasks = await sql`
    select t.aspect, t.task, t.due_date, u.name as responsible, u.initials
      from document_task t
      left join app_user u on u.id = t.responsible_id
     where t.document_id in (${versionsOf(documentId)}) and t.done_at is null`;
  const forAspect = (a: string) =>
    (tasks as any[]).find((t) => t.aspect === a) ?? null;

  const today = new Date(new Date().toDateString());
  const asDate = (v: unknown) => (v ? new Date(String(v)) : null);
  const goodsDue = asDate(anyOrder?.due_date);
  const payDue = asDate(doc.due_date);

  return {
    unit: unit?.code ?? null,
    goods: {
      outstanding: goodsOutstanding,
      billed,
      arrived,
      /**
       * Goods are counted against this invoice only where a receipt names it.
       * A shipment received against the order instead is invisible from here,
       * which is why the card says so rather than letting "100 outstanding"
       * be read as the supplier owing another hundred. The cure is the same
       * relationship receipts and orders now have, applied to invoices — not
       * a rule here that guesses which goods were for which bill.
       */
      unmatched: arrived === 0 && billed > 0,
      expectedDate: anyOrder?.due_date ? String(anyOrder.due_date) : null,
      expectedFrom: anyOrder?.doc_no ?? null,
      overdue: goodsOutstanding > 0 && !!goodsDue && goodsDue < today,
      ...(forAspect("GOODS") ?? {}),
    },
    payment: {
      outstanding: paid,
      total: Number(doc.gross_total),
      dueDate: doc.due_date ? String(doc.due_date) : null,
      overdue: paid > 0 && !!payDue && payDue < today,
      ...(forAspect("PAYMENT") ?? {}),
    },
  };
}

/**
 * Sales invoices marked "to deliver" with goods still to go, line by line.
 *
 * "Still to go" used to mean no delivery existed at all. Two things followed
 * from that. An invoice for 1,000 with 100 delivered vanished from the list
 * with 900 undelivered — the customer is owed 900 units and the screen said
 * there was nothing to do. And because the test never looked at the
 * delivery's status, voiding that delivery did not bring the invoice back:
 * the goods were on the shelf again, the invoice was still billed, and
 * nothing anywhere said so.
 *
 * Remaining is derived through the same matcher the ledger settles with, so
 * what this offers and what a delivery can actually fulfil are the same
 * quantities. Voided deliveries are not deliveries.
 */
export async function getPendingDeliveryLines(companyId: string) {
  const docs = await sql`
    select inv.id, inv.doc_no, inv.doc_date, inv.partner_id, inv.location_id,
           p.name as partner_name
      from document inv
      join business_partner p on p.id = inv.partner_id
     where inv.company_id = ${companyId} and inv.doc_type = 'SALES_INVOICE'
       and inv.to_deliver and inv.status = 'POSTED'
     order by inv.doc_date`;
  if (docs.length === 0) return [];

  const ids = docs.map((d: any) => d.id);

  // Only stocked lines: a service line on a to-deliver invoice has nothing
  // to ship, and counting it would keep the invoice on the list forever.
  const lines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           dl.unit_price, dl.foc_reason_id, i.code as item_code, i.name as item_name
      from document_line dl
      join item i on i.id = dl.item_id
     where dl.document_id = any(${ids}) and i.is_stocked
     order by dl.line_no`;

  const delivered = await sql`
    select d.source_document_id as invoice_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${companyId}
       and d.doc_type = 'DELIVERY'
       and d.status = 'POSTED'
       and d.source_document_id = any(${ids})
     order by d.posting_date, d.doc_no, dl.line_no`;

  return docs
    .map((d: any) => {
      const own = lines.filter((l: any) => l.document_id === d.id);
      const draw = grirMatcher(own as unknown as MatchableLine[]);
      const gone = new Map<string, number>();

      for (const del of delivered.filter((x: any) => x.invoice_id === d.id)) {
        for (const t of draw(del.item_id, Number(del.qty), del.source_line_id).taken) {
          gone.set(t.lineId, (gone.get(t.lineId) ?? 0) + t.qty);
        }
      }

      const open = own
        .map((l: any) => ({
          lineId: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          focReasonId: l.foc_reason_id as string | null,
          qty: Math.round((Number(l.qty) - (gone.get(l.id) ?? 0)) * 10000) / 10000,
        }))
        .filter((l) => l.qty > 0);

      return { ...d, lines: open };
    })
    .filter((d: any) => d.lines.length > 0);
}

/** The same, counted, for the list that only shows how much is outstanding. */
export async function getPendingDeliveries(companyId: string) {
  const pending = await getPendingDeliveryLines(companyId);
  return pending.map((d: any) => ({
    id: d.id, doc_no: d.doc_no, doc_date: d.doc_date, partner_name: d.partner_name,
    lines: d.lines.length,
    total_qty: d.lines.reduce((s: number, l: any) => s + l.qty, 0),
  }));
}

/**
 * Reserved and incoming quantity per item, for the stock position — demand
 * committed but not yet delivered (sales orders and to-deliver invoices),
 * and supply committed but not yet received (purchase orders).
 */
/** Every movement of one item, oldest first — a stock card. */
export async function getStockMovements(companyId: string, itemId: string) {
  return sql`
    select sm.id, sm.movement_date, sm.qty, sm.unit_cost, sm.total_cost,
           sm.batch_no, sm.expiry_date, sm.created_at,
           d.doc_no, d.doc_type, d.id as document_id,
           l.code as location_code
      from stock_movement sm
      left join document d on d.id = sm.document_id
      join location l on l.id = sm.location_id
     where sm.company_id = ${companyId} and sm.item_id = ${itemId}
     order by sm.movement_date, sm.created_at`;
}

export async function getReservedQty(companyId: string) {
  return sql`
    with so_remaining as (
      select ol.item_id, ol.location_id, sum(ol.base_qty - coalesce(d.delivered_qty, 0)) as qty
        from document o
        join document_line ol on ol.document_id = o.id
        left join (
          select dl.source_line_id, sum(dl.base_qty) as delivered_qty
            from document_line dl join document dd on dd.id = dl.document_id
           where dd.doc_type = 'DELIVERY' and dd.status = 'POSTED'
           group by dl.source_line_id
        ) d on d.source_line_id = ol.id
       where o.company_id = ${companyId} and o.doc_type = 'SALES_ORDER' and o.status = 'POSTED'
       group by ol.item_id, ol.location_id
      having sum(ol.base_qty - coalesce(d.delivered_qty, 0)) > 0
    ),
    -- Committed to a customer and not yet shipped. Per invoice and item,
    -- because "no delivery at all" both over-reserved (the whole invoice
    -- stayed reserved while nothing had shipped, which is right) and then
    -- under-reserved to nothing the moment one unit went out — releasing 900
    -- units that are still owed to that customer.
    invoice_billed as (
      select inv.id as inv_id, il.item_id, il.location_id, sum(il.base_qty) as qty
        from document inv
        join document_line il on il.document_id = inv.id
       where inv.company_id = ${companyId} and inv.doc_type = 'SALES_INVOICE'
         and inv.to_deliver and inv.status = 'POSTED'
       group by inv.id, il.item_id, il.location_id
    ),
    invoice_shipped as (
      select d.source_document_id as inv_id, dl.item_id, sum(dl.base_qty) as qty
        from document d
        join document_line dl on dl.document_id = d.id
       where d.company_id = ${companyId} and d.doc_type = 'DELIVERY'
         and d.status = 'POSTED' and d.source_document_id is not null
       group by d.source_document_id, dl.item_id
    ),
    invoice_pending as (
      select b.item_id, b.location_id,
             sum(greatest(b.qty - coalesce(s.qty, 0), 0)) as qty
        from invoice_billed b
        left join invoice_shipped s
               on s.inv_id = b.inv_id and s.item_id = b.item_id
       group by b.item_id, b.location_id
    )
    select item_id, location_id, sum(qty) as reserved_qty
      from (select * from so_remaining union all select * from invoice_pending) x
     group by item_id, location_id`;
}

export async function getIncomingQty(companyId: string) {
  return sql`
    select ol.item_id, ol.location_id, sum(ol.base_qty - coalesce(r.received_qty, 0)) as incoming_qty
      from document o
      join document_line ol on ol.document_id = o.id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as received_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'GOODS_RECEIPT' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) r on r.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'PURCHASE_ORDER' and o.status = 'POSTED'
     group by ol.item_id, ol.location_id
    having sum(ol.base_qty - coalesce(r.received_qty, 0)) > 0`;
}

export async function getBrands(companyId: string) {
  return sql`
    select id, code, name, name_my, is_active
      from brand
     where company_id = ${companyId}
     order by name`;
}

export async function getLocations(companyId: string) {
  return sql`
    select l.id, l.code, l.name, l.name_my, l.parent_id, l.is_stock_location, l.is_active,
           p.name as parent_name
      from location l
      left join location p on p.id = l.parent_id
     where l.company_id = ${companyId}
     order by l.code`;
}

// -------------------------------------------------------- three statements --

/**
 * Revenue less COGS less expense, for a date range. `amount` is always
 * shown natural-positive per account — revenue's credit balance and an
 * expense's debit balance both read as a plain positive number, and the
 * three section totals combine with plain subtraction.
 */
/**
 * Branches: the top of the location tree. A branch is a site that holds no
 * stock itself and sits under nothing; the warehouses that do hold stock are
 * its children. Both live in `location` — they are separate rows in a
 * parent/child relationship, not one row playing two roles, so a branch can
 * hold many warehouses and a warehouse belongs to exactly one branch.
 */
export async function getBranches(companyId: string) {
  return sql`
    select b.id, b.code, b.name,
           count(w.id) filter (where w.is_stock_location)::int as warehouse_count
      from location b
      left join location w on w.parent_id = b.id
     where b.company_id = ${companyId} and b.parent_id is null and b.is_active
     group by b.id, b.code, b.name
     order by b.code`;
}

/**
 * Restricts a ledger query to one branch, or to everything when no branch is
 * chosen. A journal line carries the warehouse it happened at, so rolling up
 * to a branch means walking one step up the tree — and a line posted against
 * the branch itself (an expense booked centrally, say) counts as its own
 * branch, which is what coalesce(parent_id, id) says.
 */
export const UNASSIGNED_BRANCH = "none";

function branchFilter(branchId?: string | null) {
  return branchFilterOn(sql`jl`, branchId);
}

/**
 * The same rule against whichever alias the caller is using. A branch is a
 * top-level location and its warehouses are its children, so a line stamped
 * with a warehouse belongs to the branch above it — comparing the line's
 * location straight to a branch id matches nothing and reads as "this branch
 * has no activity", which is worse than an error.
 */
function branchFilterOn(alias: ReturnType<typeof sql>, branchId?: string | null) {
  if (!branchId) return sql``;
  // Entries posted before the branch dimension was stamped carry no location
  // and belong to no branch. They still count in the consolidated company
  // figures, so without a way to see them the branches would silently fail to
  // add up to the company total and there would be nothing on screen saying
  // why. This makes that remainder selectable instead of invisible.
  if (branchId === UNASSIGNED_BRANCH) return sql`and ${alias}.location_id is null`;
  return sql`and exists (
          select 1 from location w
           where w.id = ${alias}.location_id
             and coalesce(w.parent_id, w.id) = ${branchId})`;
}

/**
 * How much activity carries no branch at all, so a report can say so.
 *
 * This is the difference between the company total and the branches added
 * together, and a report that shows the first two without the third is asking
 * to be disbelieved: MAIN plus MDY comes to less than the company, and the
 * screen offers no account of where the rest went. Opening balances carry no
 * branch at all, and a voucher could be posted without one, so the remainder
 * is real rather than theoretical.
 */
export async function getUnassignedBranchActivity(companyId: string) {
  const [r] = await sql`
    select count(*)::int as lines,
           coalesce(sum(case when jl.base_amount > 0 then jl.base_amount else 0 end), 0) as debits
      from journal_line jl
     where jl.company_id = ${companyId} and jl.location_id is null`;
  return { lines: Number(r?.lines ?? 0), debits: Number(r?.debits ?? 0) };
}

export async function getIncomeStatement(
  companyId: string, from: string, to: string, branchId?: string | null
) {
  return sql`
    select a.id, a.code, a.name, a.account_type,
           case when fn_is_debit_normal(a.account_type)
                then sum(jl.base_amount) else -sum(jl.base_amount) end as amount
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
     where jl.company_id = ${companyId}
       and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
       and je.entry_date between ${from}::date and ${to}::date
       ${branchFilter(branchId)}
     group by a.id, a.code, a.name, a.account_type
    having sum(jl.base_amount) <> 0
     order by a.account_type, a.code`;
}

/**
 * Revenue by calendar month for the trailing `months` months, including
 * months with no postings at all — a chart needs the empty gaps to show a
 * true trend rather than silently compressing the x-axis to whichever
 * months happened to have activity.
 */
export async function getRevenueTrend(companyId: string, months: number = 6) {
  return sql`
    with months as (
      select date_trunc('month', current_date) - (n || ' months')::interval as month
        from generate_series(0, ${months} - 1) as n
    ),
    monthly_revenue as (
      select date_trunc('month', je.entry_date) as month,
             sum(-jl.base_amount) as revenue
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and a.account_type = 'REVENUE'
       group by date_trunc('month', je.entry_date)
    )
    select to_char(m.month, 'YYYY-MM') as month, coalesce(r.revenue, 0) as revenue
      from months m
      left join monthly_revenue r on r.month = m.month
     order by m.month`;
}

/** Best-selling items by revenue over the trailing `months` months, sales invoices only (returns not netted out). */
export async function getTopItems(companyId: string, months: number = 6, limit: number = 6) {
  return sql`
    select i.id, i.code, i.name,
           sum(dl.base_qty) as qty,
           sum(dl.net_amount) as revenue
      from document_line dl
      join document d on d.id = dl.document_id
      join item i on i.id = dl.item_id
     where d.company_id = ${companyId}
       and d.doc_type = 'SALES_INVOICE'
       and d.status = 'POSTED'
       and d.posting_date >= date_trunc('month', current_date) - (${months} - 1 || ' months')::interval
     group by i.id, i.code, i.name
     order by revenue desc
     limit ${limit}`;
}

/** Best customers by revenue over the trailing `months` months, sales invoices only. */
export async function getTopCustomers(companyId: string, months: number = 6, limit: number = 6) {
  return sql`
    select p.id, p.code, p.name,
           sum(d.net_total) as revenue,
           count(*)::int as invoices
      from document d
      join business_partner p on p.id = d.partner_id
     where d.company_id = ${companyId}
       and d.doc_type = 'SALES_INVOICE'
       and d.status = 'POSTED'
       and d.posting_date >= date_trunc('month', current_date) - (${months} - 1 || ' months')::interval
     group by p.id, p.code, p.name
     order by revenue desc
     limit ${limit}`;
}

/**
 * Item/location pairs needing attention: below a configured reorder point,
 * OR sitting at zero or negative on hand regardless of whether anyone ever
 * configured one — a stockout is alarming on its own, not only once someone
 * has gotten around to setting a threshold. v_stock_on_hand excludes any
 * item/location that nets to exactly zero movement and value (it reads as
 * "never stocked here", not "stocked out"), so this reads the raw movement
 * ledger directly for the out-of-stock half of the check instead.
 */
export async function getLowStock(companyId: string) {
  return sql`
    with stock as (
      select item_id, location_id, sum(qty) as qty_on_hand
        from stock_movement
       where company_id = ${companyId}
       group by item_id, location_id
    ),
    keys as (
      select item_id, location_id from item_reorder where company_id = ${companyId}
      union
      select s.item_id, s.location_id
        from stock s
        join item i on i.id = s.item_id
       where i.company_id = ${companyId} and i.is_stocked and i.is_active
    )
    select i.id as item_id, i.code as item_code, i.name as item_name,
           l.id as location_id, l.code as location_code,
           coalesce(s.qty_on_hand, 0) as qty_on_hand,
           r.min_qty,
           case when r.min_qty is not null and coalesce(s.qty_on_hand, 0) < r.min_qty
                then 'below_reorder' else 'out_of_stock' end as reason
      from keys k
      join item i on i.id = k.item_id
      join location l on l.id = k.location_id
      left join stock s on s.item_id = k.item_id and s.location_id = k.location_id
      left join item_reorder r on r.item_id = k.item_id and r.location_id = k.location_id and r.company_id = ${companyId}
     where (r.min_qty is not null and coalesce(s.qty_on_hand, 0) < r.min_qty)
        or coalesce(s.qty_on_hand, 0) <= 0
     order by (case when r.min_qty is not null then r.min_qty - coalesce(s.qty_on_hand, 0)
                     else -coalesce(s.qty_on_hand, 0) end) desc`;
}

/** Every configured reorder point, for the management list on the Stock page — not just the ones currently violated. */
export async function getReorderPoints(companyId: string) {
  return sql`
    select r.id, r.item_id, r.location_id, r.min_qty,
           i.code as item_code, i.name as item_name,
           l.code as location_code
      from item_reorder r
      join item i on i.id = r.item_id
      join location l on l.id = r.location_id
     where r.company_id = ${companyId}
     order by i.code, l.code`;
}

/**
 * Asset/liability/equity balances as of a date, cumulative from inception —
 * a balance sheet is a snapshot, not a period. Revenue/COGS/expense accounts
 * are never closed to equity here, so their cumulative net (through asOf)
 * is folded in as a "Retained earnings" line — without it Assets would not
 * equal Liabilities + Equity.
 */
export async function getBalanceSheet(companyId: string, asOf: string, branchId?: string | null) {
  const [rows, netIncomeRows] = await Promise.all([
    sql`
      select a.id, a.code, a.name, a.account_type,
             case when fn_is_debit_normal(a.account_type)
                  then sum(jl.base_amount) else -sum(jl.base_amount) end as amount
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
         and je.entry_date <= ${asOf}::date
         ${branchFilter(branchId)}
       group by a.id, a.code, a.name, a.account_type
      having sum(jl.base_amount) <> 0
       order by a.account_type, a.code`,
    sql`
      select coalesce(-sum(jl.base_amount), 0) as net_income
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
         and je.entry_date <= ${asOf}::date
         ${branchFilter(branchId)}`,
  ]);

  return { rows, netIncome: Number(netIncomeRows[0]?.net_income ?? 0) };
}

/**
 * Direct-method cash flow: every cash/bank-touching journal line, attributed
 * to a category by the OTHER side of its entry rather than the cash side
 * itself — decomposing per contra line handles multi-line vouchers
 * correctly, and excluding cash-to-cash contra lines drops internal
 * transfers, which are not a real inflow or outflow.
 */
export async function getCashFlowStatement(
  companyId: string, from: string, to: string, branchId?: string | null
) {
  const [rows, beginning, ending] = await Promise.all([
    // Each cash movement counted once. Joining every cash line to every
    // contra line and summing the contra repeated the entry once per cash
    // line: Dr Cash 60,000 + Dr Bank 40,000 / Cr Capital 100,000 reported
    // 200,000 of financing inflow against 100,000 of actual cash.
    //
    // So the amount is the cash line's own movement — which is the cash that
    // truly moved — apportioned across the entry's contra lines in
    // proportion to them. One cash line against one contra keeps its whole
    // value; a payment split across an expense and an asset splits in the
    // same ratio. The parts always add back to the cash line.
    sql`
      with cash_line as (
        select jl.id, jl.journal_entry_id, jl.base_amount, jl.location_id
          from journal_line jl
          join account a on a.id = jl.account_id
         where jl.company_id = ${companyId}
           and (a.is_cash_account or a.is_bank_account)
      ),
      contra as (
        select jl.journal_entry_id, jl.base_amount, a.account_type
          from journal_line jl
          join account a on a.id = jl.account_id
         where jl.company_id = ${companyId}
           and not (a.is_cash_account or a.is_bank_account)
      ),
      contra_total as (
        select journal_entry_id, sum(base_amount) as total
          from contra group by journal_entry_id
      )
      select
        case
          when je.source_type in ('CUSTOMER_RECEIPT', 'SALES_INVOICE') then 'Received from customers'
          when je.source_type = 'SUPPLIER_PAYMENT' then 'Paid to suppliers'
          when k.account_type = 'REVENUE' then 'Received from customers'
          when k.account_type = 'COGS' then 'Paid to suppliers'
          when k.account_type = 'EXPENSE' then 'Operating expenses paid'
          when k.account_type = 'EQUITY' then 'Owner contributions / drawings'
          when k.account_type = 'LIABILITY' then 'Loans and other liabilities'
          when k.account_type = 'ASSET' then 'Purchase / sale of fixed assets'
          else 'Other'
        end as category,
        case
          when je.source_type in ('CUSTOMER_RECEIPT', 'SALES_INVOICE', 'SUPPLIER_PAYMENT')
            or k.account_type in ('REVENUE', 'COGS', 'EXPENSE') then 'operating'
          when k.account_type = 'ASSET' then 'investing'
          when k.account_type in ('EQUITY', 'LIABILITY') then 'financing'
          else 'operating'
        end as section,
        sum(c.base_amount * k.base_amount / nullif(ct.total, 0)) as amount
        from cash_line c
        join journal_entry je on je.id = c.journal_entry_id
        join contra k on k.journal_entry_id = c.journal_entry_id
        join contra_total ct on ct.journal_entry_id = c.journal_entry_id
       where je.entry_date between ${from}::date and ${to}::date
         ${branchFilterOn(sql`c`, branchId)}
       group by category, section
       order by section, category`,
    sql`
      select coalesce(sum(jl.base_amount), 0) as balance
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and (a.is_cash_account or a.is_bank_account)
         and je.entry_date < ${from}::date
         ${branchFilter(branchId)}`,
    sql`
      select coalesce(sum(jl.base_amount), 0) as balance
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and (a.is_cash_account or a.is_bank_account)
         and je.entry_date <= ${to}::date
         ${branchFilter(branchId)}`,
  ]);

  return {
    rows,
    beginningCash: Number(beginning[0]?.balance ?? 0),
    endingCash: Number(ending[0]?.balance ?? 0),
  };
}

export async function getSalesmen(companyId: string) {
  return sql`
    select s.id, s.code, s.name, s.name_my, s.phone, s.location_id,
           s.commission_pct, s.is_active,
           l.name as location_name
      from salesman s
      left join location l on l.id = s.location_id
     where s.company_id = ${companyId}
     order by s.code`;
}

/**
 * A trial balance lists each account's closing balance on the side it
 * naturally falls, and the two columns must agree — that agreement is the
 * whole point of the report.
 *
 * Balances are stored signed (positive debit), so a liability comes back
 * negative. Presenting that raw would show Accounts Payable as -450,000
 * rather than a 450,000 credit. The split below puts each balance in the
 * right column, and an account carrying an abnormal balance — an overdrawn
 * bank, say — correctly lands on the other side rather than being hidden.
 */
export async function getTrialBalance(companyId: string) {
  return sql`
    select a.code, a.name, a.account_type,
           sum(tb.debit)   as debit_movement,
           sum(tb.credit)  as credit_movement,
           sum(tb.balance) as signed_balance,
           case when sum(tb.balance) > 0 then  sum(tb.balance) else 0 end as closing_debit,
           case when sum(tb.balance) < 0 then -sum(tb.balance) else 0 end as closing_credit,
           fn_is_debit_normal(a.account_type) as debit_normal
      from v_trial_balance tb
      join account a on a.id = tb.account_id
     where tb.company_id = ${companyId}
     group by a.code, a.name, a.account_type
    having sum(tb.balance) <> 0
     order by a.code`;
}


// ------------------------------------------------- GR/IR line-level status --

export type MatchedBy = { docId: string; docNo: string; docDate: string; qty: number; value: number };
export type MatchLineStatus = {
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  qty: number;          // what this line carries
  settled: number;      // how much of it the counterpart documents have covered
  remaining: number;
  matchedBy: MatchedBy[];
};
export type MatchStatus = {
  state: "NONE" | "PARTIAL" | "FULL";
  lines: MatchLineStatus[];
};

/**
 * How much of a goods receipt has been invoiced, or of a purchase invoice
 * received — line by line, and by which counterpart documents.
 *
 * This does not re-derive the answer with a rule of its own. It replays the
 * counterpart documents through `grirMatcher`, the same function the posting
 * engine settles GR/IR with, in the same order. So a receipt line the screen
 * calls fully invoiced is a line the ledger has actually released, and a
 * partial one shows the quantity that is genuinely still open.
 *
 * That matters most for documents posted before invoices recorded which line
 * they billed: those name only the item, and the matcher drains them oldest
 * layer first. Displaying them any other way would put the screen and the
 * accounts into disagreement over the same receipt.
 */
export async function getMatchStatus(documentId: string): Promise<MatchStatus | null> {
  const [doc] = await sql`
    select id, company_id, doc_type, status, source_document_id
      from document where id = ${documentId}`;
  if (!doc || doc.status !== "POSTED") return null;

  // The sales side is the same shape in different vocabulary: goods move on
  // one document, the money is billed on another, and either can come first.
  // A delivery is to a sales invoice what a goods receipt is to a purchase
  // invoice, so it is tracked by the same code rather than a parallel copy
  // that would drift.
  const counterpartType =
    doc.doc_type === "GOODS_RECEIPT"   ? "PURCHASE_INVOICE"
    : doc.doc_type === "PURCHASE_INVOICE" ? "GOODS_RECEIPT"
    : doc.doc_type === "DELIVERY"      ? "SALES_INVOICE"
    : doc.doc_type === "SALES_INVOICE" ? "DELIVERY"
    : null;
  if (!counterpartType) return null;

  const lines = await sql`
    select dl.id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           dl.source_line_id,
           i.code as item_code, i.name as item_name, u.code as uom_code
      from document_line dl
      join item i on i.id = dl.item_id
      left join uom u on u.id = dl.entered_uom_id
     where dl.document_id = ${documentId}
     order by dl.line_no`;
  if (lines.length === 0) return null;

  // Counterpart documents in the order they posted, which is the order the
  // ledger settled them in.
  //
  // Both directions, because the chain is only ever built one way: a receipt
  // is posted, and the invoice billing it names the receipt as its source.
  // Nothing points back. Looking only for "documents whose source is me"
  // therefore answers correctly from the receipt and wrongly from the
  // invoice, which reported the goods it was raised from as never having
  // arrived — and then offered a button to receive them a second time.
  const counterparts = await sql`
    select d.id, d.doc_no, d.doc_date, dl.id as line_id, dl.item_id,
           dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${doc.company_id}
       and d.doc_type = ${counterpartType}
       and d.status = 'POSTED'
       and (d.source_document_id = ${documentId}
            or d.id = ${doc.source_document_id ?? null})
     order by d.posting_date, d.doc_no, dl.line_no`;

  const draw = grirMatcher(lines as unknown as MatchableLine[]);

  // Looking down the chain, a counterpart line names the line it settles.
  // Looking up it, this document's lines name theirs — so the same link read
  // backwards is what identifies the counterpart, and line-level matching
  // stays exact rather than falling back to oldest-first.
  const inverse = new Map<string, string>();
  for (const l of lines as any[]) {
    if (l.source_line_id) inverse.set(l.source_line_id, l.id);
  }

  const settled = new Map<string, number>();
  const matchedBy = new Map<string, MatchedBy[]>();

  for (const c of counterparts) {
    const { taken } = draw(c.item_id, Number(c.qty), inverse.get(c.line_id) ?? c.source_line_id);
    for (const t of taken) {
      settled.set(t.lineId, (settled.get(t.lineId) ?? 0) + t.qty);
      const list = matchedBy.get(t.lineId) ?? [];
      const existing = list.find((m) => m.docId === c.id);
      if (existing) {
        existing.qty += t.qty;
        existing.value += t.value;
      } else {
        list.push({
          docId: c.id,
          docNo: c.doc_no,
          docDate: String(c.doc_date),
          qty: t.qty,
          value: t.value,
        });
      }
      matchedBy.set(t.lineId, list);
    }
  }

  const out: MatchLineStatus[] = lines.map((l: any) => {
    const qty = Number(l.qty);
    const done = settled.get(l.id) ?? 0;
    return {
      lineId: l.id,
      itemId: l.item_id,
      itemCode: l.item_code,
      itemName: l.item_name,
      uomCode: l.uom_code ?? null,
      qty,
      settled: done,
      remaining: Math.max(0, Math.round((qty - done) * 10000) / 10000),
      matchedBy: matchedBy.get(l.id) ?? [],
    };
  });

  const totalRemaining = out.reduce((s, l) => s + l.remaining, 0);
  const totalSettled = out.reduce((s, l) => s + l.settled, 0);

  return {
    state: totalSettled === 0 ? "NONE" : totalRemaining === 0 ? "FULL" : "PARTIAL",
    lines: out,
  };
}

/**
 * An order's lines with how much of each has actually been fulfilled.
 *
 * Fulfilment is derived from `source_line_id` on the delivery or receipt
 * lines, which is the same reference GR/IR matching uses — so the figure on
 * the order agrees with the one the ledger settled against, rather than
 * being a second count of the same thing.
 *
 * Invoiced quantity is deliberately absent. On this chain an invoice points
 * at the *delivery*, not the order, so an invoiced-per-order-line figure
 * needs a second hop that would only sometimes resolve. A column that is
 * right most of the time is worse here than no column.
 */
export async function getOrderProgress(orderId: string, docType: string) {
  const fulfilmentType = docType === "SALES_ORDER" ? "DELIVERY" : "GOODS_RECEIPT";

  const lines = await sql`
    select ol.id, ol.line_no, ol.item_id,
           i.code as item_code, i.name as item_name, i.name_my as item_name_my,
           u.code as uom_code,
           ol.base_qty as ordered, ol.unit_price, ol.net_amount
      from document_line ol
      join item i on i.id = ol.item_id
      left join uom u on u.id = ol.entered_uom_id
     where ol.document_id = ${orderId}
     order by ol.line_no`;

  // Matched across versions, not by id. A receipt raised against v1 of this
  // order still answered it after the order was corrected to v2 — the link it
  // recorded is the truth about what happened and is deliberately never
  // rewritten, so the reading follows the chain instead. Without this a
  // corrected order reads as nothing received, with the goods sitting on a
  // receipt that says it received them.
  const fulfilled = await sql`
    select dl.item_id, dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.doc_type = ${fulfilmentType}
       and d.status = 'POSTED'
       and d.source_document_id in (${versionsOf(orderId)})
     order by d.posting_date, d.doc_no, dl.line_no`;

  // A fulfilment line that names the order line it satisfies is credited to
  // that line. One that does not — anything posted before the reference
  // existed, and everything the seed writes — names only the item, so it is
  // spread across that item's order lines in line order, capped at what each
  // asked for. Same rule the GR/IR matcher uses for the same reason: the
  // alternative is a screen that reports nothing delivered while the chain
  // plainly shows a delivery.
  // Goods linked to this order after the fact — the receipt or delivery names
  // its own source, or none at all, and somebody said afterwards that these
  // goods answered this order. They count exactly as much as the ones that
  // named it: v_order_outstanding has always counted them, so leaving them out
  // here made the figures above the line table disagree with the line table.
  const linked = await sql`
    select fl.order_line_id, ol.item_id, sum(fl.qty) as qty
      from fulfilment_link fl
      join document_line ol on ol.id = fl.order_line_id
      join document_line dl on dl.id = fl.fulfilment_line_id
      join document dd on dd.id = dl.document_id
     where ol.document_id in (${versionsOf(orderId)})
       and dd.status = 'POSTED'
     group by fl.order_line_id, ol.item_id`;

  const done = new Map<string, number>();
  const pool = new Map<string, number>();

  // A line id belongs to one version of the order. A fulfilment that names a
  // line of the version this one replaced cannot be credited to a line here —
  // there is no such line — so it goes to the item, and is spread the same way
  // as anything that named no line at all.
  const mine = new Set(lines.map((l: any) => l.id as string));
  const credit = (lineId: string | null, itemId: string, q: number) => {
    if (lineId && mine.has(lineId)) {
      done.set(lineId, (done.get(lineId) ?? 0) + q);
    } else {
      pool.set(itemId, (pool.get(itemId) ?? 0) + q);
    }
  };

  for (const l of linked) {
    credit(l.order_line_id as string, l.item_id as string, Number(l.qty));
  }

  for (const f of fulfilled) {
    credit(f.source_line_id as string | null, f.item_id as string, Number(f.qty));
  }

  return lines.map((l: any) => {
    const ordered = Number(l.ordered);
    let got = done.get(l.id) ?? 0;

    const spare = pool.get(l.item_id) ?? 0;
    if (spare > 0 && got < ordered) {
      const take = Math.min(spare, ordered - got);
      pool.set(l.item_id, spare - take);
      got += take;
    }

    return { ...l, fulfilled: got };
  });
}

export type OriginFulfilment =
  | { state: "NOT_REQUIRED" }
  | { state: "PENDING" }
  | { state: "PARTIAL"; outstanding: number; unit: string | null }
  | { state: "DONE" };

export type TransactionOrigin = {
  /** Where this piece of work actually began. */
  startedFrom: "ORDER" | "FULFILMENT" | "INVOICE";
  startDoc: { id: string; doc_no: string; doc_type: string } | null;
  order:
    | { state: "USED"; doc: { id: string; doc_no: string } }
    /** One or more orders the goods were allocated to after the event. */
    | { state: "LINKED_LATER"; docs: { id: string; doc_no: string }[] }
    | { state: "NOT_USED" };
  fulfilment: OriginFulfilment;
  /** Goods documents this invoice was raised from — they came first. */
  fulfilmentBefore: { id: string; doc_no: string; doc_type: string }[];
  /** Goods documents raised from this invoice — they came after. */
  fulfilmentAfter: { id: string; doc_no: string; doc_type: string }[];
  payment: "PAID" | "PARTIAL" | "UNPAID";
  /** Where a correction to this transaction belongs. */
  correctAt: { kind: "ORDER"; doc: { id: string; doc_no: string } } | { kind: "SELF" };
  sales: boolean;
};

/**
 * How this transaction came about, and where correcting it belongs.
 *
 * An invoice with no order is not an unfinished one — a walk-in sale and a
 * phoned-in purchase are ordinary, complete business — but every screen that
 * draws the chain as a row of stages makes the missing stage look like a gap.
 * So the document says which route it actually took, and names the difference
 * between three things a blank space cannot distinguish:
 *
 *   not used      an optional stage this transaction skipped
 *   pending       a stage this transaction needs and has not reached
 *   not required  a stage that does not apply at all, as for a service
 *
 * Read from what the documents record about each other — the chain they were
 * raised through, and the links somebody made afterwards — never from matching
 * names or dates, which is guessing dressed as fact.
 *
 * The starting point survives a correction. A correction re-posts the document
 * against the same source it was raised from, so the route it took is the
 * route it still took; and an order attached after the fact is reported
 * separately rather than rewriting where the work began, because it did not
 * begin there.
 */
export async function getTransactionOrigin(
  companyId: string, documentId: string,
): Promise<TransactionOrigin | null> {
  const [doc] = await sql`
    select id, doc_type, source_document_id, to_deliver, gross_total
      from document where id = ${documentId} and company_id = ${companyId}`;
  if (!doc) return null;

  const sales = doc.doc_type === "SALES_INVOICE";
  const orderType = sales ? "SALES_ORDER" : "PURCHASE_ORDER";
  const moveType = sales ? "DELIVERY" : "GOODS_RECEIPT";

  // The chain this document was raised through, walked upward. At most two
  // hops: invoice → delivery or receipt → order.
  const chain: { id: string; doc_no: string; doc_type: string }[] = [];
  let cursor = doc.source_document_id as string | null;
  for (let hop = 0; hop < 3 && cursor; hop++) {
    const [row] = await sql`
      select id, doc_no, doc_type, source_document_id
        from document where id = fn_current_document(${cursor})`;
    if (!row) break;
    chain.push({ id: row.id as string, doc_no: row.doc_no as string,
                 doc_type: row.doc_type as string });
    cursor = row.source_document_id as string | null;
  }

  const orderInChain = chain.find((c) => c.doc_type === orderType) ?? null;

  /**
   * Orders the goods were allocated to after the event, reported as what they
   * are: not where this began.
   *
   * Both directions, because goods reach an invoice both ways. Billing a
   * delivery, the invoice's lines name the delivery's lines and the link hangs
   * off those — upstream. Billing first and shipping later, the delivery is
   * raised *from* the invoice and carries the link itself — downstream, which
   * the upstream query cannot see and which used to read as "Order: Not used"
   * on a transaction that plainly had one.
   *
   * All of them, not the first. Goods from one receipt can answer two orders,
   * and naming one of them is worse than naming none: it reads as the whole
   * answer.
   */
  const linkedLater = orderInChain ? [] : await sql`
    select distinct o.id, o.doc_no
      from fulfilment_link k
      join document_line ol on ol.id = k.order_line_id
      join document o on o.id = fn_current_document(ol.document_id)
      join document_line fl on fl.id = k.fulfilment_line_id
     where o.doc_type = ${orderType}
       and (
         -- upstream: this document bills a goods line that was linked
         exists (
           select 1 from document_line il
            where il.document_id in (${versionsOf(documentId)})
              and il.source_line_id = fl.id)
         -- downstream: goods raised from this document, linked afterwards
         or fl.document_id in (
           select d.id from document d
            where d.source_document_id in (${versionsOf(documentId)})
              and d.status = 'POSTED')
       )
     order by o.doc_no`;

  const order: TransactionOrigin["order"] =
    orderInChain ? { state: "USED", doc: orderInChain }
    : linkedLater.length > 0
      ? { state: "LINKED_LATER",
          docs: (linkedLater as unknown as { id: string; doc_no: string }[])
            .map((o) => ({ id: o.id, doc_no: o.doc_no })) }
      : { state: "NOT_USED" };

  // Everything that moved goods for this invoice, in either direction: the
  // one it was raised from, and any raised from it afterwards.
  const movedFrom = chain.filter((c) => c.doc_type === moveType);
  const movedAfter = await sql`
    select id, doc_no, doc_type from document
     where company_id = ${companyId} and doc_type = ${moveType} and status = 'POSTED'
       and source_document_id in (${versionsOf(documentId)})
     order by doc_no`;
  const fulfilmentAfter =
    movedAfter as unknown as { id: string; doc_no: string; doc_type: string }[];
  const fulfilmentDocs = [...movedFrom, ...fulfilmentAfter];

  // Nothing physical to deliver. A service invoice is complete with no
  // delivery and must not be drawn as waiting for one.
  const [stocked] = await sql`
    select count(*)::int as n
      from document_line dl join item i on i.id = dl.item_id
     where dl.document_id = ${documentId} and i.is_stocked`;

  let fulfilment: OriginFulfilment;
  if (Number(stocked.n) === 0) {
    fulfilment = { state: "NOT_REQUIRED" };
  } else {
    // The same reckoning the two halves of the invoice use, rather than a
    // second opinion about the same goods.
    const progress = await getInvoiceProgress(companyId, documentId);
    const outstanding = Number(progress?.goods.outstanding ?? 0);
    fulfilment =
      fulfilmentDocs.length === 0 ? { state: "PENDING" }
      : outstanding > 0.0001
        ? { state: "PARTIAL", outstanding, unit: progress?.unit ?? null }
        : { state: "DONE" };
  }

  const owed = await getDocumentOutstanding(documentId);
  const gross = Number(doc.gross_total);
  const payment: TransactionOrigin["payment"] =
    owed <= 0.0001 ? "PAID" : owed >= gross - 0.0001 ? "UNPAID" : "PARTIAL";

  return {
    startedFrom: orderInChain ? "ORDER" : chain.length > 0 ? "FULFILMENT" : "INVOICE",
    startDoc: orderInChain ?? chain[chain.length - 1] ?? null,
    order,
    fulfilment,
    fulfilmentBefore: movedFrom,
    fulfilmentAfter,
    payment,
    // The tester's rule, said on the document rather than discovered by
    // pressing a button that is not there: an order-based invoice is
    // corrected at the order.
    correctAt: orderInChain ? { kind: "ORDER", doc: orderInChain } : { kind: "SELF" },
    sales,
  };
}

/**
 * Money this partner has on account, for an invoice that could use it.
 *
 * Matched to the invoice's own kind: a customer's receipt settles a sales
 * invoice and a supplier payment a purchase one, which is the same rule
 * ordinary settlement follows and stops a deposit from one side being offered
 * against the other's bill.
 */
export async function getAdvancesFor(companyId: string, documentId: string) {
  const [doc] = await sql`
    select partner_id, doc_type from document
     where id = ${documentId} and company_id = ${companyId}`;
  if (!doc) return [];
  const kind = doc.doc_type === "PURCHASE_INVOICE" ? "SUPPLIER_PAYMENT" : "CUSTOMER_RECEIPT";

  return sql`
    select payment_id, doc_no, to_char(doc_date, 'YYYY-MM-DD') as doc_date, available
      from v_partner_advance
     where company_id = ${companyId}
       and partner_id = ${doc.partner_id}
       and doc_type = ${kind}
     order by doc_date, doc_no`;
}

/** One application of one advance: which invoice took it, and when. */
export type AdvanceApplication = {
  invoice_id: string;
  invoice_no: string;
  application_id: string | null;
  application_no: string | null;
  applied_on: string;
  amount: number;
};

/** One advance, with what has become of it. */
export type AdvanceRow = {
  id: string;
  doc_no: string;
  doc_date: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  branch: string | null;
  taken: number;
  applied: number;
  remaining: number;
  applications: AdvanceApplication[];
};

/**
 * Every advance taken from a customer or paid to a supplier, and what became
 * of each.
 *
 * v_partner_advance answers a different question — what is still available to
 * apply — and so drops an advance the moment it is fully spent. That is right
 * for the apply panel, which must not offer money that is gone, and wrong for
 * anyone asking what happened to a deposit: the fully spent one is exactly
 * the case where "when was it applied" is the whole question, and until now
 * it left the screens entirely.
 *
 * What makes a receipt an advance is not a flag but where it posted: to the
 * advances account rather than to the control account, because it relieved no
 * invoice. So that is what this asks. A flag would be a second opinion about
 * something the ledger already states, and the two would drift.
 *
 * Applications count only while both the application and the invoice stand,
 * the same condition v_partner_advance and v_open_item apply — so a voided
 * application puts the money back here too, and stops being listed under the
 * advance it once spent.
 */
export async function getAdvanceLedger(
  companyId: string,
  side: "CUSTOMER" | "SUPPLIER"
) {
  const kind = side === "CUSTOMER" ? "CUSTOMER_RECEIPT" : "SUPPLIER_PAYMENT";
  const role = side === "CUSTOMER" ? "CUSTOMER_ADVANCE" : "SUPPLIER_ADVANCE";

  // Joined through system_account rather than fn_system_account, which raises
  // when the role is not configured: a company set up before the advance
  // accounts existed should see an empty list, not an error page.
  const advances = sql`
    select d.id
      from document d
     where d.company_id = ${companyId}
       and d.doc_type = ${kind}
       and d.status = 'POSTED'
       -- Voiding a receipt reverses it: the original goes to REVERSED, which
       -- the status test above drops, and a mirror document is posted for the
       -- negative. That mirror is not an advance anybody holds, and counting
       -- it would subtract returned money from the deposits still held.
       and d.reverses_document_id is null
       and exists (
             select 1 from journal_line jl
               join system_account sa
                 on sa.account_id = jl.account_id
                and sa.company_id = d.company_id
                and sa.role = ${role}
              where jl.journal_entry_id = d.journal_entry_id)`;

  const rows = await sql`
    select d.id, d.doc_no, to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
           d.partner_id, p.code as partner_code, p.name as partner_name,
           l.name as branch,
           d.gross_total::float                                    as taken,
           coalesce(a.applied, 0)::float                           as applied,
           (d.gross_total - coalesce(a.applied, 0))::float         as remaining
      from document d
      join business_partner p on p.id = d.partner_id
      left join location l on l.id = d.location_id
      left join (
            select pa.payment_id, sum(pa.amount) as applied
              from payment_allocation pa
              join document inv on inv.id = pa.invoice_id
              left join document app on app.id = pa.applied_by_document_id
             where inv.status = 'POSTED'
               and (pa.applied_by_document_id is null or app.status = 'POSTED')
             group by pa.payment_id
      ) a on a.payment_id = d.id
     where d.id in (${advances})
     order by d.doc_date desc, d.doc_no desc`;

  const applied = await sql`
    select pa.payment_id,
           pa.invoice_id, inv.doc_no as invoice_no,
           pa.applied_by_document_id as application_id,
           app.doc_no as application_no,
           -- The application document's own date where there is one. An
           -- allocation made at the moment the money was taken has no
           -- application document and no date of its own but the payment's.
           to_char(coalesce(app.doc_date, pa.created_at::date), 'YYYY-MM-DD') as applied_on,
           pa.amount::float as amount
      from payment_allocation pa
      join document inv on inv.id = pa.invoice_id
      left join document app on app.id = pa.applied_by_document_id
     where pa.company_id = ${companyId}
       and pa.payment_id in (${advances})
       and inv.status = 'POSTED'
       and (pa.applied_by_document_id is null or app.status = 'POSTED')
     order by 6, app.doc_no, inv.doc_no`;

  const byPayment = new Map<string, AdvanceApplication[]>();
  for (const a of applied as unknown as (AdvanceApplication & { payment_id: string })[]) {
    const list = byPayment.get(a.payment_id) ?? [];
    list.push(a);
    byPayment.set(a.payment_id, list);
  }

  return (rows as unknown as AdvanceRow[]).map((r) => ({
    ...r, applications: byPayment.get(r.id) ?? [],
  }));
}

/**
 * Every version of a document number, oldest first.
 *
 * A correction keeps the number and posts the next version, so the number on
 * a customer's copy has to lead to all of them: the one standing now, and
 * every one it replaced, each with the reason it was replaced and by whom.
 * That last part is the point — a version history without the reason is a
 * list of numbers that changed, which tells nobody anything.
 *
 * The AMEND row sits on the version that was replaced, not on its
 * replacement, so the reason reads as "why this one stopped being right".
 */
export async function getDocumentVersions(companyId: string, docNo: string | null) {
  if (!docNo) return [];
  return sql`
    select d.id, d.version, d.status, d.gross_total, d.doc_date,
           d.superseded_by_document_id is not null as superseded,
           h.reason, h.acted_at,
           u.name as edited_by, u.initials as edited_initials
      from document d
      left join document_history h
             on h.document_id = d.id and h.action = 'AMEND'
      left join app_user u on u.id = h.acted_by
     where d.company_id = ${companyId} and d.doc_no = ${docNo}
     order by d.version`;
}

// ------------------------------------------------------- consignment --

/**
 * Every consignment agreement, with its item lines nested — the settlement
 * rule each item is received under, and how much of it is currently on
 * consigned stock (received minus consumed, derived rather than stored, the
 * same as every other on-hand figure in this app).
 */
export async function getConsignmentAgreements(companyId: string) {
  return sql`
    -- Quoted, so Postgres keeps the capitals. The keys inside the lines below
    -- are built camelCase by json_build_object and the screens read them that
    -- way; these three came back partner_name and friends, so every consignor
    -- rendered blank — and worse, the receive form's dropdown carried an
    -- undefined value, so choosing a consignor matched no agreement and the
    -- items section with the quantity box never appeared at all.
    select ag.id, ag.memo, ag.created_at,
           p.id as "partnerId", p.code as "partnerCode", p.name as "partnerName",
           coalesce(json_agg(json_build_object(
             'lineId', al.id,
             'itemId', i.id, 'itemCode', i.code, 'itemName', i.name,
             'pricingMethod', al.pricing_method, 'pricingValue', al.pricing_value,
             'isActive', al.is_active,
             'onHand', coalesce(lot.on_hand, 0)
           ) order by i.code) filter (where al.id is not null), '[]') as lines
      from consignment_agreement ag
      join business_partner p on p.id = ag.partner_id
      left join consignment_agreement_line al on al.agreement_id = ag.id
      left join item i on i.id = al.item_id
      left join lateral (
            select sum(cl.qty_received) - coalesce(sum(consumed.qty), 0) as on_hand
              from consignment_lot cl
              left join lateral (
                    select sum(c.qty) as qty from consignment_lot_consumption c
                     where c.lot_id = cl.id
              ) consumed on true
             where cl.agreement_line_id = al.id
      ) lot on true
     where ag.company_id = ${companyId}
     group by ag.id, ag.memo, ag.created_at, p.id, p.code, p.name
     order by p.name`;
}

/**
 * Suppliers with a consignment agreement on file — the only partners a
 * consignment receipt can legally name, so this is the receive form's
 * supplier list rather than every supplier in the company.
 */
/**
 * Suppliers a new consignment agreement could be made with: every active
 * supplier that does not already have one, since consignment_agreement is
 * unique per (company, partner).
 *
 * This deliberately reads from business_partner rather than from the
 * agreements themselves. Sourcing it from consignment_agreement — as it was
 * originally written — meant the "new agreement" dropdown only ever offered
 * consignors who already had an agreement, so the first one could never be
 * created through the UI on a database that had suppliers but no agreements.
 */
export async function getConsignmentSupplierChoices(companyId: string) {
  return sql`
    select p.id, p.code, p.name
      from business_partner p
     where p.company_id = ${companyId}
       and p.is_supplier
       and p.is_active
       and not exists (
             select 1 from consignment_agreement ag
              where ag.company_id = p.company_id and ag.partner_id = p.id
           )
     order by p.code`;
}

/**
 * Consigned stock currently on hand, item by item, with the consignor(s) and
 * rate(s) behind it — the breakdown a consignment sale needs to preview its
 * settlement, and what the inventory screen shows to make ownership visible
 * rather than folding consigned units into one on-hand figure that does not
 * say whose they are.
 */
export async function getConsignedStockOnHand(companyId: string) {
  return sql`
    select i.id as item_id, i.code as item_code, i.name as item_name,
           l.id as location_id, l.code as location_code, l.name as location_name,
           p.id as consignor_id, p.code as consignor_code, p.name as consignor_name,
           al.pricing_method, al.pricing_value,
           sum(cl.qty_received) - coalesce(sum(consumed.qty), 0) as on_hand
      from consignment_lot cl
      join item i on i.id = cl.item_id
      join location l on l.id = cl.location_id
      join consignment_agreement_line al on al.id = cl.agreement_line_id
      join consignment_agreement ag on ag.id = al.agreement_id
      join business_partner p on p.id = ag.partner_id
      left join lateral (
            select sum(c.qty) as qty from consignment_lot_consumption c
             where c.lot_id = cl.id
      ) consumed on true
     where cl.company_id = ${companyId}
     group by i.id, i.code, i.name, l.id, l.code, l.name,
              p.id, p.code, p.name, al.pricing_method, al.pricing_value
    having sum(cl.qty_received) - coalesce(sum(consumed.qty), 0) > 0.0001
     order by i.code, l.code`;
}

/**
 * Owned on-hand for the same items that carry consigned stock, joined
 * alongside it — what makes "owned 100 / consigned 50" possible to show as
 * one line rather than two screens the reader has to reconcile by hand.
 */
export async function getOwnedStockForItems(companyId: string, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  return sql`
    select item_id, location_id, qty_on_hand
      from v_stock_on_hand
     where company_id = ${companyId} and item_id = any(${itemIds})`;
}

/**
 * Everything the spreadsheet importer checks a row against. One round trip,
 * because the validator is pure and needs the whole picture in hand before it
 * can say anything about a file.
 */
export async function getImportMasterData(companyId: string) {
  const [items, categories, brands, uoms] = await Promise.all([
    sql`select id, code, serial, name, barcode, item_group_id, brand_id, base_uom_id
          from item where company_id = ${companyId} and is_active`,
    sql`select id, code, name, parent_id from item_group
          where company_id = ${companyId} and is_active`,
    sql`select id, code, name from brand where company_id = ${companyId} and is_active`,
    sql`select id, code, name from uom where company_id = ${companyId} and is_active`,
  ]);
  return { items, categories, brands, uoms };
}

/**
 * Everything that has been voided or edited, newest first.
 *
 * The log is the point of the feature: a document that vanished from a list
 * with no trace is indistinguishable from one that was never entered, and
 * that is precisely the property this system is sold as not having. So every
 * void and every edit is readable here, with what the document said before,
 * what replaced or reversed it, and when.
 *
 * `acted_by` is selected even though nothing sets it yet. When there are
 * users, rows written from that day carry one and older rows keep their
 * honest null — which is a better answer than attributing them to whoever
 * happened to be added first.
 */
export async function getDocumentHistory(companyId: string, limit = 200) {
  return sql`
    select h.id, h.action, h.reason, h.detail, h.acted_by, h.acted_at,
           d.id            as document_id,
           d.doc_no        as document_no,
           d.doc_type,
           d.status,
           to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
           d.gross_total,
           p.name          as partner_name,
           r.id            as related_document_id,
           r.doc_no        as related_no,
           r.doc_type      as related_type
      from document_history h
      join document d on d.id = h.document_id
      left join document r on r.id = h.related_id
      left join business_partner p on p.id = d.partner_id
     where h.company_id = ${companyId}
     order by h.acted_at desc
     limit ${limit}`;
}

/**
 * Negative Stock — Pending Reconciliation.
 *
 * Stock that went out before anything recorded it arriving, still awaiting a
 * receipt or an adjustment. Each row carries the price it was charged out at
 * and the document that price came from, so the reconciliation screen states
 * both rather than asking someone to supply a figure.
 */
export async function getNegativeStock(companyId: string) {
  return sql`
    select * from v_negative_stock
     where company_id = ${companyId}
     order by created_at`;
}

/** Past imports, newest first, with what each one actually created. */
export async function getImportBatches(companyId: string) {
  return sql`
    select b.id, b.ref, b.filename, b.row_count, b.status, b.created_at,
           (select count(*)::int from item i where i.import_batch_id = b.id) as items_created,
           (select count(*)::int from document d where d.import_batch_id = b.id) as documents
      from import_batch b
     where b.company_id = ${companyId}
     order by b.created_at desc`;
}

/** Everything the cash/bank receipt importer checks a row against. */
export async function getVoucherImportMasterData(companyId: string) {
  const [accounts, locations, openPeriods] = await Promise.all([
    sql`select id, code, name, is_postable, is_control, is_cash_account, is_bank_account
          from account where company_id = ${companyId} and is_active order by code`,
    sql`select id, code, name, parent_id, is_active
          from location where company_id = ${companyId}`,
    // Checked up front so a date in a closed period is reported against its
    // row, rather than failing the whole import at the moment of posting.
    sql`select to_char(start_date, 'YYYY-MM-DD') as start_date,
               to_char(end_date, 'YYYY-MM-DD') as end_date
          from fiscal_period where company_id = ${companyId} and status = 'OPEN'`,
  ]);
  return { accounts, locations, openPeriods };
}

// ------------------------------------------------------- journal entries --

export type JournalEntryFilters = {
  from?: string;
  to?: string;
  accountId?: string;
  locationId?: string;
  docType?: string;
  docNo?: string;
  q?: string;
};

/**
 * Every posted entry, newest first, with its own debit and credit totals —
 * the ledger read chronologically rather than one account at a time.
 *
 * The general ledger answers "what happened to this account". This answers
 * "what has been posted", which is the question someone asks when they are
 * looking for a document rather than reconciling a balance, and it was the
 * one screen the app had no answer for.
 *
 * Filtering is done here rather than in the browser because the entry list
 * grows with every document ever posted, unlike the master-data lists that
 * DataTable filters client-side.
 */
export async function getJournalEntries(companyId: string, f: JournalEntryFilters = {}) {
  const like = (v?: string) => (v && v.trim() ? `%${v.trim()}%` : null);
  const docNo = like(f.docNo);
  const q = like(f.q);

  return sql`
    select je.id, je.entry_no,
           to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
           je.memo, je.source_type,
           d.id as document_id, d.doc_no, d.doc_type, d.status,
           p.name as partner_name,
           sum(case when jl.base_amount > 0 then  jl.base_amount else 0 end) as debit,
           sum(case when jl.base_amount < 0 then -jl.base_amount else 0 end) as credit
      from journal_entry je
      join journal_line jl on jl.journal_entry_id = je.id
      left join document d on d.id = je.source_id
      left join business_partner p on p.id = d.partner_id
     where je.company_id = ${companyId}
       ${f.from ? sql`and je.entry_date >= ${f.from}::date` : sql``}
       ${f.to ? sql`and je.entry_date <= ${f.to}::date` : sql``}
       ${f.docType ? sql`and d.doc_type = ${f.docType}` : sql``}
       ${docNo ? sql`and d.doc_no ilike ${docNo}` : sql``}
       ${q ? sql`and (je.memo ilike ${q} or d.doc_no ilike ${q} or je.entry_no ilike ${q})` : sql``}
       -- An account or a branch filter asks whether the entry touches one,
       -- not whether every line does: an entry is the unit here, and showing
       -- half of one would make it look unbalanced.
       ${f.accountId ? sql`
         and exists (select 1 from journal_line x
                      where x.journal_entry_id = je.id and x.account_id = ${f.accountId})` : sql``}
       ${f.locationId ? sql`
         and exists (select 1 from journal_line x
                      where x.journal_entry_id = je.id
                        ${branchFilterOn(sql`x`, f.locationId)})` : sql``}
     group by je.id, je.entry_no, je.entry_date, je.memo, je.source_type,
              d.id, d.doc_no, d.doc_type, d.status, p.name
     order by je.entry_date desc, je.entry_no desc
     limit 500`;
}

/** The lines behind a set of entries, for the rows the list expands. */
export async function getJournalEntryLines(companyId: string, entryIds: string[]) {
  if (entryIds.length === 0) return [];
  return sql`
    select jl.journal_entry_id, jl.line_no, jl.base_amount, jl.memo,
           a.code as account_code, a.name as account_name,
           p.name as partner_name, l.code as location_code
      from journal_line jl
      join account a on a.id = jl.account_id
      left join business_partner p on p.id = jl.partner_id
      left join location l on l.id = jl.location_id
     where jl.company_id = ${companyId} and jl.journal_entry_id = any(${entryIds})
     order by jl.journal_entry_id, jl.line_no`;
}

/** One entry, its lines, and the document that wrote it. */
export async function getJournalEntry(companyId: string, entryId: string) {
  const [entry] = await sql`
    select je.id, je.entry_no, je.memo, je.source_type,
           to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
           d.id as document_id, d.doc_no, d.doc_type, d.status,
           d.gross_total, p.name as partner_name, p.code as partner_code
      from journal_entry je
      left join document d on d.id = je.source_id
      left join business_partner p on p.id = d.partner_id
     where je.company_id = ${companyId} and je.id = ${entryId}`;
  if (!entry) return null;

  const lines = await sql`
    select jl.line_no, jl.base_amount, jl.memo,
           a.id as account_id, a.code as account_code, a.name as account_name,
           p.name as partner_name, l.code as location_code
      from journal_line jl
      join account a on a.id = jl.account_id
      left join business_partner p on p.id = jl.partner_id
      left join location l on l.id = jl.location_id
     where jl.company_id = ${companyId} and jl.journal_entry_id = ${entryId}
     order by jl.line_no`;

  return { entry, lines };
}

// --------------------------------------------------------- trial balance --

export type TrialBalanceFilters = {
  asOf?: string;
  locationId?: string;
  accountType?: string;
};

/**
 * Every account that has moved, with its closing balance on the side it
 * naturally falls.
 *
 * Written against journal_line rather than v_trial_balance because that view
 * groups by fiscal period and has no date bound — a trial balance is always
 * "as at", and asking for one as at the 30th is the normal case, not a
 * variant. The Type column is the section the chart files the account under,
 * not the six-member account_type enum: a chart draws finer distinctions than
 * the enum does, and "Current Assets" is what an accountant expects to read.
 */
export async function getTrialBalanceAsOf(companyId: string, f: TrialBalanceFilters = {}) {
  return sql`
    select a.id, a.code, a.name, a.account_type,
           coalesce(sec.name, initcap(lower(a.account_type::text))) as section,
           sum(case when jl.base_amount > 0 then  jl.base_amount else 0 end) as debit,
           sum(case when jl.base_amount < 0 then -jl.base_amount else 0 end) as credit,
           sum(jl.base_amount) as balance
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
      left join account sec on sec.id = a.parent_id
     where jl.company_id = ${companyId}
       ${f.asOf ? sql`and je.entry_date <= ${f.asOf}::date` : sql``}
       ${branchFilter(f.locationId)}
       ${f.accountType ? sql`and a.account_type = ${f.accountType}` : sql``}
     group by a.id, a.code, a.name, a.account_type, sec.name
     -- An account that moved and came back to nil is still part of the
     -- period's story, so it stays: only accounts that never moved are out.
     having sum(case when jl.base_amount > 0 then jl.base_amount else 0 end) <> 0
         or sum(case when jl.base_amount < 0 then jl.base_amount else 0 end) <> 0
     order by a.code`;
}

/**
 * One account's movements, optionally within one branch, with a running
 * balance computed over exactly the rows returned.
 *
 * v_account_ledger cannot do this: its running balance is a window over every
 * movement on the account, so filtering rows out from under it leaves a
 * balance that disagrees with its own column. Computing the window after the
 * filter gives the branch's own running balance, which is the figure someone
 * asking for one branch is actually after.
 */
export async function getAccountLedgerFiltered(
  companyId: string, accountId: string,
  f: { from?: string; to?: string; branchId?: string | null } = {},
) {
  return sql`
    select je.entry_no, je.entry_date, je.memo, je.source_type,
           d.doc_no, d.doc_type, p.name as partner_name, l.code as location_code,
           case when jl.base_amount > 0 then  jl.base_amount else 0 end as debit,
           case when jl.base_amount < 0 then -jl.base_amount else 0 end as credit,
           sum(jl.base_amount) over (
             order by je.entry_date, je.entry_no, jl.line_no
             rows between unbounded preceding and current row
           ) as running_balance
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      left join document d on d.id = je.source_id
      left join business_partner p on p.id = jl.partner_id
      left join location l on l.id = jl.location_id
     where jl.company_id = ${companyId} and jl.account_id = ${accountId}
       ${f.from ? sql`and je.entry_date >= ${f.from}::date` : sql``}
       ${f.to ? sql`and je.entry_date <= ${f.to}::date` : sql``}
       ${branchFilter(f.branchId)}
     order by je.entry_date, je.entry_no, jl.line_no`;
}

/**
 * The four figures that frame those movements. Opening is its own sum rather
 * than the first row's running balance — that balance already includes its
 * own row, so reading it would double-count the first movement of the period.
 */
export async function getAccountSummary(
  companyId: string, accountId: string,
  f: { from?: string; to?: string; branchId?: string | null } = {},
) {
  const [row] = await sql`
    select
      coalesce(sum(case when ${f.from ? sql`je.entry_date < ${f.from}::date` : sql`false`}
                        then jl.base_amount else 0 end), 0) as opening,
      coalesce(sum(case when jl.base_amount > 0
                         and ${f.from ? sql`je.entry_date >= ${f.from}::date` : sql`true`}
                         and ${f.to ? sql`je.entry_date <= ${f.to}::date` : sql`true`}
                        then jl.base_amount else 0 end), 0) as debits,
      coalesce(sum(case when jl.base_amount < 0
                         and ${f.from ? sql`je.entry_date >= ${f.from}::date` : sql`true`}
                         and ${f.to ? sql`je.entry_date <= ${f.to}::date` : sql`true`}
                        then -jl.base_amount else 0 end), 0) as credits,
      coalesce(sum(case when ${f.to ? sql`je.entry_date <= ${f.to}::date` : sql`true`}
                        then jl.base_amount else 0 end), 0) as closing
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
     where jl.company_id = ${companyId} and jl.account_id = ${accountId}
       ${branchFilter(f.branchId)}`;
  return {
    opening: Number(row?.opening ?? 0),
    debits: Number(row?.debits ?? 0),
    credits: Number(row?.credits ?? 0),
    closing: Number(row?.closing ?? 0),
  };
}

// -------------------------------------------------------------- cutover --

/** The posted cutover, if this company has had one. */
export async function getOpeningBatch(companyId: string) {
  const [batch] = await sql`
    select id, to_char(cutover_date, 'YYYY-MM-DD') as cutover_date, memo, posted_at
      from opening_batch
     where company_id = ${companyId} and status = 'POSTED'
     limit 1`;
  if (!batch) return null;
  const documents = await sql`
    select d.id, d.doc_no, d.doc_type, d.gross_total, d.reference,
           to_char(d.doc_date, 'YYYY-MM-DD') as doc_date, p.name as partner_name
      from document d
      left join business_partner p on p.id = d.partner_id
     where d.opening_batch_id = ${batch.id}
     order by d.doc_type, d.doc_no`;
  return { batch, documents };
}

// --------------------------------------------------- stock by ownership --

/**
 * What is physically on the shelf, split by who owns it.
 *
 * A hundred shirts in one place can be sixty of yours and forty of two
 * consignors', and the difference is not visible in the warehouse — only
 * here. Owned stock is an asset on the balance sheet; consigned stock is
 * somebody else's goods you are holding, and selling the wrong one posts the
 * wrong accounting. So the split has to be readable before the sale, not
 * reconstructed from the ledger after it.
 */
export async function getStockByOwnership(
  companyId: string, itemId: string, locationId: string,
) {
  const [owned] = await sql`
    select coalesce(fn_qty_on_hand(${companyId}, ${itemId}, ${locationId}), 0) as qty`;

  const consigned = await sql`
    select d.partner_id as consignor_id, p.code as consignor_code, p.name as consignor_name,
           sum(cl.qty_received - coalesce(c.used, 0)) as qty
      from consignment_lot cl
      join document d on d.id = cl.receipt_document_id
      join business_partner p on p.id = d.partner_id
      left join (
        select lot_id, sum(qty) as used from consignment_lot_consumption group by lot_id
      ) c on c.lot_id = cl.id
     where cl.company_id = ${companyId} and cl.item_id = ${itemId}
       and cl.location_id = ${locationId}
     group by d.partner_id, p.code, p.name
    having sum(cl.qty_received - coalesce(c.used, 0)) > 0.0001
     order by p.code`;

  return {
    owned: Number(owned?.qty ?? 0),
    consigned: consigned.map((r: any) => ({
      consignorId: r.consignor_id as string,
      code: r.consignor_code as string,
      name: r.consignor_name as string,
      qty: Number(r.qty),
    })),
  };
}

/** The same split for every item a location holds, for the picker to read. */
export async function getOwnershipMap(companyId: string) {
  const owned = await sql`
    select item_id, location_id, qty_on_hand as qty
      from v_stock_on_hand where company_id = ${companyId}`;
  const consigned = await sql`
    select cl.item_id, cl.location_id, d.partner_id as consignor_id,
           p.code as consignor_code, p.name as consignor_name,
           sum(cl.qty_received - coalesce(c.used, 0)) as qty
      from consignment_lot cl
      join document d on d.id = cl.receipt_document_id
      join business_partner p on p.id = d.partner_id
      left join (
        select lot_id, sum(qty) as used from consignment_lot_consumption group by lot_id
      ) c on c.lot_id = cl.id
     where cl.company_id = ${companyId}
     group by cl.item_id, cl.location_id, d.partner_id, p.code, p.name
    having sum(cl.qty_received - coalesce(c.used, 0)) > 0.0001`;
  return { owned, consigned };
}

/** Consigned goods on this delivery with no settlement standing against them. */
export async function getUnsettledConsignment(companyId: string, deliveryId: string) {
  const rows = await sql`
    select u.consumption_id, u.qty, i.code as item_code, i.name as item_name,
           p.name as consignor_name
      from v_consignment_unsettled u
      join item i on i.id = u.item_id
      join business_partner p on p.id = u.consignor_id
     where u.company_id = ${companyId} and u.delivery_document_id = ${deliveryId}`;
  return rows as unknown as {
    consumption_id: string; qty: string;
    item_code: string; item_name: string; consignor_name: string;
  }[];
}
