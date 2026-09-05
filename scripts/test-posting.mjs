// The purchase and sales cycles as they actually post now: stock moves on the
// goods receipt and the delivery, never on the invoice. Costing is FIFO, so a
// sale draws from the oldest cost layer first.
//
//   node scripts/test-posting.mjs
//
// Posts real documents. Run against a scratch database.

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

const {
  postGoodsReceipt, postPurchaseInvoice,
  postDelivery, postSalesInvoice,
  postPurchaseWithReceipt, postSaleWithDelivery,
} = await import("../lib/posting.ts");
const { accountsFor } = await import("./accounts.mjs");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

const onHand = async (co, item, loc) =>
  n((await sql`select fn_qty_on_hand(${co}, ${item}, ${loc}) as q`)[0].q);

const journalOf = async (docId) =>
  sql`select account_code, debit, credit from v_journal_line
       where source_id = ${docId} order by line_no`;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  // Fixtures, created only if the database does not already have them.
  let [cust] = await sql`
    select id, code from business_partner where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!cust) {
    [cust] = await sql`
      insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
      values (${co.id}, 'PT-C', 'Posting Test Customer', true, 30) returning id, code`;
  }

  let [supp] = await sql`
    select id, code from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'PT-S', 'Posting Test Supplier', true) returning id, code`;
  }

  let [item] = await sql`
    select id, code, name from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`
        insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'PT', 'x', 'Posting Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`
      insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'Posting Test Item', ${uom.id})
      returning id, code, name`;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n  ${co.name}  ·  item ${item.code}  ·  ${loc.code}\n`);

  // ---- GOODS RECEIPT: stock in, nothing owed yet -------------------------

  // The codes this chart actually uses, asked of the same resolvers the
  // posting code asks. Hard-coded demo codes made a real chart look broken.
  const acct = accountsFor(sql, co.id);
  const INVENTORY = await acct.forItem("INVENTORY", item.id);
  const COGS = await acct.forItem("COGS", item.id);
  const REVENUE = await acct.forItem("REVENUE", item.id);
  const GRIR = await acct.role("GRIR_CLEARING");
  const AR = await acct.control("AR_CONTROL", cust.id);
  const AP = await acct.control("AP_CONTROL", supp.id);

  const gr = await postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, memo: "first layer",
    lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }],
  });
  console.log(`  posted ${gr.docNo}  100 @ 1000`);

  check("goods receipt brings stock in", (await onHand(co.id, item.id, loc.id)) === 100);

  const grJ = await journalOf(gr.id);
  check("receipt debits inventory", grJ.some((l) => n(l.debit) === 100000 && l.account_code === INVENTORY));
  check("receipt credits GR/IR, not payables",
    grJ.some((l) => n(l.credit) === 100000 && l.account_code === GRIR) &&
    !grJ.some((l) => l.account_code === AP));

  // ---- PURCHASE INVOICE: the bill, no stock movement ---------------------

  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }],
  });
  console.log(`  posted ${pi.docNo}  billing that receipt`);

  check("invoice moves no stock", (await onHand(co.id, item.id, loc.id)) === 100);

  const piJ = await journalOf(pi.id);
  check("invoice clears GR/IR", piJ.some((l) => n(l.debit) === 100000 && l.account_code === GRIR));
  check("invoice credits payables", piJ.some((l) => n(l.credit) === 100000 && l.account_code === AP));
  check("invoice opens a payable",
    n((await sql`select outstanding from v_open_item where document_id = ${pi.id}`)[0]?.outstanding) === 100000);

  // ---- A SECOND, DEARER LAYER -------------------------------------------

  const gr2 = await postPurchaseWithReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: null, memo: "second layer",
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1500 }],
  });
  console.log(`  posted ${gr2.docNo}  100 @ 1500 (received and billed together)`);

  check("combined receipt-and-bill brings stock in",
    (await onHand(co.id, item.id, loc.id)) === 200);

  const lots = await sql`
    select unit_cost, qty_received from stock_lot
     where company_id = ${co.id} and item_id = ${item.id} order by received_date, created_at`;
  check("two cost layers exist", lots.length === 2,
    lots.map((l) => `${n(l.qty_received)}@${n(l.unit_cost)}`).join(" "));

  // ---- DELIVERY: stock out at FIFO cost ----------------------------------
  // 150 units drawn from 100@1000 then 50@1500 = 175,000, not 150 × the
  // average of 1250 (187,500) and not 150 × 1500.

  const del = await postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 150 }],
  });
  console.log(`\n  posted ${del.docNo}  150 out`);

  check("delivery reduces stock", (await onHand(co.id, item.id, loc.id)) === 50);

  const delJ = await journalOf(del.id);
  const cogs = delJ.find((l) => l.account_code === COGS);
  check("delivery debits COGS", Boolean(cogs));
  check("COGS is FIFO: oldest layer first", Math.abs(n(cogs?.debit) - 175000) < 1,
    `${n(cogs?.debit)} (expected 175,000; average would be 187,500)`);
  check("delivery credits inventory for the same",
    delJ.some((l) => Math.abs(n(l.credit) - 175000) < 1 && l.account_code === INVENTORY));
  check("delivery raises no revenue", !delJ.some((l) => l.account_code === REVENUE));

  // ---- SALES INVOICE: revenue, no stock movement -------------------------

  const si = await postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, deliveryId: del.id,
    lines: [{ itemId: item.id, qty: 150, unitPrice: 2500 }],
  });
  console.log(`  posted ${si.docNo}  150 @ 2500`);

  check("invoice moves no stock", (await onHand(co.id, item.id, loc.id)) === 50);

  const siJ = await journalOf(si.id);
  check("invoice debits receivables", siJ.some((l) => n(l.debit) === 375000 && l.account_code === AR));
  check("invoice credits revenue", siJ.some((l) => n(l.credit) === 375000 && l.account_code === REVENUE));
  check("invoice posts no COGS — the delivery already did",
    !siJ.some((l) => l.account_code === COGS));

  // ---- Counter sale: one step, both effects ------------------------------

  const counter = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2500 }],
  });
  console.log(`  posted ${counter.docNo}  10 sold over the counter`);
  check("counter sale moves stock and bills in one step",
    (await onHand(co.id, item.id, loc.id)) === 40);

  // ---- Overselling is refused --------------------------------------------

  let refused = false;
  try {
    await postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, lines: [{ itemId: item.id, qty: 99999 }],
    });
  } catch { refused = true; }
  check("delivering more than is on hand is refused", refused);

  // ---- Invariants --------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all posting tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
