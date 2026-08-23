// Free-of-charge sales, end to end. A giveaway is a real stock movement at a
// real cost — the goods leave, they are just not charged for. So the cost has
// to reach a promotion expense account instead of COGS, no revenue may be
// recognised, and the customer must not be billed a single kyat for it.
//
//   node scripts/test-foc.mjs
//
// Posts real documents. Run against a scratch database.
//
// This suite exists because FOC was offered in the sales voucher and covered
// by nothing, and was broken the whole time: the delivery wrote the FIFO cost
// into unit_price, which the schema forbids on a free line, so every FOC sale
// died on a check constraint.

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

const { postGoodsReceipt, postSaleWithDelivery } = await import("../lib/posting.ts");

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
  sql`select account_code, account_name, debit, credit from v_journal_line
       where source_id = ${docId} order by line_no`;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  let [cust] = await sql`
    select id, code from business_partner where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!cust) {
    [cust] = await sql`
      insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
      values (${co.id}, 'FOC-C', 'FOC Test Customer', true, 30) returning id, code`;
  }

  let [supp] = await sql`
    select id, code from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'FOC-S', 'FOC Test Supplier', true) returning id, code`;
  }

  let [item] = await sql`
    select id, code, name from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`
        insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'FC', 'x', 'FOC Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`
      insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'FOC Test Item', ${uom.id})
      returning id, code, name`;
  }

  const [foc] = await sql`
    select id, code, name, account_id from foc_reason where company_id = ${co.id} order by code limit 1`;
  if (!foc) throw new Error("No FOC reason configured — foundation data is incomplete");

  const [focAcct] = await sql`select code, name from account where id = ${foc.account_id}`;

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n  ${co.name}  ·  item ${item.code}  ·  ${loc.code}  ·  FOC reason ${foc.code} → ${focAcct.code}\n`);

  await postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }],
  });

  // ---- A sale with a giveaway rider: 10 sold, 2 free ---------------------

  const sale = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, memo: "buy ten get two",
    lines: [
      { itemId: item.id, qty: 10, unitPrice: 1500 },
      { itemId: item.id, qty: 2, unitPrice: 0, focReasonId: foc.id },
    ],
  });
  console.log(`  posted ${sale.docNo}  10 @ 1500 plus 2 free\n`);

  check("a free-of-charge sale posts at all", !!sale.id);
  check("all twelve units leave stock", (await onHand(co.id, item.id, loc.id)) === 88);

  const [inv] = await sql`select net_total, gross_total from document where id = ${sale.id}`;
  check("the customer is billed for the ten only", n(inv.net_total) === 15000, `${n(inv.net_total)}`);

  const invJ = await journalOf(sale.id);
  check("revenue is the ten only", invJ.some((l) => n(l.credit) === 15000 && l.account_code === "4100"));
  check("receivable is the ten only", invJ.some((l) => n(l.debit) === 15000));

  // postSaleWithDelivery posts the delivery first, so it is the invoice that
  // points back at it, not the other way round.
  const [del] = await sql`
    select dl.id, dl.doc_no from document si
      join document dl on dl.id = si.source_document_id and dl.doc_type = 'DELIVERY'
     where si.id = ${sale.id}`;
  if (!del) throw new Error("the sale posted no delivery");
  const delJ = await journalOf(del.id);

  check("inventory is relieved of all twelve at cost",
    delJ.some((l) => n(l.credit) === 12000 && l.account_code === "1300"), "12 × 1000");
  check("the ten sold hit COGS", delJ.some((l) => n(l.debit) === 10000 && l.account_code === "5100"));
  check(`the two free hit ${focAcct.code} ${focAcct.name}, not COGS`,
    delJ.some((l) => n(l.debit) === 2000 && l.account_code === focAcct.code));

  // ---- The line itself ---------------------------------------------------

  const delLines = await sql`
    select unit_price, net_amount, base_qty, foc_reason_id from document_line
     where document_id = ${del.id} order by line_no`;
  const focLine = delLines.find((l) => l.foc_reason_id);
  check("the free delivery line carries no price", focLine && n(focLine.unit_price) === 0);
  check("its cost is still recorded", focLine && n(focLine.net_amount) === 2000, `${n(focLine?.net_amount)}`);

  const invLines = await sql`
    select unit_price, net_amount, foc_reason_id from document_line
     where document_id = ${sale.id} order by line_no`;
  const focInvLine = invLines.find((l) => l.foc_reason_id);
  check("the free invoice line charges nothing",
    focInvLine && n(focInvLine.unit_price) === 0 && n(focInvLine.net_amount) === 0);

  // ---- Everything free ---------------------------------------------------

  let refusal = null;
  try {
    await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null,
      lines: [{ itemId: item.id, qty: 3, unitPrice: 0, focReasonId: foc.id }],
    });
  } catch (err) { refusal = err.message; }
  check("a sale that is entirely free is refused, not half-posted", refusal !== null, refusal ?? "");
  check("and the refusal says what to do instead",
    refusal !== null && /deliver/i.test(refusal), refusal ?? "");
  check("nothing was left behind by the refusal", (await onHand(co.id, item.id, loc.id)) === 88);

  // ---- Invariants --------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all FOC tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
