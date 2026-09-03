// Proves a cleared database can still take data entry end to end: create a
// category, an item, a customer and a supplier, then buy and sell.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  // Anchored and read line by line — .env can carry more than one
  // "DATABASE_URL=" occurrence (an active line plus a commented alternative
  // documenting another branch), and an unanchored match against the whole
  // file grabs whichever occurs FIRST regardless of a leading "# ". That
  // silently pointed this script at the wrong Neon branch the moment .env
  // gained a second mention, with no error to notice it by.
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["\']|["\']$/g, ""); break; }
  }
}
const { postSaleWithDelivery, postPurchaseWithReceipt } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require",
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };
const n = (v) => Number(v ?? 0);

try {
  const [co] = await sql`select id from company limit 1`;

  // Start from a known state. These tests post real documents, and journal
  // entries and stock movements refuse row deletion by design, so anything a
  // previous run left has to go through TRUNCATE.
  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  // Promotions reference categories, so they have to go first.
  await sql`delete from promotion`;
  await sql`delete from account_determination where item_group_id is not null`;
  await sql`delete from item`;
  await sql`delete from item_group`;
  await sql`delete from business_partner`;

  const [loc] = await sql`select id from location where is_stock_location order by code limit 1`;
  const [uom] = await sql`select id from uom order by code limit 1`;
  const today = new Date().toISOString().slice(0, 10);

  check("database is empty", n((await sql`select count(*) as c from document`)[0].c) === 0);

  // Parent category, then a child under it — the depth the UI now allows.
  const [parent] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'TEST', 'x', 'Test Category') returning id`;
  const [child] = await sql`
    insert into item_group (company_id, parent_id, segment, code, name)
    values (${co.id}, ${parent.id}, '-SUB', 'x', 'Test Sub Category') returning id`;
  check("nested category created", Boolean(child.id));

  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${child.id}, '001', 'x', 'Test Product', ${uom.id}) returning id`;

  const [cust] = await sql`
    insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, 'TC-01', 'Test Customer', true, 30) returning id`;
  const [supp] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, 'TS-01', 'Test Supplier', true) returning id`;
  check("partners created", Boolean(cust.id && supp.id));

  const pi = await postPurchaseWithReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 2000 }],
  });
  check("receiving and billing posts on a cleared database", Boolean(pi.docNo), pi.docNo);
  // Type, date, then a sequence that restarts daily (migration 0035). The
  // date is asserted as well as the "001": a number that merely ends in 001
  // would also pass on a scheme that had lost the date entirely.
  check("numbering restarted at 1 for today",
    pi.docNo === `DP${today.replace(/-/g, "")}001`, pi.docNo);
  check("stock arrived",
    n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q) === 50);

  const si = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 3000 }],
  });
  check("sale posts", Boolean(si.docNo), si.docNo);
  check("stock reduced to 30",
    n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q) === 30);

  // The sale posts across two documents now: the delivery carries cost, the
  // invoice carries revenue. Every account has to resolve from the posting
  // rules on a database that was set up from scratch.
  const j = await sql`
    select account_code from v_journal_line
     where company_id = ${co.id} and account_code in ('1200', '4100', '5100', '1300')`;
  const hit = new Set(j.map((r) => r.account_code));
  check("account determination resolves receivables and revenue",
    hit.has("1200") && hit.has("4100"));
  check("account determination resolves COGS and inventory",
    hit.has("5100") && hit.has("1300"),
    [...hit].sort().join(" "));

  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001);
  check("inventory reconciles",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0 ? "\n  a cleared database is fully usable\n" : `\n  ${bad} failed\n`);
} catch (e) {
  console.error(`\n  error: ${e.message}\n`); bad++;
} finally { await sql.end(); }
process.exit(bad === 0 ? 0 : 1);
