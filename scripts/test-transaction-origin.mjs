// Which route a transaction took, said on the document.
//
//   npx tsx scripts/test-transaction-origin.mjs
//
// An invoice without an order is not an unfinished one — a walk-in sale and a
// phoned-in purchase are ordinary, complete business. But a chain drawn as a
// row of stages makes the stage nobody used look like the stage nobody reached,
// so the document has to say which route it actually took, and tell apart
// three things a blank space cannot:
//
//   not used      an optional stage this transaction skipped
//   pending       a stage it needs and has not reached
//   not required  a stage that does not apply at all, as for a service
//
// Read from the links the documents record about each other — never from
// matching names or dates, which is guessing dressed as fact.

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

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  const today = new Date().toISOString().slice(0, 10);

  // A service item, so "not required" has something to be true of.
  const [grp] = await sql`select item_group_id from item where id = ${item.id}`;
  const [uom] = await sql`select base_uom_id from item where id = ${item.id}`;
  let svc = (await sql`select id from item
      where company_id = ${co.id} and not is_stocked and is_active order by code limit 1`)[0];
  if (!svc) {
    // The code is set by a trigger from the group and the serial, so both go
    // in rather than a code of our own.
    [svc] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
      values (${co.id}, ${grp.item_group_id}, ${"ORG1"}, 'Delivery service',
              ${uom.base_uom_id}, false)
      returning id`;
  }

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 400, unitCost: 400 }] });

  const origin = (id) => Q.getTransactionOrigin(co.id, id);

  // ---- order → delivery → invoice ----------------------------------------

  console.log("  a sale that went through an order\n");
  {
    const so = await P.postSalesOrder({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }] });
    const [sol] = await sql`select id from document_line where document_id = ${so.id}`;
    const dl = await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, sourceDocumentId: so.id,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, sourceLineId: sol.id }] });
    const [dll] = await sql`select id from document_line where document_id = ${dl.id}`;
    const inv = await P.postSalesInvoice({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, sourceLineId: dll.id }] });

    const o = await origin(inv.id);
    check("it started from the order", o.startedFrom === "ORDER", o.startedFrom);
    check("  the order is used, not merely linked",
      o.order.state === "USED" && o.order.doc.doc_no === so.docNo, o.order.state);
    check("  the delivery is done", o.fulfilment.state === "DONE", o.fulfilment.state);
    check("  and a correction belongs at the order",
      o.correctAt.kind === "ORDER" && o.correctAt.doc.doc_no === so.docNo, o.correctAt.kind);

    // The route survives being corrected.
    const v2 = await P.amendOrder({
      companyId: co.id, documentId: so.id, reason: "agreed 1,200", cascade: true,
      order: { companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: today, lines: [{ itemId: item.id, qty: 10, unitPrice: 1200 }] },
    });
    const [liveInv] = await sql`select id from document
       where doc_no = ${inv.docNo} and status = 'POSTED'`;
    const o2 = await origin(liveInv.id);
    check("  and still says so after a correction",
      o2.startedFrom === "ORDER" && o2.order.state === "USED", `${o2.startedFrom}/${o2.order.state}`);
    check("    naming the version that stands", o2.order.doc.doc_no === so.docNo,
      `${o2.order.doc.doc_no} v${v2.version}`);
  }

  // ---- delivery → invoice, no order --------------------------------------

  console.log("\n  a sale with no order behind it\n");
  {
    const dl = await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, lines: [{ itemId: item.id, qty: 6, unitPrice: 1200 }] });
    const [dll] = await sql`select id from document_line where document_id = ${dl.id}`;
    const inv = await P.postSalesInvoice({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
      lines: [{ itemId: item.id, qty: 6, unitPrice: 1200, sourceLineId: dll.id }] });

    const o = await origin(inv.id);
    check("it started from the delivery", o.startedFrom === "FULFILMENT", o.startedFrom);
    check("  the order is not used — not missing", o.order.state === "NOT_USED", o.order.state);
    check("  the goods are done", o.fulfilment.state === "DONE", o.fulfilment.state);
    check("  and a correction belongs here", o.correctAt.kind === "SELF", o.correctAt.kind);
  }

  // ---- direct invoice, goods still to go ---------------------------------

  console.log("\n  a bill raised before the goods moved\n");
  {
    const inv = await P.postSalesInvoice({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: true,
      lines: [{ itemId: item.id, qty: 4, unitPrice: 1500 }] });
    const o = await origin(inv.id);
    check("it started from the invoice", o.startedFrom === "INVOICE", o.startedFrom);
    check("  delivery is pending, which is not the same as not used",
      o.fulfilment.state === "PENDING", o.fulfilment.state);
    check("  and the order is not used", o.order.state === "NOT_USED", o.order.state);

    // Deliver it, and the same invoice now reads as done.
    const [il] = await sql`select id from document_line where document_id = ${inv.id}`;
    await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, sourceDocumentId: inv.id,
      lines: [{ itemId: item.id, qty: 4, unitPrice: 1500, sourceLineId: il.id }] });
    const o2 = await origin(inv.id);
    check("  delivering it afterwards makes it done, still invoice-first",
      o2.fulfilment.state === "DONE" && o2.startedFrom === "INVOICE",
      `${o2.startedFrom}/${o2.fulfilment.state}`);
    check("    with the delivery recorded as coming after",
      o2.fulfilmentAfter.length === 1 && o2.fulfilmentBefore.length === 0,
      `${o2.fulfilmentBefore.length} before, ${o2.fulfilmentAfter.length} after`);
  }

  // ---- a service, where no delivery applies ------------------------------

  console.log("\n  a service, which nothing delivers\n");
  {
    const inv = await P.postSalesInvoice({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: false,
      lines: [{ itemId: svc.id, qty: 1, unitPrice: 50000 }] });
    const o = await origin(inv.id);
    check("delivery is not required, rather than pending",
      o.fulfilment.state === "NOT_REQUIRED", o.fulfilment.state);
    check("  and it is a direct invoice", o.startedFrom === "INVOICE", o.startedFrom);
  }

  // ---- goods receipt → purchase invoice ----------------------------------

  console.log("\n  a bill for goods that arrived without an order\n");
  {
    const gr = await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, lines: [{ itemId: item.id, qty: 20, unitCost: 900 }] });
    const [grl] = await sql`select id from document_line where document_id = ${gr.id}`;
    const pi = await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 900, sourceLineId: grl.id }] });

    const o = await origin(pi.id);
    check("it started from the goods receipt", o.startedFrom === "FULFILMENT", o.startedFrom);
    check("  the purchase order is not used", o.order.state === "NOT_USED", o.order.state);
    check("  the goods are in", o.fulfilment.state === "DONE", o.fulfilment.state);
    check("  and it is a purchase, not a sale", o.sales === false);
  }

  // ---- an order attached after the fact ----------------------------------

  console.log("\n  an order linked afterwards\n");
  {
    const po = await P.postPurchaseOrder({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, lines: [{ itemId: item.id, qty: 12, unitPrice: 800 }] });
    const [pol] = await sql`select id from document_line where document_id = ${po.id}`;
    const gr = await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, lines: [{ itemId: item.id, qty: 12, unitCost: 800 }] });
    const [grl] = await sql`select id from document_line where document_id = ${gr.id}`;
    const pi = await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 12, unitPrice: 800, sourceLineId: grl.id }] });

    await P.linkFulfilmentToOrder({ companyId: co.id,
      lines: [{ fulfilmentLineId: grl.id, orderLineId: pol.id, qty: 12 }],
      reason: "this receipt answered that order" });

    const o = await origin(pi.id);
    check("the order is reported as linked later, not as where this began",
      o.order.state === "LINKED_LATER" && o.order.doc.doc_no === po.docNo, o.order.state);
    check("  the route still says it started at the receipt",
      o.startedFrom === "FULFILMENT", o.startedFrom);
    check("  so a correction still belongs on the bill itself",
      o.correctAt.kind === "SELF", o.correctAt.kind);
  }

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(Number(tb.v)) < 0.0001, `${Number(tb.v)}`);

  console.log(bad === 0
    ? "\n  a document says which route it took, and where correcting it belongs\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
