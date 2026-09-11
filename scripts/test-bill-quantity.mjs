// An invoice bills what the document it names actually contains.
//
//   npx tsx scripts/test-bill-quantity.mjs
//
// From the tester, in her own words: "if the delivery is 100, the invoice may
// be incorrectly opened as 90, 80, or 110, so I don't want to allow you to
// make changes." She was right that it could. The invoice forms prefilled the
// quantity from the receipt or the delivery and then let it be typed over,
// and nothing downstream disagreed — on the purchase side the excess landed
// in price variance, and on the sales side the delivery's lines were never
// compared with the invoice's at all.
//
// Quantity is not an opinion. Price can differ from what the goods were
// valued at, and that difference is what variance is for; a hundred and ten
// boxes cannot arrive in a hundred.
//
// Billing in parts stays possible, because a receipt genuinely can be
// invoiced twice — what is refused is the total exceeding what exists.

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

  await sql.unsafe(`truncate table fulfilment_link, order_closure, payment_allocation,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  // ---- purchases: 100 received --------------------------------------------

  console.log("  100 received, and what an invoice may bill for it\n");

  const gr = await P.postGoodsReceipt({ ...base, docDate: today,
    lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] });
  const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;

  let over = null;
  try {
    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
      goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 110, unitPrice: 1000, sourceLineId: grLine.id }],
    });
  } catch (e) { over = e.message; }
  check("billing 110 against 100 received is refused", over !== null,
    over ? over.slice(0, 74) : "POSTED — ten boxes that never arrived are now owed for");

  // Billing less is ordinary, and so is billing the rest afterwards.
  const part = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 60, unitPrice: 1000, sourceLineId: grLine.id }],
  });
  check("  billing 60 of it is fine", !!part.docNo, part.docNo);

  let overRest = null;
  try {
    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
      goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 50, unitPrice: 1000, sourceLineId: grLine.id }],
    });
  } catch (e) { overRest = e.message; }
  check("  and a second invoice cannot take 50 when 40 is left", overRest !== null,
    overRest ? overRest.slice(0, 62) : "POSTED — 110 billed across two invoices");

  const rest = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 1000, sourceLineId: grLine.id }],
  });
  check("  the remaining 40 bills normally", !!rest.docNo, rest.docNo);

  // A price that differs is not the same thing, and stays allowed.
  const gr2 = await P.postGoodsReceipt({ ...base,
    lines: [{ itemId: item.id, qty: 10, unitCost: 1000 }] });
  const [gr2Line] = await sql`select id from document_line where document_id = ${gr2.id}`;
  const dearer = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, docDate: today, dueDate: null,
    goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1200, sourceLineId: gr2Line.id }],
  });
  check("a price the supplier actually charged still posts", !!dearer.docNo,
    "10 received at 1,000, billed at 1,200");

  // ---- sales: 100 delivered, her example exactly ---------------------------

  console.log("\n  100 delivered, and what an invoice may bill for it\n");

  await P.postGoodsReceipt({ ...base, lines: [{ itemId: item.id, qty: 300, unitCost: 1000 }] });
  const del = await P.postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 100 }],
  });
  const [delLine] = await sql`select id from document_line where document_id = ${del.id}`;

  let overSale = null;
  try {
    await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null, deliveryId: del.id,
      lines: [{ itemId: item.id, qty: 110, unitPrice: 1800, sourceLineId: delLine.id }],
    });
  } catch (e) { overSale = e.message; }
  check("billing 110 against 100 delivered is refused", overSale !== null,
    overSale ? overSale.slice(0, 74) : "POSTED — the customer is billed for goods never sent");

  const sold = await P.postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, deliveryId: del.id,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1800, sourceLineId: delLine.id }],
  });
  check("  100 bills exactly", n(sold.docNo && 1) === 1, `${sold.docNo} · 100 × 1,800`);

  // And an invoice naming a delivery cannot bill an item it never carried.
  const [other] = await sql`select id, code from item
     where company_id = ${co.id} and is_active and id <> ${item.id} order by code limit 1`;
  let wrongItem = null;
  try {
    await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null, deliveryId: del.id,
      lines: [{ itemId: other.id, qty: 1, unitPrice: 500, sourceLineId: delLine.id }],
    });
  } catch (e) { wrongItem = e.message; }
  check("  and it cannot bill a line for a different item", wrongItem !== null,
    wrongItem ? wrongItem.slice(0, 58) : "POSTED — billed something that never shipped");

  // ---- the books still hold ------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0
    ? "\n  an invoice bills what is there, and no more\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
