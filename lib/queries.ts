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

  return { stock, ar, ap, cash };
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
  const [so] = await sql`
    select
      count(distinct o.id)::int as open,
      count(distinct o.id) filter (
        where o.due_date is not null and o.due_date < current_date
      )::int as overdue
      from document o
      join document_line ol on ol.document_id = o.id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as delivered_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'DELIVERY' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) d on d.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'SALES_ORDER' and o.status = 'POSTED'
       and (ol.base_qty - coalesce(d.delivered_qty, 0)) > 0.0001`;

  const [po] = await sql`
    select
      count(distinct o.id)::int as open,
      count(distinct o.id) filter (
        where o.due_date is not null and o.due_date < current_date
      )::int as overdue
      from document o
      join document_line ol on ol.document_id = o.id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as received_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'GOODS_RECEIPT' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) r on r.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'PURCHASE_ORDER' and o.status = 'POSTED'
       and (ol.base_qty - coalesce(r.received_qty, 0)) > 0.0001`;

  const [pd] = await sql`
    select count(*)::int as n
      from document inv
     where inv.company_id = ${companyId} and inv.doc_type = 'SALES_INVOICE'
       and inv.to_deliver and inv.status = 'POSTED'
       and not exists (
         select 1 from document dd where dd.source_document_id = inv.id and dd.doc_type = 'DELIVERY'
       )`;

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

  const [custOverdue] = await sql`
    select coalesce(sum(outstanding), 0) as total, count(*)::int as n
      from v_open_item
     where company_id = ${companyId} and doc_type = 'SALES_INVOICE' and aging_bucket <> 'CURRENT'`;

  const [supOverdue] = await sql`
    select coalesce(sum(outstanding), 0) as total, count(*)::int as n
      from v_open_item
     where company_id = ${companyId} and doc_type = 'PURCHASE_INVOICE' and aging_bucket <> 'CURRENT'`;

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
    salesOrders: { open: Number(so.open), overdue: Number(so.overdue) },
    purchaseOrders: { open: Number(po.open), overdue: Number(po.overdue) },
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
    select partner_id, partner_code, partner_name,
           open_invoices, invoiced, paid, outstanding, overdue, due_soon, credit_limit
      from v_partner_balance
     where company_id = ${companyId} and doc_type = ${docType}
     order by outstanding desc`;
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
 * Goods receipts that still have something to bill, with each line's
 * remaining quantity rather than its original one.
 *
 * Offering the full received quantity was wrong the moment any of it had
 * been invoiced: prefilling an invoice from a receipt already half billed
 * would bill the same goods twice. Remaining is replayed through the same
 * matcher the ledger settles with, so what the form offers and what GR/IR
 * still holds are the same figure.
 */
export async function getOpenGoodsReceipts(companyId: string) {
  const docs = await sql`
    select d.id, d.doc_no, d.doc_date, d.partner_id
      from document d
      join v_grir_balance g on g.document_id = d.id and g.company_id = d.company_id
     where d.company_id = ${companyId} and d.doc_type = 'GOODS_RECEIPT' and d.status = 'POSTED'
     order by d.doc_date desc, d.doc_no desc
     limit 200`;
  if (docs.length === 0) return [];

  const ids = docs.map((d: any) => d.id);

  const lines = await sql`
    select dl.id, dl.document_id, dl.item_id, dl.base_qty as qty, dl.net_amount as net,
           dl.unit_price, i.code as item_code, i.name as item_name
      from document_line dl
      join item i on i.id = dl.item_id
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

      const open = own
        .map((l: any) => ({
          lineId: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          qty: Math.round((Number(l.qty) - (billed.get(l.id) ?? 0)) * 10000) / 10000,
          unitPrice: Number(l.unit_price),
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
 */
export async function getOpenPurchaseInvoices(companyId: string) {
  return sql`
    select d.id, d.doc_no, d.doc_date, d.partner_id,
           coalesce(json_agg(json_build_object(
             'itemId', dl.item_id, 'itemCode', i.code, 'itemName', i.name,
             'qty', dl.base_qty, 'unitPrice', dl.unit_price
           ) order by dl.line_no), '[]') as lines
      from document d
      join v_grir_balance g on g.document_id = d.id and g.company_id = d.company_id
      join document_line dl on dl.document_id = d.id
      join item i on i.id = dl.item_id
     where d.company_id = ${companyId} and d.doc_type = 'PURCHASE_INVOICE' and d.status = 'POSTED'
     group by d.id, d.doc_no, d.doc_date, d.partner_id
     order by d.doc_date desc, d.doc_no desc
     limit 200`;
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
export async function getOpenDeliveries(companyId: string) {
  return sql`
    select d.id, d.doc_no, d.doc_date, d.partner_id, d.location_id,
           coalesce(json_agg(json_build_object(
             'itemId', dl.item_id, 'itemCode', i.code, 'itemName', i.name,
             'qty', dl.base_qty
           ) order by dl.line_no), '[]') as lines
      from document d
      join document_line dl on dl.document_id = d.id
      join item i on i.id = dl.item_id
     where d.company_id = ${companyId} and d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       and not exists (
         select 1 from document si
          where si.doc_type = 'SALES_INVOICE' and si.status = 'POSTED'
            and (si.source_document_id = d.id or d.source_document_id = si.id)
       )
     group by d.id, d.doc_no, d.doc_date, d.partner_id, d.location_id
     order by d.doc_date desc, d.doc_no desc
     limit 200`;
}

export async function getDocument(id: string) {
  const [doc] = await sql`
    select d.*, p.name as partner_name, p.code as partner_code,
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
      from document where source_document_id = ${documentId}
     order by posting_date`;
}

/** What's still unpaid on an invoice — 0 for anything that isn't one. */
export async function getDocumentOutstanding(documentId: string): Promise<number> {
  const [row] = await sql`select outstanding from v_open_item where document_id = ${documentId}`;
  return row ? Number(row.outstanding) : 0;
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
      select id, doc_type, doc_no, source_document_id from document where id = ${cursor}`) as Row[];
    if (!row || seen.has(row.id)) break;
    seen.set(row.id, row);
    cursor = row.source_document_id;
  }

  let frontier = [self.id];
  for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
    const rows = (await sql`
      select id, doc_type, doc_no, source_document_id
        from document where source_document_id = any(${frontier})`) as Row[];
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
  const fulfilmentType = docType === "SALES_ORDER" ? "DELIVERY" : "GOODS_RECEIPT";

  return sql`
    select o.id as document_id, o.doc_no, o.posting_date, o.due_date,
           o.partner_id, p.code as partner_code, p.name as partner_name,
           o.gross_total, o.status as doc_status,
           coalesce(sum(ol.base_qty), 0)      as ordered_qty,
           coalesce(sum(fl.line_fulfilled), 0) as fulfilled_qty
      from document o
      join business_partner p on p.id = o.partner_id
      left join document_line ol on ol.document_id = o.id
      left join (
            select dl.source_line_id, sum(dl.base_qty) as line_fulfilled
              from document_line dl
              join document dd on dd.id = dl.document_id
             where dd.company_id = ${companyId} and dd.doc_type = ${fulfilmentType} and dd.status = 'POSTED'
             group by dl.source_line_id
      ) fl on fl.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = ${docType}
     group by o.id, o.doc_no, o.posting_date, o.due_date,
              o.partner_id, p.code, p.name, o.gross_total, o.status
     order by o.posting_date desc, o.doc_no desc`;
}

export async function getOpenSalesOrders(companyId: string) {
  return sql`
    select o.id as order_id, o.doc_no as order_no, o.partner_id, p.name as partner_name,
           o.location_id,
           ol.id as line_id, ol.item_id, i.code as item_code, i.name as item_name,
           ol.base_qty as ordered_qty,
           coalesce(d.delivered_qty, 0) as delivered_qty,
           ol.base_qty - coalesce(d.delivered_qty, 0) as remaining_qty
      from document o
      join document_line ol on ol.document_id = o.id
      join item i on i.id = ol.item_id
      join business_partner p on p.id = o.partner_id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as delivered_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'DELIVERY' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) d on d.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'SALES_ORDER' and o.status = 'POSTED'
       and (ol.base_qty - coalesce(d.delivered_qty, 0)) > 0
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
           ol.base_qty - coalesce(r.received_qty, 0) as remaining_qty
      from document o
      join document_line ol on ol.document_id = o.id
      join item i on i.id = ol.item_id
      join business_partner p on p.id = o.partner_id
      left join (
        select dl.source_line_id, sum(dl.base_qty) as received_qty
          from document_line dl join document dd on dd.id = dl.document_id
         where dd.doc_type = 'GOODS_RECEIPT' and dd.status = 'POSTED'
         group by dl.source_line_id
      ) r on r.source_line_id = ol.id
     where o.company_id = ${companyId} and o.doc_type = 'PURCHASE_ORDER' and o.status = 'POSTED'
       and (ol.base_qty - coalesce(r.received_qty, 0)) > 0
     order by o.doc_no, ol.line_no`;
}

/** Sales invoices marked "to deliver" that no delivery has fulfilled yet. */
export async function getPendingDeliveries(companyId: string) {
  return sql`
    select inv.id, inv.doc_no, inv.doc_date, p.name as partner_name,
           count(il.id)::int as lines, sum(il.base_qty)::numeric as total_qty
      from document inv
      join document_line il on il.document_id = inv.id
      join business_partner p on p.id = inv.partner_id
     where inv.company_id = ${companyId} and inv.doc_type = 'SALES_INVOICE'
       and inv.to_deliver and inv.status = 'POSTED'
       and not exists (
         select 1 from document dd where dd.source_document_id = inv.id and dd.doc_type = 'DELIVERY'
       )
     group by inv.id, inv.doc_no, inv.doc_date, p.name
     order by inv.doc_date`;
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
    invoice_pending as (
      select il.item_id, il.location_id, sum(il.base_qty) as qty
        from document inv
        join document_line il on il.document_id = inv.id
       where inv.company_id = ${companyId} and inv.doc_type = 'SALES_INVOICE'
         and inv.to_deliver and inv.status = 'POSTED'
         and not exists (
           select 1 from document dd where dd.source_document_id = inv.id and dd.doc_type = 'DELIVERY'
         )
       group by il.item_id, il.location_id
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
  if (!branchId) return sql``;
  // Entries posted before the branch dimension was stamped carry no location
  // and belong to no branch. They still count in the consolidated company
  // figures, so without a way to see them the branches would silently fail to
  // add up to the company total and there would be nothing on screen saying
  // why. This makes that remainder selectable instead of invisible.
  if (branchId === UNASSIGNED_BRANCH) return sql`and jl.location_id is null`;
  return sql`and exists (
          select 1 from location w
           where w.id = jl.location_id
             and coalesce(w.parent_id, w.id) = ${branchId})`;
}

/** How much activity carries no branch at all, so a report can say so. */
export async function getUnassignedBranchActivity(companyId: string) {
  const [r] = await sql`
    select count(*)::int as lines
      from journal_line jl
     where jl.company_id = ${companyId} and jl.location_id is null`;
  return Number(r?.lines ?? 0);
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
export async function getCashFlowStatement(companyId: string, from: string, to: string) {
  const [rows, beginning, ending] = await Promise.all([
    sql`
      select
        case
          when je.source_type in ('CUSTOMER_RECEIPT', 'SALES_INVOICE') then 'Received from customers'
          when je.source_type = 'SUPPLIER_PAYMENT' then 'Paid to suppliers'
          when a2.account_type = 'REVENUE' then 'Received from customers'
          when a2.account_type = 'COGS' then 'Paid to suppliers'
          when a2.account_type = 'EXPENSE' then 'Operating expenses paid'
          when a2.account_type = 'EQUITY' then 'Owner contributions / drawings'
          when a2.account_type = 'LIABILITY' then 'Loans and other liabilities'
          when a2.account_type = 'ASSET' then 'Purchase / sale of fixed assets'
          else 'Other'
        end as category,
        case
          when je.source_type in ('CUSTOMER_RECEIPT', 'SALES_INVOICE', 'SUPPLIER_PAYMENT')
            or a2.account_type in ('REVENUE', 'COGS', 'EXPENSE') then 'operating'
          when a2.account_type = 'ASSET' then 'investing'
          when a2.account_type in ('EQUITY', 'LIABILITY') then 'financing'
          else 'operating'
        end as section,
        -sum(jl2.base_amount) as amount
        from journal_line jl_cash
        join journal_entry je on je.id = jl_cash.journal_entry_id
        join account a_cash on a_cash.id = jl_cash.account_id
        join journal_line jl2 on jl2.journal_entry_id = je.id and jl2.id <> jl_cash.id
        join account a2 on a2.id = jl2.account_id
       where jl_cash.company_id = ${companyId}
         and (a_cash.is_cash_account or a_cash.is_bank_account)
         and not (a2.is_cash_account or a2.is_bank_account)
         and je.entry_date between ${from}::date and ${to}::date
       group by category, section
       order by section, category`,
    sql`
      select coalesce(sum(jl.base_amount), 0) as balance
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and (a.is_cash_account or a.is_bank_account)
         and je.entry_date < ${from}::date`,
    sql`
      select coalesce(sum(jl.base_amount), 0) as balance
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where jl.company_id = ${companyId}
         and (a.is_cash_account or a.is_bank_account)
         and je.entry_date <= ${to}::date`,
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

  const fulfilled = await sql`
    select dl.item_id, dl.base_qty as qty, dl.source_line_id
      from document_line dl
      join document d on d.id = dl.document_id
     where d.doc_type = ${fulfilmentType}
       and d.status = 'POSTED'
       and d.source_document_id = ${orderId}
     order by d.posting_date, d.doc_no, dl.line_no`;

  // A fulfilment line that names the order line it satisfies is credited to
  // that line. One that does not — anything posted before the reference
  // existed, and everything the seed writes — names only the item, so it is
  // spread across that item's order lines in line order, capped at what each
  // asked for. Same rule the GR/IR matcher uses for the same reason: the
  // alternative is a screen that reports nothing delivered while the chain
  // plainly shows a delivery.
  const done = new Map<string, number>();
  const pool = new Map<string, number>();

  for (const f of fulfilled) {
    const q = Number(f.qty);
    if (f.source_line_id) {
      done.set(f.source_line_id, (done.get(f.source_line_id) ?? 0) + q);
    } else {
      pool.set(f.item_id, (pool.get(f.item_id) ?? 0) + q);
    }
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

// ------------------------------------------------------- consignment --

/**
 * Every consignment agreement, with its item lines nested — the settlement
 * rule each item is received under, and how much of it is currently on
 * consigned stock (received minus consumed, derived rather than stored, the
 * same as every other on-hand figure in this app).
 */
export async function getConsignmentAgreements(companyId: string) {
  return sql`
    select ag.id, ag.memo, ag.created_at,
           p.id as partner_id, p.code as partner_code, p.name as partner_name,
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
