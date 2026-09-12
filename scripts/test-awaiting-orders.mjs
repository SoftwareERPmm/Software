// What a partner is already waiting for, before it is ordered again.
//
//   npx tsx scripts/test-awaiting-orders.mjs
//
// The duplicate order is not carelessness. A blank purchase order says
// nothing about the one placed nine days ago, so there is nothing to notice
// — and the goods arrive twice, the money goes out twice, and the shelf
// holds stock nobody planned to buy.
//
// So the new-order form asks, the moment a supplier is chosen, what that
// supplier already owes. This is the question behind it. Everything here is
// about what must NOT appear: an order that has been received against, or
// billed, or closed, or replaced by a corrected version is a different
// conversation, and a reminder that fires on those is a reminder nobody
// reads.
//
// Outstanding is taken from v_order_outstanding, the same reckoning the
// dashboard and the receive form use, so the banner cannot disagree with the
// rest of the app about what is still owed.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}
const url = process.env.DATABASE_URL;
const sql = postgres(url, { ssl: url.includes("localhost") ? false : "require",
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });

const P = await import("../lib/posting.ts");
const Q = await import("../lib/queries.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.0001;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;

  // Its own fixtures rather than whatever master data happens to be there:
  // this suite needs two suppliers to prove one supplier's orders stay out of
  // another's reminder, and two items to prove the line flag picks the right
  // one. Made once and reused, so re-running it is safe.
  const partner = async (code, name, role) => {
    const [found] = await sql`select id from business_partner
       where company_id = ${co.id} and code = ${code}`;
    if (found) return found;
    const [made] = await sql`
      insert into business_partner (company_id, code, name, is_supplier, is_customer)
      values (${co.id}, ${code}, ${name}, ${role === "supplier"}, ${role === "customer"})
      returning id`;
    return made;
  };
  // Found by name, not by code: a trigger builds the code from the category
  // and the serial, so the code this asked for is not the code it gets.
  const product = async (serial, name) => {
    const [found] = await sql`select id, code from item
       where company_id = ${co.id} and name = ${name}`;
    if (found) return found;
    const [grp] = await sql`select id from item_group
       where company_id = ${co.id} order by code limit 1`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    const [made] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id)
      values (${co.id}, ${grp.id}, ${serial}, ${name}, ${uom.id})
      returning id, code`;
    return made;
  };

  const itemA = await product("W-A", "Awaiting Test Item A");
  const itemB = await product("W-B", "Awaiting Test Item B");
  const supp = await partner("AW-SUP1", "Awaiting Test Supplier", "supplier");
  const other = await partner("AW-SUP2", "Awaiting Other Supplier", "supplier");
  const cust = await partner("AW-CUST", "Awaiting Test Customer", "customer");

  console.log(`\n  ${co.name}  ·  ${itemA.code} / ${itemB.code}\n`);

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_consumption, stock_lot, stock_movement,
    document_line, document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const po = (partnerId, lines, dueDate = today) =>
    P.postPurchaseOrder({ companyId: co.id, partnerId, locationId: loc.id,
      docDate: today, dueDate, lines });
  const awaiting = (type = "PURCHASE_ORDER") => Q.getUntouchedOpenOrders(co.id, type);
  // The broader set the bill and delivery forms read: goods still owed,
  // whether or not some have already arrived.
  const owed = (type = "PURCHASE_ORDER") => Q.getOpenOrdersAwaitingGoods(co.id, type);
  const linesFor = (rows, docNo) => rows.filter((r) => r.doc_no === docNo);
  const orderCount = (rows) => new Set(rows.map((r) => r.doc_no)).size;

  // ---- an order nobody has touched is what the form has to say ------------

  const a = await po(supp.id, [{ itemId: itemA.id, qty: 100, unitPrice: 1200 }]);
  let rows = await awaiting();

  check("the untouched order is listed", linesFor(rows, a.docNo).length === 1);
  check("with what is still awaited, not what was ordered",
    near(linesFor(rows, a.docNo)[0]?.outstanding, 100),
    `${linesFor(rows, a.docNo)[0]?.outstanding}`);
  check("named by item, in base units",
    linesFor(rows, a.docNo)[0]?.item_id === itemA.id
    && !!linesFor(rows, a.docNo)[0]?.uom_code);
  check("carrying the partner it belongs to",
    linesFor(rows, a.docNo)[0]?.partner_id === supp.id);
  check("and the date it is needed by",
    linesFor(rows, a.docNo)[0]?.due_date === today,
    String(linesFor(rows, a.docNo)[0]?.due_date));

  // ---- a second order for the same supplier is a second row --------------

  const b = await po(supp.id, [{ itemId: itemB.id, qty: 20, unitPrice: 800 }]);
  rows = await awaiting();
  check("two open orders read as two orders", orderCount(rows) === 2);

  // ---- somebody else's order is not this supplier's problem --------------

  const c = await po(other.id, [{ itemId: itemA.id, qty: 5, unitPrice: 1200 }]);
  rows = await awaiting();
  check("another supplier's order is carried separately",
    rows.filter((r) => r.partner_id === supp.id).length === 2
    && rows.filter((r) => r.partner_id === other.id).length === 1);

  // ---- a part-received order is a different conversation ------------------

  const [bLine] = await sql`select id from document_line where document_id = ${b.id}`;
  await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: b.id,
    lines: [{ itemId: itemB.id, qty: 5, unitCost: 800, sourceLineId: bLine.id }],
  });
  rows = await awaiting();
  check("a part-received order drops out — it has a receipt to answer to",
    linesFor(rows, b.docNo).length === 0);
  check("and the untouched one is still there", linesFor(rows, a.docNo).length === 1);

  // The bill form asks a different question. Billing outside the order is how
  // the same purchase gets recorded twice — the voucher raises a receipt of
  // its own — and that risk does not care whether some goods already landed.
  let owing = await owed();
  check("  but the bill form still sees it: goods are owed on it",
    linesFor(owing, b.docNo).length === 1);
  check("  showing what is left, not what was ordered",
    near(linesFor(owing, b.docNo)[0]?.outstanding, 15),
    `${linesFor(owing, b.docNo)[0]?.outstanding} of 20`);

  // ---- goods linked to it afterwards count as arrived ---------------------
  // A receipt raised without naming an order, said to answer it later. The
  // saying is what counts: the goods are on the shelf either way, and an
  // order whose goods are on the shelf must not be reported as awaiting
  // them.

  const e = await po(supp.id, [{ itemId: itemB.id, qty: 10, unitPrice: 800 }]);
  const [eLine] = await sql`select id from document_line where document_id = ${e.id}`;
  check("a fresh order is awaited before anything answers it",
    linesFor(await awaiting(), e.docNo).length === 1);

  const loose = await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: itemB.id, qty: 10, unitCost: 800 }],
  });
  const [looseLine] = await sql`select id from document_line where document_id = ${loose.id}`;
  await P.linkFulfilmentToOrder({ companyId: co.id,
    lines: [{ fulfilmentLineId: looseLine.id, orderLineId: eLine.id, qty: 10 }] });
  rows = await awaiting();
  check("goods linked to the order afterwards take it out of the list",
    linesFor(rows, e.docNo).length === 0);

  // ---- an order closed as no longer expected is not awaited ---------------

  await P.closeOrderRemaining({ companyId: co.id, documentId: c.id,
    reason: "supplier cannot supply" });
  rows = await awaiting();
  check("a closed order is expecting nothing, so it says nothing",
    linesFor(rows, c.docNo).length === 0);

  // ---- a corrected order appears once, as the version standing now --------

  const amended = await P.amendOrder({
    companyId: co.id, documentId: a.id, reason: "quantity agreed at 60",
    order: { companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: itemA.id, qty: 60, unitPrice: 1200 }] },
  });
  rows = await awaiting();
  const aRows = rows.filter((r) => r.doc_no === a.docNo);
  check("a corrected order is listed once, not as both its versions",
    aRows.length === 1, `${aRows.length} rows`);
  check("and the quantity awaited is the corrected one",
    near(aRows[0]?.outstanding, 60), `${aRows[0]?.outstanding}`);
  check("the superseded version is not separately awaited",
    !rows.some((r) => r.order_id === a.id),
    amended?.id === a.id ? "(same id — amend returned the original)" : "");

  // ---- a receipt against the old version still silences the new one -------

  const current = aRows[0]?.order_id;
  const [curLine] = await sql`select id from document_line where document_id = ${current}`;
  await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: current,
    lines: [{ itemId: itemA.id, qty: 60, unitCost: 1200, sourceLineId: curLine.id }],
  });
  rows = await awaiting();
  check("once received, the corrected order drops out too",
    linesFor(rows, a.docNo).length === 0);
  check("nothing is left awaiting for this supplier",
    rows.filter((r) => r.partner_id === supp.id).length === 0);

  // ---- the sales side is the same question, asked of a customer -----------

  const so = await P.postSalesOrder({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: today, dueDate: today,
    lines: [{ itemId: itemA.id, qty: 4, unitPrice: 2000 }] });
  const sales = await awaiting("SALES_ORDER");
  check("an open sales order is awaited from the customer",
    linesFor(sales, so.docNo).length === 1);
  check("and it is not mixed into the purchase list",
    (await awaiting()).every((r) => r.doc_no !== so.docNo));

  const [soLine] = await sql`select id from document_line where document_id = ${so.id}`;
  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, sourceDocumentId: so.id,
    lines: [{ itemId: itemA.id, qty: 4, sourceLineId: soLine.id }] });
  check("delivered, the customer's order stops being awaited",
    linesFor(await awaiting("SALES_ORDER"), so.docNo).length === 0);

  // ---- the reminder never disagrees with the receive form ----------------
  // Both read v_order_outstanding. If they ever diverge, one screen says
  // goods are coming while the other refuses to receive them.

  const d = await po(supp.id, [{ itemId: itemA.id, qty: 7, unitPrice: 1200 }], null);
  const open = await Q.getOpenPurchaseOrders(co.id);
  rows = await awaiting();
  const mine = linesFor(rows, d.docNo)[0];
  const theirs = open.filter((o) => o.order_no === d.docNo);
  check("the same quantity the receive form is prepared to take",
    near(mine?.outstanding, theirs.reduce((t, o) => t + n(o.remaining_qty), 0)),
    `${mine?.outstanding} vs ${theirs.reduce((t, o) => t + n(o.remaining_qty), 0)}`);
  check("an order with no needed-by date is still listed",
    mine?.due_date === null, String(mine?.due_date));

  // ---- a draft order has not been placed with anyone ---------------------

  await sql`update document set status = 'DRAFT' where id = ${d.id}`;
  check("a draft order is not awaited — nobody has been asked for anything",
    linesFor(await awaiting(), d.docNo).length === 0);

  // ---- what the bill and delivery forms are warned about -----------------
  // The tester's case, exactly: an order placed, nothing received, and a bill
  // raised straight against the supplier. Nothing links the two — a purchase
  // invoice can only name a goods receipt — so both doors read "nothing has
  // happened", each raises its own receipt, and 100 units arrive twice.

  const f = await po(supp.id, [{ itemId: itemA.id, qty: 30, unitPrice: 1200 }]);
  owing = await owed();
  check("an untouched order is owed goods, so the bill form warns on it",
    linesFor(owing, f.docNo).length === 1);

  const [fLine] = await sql`select id from document_line where document_id = ${f.id}`;
  await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: f.id,
    lines: [{ itemId: itemA.id, qty: 30, unitCost: 1200, sourceLineId: fLine.id }],
  });
  check("once the goods are all in, it stops warning — the answer is the receipt",
    linesFor(await owed(), f.docNo).length === 0);

  const g = await po(supp.id, [{ itemId: itemB.id, qty: 8, unitPrice: 800 }]);
  await P.closeOrderRemaining({ companyId: co.id, documentId: g.id,
    reason: "supplier cannot supply" });
  check("a closed order is owed nothing, so neither form warns",
    linesFor(await owed(), g.docNo).length === 0
    && linesFor(await awaiting(), g.docNo).length === 0);

  const h = await po(supp.id, [{ itemId: itemB.id, qty: 9, unitPrice: 800 }]);
  await sql`update document set status = 'DRAFT' where id = ${h.id}`;
  check("a draft order is owed nothing either",
    linesFor(await owed(), h.docNo).length === 0);

  const so2 = await P.postSalesOrder({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: today, dueDate: today,
    lines: [{ itemId: itemA.id, qty: 3, unitPrice: 2000 }] });
  check("the sales voucher gets the same warning about its own orders",
    linesFor(await owed("SALES_ORDER"), so2.docNo).length === 1);
  check("  and purchase orders stay out of it",
    (await owed("SALES_ORDER")).every((r) => r.doc_no !== f.docNo));


  // ---- a bill filled from an order belongs to that order ------------------
  //
  // "Fill from this order" is not only a typing convenience. The voucher it
  // fills names the order's own lines, which is what amendInvoice and the
  // correction cascade already read — so the bill stops being a document of
  // its own and becomes part of that order's chain. The dialog says exactly
  // that before it happens; these are the three claims it makes.

  console.log("\n  a bill filled from an order\n");
  {
    const f = await po(supp.id, [{ itemId: itemA.id, qty: 20, unitPrice: 1500 }]);
    const [fl] = await sql`select id from document_line where document_id = ${f.id}`;

    // What the form sends once the dialog is confirmed.
    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, reference: f.docNo,
      lines: [{ itemId: itemA.id, qty: 20, unitPrice: 1500, sourceLineId: fl.id }],
    });

    const [stored] = await sql`select reference from document where id = ${bill.id}`;
    check("the order number is kept on the bill", stored.reference === f.docNo,
      `${stored.reference}`);

    const origin = await Q.getTransactionOrigin(co.id, bill.id);
    check("  the document page calls it an order-based bill, not a direct one",
      origin?.startedFrom === "ORDER", `${origin?.startedFrom}`);
    check("  naming the order it came from",
      origin?.order.state === "USED" && origin.order.doc.doc_no === f.docNo,
      origin?.order.state === "USED" ? origin.order.doc.doc_no : String(origin?.order.state));
    check("  and sending corrections there",
      origin?.correctAt.kind === "ORDER" && origin.correctAt.doc.doc_no === f.docNo);

    // Corrected at the order, not on the bill — the same rule as a bill
    // raised through that order's receipt.
    let refused = null;
    try {
      await P.amendInvoice({ companyId: co.id, documentId: bill.id, reason: "supplier billed 1,600",
        invoice: { companyId: co.id, partnerId: supp.id, locationId: loc.id,
          docDate: today, dueDate: today,
          lines: [{ itemId: itemA.id, qty: 20, unitPrice: 1600 }] } });
    } catch (e) { refused = e.message; }
    check("the bill cannot be corrected on its own", !!refused);
    check("  and the refusal names where to do it",
      !!refused && refused.includes(f.docNo), refused?.slice(0, 60));

    // And the other half of the dialog's promise: a price changed at the
    // order carries into the bill it filled.
    const amended = await P.amendOrder({
      companyId: co.id, documentId: f.id, reason: "price renegotiated to 1,600",
      order: { companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: itemA.id, qty: 20, unitPrice: 1600 }] },
      cascade: true,
    });
    const [billNow] = await sql`
      select version, gross_total::float g from document
       where doc_no = ${bill.docNo} and superseded_by_document_id is null`;
    check("correcting the order carries into the bill it filled",
      near(billNow?.g, 32000), `${billNow?.g} at v${billNow?.version}`);
    void amended;
  }


  // ---- filled from an order, and received in the same breath --------------
  //
  // The form's "Received now" is ticked by default, so this is the ordinary
  // way a filled bill is posted — and it refused outright: the bill named the
  // order's lines, the receipt created alongside it had lines of its own, and
  // assertSourceLines rejected the bill for naming lines that were not on the
  // receipt it bills. "Line 1 refers to a line that is not on that document."
  //
  // The allocation now moves to where it belongs: the receipt answers the
  // order, and the bill names the receipt. One posting, and the order is
  // fulfilled without anybody linking anything by hand.

  console.log("\n  filled from an order, received now\n");
  {
    const k = await po(supp.id, [{ itemId: itemA.id, qty: 12, unitPrice: 900 }]);
    const [kl] = await sql`select id from document_line where document_id = ${k.id}`;

    let posted = null, refusal = null;
    try {
      posted = await P.postPurchaseWithReceipt({
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today, reference: k.docNo,
        lines: [{ itemId: itemA.id, qty: 12, unitPrice: 900, sourceLineId: kl.id }],
      });
    } catch (e) { refusal = e.message; }

    check("it posts instead of refusing the order's own line ids", !!posted, refusal ?? "");

    if (posted) {
      const [gr] = await sql`
        select d.id, d.doc_no, d.source_document_id from document d
         where d.company_id = ${co.id} and d.doc_type = 'GOODS_RECEIPT'
         order by d.created_at desc limit 1`;
      check("  the receipt answers the order", gr?.source_document_id === k.id);
      check("  so the order is fulfilled with nothing linked by hand",
        near((await sql`select coalesce(sum(outstanding),0)::float o
                          from v_order_outstanding where order_id = ${k.id}`)[0].o, 0));

      const [billRow] = await sql`
        select source_document_id, reference from document where id = ${posted.id}`;
      check("  the bill names that receipt, not the order",
        billRow?.source_document_id === gr?.id);
      check("  and still carries the order number", billRow?.reference === k.docNo);

      const [pair] = await sql`
        select coalesce(sum(g.balance), 0)::float b from v_grir_balance g
         where g.company_id = ${co.id} and g.document_id in (${gr.id}, ${posted.id})`;
      check("  GR/IR closes between them", near(pair?.b, 0), `${pair?.b}`);

      const origin = await Q.getTransactionOrigin(co.id, posted.id);
      check("  and the bill still reads as raised through the order",
        origin?.startedFrom === "ORDER"
        && origin.order.state === "USED" && origin.order.doc.doc_no === k.docNo);
    }

    // Two orders on one bill cannot both be answered by one receipt line, so
    // it is refused rather than silently attached to whichever came first.
    const m1 = await po(supp.id, [{ itemId: itemA.id, qty: 3, unitPrice: 900 }]);
    const m2 = await po(supp.id, [{ itemId: itemB.id, qty: 4, unitPrice: 700 }]);
    const [m1l] = await sql`select id from document_line where document_id = ${m1.id}`;
    const [m2l] = await sql`select id from document_line where document_id = ${m2.id}`;
    let both = null;
    try {
      await P.postPurchaseWithReceipt({
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: itemA.id, qty: 3, unitPrice: 900, sourceLineId: m1l.id },
                { itemId: itemB.id, qty: 4, unitPrice: 700, sourceLineId: m2l.id }],
      });
    } catch (e) { both = e.message; }
    check("one bill filled from two orders is refused, not guessed at",
      !!both && both.includes("more than one order"), both?.slice(0, 60) ?? "posted");
  }


  // ---- filled from an order, billed now, received later -------------------
  //
  // The other route, and the one the original complaint came from. The bill
  // is posted with nothing received; the goods turn up later and are received
  // against the bill, which is what clears GR/IR. The order they were ordered
  // on has been answered by those goods, and used to show nothing received
  // for ever — sitting open and going overdue with the stock already on the
  // shelf, unless somebody remembered to press "Link existing receipt".
  //
  // Now the receipt carries the allocation the bill was filled with, through
  // the same link and the same checks a person would have made by hand.

  console.log("\n  filled from an order, billed now, received later\n");
  {
    // On a clean slate: this section is about what is visible at each step,
    // and earlier sections leave unbilled goods of their own for this same
    // supplier and item — which is a collision in its own right, and would
    // be read here as this scenario's.
    await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
      payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
      stock_movement, document_line, document, journal_line, journal_entry
      restart identity cascade`);
    await sql`update number_series set next_value = 1`;

    const owedOn = async (orderId) =>
      Number((await sql`select coalesce(sum(outstanding), 0)::float o
                          from v_order_outstanding where order_id = ${orderId}`)[0].o);
    const gotOn = async (orderId) =>
      Number((await sql`select coalesce(sum(fulfilled), 0)::float f
                          from v_order_outstanding where order_id = ${orderId}`)[0].f);

    const n = await po(supp.id, [{ itemId: itemA.id, qty: 100, unitPrice: 1000 }]);
    const [nl] = await sql`select id from document_line where document_id = ${n.id}`;
    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, reference: n.docNo,
      lines: [{ itemId: itemA.id, qty: 100, unitPrice: 1000, sourceLineId: nl.id }],
    });
    check("billed with nothing received, the order is still owed all of it",
      near(await owedOn(n.id), 100), `${await owedOn(n.id)}`);

    // What the order's own receive form warns with, before any goods exist:
    // the collision notice needs both halves and has nothing to say yet.
    const waiting = async () => (await Q.getOpenPurchaseInvoices(co.id))
      .filter((b) => b.partner_id === supp.id
        && b.lines.some((l) => l.itemId === itemA.id));
    check("  and a bill is on record as already waiting for these goods",
      (await waiting()).some((b) => b.id === bill.id));
    // Scoped to this bill: earlier sections leave unbilled goods of their own
    // lying about, and a global count would be reading their residue.
    check("  which is the one thing the collision notice cannot see yet",
      !(await Q.getGrirCollisions(co.id)).some((r) => r.doc_no === bill.docNo));

    const [bl] = await sql`select id from document_line where document_id = ${bill.id}`;
    const first = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      sourceDocumentId: bill.id,
      lines: [{ itemId: itemA.id, qty: 60, unitCost: 1000, sourceLineId: bl.id }],
    });
    check("receiving 60 against the bill fulfils 60 of the order",
      near(await gotOn(n.id), 60), `${await gotOn(n.id)} fulfilled`);
    check("  leaving 40 still owed", near(await owedOn(n.id), 40), `${await owedOn(n.id)}`);
    check("  with nobody linking anything by hand",
      Number((await sql`select count(*)::int n from fulfilment_link
                          where source = 'POSTING'`)[0].n) > 0);

    await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      sourceDocumentId: bill.id,
      lines: [{ itemId: itemA.id, qty: 40, unitCost: 1000, sourceLineId: bl.id }],
    });
    check("the last 40 closes the order", near(await owedOn(n.id), 0), `${await owedOn(n.id)}`);
    check("  and the bill stops being listed as waiting for goods",
      !(await waiting()).some((b) => b.id === bill.id));
    check("  and the clearing account between bill and goods closes with it",
      Number((await sql`select coalesce(sum(g.balance), 0)::float b from v_grir_balance g
                          where g.company_id = ${co.id}
                            and g.document_id in (${bill.id}, ${first.id})`)[0].b) === 0);

    // A receipt posted twice must not fulfil the order twice. The allocation
    // is capped at what the order still expects, so the second one carries
    // nothing rather than taking the order to 140 of 100.
    const before = await gotOn(n.id);
    try {
      await P.postGoodsReceipt({
        companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
        sourceDocumentId: bill.id,
        lines: [{ itemId: itemA.id, qty: 40, unitCost: 1000, sourceLineId: bl.id }],
      });
    } catch { /* refused upstream is just as good an answer */ }
    check("receiving the same goods again cannot fulfil the order twice",
      near(await gotOn(n.id), before), `${await gotOn(n.id)} vs ${before}`);
  }


  // ---- the order's terms are the bill's terms -----------------------------
  //
  // Locking the inputs on the form is not enforcement: a request reaching the
  // action has not been past any form. So the item, the price and the
  // quantity are checked where every path has to come through, and the
  // quantity is capped at what that order line still has left to bill —
  // billing an order in two halves works, billing it twice over does not.

  console.log("\n  the order's terms hold on the server\n");
  {
    const q = await po(supp.id, [{ itemId: itemA.id, qty: 50, unitPrice: 2000 }]);
    const [ql] = await sql`select id from document_line where document_id = ${q.id}`;
    const bill = (lines) => P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, reference: q.docNo, lines,
    });
    const refused = async (lines) => {
      try { await bill(lines); return null; } catch (e) { return e.message; }
    };

    const priced = await refused(
      [{ itemId: itemA.id, qty: 50, unitPrice: 2200, sourceLineId: ql.id }]);
    check("a price the order did not agree is refused", !!priced,
      priced?.slice(0, 74) ?? "posted");

    const swapped = await refused(
      [{ itemId: itemB.id, qty: 50, unitPrice: 2000, sourceLineId: ql.id }]);
    check("an item the order did not ask for is refused", !!swapped,
      swapped?.slice(0, 74) ?? "posted");

    const over = await refused(
      [{ itemId: itemA.id, qty: 60, unitPrice: 2000, sourceLineId: ql.id }]);
    check("more than the order asked for is refused", !!over,
      over?.slice(0, 74) ?? "posted");

    // Billing part of it is the sanctioned way to bill less, and what is
    // left stays billable.
    const half = await bill([{ itemId: itemA.id, qty: 30, unitPrice: 2000, sourceLineId: ql.id }]);
    check("billing part of the order is allowed", !!half);

    const tooMuchLeft = await refused(
      [{ itemId: itemA.id, qty: 25, unitPrice: 2000, sourceLineId: ql.id }]);
    check("  and the rest is capped at what is left, not at what was ordered",
      !!tooMuchLeft && tooMuchLeft.includes("20"), tooMuchLeft?.slice(0, 74) ?? "posted");

    const rest = await bill([{ itemId: itemA.id, qty: 20, unitPrice: 2000, sourceLineId: ql.id }]);
    check("  the remaining 20 bills", !!rest);

    const again = await refused(
      [{ itemId: itemA.id, qty: 1, unitPrice: 2000, sourceLineId: ql.id }]);
    check("  and nothing is left to bill after that", !!again,
      again?.slice(0, 74) ?? "posted");

    // A direct bill is nobody's inheritance and stays editable.
    const direct = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: itemA.id, qty: 7, unitPrice: 9999 }],
    });
    check("a direct bill is still free to say what it says", !!direct);
  }

  console.log(`\n  ${bad === 0 ? "All good." : `${bad} failed.`}\n`);
} catch (e) {
  console.error("\n  ERROR", e.message, "\n");
  bad++;
} finally {
  await sql.end();
}
process.exit(bad === 0 ? 0 : 1);
