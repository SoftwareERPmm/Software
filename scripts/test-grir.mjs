// GR/IR clearing, matched line by line, from both directions.
//
//   node scripts/test-grir.mjs
//
// Posts real documents. Run against a scratch database.
//
// A goods receipt and a purchase invoice settle against each other, and
// either can arrive first. Whichever posts second must work out how much of
// the first it actually covers, and at what rate. Two ways that went wrong:
//
//   Per document instead of per line — half a shipment released an entire
//   invoice and dumped the rest into price variance.
//   Per item instead of per line — two lines of one item at different costs
//   were averaged, settling at a rate nothing was received at.
//
// Both are proven here in the shapes that exposed them.

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

const { postGoodsReceipt, postPurchaseInvoice } = await import("../lib/posting.ts");

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

// Signed: positive is a debit. GR/IR carries a credit balance while goods are
// received and unbilled, so an outstanding liability reads as a positive
// "owed" figure here.
const balance = async (code) =>
  n((await sql`select coalesce(sum(jl.amount), 0) as v from journal_line jl
                join account a on a.id = jl.account_id where a.code = ${code}`)[0].v);

const wipe = async () => {
  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await wipe();

  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'GI-S', 'GR/IR Test Supplier', true) returning id`;
  }

  let [item] = await sql`
    select id, code from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`
        insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'GI', 'x', 'GR/IR Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`
      insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'GR/IR Test Item', ${uom.id}) returning id, code`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  console.log(`\n  ${co.name}  ·  item ${item.code}  ·  ${loc.code}`);

  // ---- Goods first, one receipt holding two different costs --------------

  console.log("\n  goods first — 50 @ 1,000 and 50 @ 2,000 on one receipt\n");

  const gr = await postGoodsReceipt({ ...base, lines: [
    { itemId: item.id, qty: 50, unitCost: 1000 },
    { itemId: item.id, qty: 50, unitCost: 2000 },
  ]});
  const grLines = await sql`
    select id from document_line where document_id = ${gr.id} order by line_no`;

  check("the receipt holds the full 150,000 in GR/IR", (await balance("1310")) === -150000,
    `${-(await balance("1310"))}`);

  const pi1 = await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1000, sourceLineId: grLines[0].id }] });

  check("billing the cheap line settles 50,000, not an averaged 75,000",
    (await balance("1310")) === -100000, `${-(await balance("1310"))} still owed`);
  check("and books no variance, because it matched exactly",
    (await balance("5200")) === 0, `${await balance("5200")}`);

  const pi2 = await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 2000, sourceLineId: grLines[1].id }] });

  check("billing the dear line clears the rest", (await balance("1310")) === 0);
  check("still no variance across the pair", (await balance("5200")) === 0);
  check("both invoices recorded which receipt line they billed",
    (await sql`select count(*)::int as c from document_line dl join document d on d.id = dl.document_id
                where d.doc_type = 'PURCHASE_INVOICE' and dl.source_line_id is not null`)[0].c === 2);

  // ---- Same shape, but the invoice names no line -------------------------

  await wipe();
  console.log("\n  same receipt, invoice names no line — oldest cost layer first\n");

  const gr2 = await postGoodsReceipt({ ...base, lines: [
    { itemId: item.id, qty: 50, unitCost: 1000 },
    { itemId: item.id, qty: 50, unitCost: 2000 },
  ]});
  await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1000 }] });

  check("an unnamed line settles the oldest layer, at 1,000",
    (await balance("1310")) === -100000, `${-(await balance("1310"))} still owed`);
  check("no variance invented", (await balance("5200")) === 0);

  await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 2200 }] });
  check("a genuine overcharge does reach variance",
    (await balance("5200")) === 10000, `${await balance("5200")} on 50 × 200`);

  // ---- Bill first, goods in two shipments --------------------------------

  await wipe();
  console.log("\n  bill first — 100 @ 1,000 invoiced, goods arrive in halves\n");

  const pi3 = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  check("the invoice alone holds 100,000 in GR/IR", (await balance("1310")) === 100000);

  await postGoodsReceipt({ ...base, sourceDocumentId: pi3.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  check("half the goods release half the invoice, not all of it",
    (await balance("1310")) === 50000, `${await balance("1310")} still awaited`);
  check("and book no variance", (await balance("5200")) === 0, `${await balance("5200")}`);

  await postGoodsReceipt({ ...base, sourceDocumentId: pi3.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  check("the second half clears it exactly", (await balance("1310")) === 0);
  check("with no variance across the pair", (await balance("5200")) === 0);

  // ---- Goods dearer than billed ------------------------------------------

  await wipe();
  console.log("\n  goods arrive dearer than the bill said\n");

  const pi4 = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  await postGoodsReceipt({ ...base, sourceDocumentId: pi4.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1100 }] });

  check("only the invoiced half is released", (await balance("1310")) === 50000);
  check("stock capitalised above what is owed is a favourable variance",
    (await balance("5200")) === -5000, `${await balance("5200")} credit on 50 × 100`);

  // ---- Invariants --------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all GR/IR tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
