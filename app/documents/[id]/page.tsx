import { Fragment } from "react";
import { planVoid } from "@/lib/void";
import { RelatedDocumentsPanel } from "@/components/related-documents";
import { VoidDocument } from "@/components/void-document";
import { voidDocumentAction } from "@/lib/actions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sql, money, qty, shortDate } from "@/lib/db";
import {
  getDocument,
  getDocumentLines,
  getJournalForDocument,
  getDownstream,
  getDocumentOutstanding,
  getOpenSalesOrders,
  getOpenPurchaseOrders,
  getChainDocuments,
  getSettlingPayment,
  isGrirOutstanding,
  getMatchStatus,
  getStockByLocation,
  getOrderProgress,
  getRelatedDocuments,
} from "@/lib/queries";
import { createDelivery, createGoodsReceipt } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";
import { ErpOrderForm, type OrderLine as ErpOrderLine } from "@/components/erp-order-form";
import { ErpDocShell } from "@/components/erp-doc-shell";

// The chain each document type sits in, so the detail page can show where
// this document falls and what comes next.
const CHAINS: Record<string, string[]> = {
  PURCHASE_ORDER:   ["PURCHASE_ORDER", "GOODS_RECEIPT", "PURCHASE_INVOICE", "SUPPLIER_PAYMENT"],
  GOODS_RECEIPT:    ["PURCHASE_ORDER", "GOODS_RECEIPT", "PURCHASE_INVOICE", "SUPPLIER_PAYMENT"],
  PURCHASE_INVOICE: ["PURCHASE_ORDER", "GOODS_RECEIPT", "PURCHASE_INVOICE", "SUPPLIER_PAYMENT"],
  SUPPLIER_PAYMENT: ["PURCHASE_ORDER", "GOODS_RECEIPT", "PURCHASE_INVOICE", "SUPPLIER_PAYMENT"],
  SALES_ORDER:      ["SALES_ORDER", "DELIVERY", "SALES_INVOICE", "CUSTOMER_RECEIPT"],
  DELIVERY:         ["SALES_ORDER", "DELIVERY", "SALES_INVOICE", "CUSTOMER_RECEIPT"],
  SALES_INVOICE:    ["SALES_ORDER", "DELIVERY", "SALES_INVOICE", "CUSTOMER_RECEIPT"],
  CUSTOMER_RECEIPT: ["SALES_ORDER", "DELIVERY", "SALES_INVOICE", "CUSTOMER_RECEIPT"],
};

const label = (t: string) => t.replace(/_/g, " ").toLowerCase();

// Matches the tab labels on the documents list itself — "delivery" doesn't
// just take an s.
const PLURAL: Record<string, string> = {
  PURCHASE_ORDER: "Purchase orders",
  GOODS_RECEIPT: "Goods receipts",
  PURCHASE_INVOICE: "Purchase invoices",
  SUPPLIER_PAYMENT: "Supplier payments",
  SALES_ORDER: "Sales orders",
  DELIVERY: "Deliveries",
  SALES_INVOICE: "Sales invoices",
  CUSTOMER_RECEIPT: "Customer receipts",
};

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) notFound();

  const [lines, journal, downstream, chainDocuments] = await Promise.all([
    getDocumentLines(id),
    getJournalForDocument(doc.journal_entry_id),
    getDownstream(id),
    getChainDocuments(id),
  ]);

  const chain = CHAINS[doc.doc_type] ?? [doc.doc_type];
  const totalDebit = journal.reduce((s: number, l: any) => s + Number(l.debit), 0);
  const totalCredit = journal.reduce((s: number, l: any) => s + Number(l.credit), 0);

  // What to do next, computed from this document alone — the whole point is
  // not making the user go find themselves in a separate list.
  const isOpenOrder = (doc.doc_type === "SALES_ORDER" || doc.doc_type === "PURCHASE_ORDER") && doc.status === "POSTED";
  const isInvoice = (doc.doc_type === "SALES_INVOICE" || doc.doc_type === "PURCHASE_INVOICE") && doc.status === "POSTED";

  // Real documents behind each stage of the chain, not just the stage's
  // name — resolved from whatever's actually connected to this one via
  // source_document_id, in either direction. Payment sits outside that
  // chain (it allocates against invoices, it isn't sourced from one), so
  // it gets its own lookup once an invoice is found.
  const stageDoc: Record<string, { id: string; doc_no: string } | null> = {};
  for (const step of chain) {
    if (step === "SUPPLIER_PAYMENT" || step === "CUSTOMER_RECEIPT") continue;
    stageDoc[step] = (chainDocuments as any[]).find((d) => d.doc_type === step) ?? null;
  }
  const invoiceStage = stageDoc["PURCHASE_INVOICE"] ?? stageDoc["SALES_INVOICE"] ?? null;
  const paymentStep = chain.includes("SUPPLIER_PAYMENT") ? "SUPPLIER_PAYMENT" : "CUSTOMER_RECEIPT";
  if (chain.includes(paymentStep)) {
    stageDoc[paymentStep] = invoiceStage ? ((await getSettlingPayment(invoiceStage.id)) as any) : null;
  }

  // Only offer to match this document against its counterpart if it
  // actually has an outstanding GR/IR clearing balance — not just "no
  // downstream document yet." A document that never touched GR/IR clearing
  // in the first place (an old purchase invoice that posted straight to
  // Inventory, from before this pattern existed) has nothing to clear, and
  // matching one to a fresh receipt would double-count the stock it already
  // recorded rather than reconcile anything.
  const isGr = doc.doc_type === "GOODS_RECEIPT" && doc.status === "POSTED";
  const isPi = doc.doc_type === "PURCHASE_INVOICE" && doc.status === "POSTED";
  // The sales mirror: a delivery moves the goods and a sales invoice bills
  // them, exactly as a receipt and a purchase invoice do. Same two questions,
  // so the same panel answers them in the sales vocabulary.
  const isDel = doc.doc_type === "DELIVERY" && doc.status === "POSTED";
  const isSi = doc.doc_type === "SALES_INVOICE" && doc.status === "POSTED";
  /** True on the document that moves goods, false on the one that bills. */
  const movesGoods = isGr || isDel;
  const goodsWord = isGr || isPi ? "received" : "delivered";
  const Goods = goodsWord.replace(/^\w/, (c) => c.toUpperCase());
  const grirOutstanding = (isGr || isPi) ? await isGrirOutstanding(doc.id) : false;

  // Line-level settlement: how much of this receipt has been invoiced, or of
  // this invoice received, and by which documents. Replayed through the same
  // matcher the posting engine uses, so the page cannot claim a line is
  // settled that the ledger still holds open.
  const match = (isGr || isPi || isDel || isSi) ? await getMatchStatus(doc.id) : null;

  // What voiding would do, and what stands in the way. The same analysis the
  // engine re-runs before it writes, so the screen cannot promise something
  // the action then refuses.
  const voidPlan = doc.status === "POSTED" ? await planVoid(doc.id) : null;

  // What this document is genuinely linked to, in both directions. Shown
  // alongside the workflow pipeline rather than instead of it: the pipeline
  // is the shape a sale usually takes and carries the "create the next one"
  // links, while this states only what exists — including the headings with
  // nothing under them.
  const related = await getRelatedDocuments(doc.id);

  /**
   * Where the next stage of the chain gets created from this document.
   *
   * Only the step immediately after this one: a purchase order can be
   * received, a receipt can be invoiced, and nothing further down has
   * anything to be made from yet. This is what makes the pipeline walkable
   * forwards — clicking Delivery on an order takes you to that order's
   * delivery, carrying the order with it, so the invoice at the end can show
   * which order it belongs to.
   */
  const nextStageHref = (stageType: string): string | null => {
    if (doc.status !== "POSTED") return null;
    const from = doc.doc_type;
    if (from === "PURCHASE_ORDER" && stageType === "GOODS_RECEIPT")
      return `/purchases/receive?order=${doc.id}`;
    if (from === "SALES_ORDER" && stageType === "DELIVERY")
      return `/sales/deliver?order=${doc.id}`;
    if (from === "GOODS_RECEIPT" && stageType === "PURCHASE_INVOICE")
      return `/purchases/new?goods_receipt_id=${doc.id}`;
    if (from === "DELIVERY" && stageType === "SALES_INVOICE")
      return `/sales/new?delivery_id=${doc.id}`;
    // An invoice raised "deliver later" still owes the goods. The pending
    // list is where that delivery is posted, and without this the chain runs
    // forwards everywhere except the one place it is actually waiting.
    if (from === "SALES_INVOICE" && stageType === "DELIVERY" && doc.to_deliver)
      return "/sales/deliver";
    return null;
  };

  // A voided document must say so on its face. Finding out only by noticing
  // the status pill, on a document whose figures all still read normally, is
  // how someone acts on a number that has already been reversed.
  const voidInfo = doc.status === "REVERSED" ? (await sql`
    select r.id, r.doc_no, to_char(r.doc_date, 'YYYY-MM-DD') as doc_date,
           d.void_reason,
           s.id as replacement_id, s.doc_no as replacement_no
      from document d
      left join document r on r.id = d.reversed_by_document_id
      left join document s on s.supersedes_document_id = d.id
     where d.id = ${doc.id}`)[0] as unknown as {
       id: string | null; doc_no: string | null; doc_date: string | null;
       void_reason: string | null;
       replacement_id: string | null; replacement_no: string | null;
     } | undefined : undefined;
  const openToMatch = match ? match.lines.some((l) => l.remaining > 0) : grirOutstanding;
  const needsInvoiceMatch = isGr && openToMatch;
  const needsReceiptMatch = isPi && openToMatch;

  // A delivery with no invoice against it yet — the sales-side mirror of
  // needsInvoiceMatch, just off the chain link itself rather than a
  // clearing-account view, since a delivery never touches GR/IR.
  const needsSalesInvoice = doc.doc_type === "DELIVERY" && doc.status === "POSTED" && !stageDoc["SALES_INVOICE"];

  // A delivery and a stock transfer charge nobody: the figure on the line is
  // what the goods cost leaving inventory, not what anyone is paying. Calling
  // that "Price" reads as a bill the customer never received — and a
  // free-of-charge line, which must carry a zero price, would then look like
  // it cost the company nothing to give away.
  const valuedAtCost = doc.doc_type === "DELIVERY" || doc.doc_type === "STOCK_TRANSFER";
  const valueLabel = valuedAtCost ? "Cost" : "Price";

  // On those documents the per-unit figure is derived from the line's value
  // rather than read from unit_price, because a free-of-charge line is
  // required to store a zero there. The goods still cost what they cost, and
  // net_amount is where that is kept.
  const unitValue = (l: any) => {
    if (!valuedAtCost) return l.unit_price;
    const q = Number(l.base_qty ?? 0);
    return q === 0 ? l.unit_price : Number(l.net_amount ?? 0) / q;
  };

  let orderLines: {
    lineId: string; itemId: string; itemCode: string; itemName: string;
    remainingQty: number; expectedPrice: number;
  }[] = [];
  let stockByLocation: Array<{ item_id: string; location_id: string; qty_on_hand: string }> = [];
  if (isOpenOrder) {
    const open = doc.doc_type === "SALES_ORDER"
      ? await getOpenSalesOrders(doc.company_id)
      : await getOpenPurchaseOrders(doc.company_id);
    orderLines = (open as any[])
      .filter((r) => r.order_id === doc.id)
      .map((r) => ({
        lineId: r.line_id, itemId: r.item_id, itemCode: r.item_code, itemName: r.item_name,
        remainingQty: Number(r.remaining_qty), expectedPrice: Number(r.expected_price ?? 0),
      }));
    if (doc.doc_type === "SALES_ORDER") {
      stockByLocation = (await getStockByLocation(doc.company_id)) as never;
    }
  }

  const outstanding = isInvoice ? await getDocumentOutstanding(doc.id) : 0;

  // Orders render on the ERP form. Only the two order types for now: the
  // shell is adopted screen by screen rather than switched on globally, so
  // anything not yet moved keeps working exactly as it did.
  // Which stages this chain can simply do without. The orders are the clear
  // case — a walk-in sale starts at the delivery and a phoned-in purchase at
  // the receipt — and drawing them like a step still owed is what made an
  // ordinary counter sale look unfinished.
  const OPTIONAL_STAGE = new Set(["SALES_ORDER", "PURCHASE_ORDER"]);

  const isOrder = doc.doc_type === "SALES_ORDER" || doc.doc_type === "PURCHASE_ORDER";

  if (isOrder) {
    const sales = doc.doc_type === "SALES_ORDER";
    const progress = (await getOrderProgress(doc.id, doc.doc_type)) as any[];

    const erpLines: ErpOrderLine[] = progress.map((l) => ({
      id: l.id,
      itemCode: l.item_code,
      itemName: l.item_name,
      itemNameMy: l.item_name_my ?? null,
      uomCode: l.uom_code ?? null,
      ordered: Number(l.ordered),
      fulfilled: Number(l.fulfilled),
      unitPrice: Number(l.unit_price),
      netAmount: Number(l.net_amount),
    }));

    return (
      <ErpOrderForm
        config={{
          typeLabel: sales ? "Sales Order" : "Purchase Order",
          partyLabel: sales ? "Customer" : "Vendor",
          fulfilledLabel: sales ? "Delivered" : "Received",
          listHref: `/documents?type=${doc.doc_type}`,
          listLabel: PLURAL[doc.doc_type] ?? label(doc.doc_type),
        }}
        docId={doc.id}
        docNo={doc.doc_no ?? "Draft"}
        status={doc.status}
        partnerName={doc.partner_name ?? null}
        partnerCode={doc.partner_code ?? null}
        docDate={String(doc.doc_date)}
        dueDate={doc.due_date ? String(doc.due_date) : null}
        locationName={doc.location_name ?? null}
        reference={doc.reference ?? null}
        memo={doc.memo ?? null}
        lines={erpLines}
        netTotal={Number(doc.net_total)}
        related={<RelatedDocumentsPanel related={related} />}
        chain={chain.map((step) => ({
          type: step,
          label: label(step).replace(/\b\w/g, (c) => c.toUpperCase()),
          doc: stageDoc[step] ?? null,
          href: stageDoc[step] ? null : nextStageHref(step),
          optional: OPTIONAL_STAGE.has(step),
        }))}
        actions={
          isOpenOrder && orderLines.length > 0 ? (
            <FulfillOrderForm
              kind={sales ? "sales" : "purchase"}
              orderId={doc.id}
              orderNo={doc.doc_no}
              partnerName={doc.partner_name}
              partnerId={doc.partner_id}
              locationId={doc.location_id}
              lines={orderLines}
              action={sales ? createDelivery : createGoodsReceipt}
              stockByLocation={sales ? stockByLocation : undefined}
            />
          ) : null
        }
      />
    );
  }

  return (
    <ErpDocShell
      docId={doc.id}
      docNo={doc.doc_no ?? "Draft"}
      typeLabel={label(doc.doc_type).replace(/\b\w/g, (c) => c.toUpperCase())}
      status={doc.status}
      listHref={`/documents?type=${doc.doc_type}`}
      listLabel={PLURAL[doc.doc_type] ?? label(doc.doc_type)}
      chain={chain.map((step) => ({
        type: step,
        label: label(step).replace(/\b\w/g, (c) => c.toUpperCase()),
        doc: stageDoc[step] ?? null,
        href: stageDoc[step] ? null : nextStageHref(step),
        optional: OPTIONAL_STAGE.has(step),
      }))}
      badges={
        <>
          {isInvoice && outstanding > 0 && (
            <span className="pill warn">{money(outstanding)} outstanding</span>
          )}
          {isInvoice && outstanding === 0 && <span className="pill ok">Settled</span>}
          {match && (
            <span className={`pill ${match.state === "FULL" ? "ok" : match.state === "PARTIAL" ? "warn" : ""}`}>
              {match.state === "FULL" ? (movesGoods ? "Fully invoiced" : `Fully ${goodsWord}`)
                : match.state === "PARTIAL" ? (movesGoods ? "Partly invoiced" : `Partly ${goodsWord}`)
                : (movesGoods ? "Not invoiced" : `Not ${goodsWord}`)}
            </span>
          )}
        </>
      }
    >

      <RelatedDocumentsPanel
        related={related}
        accounting={(journal as unknown as {
          account_name: string; debit: string; credit: string;
        }[]).map((l) => ({
          accountName: l.account_name,
          debit: Number(l.debit),
          credit: Number(l.credit),
        }))}
      />

      {voidInfo && (
        <div className="alert" style={{ marginTop: "0.75rem" }}>
          <strong>This document has been voided.</strong>{" "}
          Its figures below are what it said when posted; they no longer
          affect any account.
          {voidInfo.doc_no && (
            <>
              {" "}Reversed by{" "}
              <a href={`/documents/${voidInfo.id}`} style={{ color: "var(--brand)" }}>
                {voidInfo.doc_no}
              </a>
              {voidInfo.doc_date ? ` on ${voidInfo.doc_date}` : ""}.
            </>
          )}
          {voidInfo.replacement_no && (
            <>
              {" "}Replaced by{" "}
              <a href={`/documents/${voidInfo.replacement_id}`} style={{ color: "var(--brand)" }}>
                {voidInfo.replacement_no}
              </a>.
            </>
          )}
          {voidInfo.void_reason && <> Reason: {voidInfo.void_reason}.</>}
          {" "}
          <a href="/documents/history" style={{ color: "var(--brand)" }}>History log</a>
        </div>
      )}

      {/* Voiding sits with the document rather than on the list, because it
          needs the whole picture — what it would reverse, and what has been
          built on top of it — and that is only assembled here. */}
      {voidPlan && (
        <VoidDocument
          action={voidDocumentAction}
          documentId={doc.id}
          docNo={doc.doc_no}
          canVoid={voidPlan.canVoid}
          blockers={voidPlan.blockers}
          effects={voidPlan.effects}
        />
      )}

      {(needsInvoiceMatch || needsReceiptMatch) && (
        <div className="actions" style={{ marginTop: "-0.5rem" }}>
          <Link
            href={
              needsInvoiceMatch
                ? `/purchases/new?goods_receipt_id=${doc.id}`
                : `/purchases/receive/new?match_invoice_id=${doc.id}`
            }
            className="btn"
          >
            {match?.state === "PARTIAL"
              ? needsInvoiceMatch ? "Invoice the rest" : "Receive the rest"
              : needsInvoiceMatch ? "Create purchase invoice" : "Create goods receipt"}
            {match?.state === "PARTIAL" ? "" : ` — ${money(doc.gross_total)}`}
          </Link>
          <span className="page-sub">
            {match?.state === "PARTIAL"
              ? needsInvoiceMatch
                ? "Part of this receipt has been billed. The rest is listed below."
                : "Part of this invoice has arrived. The rest is listed below."
              : needsInvoiceMatch
                ? "Nothing has billed for this receipt yet."
                : "Nothing has recorded these goods arriving yet."}
          </span>
        </div>
      )}

      {match && match.lines.length > 0 && (
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-head">
            <h2>{movesGoods ? "Invoiced" : Goods}</h2>
            <span className={`pill ${match.state === "FULL" ? "ok" : match.state === "PARTIAL" ? "warn" : ""}`}>
              {match.state === "FULL"
                ? movesGoods ? "Fully invoiced" : `Fully ${goodsWord}`
                : match.state === "PARTIAL"
                  ? movesGoods ? "Partly invoiced" : `Partly ${goodsWord}`
                  : movesGoods ? "Not invoiced" : `Not ${goodsWord}`}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="r">{movesGoods ? Goods : "Invoiced"}</th>
                  <th className="r">{movesGoods ? "Invoiced" : Goods}</th>
                  <th className="r">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {match.lines.map((l) => (
                  <Fragment key={l.lineId}>
                    <tr>
                      <td className="wrap">
                        <span className="code">{l.itemCode}</span> {l.itemName}
                      </td>
                      <td className="r">{qty(l.qty)}</td>
                      <td className="r">{l.settled > 0 ? qty(l.settled) : "—"}</td>
                      <td className="r">
                        {l.remaining > 0
                          ? <strong>{qty(l.remaining)}</strong>
                          : <span style={{ color: "var(--muted)" }}>—</span>}
                      </td>
                    </tr>
                    {l.matchedBy.map((m) => (
                      <tr key={`${l.lineId}-${m.docId}`} className="subrow">
                        <td className="wrap">
                          <Link href={`/documents/${m.docId}`}>{m.docNo}</Link>
                          {" · "}{shortDate(m.docDate)}
                        </td>
                        <td className="r">—</td>
                        <td className="r">{qty(m.qty)}</td>
                        <td className="r">—</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {needsSalesInvoice && (
        <div className="actions" style={{ marginTop: "-0.5rem" }}>
          <Link href={`/sales/new?delivery_id=${doc.id}`} className="btn">
            Create sales invoice — {money(doc.gross_total)}
          </Link>
          <span className="page-sub">Nothing has billed for this delivery yet.</span>
        </div>
      )}


      {isOpenOrder && orderLines.length > 0 && (
        <FulfillOrderForm
          kind={doc.doc_type === "SALES_ORDER" ? "sales" : "purchase"}
          orderId={doc.id}
          orderNo={doc.doc_no}
          partnerName={doc.partner_name}
          partnerId={doc.partner_id}
          locationId={doc.location_id}
          lines={orderLines}
          action={doc.doc_type === "SALES_ORDER" ? createDelivery : createGoodsReceipt}
          stockByLocation={doc.doc_type === "SALES_ORDER" ? stockByLocation : undefined}
        />
      )}

      {/* What the invoice is worth, what has come in, and what is still
          owed — the three figures anyone opening an invoice is looking for,
          side by side rather than inferred from a pill and a journal.
          Paid is derived here for display; only the total and the
          outstanding balance are ever read from the ledger. */}
      {isInvoice && (
        <div className="erp-settle">
          <div className="erp-settle-figs">
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Total</span>
              <span className="erp-settle-value">{money(doc.gross_total)}</span>
            </div>
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Paid</span>
              <span className="erp-settle-value">
                {money(Math.max(0, Number(doc.gross_total) - outstanding))}
              </span>
            </div>
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Outstanding</span>
              <span className={`erp-settle-value ${outstanding > 0 ? "due" : "clear"}`}>
                {money(outstanding)}
              </span>
            </div>
          </div>
          {outstanding > 0 && (
            <Link
              href={
                doc.doc_type === "SALES_INVOICE"
                  ? `/receivables/receive?partner=${doc.partner_id}&invoice=${doc.id}`
                  : `/payables/pay?partner=${doc.partner_id}&invoice=${doc.id}`
              }
              className="erp-btn erp-btn-primary erp-settle-act"
            >
              {doc.doc_type === "SALES_INVOICE" ? "Receive payment" : "Pay supplier"}
            </Link>
          )}
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <div className="card-head"><h2>Document</h2><span className={`pill ${doc.status.toLowerCase()}`}>{doc.status}</span></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Number</dt><dd className="m">{doc.doc_no ?? "—"}</dd>
              <dt>Date</dt><dd>{shortDate(doc.doc_date)}</dd>
              <dt>Posting</dt><dd>{shortDate(doc.posting_date)}</dd>
              <dt>Due</dt><dd>{doc.due_date ? shortDate(doc.due_date) : "—"}</dd>
              <dt>Partner</dt><dd>{doc.partner_name ? `${doc.partner_code} · ${doc.partner_name}` : "—"}</dd>
              <dt>Location</dt><dd>{doc.location_code ? `${doc.location_code} · ${doc.location_name}` : "—"}</dd>
              <dt>Currency</dt><dd className="m">{doc.currency} @ {Number(doc.exchange_rate)}</dd>
              {doc.salesman_name && (
                <>
                  <dt>Salesman</dt>
                  <dd>{doc.salesman_code} · {doc.salesman_name}</dd>
                </>
              )}
              {doc.payment_type && (
                <>
                  <dt>Payment</dt>
                  <dd><span className="pill">{doc.payment_type}</span></dd>
                </>
              )}
              {doc.reference && (
                <>
                  <dt>Reference</dt>
                  <dd className="m">{doc.reference}</dd>
                </>
              )}
              {isSi && (
                <>
                  <dt>Fulfilment</dt>
                  <dd>
                    {/* Which way this invoice was raised, and whether the
                        goods have gone. "Take now" and "Deliver later" are
                        two different promises to the customer, and an invoice
                        that has not shipped yet should say so on its face
                        rather than in the absence of a delivery link. */}
                    {doc.to_deliver ? (
                      <span className={`pill ${stageDoc["DELIVERY"] ? "ok" : "warn"}`}>
                        {stageDoc["DELIVERY"] ? "Delivered" : "Delivery pending"}
                      </span>
                    ) : (
                      <span className="pill ok">Taken now</span>
                    )}
                  </dd>
                </>
              )}
              {doc.memo && (
                <>
                  <dt>Remark</dt>
                  <dd className="wrap">{doc.memo}</dd>
                </>
              )}
              <dt>Source</dt>
              <dd>
                {doc.source_doc_no
                  ? <Link href={`/documents/${doc.source_id}`} className="m" style={{ color: "var(--brand)" }}>{doc.source_doc_no}</Link>
                  : "—"}
              </dd>
            </dl>
          </div>
        </div>

        {/* The old Downstream card lived here. It is gone because the
            Related Documents panel above says the same thing and more: both
            directions, and the headings that have nothing under them. Two
            lists of the same links, disagreeing about which ones count, is
            worse than either. */}
      </div>

      {lines.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head"><h2>Lines</h2></div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Item</th><th>Description</th><th>Unit</th>
                    <th className="r">Qty</th><th className="r">{valueLabel}</th><th className="r">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l: any) => (
                    <tr key={l.id}>
                      <td className="code">{l.line_no}</td>
                      <td className="code">{l.item_code ?? "—"}</td>
                      <td className="wrap">
                        {l.item_name ?? l.description ?? "—"}
                        {l.foc_reason && <> <span className="pill warn">{l.foc_reason}</span></>}
                      </td>
                      <td className="code">{l.uom_code ?? "—"}</td>
                      <td className="r">{qty(l.entered_qty)}</td>
                      <td className="r">{money(unitValue(l))}</td>
                      <td className="r">{money(l.net_amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6}>Total</td>
                    <td className="r">{money(doc.gross_total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Posting</h2>
            <span className="m" style={{ color: "var(--muted)" }}>
              {doc.entry_no ? `Journal ${doc.entry_no}` : "This document type posts nothing"}
            </span>
          </div>
          {journal.length > 0 ? (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Account</th><th>Name</th>
                    <th className="r">Debit</th><th className="r">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {journal.map((l: any) => (
                    <tr key={l.line_no}>
                      <td className="code">{l.line_no}</td>
                      <td className="code">{l.account_code}</td>
                      <td className="wrap">{l.account_name}</td>
                      <td className="r dr">{Number(l.debit) ? money(l.debit) : ""}</td>
                      <td className="r cr">{Number(l.credit) ? money(l.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      {totalDebit === totalCredit ? "Balanced" : "OUT OF BALANCE"}
                    </td>
                    <td className="r dr">{money(totalDebit)}</td>
                    <td className="r cr">{money(totalCredit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="empty">
              Orders commit nothing to the ledger — they exist to be fulfilled and reported against.
            </div>
          )}
        </div>
      </section>
    </ErpDocShell>
  );
}
