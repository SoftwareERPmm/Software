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

  console.log(`\n  ${bad === 0 ? "All good." : `${bad} failed.`}\n`);
} catch (e) {
  console.error("\n  ERROR", e.message, "\n");
  bad++;
} finally {
  await sql.end();
}
process.exit(bad === 0 ? 0 : 1);
