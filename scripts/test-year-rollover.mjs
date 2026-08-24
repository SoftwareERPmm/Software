// Posting across a fiscal year boundary.
//
//   node scripts/test-year-rollover.mjs
//
// Posts real documents. Run against a scratch database.
//
// Numbering restarts every fiscal year by design, while document.doc_no and
// journal_entry.entry_no must stay unique for the life of the company. Before
// migration 0025 those two rules contradicted each other, and the first
// document of a company's second year was rejected:
//
//   duplicate key value violates unique constraint
//   "document_company_id_doc_type_doc_no_key"
//
// Nothing could post from that point on, journal entries included. A company
// could only discover it by surviving into its second year, which no test
// covered because every other suite works inside one.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { postGoodsReceipt, postPurchaseInvoice, postSaleWithDelivery } =
  await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`delete from number_series`;

  // The year the company already trades in, and the one it is about to enter.
  const [thisYear] = await sql`
    select id, code, start_date, end_date from fiscal_year
     where company_id = ${co.id} order by start_date limit 1`;

  const nextStart = new Date(thisYear.end_date); nextStart.setUTCDate(nextStart.getUTCDate() + 1);
  const nextEnd = new Date(nextStart); nextEnd.setUTCFullYear(nextEnd.getUTCFullYear() + 1);
  nextEnd.setUTCDate(nextEnd.getUTCDate() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);

  let [nextYear] = await sql`
    select id from fiscal_year where company_id = ${co.id} and start_date = ${iso(nextStart)}`;
  if (!nextYear) {
    const code = `${nextStart.getUTCFullYear()}-${String(nextEnd.getUTCFullYear()).slice(2)}`;
    [nextYear] = await sql`
      insert into fiscal_year (company_id, code, start_date, end_date)
      values (${co.id}, ${code}, ${iso(nextStart)}, ${iso(nextEnd)}) returning id`;
    for (let m = 0; m < 12; m++) {
      const s = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + m, 1));
      const e = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + m + 1, 0));
      await sql`insert into fiscal_period (company_id, fiscal_year_id, period_no, start_date, end_date)
        values (${co.id}, ${nextYear.id}, ${m + 1}, ${iso(s)}, ${iso(e)})`;
    }
  }

  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'YR-S', 'Rollover Supplier', true) returning id`;
  }
  let [cust] = await sql`
    select id from business_partner where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!cust) {
    [cust] = await sql`insert into business_partner (company_id, code, name, is_customer)
      values (${co.id}, 'YR-C', 'Rollover Customer', true) returning id`;
  }
  let [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'YR', 'x', 'Rollover Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'Rollover Item', ${uom.id}) returning id`;
  }

  // A date inside each year: the last month of this one, the first of the next.
  const lastMonth = new Date(thisYear.end_date); lastMonth.setUTCDate(15);
  const firstMonth = new Date(nextStart); firstMonth.setUTCDate(15);

  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id };

  console.log(`\n  ${co.name}   ${thisYear.code} → the year after\n`);

  const grA = await postGoodsReceipt({ ...base, docDate: iso(lastMonth),
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  const piA = await postPurchaseInvoice({ ...base, docDate: iso(lastMonth), dueDate: null,
    goodsReceiptId: grA.id, lines: [{ itemId: item.id, qty: 50, unitPrice: 1000 }] });
  console.log(`  in ${thisYear.code}:   ${grA.docNo}   ${piA.docNo}`);

  const grB = await postGoodsReceipt({ ...base, docDate: iso(firstMonth),
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  const piB = await postPurchaseInvoice({ ...base, docDate: iso(firstMonth), dueDate: null,
    goodsReceiptId: grB.id, lines: [{ itemId: item.id, qty: 50, unitPrice: 1000 }] });
  console.log(`  in the next:  ${grB.docNo}   ${piB.docNo}\n`);

  check("the new year can post at all", !!grB.id && !!piB.id);
  check("its numbers do not collide with last year's",
    grB.docNo !== grA.docNo && piB.docNo !== piA.docNo);
  check("each number says which year it belongs to",
    /^GR-\d{2,4}-\d+$/.test(grA.docNo) && /^GR-\d{2,4}-\d+$/.test(grB.docNo),
    `${grA.docNo} / ${grB.docNo}`);
  check("the count restarts in the new year, as documented",
    grA.docNo.split("-").pop() === grB.docNo.split("-").pop(), "both end 000001");

  const sale = await postSaleWithDelivery({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: iso(firstMonth), dueDate: null,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 2000 }] });
  check("a sale posts in the new year too", !!sale.docNo, sale.docNo);

  const entries = await sql`select entry_no from journal_entry order by created_at`;
  check("journal entry numbers are unique across the boundary",
    new Set(entries.map((e) => e.entry_no)).size === entries.length,
    `${entries.length} entries`);
  check("and they carry the year as well",
    entries.every((e) => /^JE-\d{2,4}-\d+$/.test(e.entry_no)),
    entries[0]?.entry_no);

  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance nets to zero across both years", Math.abs(Number(tb.v)) < 0.0001);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);

  console.log(failures === 0 ? "\n  the year turns cleanly\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
