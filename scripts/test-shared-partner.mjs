// One partner record, both roles: ABC Co. checked as both Customer and
// Supplier should be the same row in both dropdowns, never two records.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
import { resetTransactions } from "./test-reset.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { postSaleWithDelivery, postPurchaseWithReceipt } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });


// One suite at a time: these share a database and empty it, so a second
// runner is refused rather than left to collide. See scripts/test-lock.mjs.
await takeTestLock(sql, "test-shared-partner.mjs");
let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };

try {
  const [co] = await sql`select id from company limit 1`;

  await resetTransactions(sql);
  await sql`delete from business_partner where code = 'ABC'`;
  await sql`delete from item where code like 'SP%'`;
  await sql`delete from item_group where code like 'SP%'`;

  // One row, both boxes ticked — exactly the checkbox pair the UI offers.
  const [abc] = await sql`
    insert into business_partner (company_id, code, name, is_customer, is_supplier, payment_terms_days)
    values (${co.id}, 'ABC', 'ABC Co.', true, true, 30) returning id`;

  const dupes = await sql`select count(*)::int as n from business_partner where code = 'ABC'`;
  check("exactly one row exists for ABC Co.", dupes[0].n === 1);

  // The two role queries lib/actions.ts uses for the Sales Order and
  // Purchase Order dropdowns.
  const custPool = await sql`
    select id from business_partner where company_id = ${co.id} and is_customer and is_active`;
  const suppPool = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier and is_active`;

  check("ABC Co. appears in the customer dropdown", custPool.some((r) => r.id === abc.id));
  check("ABC Co. appears in the supplier dropdown", suppPool.some((r) => r.id === abc.id));
  check("same id in both — not two records",
    custPool.find((r) => r.id === abc.id)?.id === suppPool.find((r) => r.id === abc.id)?.id);

  // Post an actual sale and an actual purchase to the same id.
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'SP', 'x', 'Shared Partner Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'Test Item', ${uom.id}) returning id`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;

  const today = new Date().toISOString().slice(0, 10);

  const po = await postPurchaseWithReceipt({
    companyId: co.id, partnerId: abc.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }],
  });
  check("a purchase invoice posts against ABC Co. as supplier", Boolean(po.docNo), po.docNo);

  const so = await postSaleWithDelivery({
    companyId: co.id, partnerId: abc.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 2, unitPrice: 2000 }],
  });
  check("a sales invoice posts against the same ABC Co. as customer", Boolean(so.docNo), so.docNo);

  const [bothDocs] = await sql`
    select count(distinct partner_id)::int as n from document where id in (${po.id}, ${so.id})`;
  check("both documents reference the same partner_id", bothDocs.n === 1);

  const [ap] = await sql`select outstanding from v_open_item where document_id = ${po.id}`;
  const [ar] = await sql`select outstanding from v_open_item where document_id = ${so.id}`;
  check("ABC Co. owes and is owed independently, on one record",
    Number(ap.outstanding) === 10000 && Number(ar.outstanding) === 4000,
    `owes ${ap.outstanding}, owed ${ar.outstanding}`);

  await resetTransactions(sql);
  await sql`delete from business_partner where code = 'ABC'`;
  await sql`delete from item where code like 'SP%'`;
  await sql`delete from item_group where code like 'SP%'`;

  console.log(bad === 0 ? "\n  one partner, both roles, no duplication\n" : `\n  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await releaseTestLock(sql);
  await sql.end({ timeout: 5 });
}

process.exit(bad === 0 ? 0 : 1);
