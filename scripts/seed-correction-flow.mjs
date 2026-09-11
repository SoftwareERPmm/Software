// One order, delivered and invoiced, for the UI correction test to work on.
//
//   npx tsx scripts/seed-correction-flow.mjs
//
// Prints the order's id and number, so the browser test knows where to go
// without guessing from a list.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

const [co] = await sql`select id from company order by created_at limit 1`;
const [loc] = await sql`select id from location
   where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
const [item] = await sql`select id from item
   where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
const [cust] = await sql`select id from business_partner
   where company_id = ${co.id} and is_customer order by code limit 1`;
const [supp] = await sql`select id from business_partner
   where company_id = ${co.id} and is_supplier order by code limit 1`;
const today = new Date().toISOString().slice(0, 10);

await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
  payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
  stock_movement, document_line, document, journal_line, journal_entry
  restart identity cascade`);
await sql`update number_series set next_value = 1`;

await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
  docDate: today, lines: [{ itemId: item.id, qty: 200, unitCost: 400 }] });

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

const out = { orderId: so.id, orderNo: so.docNo, invoiceNo: inv.docNo, deliveryNo: dl.docNo };
writeFileSync(join(root, ".playwright-cli", "seed.json"),
  JSON.stringify(out, null, 1) + "\n", { flag: "w" });
console.log(JSON.stringify(out));
await sql.end();
