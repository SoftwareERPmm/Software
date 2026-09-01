// Creating a product from inside a voucher: the case where the catalogue does
// not exist yet and someone is standing at the counter.

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

const { createItemInline } = await import("../lib/actions.ts");
const { postPurchaseWithReceipt } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, {
  ssl: local ? false : "require",
  prepare: !url.includes("-pooler."),
  onnotice: () => {}, max: 1,
});

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };

try {
  const [co] = await sql`select id from company limit 1`;

  // Start from a known state. Journal entries and stock movements refuse row
  // deletion by design, so anything a previous run posted has to go through
  // TRUNCATE before the items it references can be removed.
  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from item where code like '77%'`;
  await sql`delete from item_group where code like '77%'`;

  const [parent] = await sql`
    insert into item_group (company_id, parent_id, segment, code, name)
    values (${co.id}, null, '77', 'x', 'Pharmacy') returning id, code`;
  const [child] = await sql`
    insert into item_group (company_id, parent_id, segment, code, name)
    values (${co.id}, ${parent.id}, '01', 'x', 'Eye Care') returning id, code`;

  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  console.log(`\n  category Pharmacy > Eye Care = ${child.code}\n`);

  // First item in an empty category should number itself 001.
  const a = await createItemInline({
    name: "ABC Eye Cleaner 100ml", groupId: child.id, uomId: uom.id,
    price: 4500, isStocked: true,
  });
  check("creates without leaving the voucher", a.ok, a.ok ? a.item.code : a.error);
  check("code composes from the category", a.ok && a.item.code === `${child.code}001`,
    a.ok ? a.item.code : "");

  const b = await createItemInline({
    name: "ABC Eye Drop 10ml", groupId: child.id, uomId: uom.id, isStocked: true,
  });
  check("serial auto-increments", b.ok && b.item.code === `${child.code}002`,
    b.ok ? b.item.code : "");

  // A hand-typed serial should be honoured and not disturb the sequence.
  const c = await createItemInline({
    name: "Special Order Lens", groupId: child.id, serial: "900",
    uomId: uom.id, isStocked: true,
  });
  check("explicit serial is honoured", c.ok && c.item.code === `${child.code}900`,
    c.ok ? c.item.code : "");

  const d = await createItemInline({
    name: "Duplicate attempt", groupId: child.id, serial: "001",
    uomId: uom.id, isStocked: true,
  });
  check("refuses a duplicate code", !d.ok, d.ok ? "created anyway" : d.error);

  const e = await createItemInline({
    name: "Unclassified thing", groupId: "", uomId: uom.id, isStocked: true,
  });
  check("refuses an item with no category", !e.ok);

  // The returned item must be usable immediately, which is the whole point.
  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier limit 1`;
  if (!supp) {
    [supp] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'TMP-S', 'Temp Supplier', true) returning id`;
  }
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;

  if (supp && loc && a.ok) {
    const pi = await postPurchaseWithReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: new Date().toISOString().slice(0, 10), dueDate: null,
      lines: [{ itemId: a.item.id, qty: 50, unitPrice: 4500 }],
    });
    check("the new item can be purchased straight away", Boolean(pi.docNo), pi.docNo);

    const [oh] = await sql`
      select fn_qty_on_hand(${co.id}, ${a.item.id}, ${loc.id}) as q`;
    check("stock arrived for it", Number(oh.q) === 50, `${oh.q}`);

    const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
    check("ledger still balances", Math.abs(Number(tb.v)) < 0.0001);
  } else {
    console.log("  (skipped purchase test — no supplier or stock location)");
  }

  // The purchase above references the item, and journal entries and stock
  // movements refuse row deletion by design, so tear down through TRUNCATE.
  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`delete from item where code like '77%'`;
  await sql`delete from item_group where code like '77%'`;
  await sql`delete from business_partner where code = 'TMP-S'`;
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0 ? "\n  inline item creation works\n" : `\n  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
