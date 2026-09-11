// Correcting an order corrects what was built on it.
//
//   npx tsx scripts/test-order-cascade.mjs
//
// The acceptance test, written as it was given:
//
//   Order v1: 10,000 → Delivery completed → Invoice v1: 10,000.
//   Edit the price through the Order to 12,000. Confirm once.
//   Order becomes v2, Invoice becomes v2, receivable and revenue become
//   12,000, and delivery quantity/cost stay unchanged. Both old versions
//   remain accessible.
//
// The delivery is the part that must not move. It shipped fifty boxes at
// what they cost, and no price correction changes either fact — the stock
// ledger and the cost of sales it already posted stay exactly as they are.
// What changes is what the customer is billed and what the company earned.
//
// The other half of the acceptance is quieter and easier to get wrong: after
// the correction, the delivery must still count as fulfilling the order. The
// delivery names the version it was raised against, which is now superseded,
// so anything that asks "how much of this order has shipped" has to follow
// the chain rather than look at one row.

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

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  console.log(`\n  ${co.name}  ·  ${item.code}\n`);

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_consumption, stock_lot, stock_movement,
    document_line, document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 100, unitCost: 120 }] });

  // ---- Order v1: 10,000 ---------------------------------------------------

  const so = await P.postSalesOrder({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 200 }],
  });
  const [soLine] = await sql`select id from document_line where document_id = ${so.id}`;

  // ---- Delivery completed --------------------------------------------------

  const del = await P.postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    sourceDocumentId: so.id,
    lines: [{ itemId: item.id, qty: 50, sourceLineId: soLine.id }],
  });
  const [delLine] = await sql`select id from document_line where document_id = ${del.id}`;

  // ---- Invoice v1: 10,000 --------------------------------------------------

  const inv = await P.postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, deliveryId: del.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 200, sourceLineId: delLine.id }],
  });

  const stockBefore = n((await sql`
    select coalesce(sum(qty), 0) as q from stock_movement
     where company_id = ${co.id} and document_id = ${del.id}`)[0].q);
  const cogsBefore = n((await sql`
    select coalesce(sum(jl.base_amount), 0) as v from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
     where je.source_id = ${del.id} and a.account_type = 'COGS'`)[0].v);

  console.log(`  ${so.docNo} 10,000 → ${del.docNo} 50 shipped → ${inv.docNo} 10,000\n`);

  // ---- Edit the price through the Order, once ------------------------------

  let cascade = null;
  let result = null;
  try {
    result = await P.amendOrder({
      companyId: co.id, documentId: so.id,
      reason: "agreed price corrected to 240",
      order: {
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: item.id, qty: 50, unitPrice: 240 }],
      },
      cascade: true,
    });
  } catch (e) { cascade = e.message; }

  check("the correction is accepted", cascade === null,
    cascade ? cascade.slice(0, 80) : `${result?.docNo} v${result?.version}`);

  // ---- what it must leave behind -------------------------------------------

  const orderVersions = await sql`
    select version, status, gross_total::float as total from document
     where doc_no = ${so.docNo} order by version`;
  check("the order is v2 at 12,000",
    orderVersions.length === 2
      && orderVersions[1].version === 2
      && n(orderVersions[1].total) === 12000
      && orderVersions[1].status === "POSTED",
    orderVersions.map((v) => `v${v.version} ${v.status} ${n(v.total).toLocaleString()}`).join(" · "));

  const invVersions = await sql`
    select version, status, gross_total::float as total from document
     where doc_no = ${inv.docNo} order by version`;
  check("the invoice is v2 at 12,000",
    invVersions.length === 2
      && invVersions[1].version === 2
      && n(invVersions[1].total) === 12000
      && invVersions[1].status === "POSTED",
    invVersions.map((v) => `v${v.version} ${v.status} ${n(v.total).toLocaleString()}`).join(" · "));

  const [ar] = await sql`
    select coalesce(sum(jl.base_amount), 0)::float as v from journal_line jl
      join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.is_control and a.subledger = 'CUSTOMER'`;
  check("the customer owes 12,000", n(ar.v) === 12000, `${n(ar.v).toLocaleString()}`);

  const [revenue] = await sql`
    select coalesce(-sum(jl.base_amount), 0)::float as v from journal_line jl
      join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.account_type = 'REVENUE'`;
  check("revenue is 12,000", n(revenue.v) === 12000, `${n(revenue.v).toLocaleString()}`);

  const stockAfter = n((await sql`
    select coalesce(sum(qty), 0) as q from stock_movement
     where company_id = ${co.id} and document_id = ${del.id}`)[0].q);
  const cogsAfter = n((await sql`
    select coalesce(sum(jl.base_amount), 0) as v from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
     where je.source_id = ${del.id} and a.account_type = 'COGS'`)[0].v);
  check("the delivery did not move", stockAfter === stockBefore && cogsAfter === cogsBefore,
    `${stockAfter} units, cost ${cogsAfter.toLocaleString()}`);

  const [delStatus] = await sql`select status, version from document where id = ${del.id}`;
  check("  and it is still the posted delivery it was",
    delStatus.status === "POSTED" && Number(delStatus.version) === 1,
    `${delStatus.status} v${delStatus.version}`);

  // Both old versions readable.
  const [oldOrder] = await sql`
    select status, gross_total::float as total from document
     where doc_no = ${so.docNo} and version = 1`;
  const [oldInv] = await sql`
    select status, gross_total::float as total from document
     where doc_no = ${inv.docNo} and version = 1`;
  check("both v1s are still there to read",
    n(oldOrder.total) === 10000 && n(oldInv.total) === 10000,
    `order ${oldOrder.status} · invoice ${oldInv.status}`);

  // The delivery still answers the order — through the version chain.
  const [outstanding] = await sql`
    select coalesce(sum(v.fulfilled), 0)::float as done,
           coalesce(sum(v.outstanding), 0)::float as left
      from v_order_outstanding v
      join document d on d.id = v.order_id
     where d.doc_no = ${so.docNo} and d.status = 'POSTED'`;
  check("the order still counts as fully delivered",
    n(outstanding.done) === 50 && n(outstanding.left) === 0,
    `${n(outstanding.done)} delivered, ${n(outstanding.left)} outstanding`);

  // ---- the same thing on the purchase side --------------------------------
  //
  // A supplier's order corrected the same way. The receipt must not move —
  // stock arrived at what it cost — and the bill must follow the order.

  console.log("\n  the same correction on a purchase order\n");

  const po = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100 }],
  });
  const [poLine] = await sql`select id from document_line where document_id = ${po.id}`;
  const gr = await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: po.id,
    lines: [{ itemId: item.id, qty: 20, unitCost: 100, sourceLineId: poLine.id }],
  });
  const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
  const pi = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: grLine.id }],
  });

  const grStockBefore = n((await sql`
    select coalesce(sum(qty), 0) as q from stock_movement where document_id = ${gr.id}`)[0].q);

  const poV2 = await P.amendOrder({
    companyId: co.id, documentId: po.id,
    reason: "supplier confirmed 130 a box",
    order: {
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130 }],
    },
    cascade: true,
  });

  const piVersions = await sql`
    select version, status, gross_total::float as total from document
     where doc_no = ${pi.docNo} order by version`;
  check("the purchase invoice becomes v2 at the corrected price",
    piVersions.length === 2 && n(piVersions[1].total) === 2600,
    piVersions.map((v) => `v${v.version} ${v.status} ${n(v.total).toLocaleString()}`).join(" · "));
  check("  the order is v2 too", poV2.version === 2,
    `${poV2.docNo} v${poV2.version}`);
  check("  and the receipt did not move",
    n((await sql`select coalesce(sum(qty), 0) as q from stock_movement
                  where document_id = ${gr.id}`)[0].q) === grStockBefore,
    `${grStockBefore} units still received at 100`);

  const [payable] = await sql`
    select coalesce(-sum(jl.base_amount), 0)::float as v from journal_line jl
      join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.is_control and a.subledger = 'SUPPLIER'`;
  check("  the supplier is owed 2,600, not 4,600", n(payable.v) === 2600,
    `${n(payable.v).toLocaleString()}`);

  // ---- partial billing, then the rest --------------------------------------
  //
  // 100 received, 60 billed, the price corrected, then the remaining 40
  // billed at the corrected price. The first invoice moves; the receipt does
  // not; and the second invoice is still allowed exactly 40.

  console.log("\n  a receipt billed in two parts, corrected in between\n");

  const po2 = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 50 }],
  });
  const [po2Line] = await sql`select id from document_line where document_id = ${po2.id}`;
  const gr2 = await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: po2.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 50, sourceLineId: po2Line.id }],
  });
  const [gr2Line] = await sql`select id from document_line where document_id = ${gr2.id}`;
  const firstHalf = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 60, unitPrice: 50, sourceLineId: gr2Line.id }],
  });

  await P.amendOrder({
    companyId: co.id, documentId: po2.id,
    reason: "price renegotiated to 55",
    order: {
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: item.id, qty: 100, unitPrice: 55 }],
    },
    cascade: true,
  });

  const halfVersions = await sql`
    select version, status, gross_total::float as total from document
     where doc_no = ${firstHalf.docNo} order by version`;
  check("the part-invoice is corrected, still for 60",
    n(halfVersions[1]?.total) === 3300,
    halfVersions.map((v) => `v${v.version} ${n(v.total).toLocaleString()}`).join(" · "));

  const secondHalf = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 55, sourceLineId: gr2Line.id }],
  });
  check("  and the remaining 40 can still be billed afterwards", !!secondHalf.docNo,
    `${secondHalf.docNo} · 40 × 55`);

  let overAfter = null;
  try {
    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
      goodsReceiptId: gr2.id,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 55, sourceLineId: gr2Line.id }],
    });
  } catch (e) { overAfter = e.message; }
  check("  with nothing left over to bill", overAfter !== null,
    overAfter ? overAfter.slice(0, 52) : "POSTED — 101 billed against 100 received");

  // ---- two invoices from one order ----------------------------------------

  console.log("\n  one order, two invoices\n");

  const po3 = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 30, unitPrice: 10 }],
  });
  const [po3Line] = await sql`select id from document_line where document_id = ${po3.id}`;
  const invoicesMade = [];
  for (const qty of [10, 20]) {
    const g = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      sourceDocumentId: po3.id,
      lines: [{ itemId: item.id, qty, unitCost: 10, sourceLineId: po3Line.id }],
    });
    const [gl] = await sql`select id from document_line where document_id = ${g.id}`;
    invoicesMade.push(await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
      goodsReceiptId: g.id,
      lines: [{ itemId: item.id, qty, unitPrice: 10, sourceLineId: gl.id }],
    }));
  }

  await P.amendOrder({
    companyId: co.id, documentId: po3.id,
    reason: "12 a box across the order",
    order: {
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: item.id, qty: 30, unitPrice: 12 }],
    },
    cascade: true,
  });

  const bothCorrected = [];
  for (const made of invoicesMade) {
    const [live] = await sql`
      select version, gross_total::float as total from document
       where doc_no = ${made.docNo} and status = 'POSTED'`;
    bothCorrected.push(`${made.docNo} v${live.version} ${n(live.total).toLocaleString()}`);
  }
  check("both invoices are corrected together",
    bothCorrected.every((d) => d.includes("v2")),
    bothCorrected.join(" · "));

  // ---- a paid invoice blocks the whole correction --------------------------
  //
  // And blocks it whole: the order must still be its old self afterwards, not
  // half-corrected with one invoice moved and another refused.

  console.log("\n  an order whose invoice has been paid\n");

  const po4 = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 1000 }],
  });
  const [po4Line] = await sql`select id from document_line where document_id = ${po4.id}`;
  const gr4 = await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: po4.id,
    lines: [{ itemId: item.id, qty: 5, unitCost: 1000, sourceLineId: po4Line.id }],
  });
  const [gr4Line] = await sql`select id from document_line where document_id = ${gr4.id}`;
  const pi4 = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr4.id,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 1000, sourceLineId: gr4Line.id }],
  });
  const [bank2] = await sql`select id from account
     where company_id = ${co.id} and is_bank_account and is_active order by code limit 1`;
  await P.postSupplierPayment({
    companyId: co.id, partnerId: supp.id, docDate: today,
    cashAccountId: bank2.id,
    allocations: [{ invoiceId: pi4.id, amount: 5000 }],
  });

  let blocked = null;
  try {
    await P.amendOrder({
      companyId: co.id, documentId: po4.id,
      reason: "price was wrong",
      order: {
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: item.id, qty: 5, unitPrice: 1100 }],
      },
      cascade: true,
    });
  } catch (e) { blocked = e.message; }
  check("the correction is refused, naming the invoice in the way", blocked !== null,
    blocked ? blocked.slice(0, 78) : "CORRECTED — money now points at a reversed invoice");

  const [po4After] = await sql`
    select version, status, gross_total::float as total from document where id = ${po4.id}`;
  check("  and the order is untouched — no half-correction",
    po4After.status === "POSTED" && Number(po4After.version) === 1 && n(po4After.total) === 5000,
    `v${po4After.version} ${po4After.status} ${n(po4After.total).toLocaleString()}`);
  const [pi4After] = await sql`
    select version, status from document where id = ${pi4.id}`;
  check("  and so is the invoice that was paid",
    pi4After.status === "POSTED" && Number(pi4After.version) === 1,
    `v${pi4After.version} ${pi4After.status}`);
  const [stillOne] = await sql`
    select count(*)::int as n from document where doc_no = ${po4.docNo}`;
  check("  with no orphan version left behind", stillOne.n === 1, `${stillOne.n} version`);

  // ---- the books ----------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0
    ? "\n  correcting the order corrected what was built on it\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
