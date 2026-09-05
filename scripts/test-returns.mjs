// Returns: what comes back, how much of it, and at what cost.
//
//   node scripts/test-returns.mjs
//
// Posts real documents. Run against a scratch database.
//
// A return is the one document that puts stock back without a purchase
// price of its own, so it has to get its cost from somewhere. It reads the
// FIFO layers the original delivery consumed - which makes three separate
// things matter, all of which were once unchecked:
//
//   which document it names, since that is whose cost it borrows
//   how much it returns, since the cost comes back with the quantity
//   which layers within that document, since a delivery can span several

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

const { postGoodsReceipt, postSaleWithDelivery, postSalesReturn, postPurchaseReturn } =
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
const n = (v) => Number(v ?? 0);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) [supp] = await sql`insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, 'RT-S', 'Return Test Supplier', true) returning id`;
  let [cust] = await sql`
    select id from business_partner where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!cust) [cust] = await sql`insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, 'RT-C', 'Return Test Customer', true) returning id`;
  let [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) [grp] = await sql`insert into item_group (company_id, segment, code, name)
      values (${co.id}, 'RT', 'x', 'Return Test') returning id`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'Return Test Item', ${uom.id}) returning id`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const buy = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };
  const sell = { companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today };

  // Whichever account this chart posts this item's stock to — the demo seed's
  // "1300" is not a fact about inventory, it is a fact about that seed.
  const { accountsFor } = await import("./accounts.mjs");
  const INVENTORY = await accountsFor(sql, co.id).forItem("INVENTORY", item.id);

  const inventoryOf = async (docId) => n((await sql`
    select coalesce(sum(jl.amount), 0) as v from journal_line jl
      join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
     where je.source_id = ${docId} and a.code = ${INVENTORY}`)[0].v);

  console.log(`\n  ${co.name}\n`);

  // ---- Cost comes back layer by layer ------------------------------------

  const gr = await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 5, unitCost: 100 }] });
  await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 5, unitCost: 900 }] });
  const sale = await postSaleWithDelivery({ ...sell, dueDate: null,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }] });

  console.log("  a delivery spanning two cost layers: 5 @ 100 then 5 @ 900\n");

  const r1 = await postSalesReturn({ ...sell, sourceDocumentId: sale.id,
    lines: [{ itemId: item.id, qty: 3, unitPrice: 2000 }] });
  check("the first units back come at the layer they left on", (await inventoryOf(r1.id)) === 300,
    `${await inventoryOf(r1.id)} for 3 at 100`);

  const r2 = await postSalesReturn({ ...sell, sourceDocumentId: sale.id,
    lines: [{ itemId: item.id, qty: 3, unitPrice: 2000 }] });
  check("a return straddling the boundary takes part of each", (await inventoryOf(r2.id)) === 1100,
    `${await inventoryOf(r2.id)} for 2 at 100 plus 1 at 900`);

  const r3 = await postSalesReturn({ ...sell, sourceDocumentId: sale.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 2000 }] });
  check("and the rest at the dearer layer", (await inventoryOf(r3.id)) === 3600,
    `${await inventoryOf(r3.id)} for 4 at 900`);

  const restored = (await inventoryOf(r1.id)) + (await inventoryOf(r2.id)) + (await inventoryOf(r3.id));
  check("returning the whole delivery restores exactly what it cost", restored === 5000, `${restored}`);

  const lots = await sql`
    select l.unit_cost, l.qty_received from stock_lot l
      join stock_movement sm on sm.id = l.stock_movement_id
      join document d on d.id = sm.document_id
     where d.doc_type = 'SALES_RETURN' order by l.created_at`;
  check("returned stock keeps its layers instead of being blended",
    lots.length === 4 && lots.every((l) => [100, 900].includes(n(l.unit_cost))),
    lots.map((l) => `${n(l.qty_received)}@${n(l.unit_cost)}`).join(" "));

  // ---- Bounded by what was sold ------------------------------------------

  console.log("");
  check("nothing more can be returned once it is all back",
    (await refused(() => postSalesReturn({ ...sell, sourceDocumentId: sale.id,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 2000 }] }))) !== null);

  const sale2 = await postSaleWithDelivery({ ...sell, dueDate: null,
    lines: [{ itemId: item.id, qty: 2, unitPrice: 2000 }] });
  check("nor split across two lines to get past the limit",
    (await refused(() => postSalesReturn({ ...sell, sourceDocumentId: sale2.id,
      lines: [{ itemId: item.id, qty: 2, unitPrice: 2000 },
              { itemId: item.id, qty: 1, unitPrice: 2000 }] }))) !== null);

  check("a purchase return cannot exceed the receipt it names",
    (await refused(() => postPurchaseReturn({ ...buy, sourceDocumentId: gr.id,
      lines: [{ itemId: item.id, qty: 99, unitPrice: 100 }] }))) !== null);

  // ---- Still possible without a source -----------------------------------

  const loose = await postSalesReturn({ ...sell,
    lines: [{ itemId: item.id, qty: 1, unitPrice: 2000 }] });
  check("a return with no document behind it still posts", !!loose.docNo, loose.docNo);

  // ---- Invariants --------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all return tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
