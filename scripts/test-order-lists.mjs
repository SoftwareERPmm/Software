// Sales/Purchase Orders lists: fulfilment status derived from ordered vs
// delivered/received quantity, at the whole-order level.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { postSalesOrder, postDelivery } = await import("../lib/posting.ts");
const { orderDisplayStatus } = await import("../lib/format.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });


// One suite at a time: these share a database and empty it, so a second
// runner is refused rather than left to collide. See scripts/test-lock.mjs.
await takeTestLock(sql, "test-order-lists.mjs");
let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };
const n = (v) => Number(v ?? 0);

try {
  const [co] = await sql`select id from company limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from business_partner where code = 'OL-C'`;
  await sql`delete from item where code like 'OL%'`;
  await sql`delete from item_group where code like 'OL%'`;

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'OL', 'x', 'Order List Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'Test Item', ${uom.id}) returning id`;
  const [loc] = await sql`select id from location where company_id = ${co.id} and is_stock_location limit 1`;
  const [cust] = await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, 'OL-C', 'Order List Customer', true) returning id`;

  await sql`
    insert into stock_lot (company_id, item_id, location_id, received_date, unit_cost, qty_received)
    values (${co.id}, ${item.id}, ${loc.id}, '2026-01-01', 1000, 1000)`;
  await sql`
    insert into stock_movement (company_id, item_id, location_id, movement_date, occurred_at, qty, unit_cost, total_cost)
    values (${co.id}, ${item.id}, ${loc.id}, '2026-01-01', '2026-01-01T00:00:00Z', 1000, 1000, 1000000)`;

  const today = new Date().toISOString().slice(0, 10);

  // Open: ordered, nothing delivered.
  const openOrder = await postSalesOrder({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }],
  });

  // Partial: ordered 10, deliver 4.
  const partialOrder = await postSalesOrder({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }],
  });
  const [partialLine] = await sql`select id from document_line where document_id = ${partialOrder.id}`;
  await postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 4, sourceLineId: partialLine.id }],
  });

  // Fulfilled: ordered 5, deliver all 5.
  const fullOrder = await postSalesOrder({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 2000 }],
  });
  const [fullLine] = await sql`select id from document_line where document_id = ${fullOrder.id}`;
  await postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 5, sourceLineId: fullLine.id }],
  });

  console.log(`\n  ${openOrder.docNo} open, ${partialOrder.docNo} partial, ${fullOrder.docNo} fulfilled\n`);

  const rows = await sql`
    select o.id as document_id, o.doc_no, o.status as doc_status,
           coalesce(sum(ol.base_qty), 0) as ordered_qty,
           coalesce(sum(fl.line_fulfilled), 0) as fulfilled_qty
      from document o
      join document_line ol on ol.document_id = o.id
      left join (
            select dl.source_line_id, sum(dl.base_qty) as line_fulfilled
              from document_line dl join document dd on dd.id = dl.document_id
             where dd.doc_type = 'DELIVERY' and dd.status = 'POSTED'
             group by dl.source_line_id
      ) fl on fl.source_line_id = ol.id
     where o.company_id = ${co.id} and o.doc_type = 'SALES_ORDER'
       and o.id in (${openOrder.id}, ${partialOrder.id}, ${fullOrder.id})
     group by o.id, o.doc_no, o.status`;

  const statusOf = (id) => {
    const r = rows.find((x) => x.document_id === id);
    return orderDisplayStatus({ docStatus: r.doc_status, orderedQty: r.ordered_qty, fulfilledQty: r.fulfilled_qty });
  };

  check("nothing delivered reads OPEN", statusOf(openOrder.id) === "OPEN", statusOf(openOrder.id));
  check("4 of 10 delivered reads PARTIALLY_FULFILLED",
    statusOf(partialOrder.id) === "PARTIALLY_FULFILLED", statusOf(partialOrder.id));
  check("5 of 5 delivered reads FULFILLED", statusOf(fullOrder.id) === "FULFILLED", statusOf(fullOrder.id));

  const openRow = rows.find((r) => r.document_id === openOrder.id);
  const partialRow = rows.find((r) => r.document_id === partialOrder.id);
  const fullRow = rows.find((r) => r.document_id === fullOrder.id);

  check("open order: ordered 10, fulfilled 0", n(openRow.ordered_qty) === 10 && n(openRow.fulfilled_qty) === 0);
  check("partial order: ordered 10, fulfilled 4", n(partialRow.ordered_qty) === 10 && n(partialRow.fulfilled_qty) === 4);
  check("full order: ordered 5, fulfilled 5", n(fullRow.ordered_qty) === 5 && n(fullRow.fulfilled_qty) === 5);

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from business_partner where code = 'OL-C'`;
  await sql`delete from item where code like 'OL%'`;
  await sql`delete from item_group where code like 'OL%'`;

  console.log(bad === 0 ? "\n  order fulfilment status is correct\n" : `\n  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await releaseTestLock(sql);
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
