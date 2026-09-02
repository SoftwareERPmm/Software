// Importing items and opening stock from a spreadsheet.
//
//   npx tsx scripts/test-item-import.mjs
//
// The importer's job is to refuse. Almost every check here is about a file
// that should not be allowed through, because the failure mode of an importer
// is not "it crashed" — it is master data quietly duplicated, or an opening
// balance quietly doubled, discovered at a stock count months later.
//
// Writes documents and items. Run against a scratch database.

import { readFileSync, existsSync } from "node:fs";
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

const { parseCsv, planImport } = await import("../lib/import-items.ts");
const { importItemsAndOpeningStock } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, {
  ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1,
});

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

const HEADER = "No,Barcode,Stock Name,Category,Brand,Location,Qty,Unit,Unit Cost";

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const stamp = Date.now().toString().slice(-6);

  // ---- master data the sheet will refer to --------------------------------
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"IM" + stamp.slice(-2)}, 'x', ${"Import Test " + stamp}) returning id, name`;
  const [brand] = await sql`
    insert into brand (company_id, code, name) values (${co.id}, ${"BR" + stamp}, ${"Import Brand " + stamp})
    returning id, name`;
  const [uom] = await sql`select id, code, name from uom where company_id = ${co.id} order by code limit 1`;
  const [wh] = await sql`
    select id, code, name from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [branch] = await sql`
    select id, name from location where company_id = ${co.id} and parent_id is null order by code limit 1`;
  const [inactive] = await sql`
    insert into location (company_id, code, name, is_stock_location, is_active)
    values (${co.id}, ${"OLD" + stamp}, ${"Old Warehouse " + stamp}, true, false) returning id, name`;

  const master = async () => {
    const [items, categories, brands, uoms, locations, existingStock] = await Promise.all([
      sql`select id, code, name, barcode, item_group_id, brand_id, base_uom_id
            from item where company_id = ${co.id} and is_active`,
      sql`select id, code, name from item_group where company_id = ${co.id} and is_active`,
      sql`select id, code, name from brand where company_id = ${co.id} and is_active`,
      sql`select id, code, name from uom where company_id = ${co.id}`,
      sql`select id, code, name, parent_id, is_stock_location, is_active from location where company_id = ${co.id}`,
      sql`select item_id, location_id from v_stock_on_hand where company_id = ${co.id} and qty_on_hand <> 0`,
    ]);
    return { items, categories, brands, uoms, locations, existingStock };
  };

  const plan = async (body) => planImport(parseCsv(`${HEADER}\n${body}`), await master());
  const errorsOf = (p) => p.errors.map((e) => e.message).join(" | ");
  const row = (bc, name, loc, qty, unit, cost, cat, br) =>
    `1,${bc},${name},${cat ?? grp.name},${br ?? brand.name},${loc ?? wh.name},${qty},${unit ?? uom.name},${cost}`;

  // ---- structure ----------------------------------------------------------
  check("a file with no Unit Cost column is refused",
    planImport(parseCsv("No,Barcode,Stock Name,Category,Brand,Location,Qty,Unit\n1,1,x,y,z,w,1,u"), await master())
      .errors.some((e) => /Unit Cost/.test(e.message)));

  check("an empty file is refused",
    planImport(parseCsv(""), await master()).errors.length > 0);

  // ---- the Excel barcode trap ---------------------------------------------
  const sci = await plan(row("8.85123E+12", "Coke", null, 10, null, 600));
  check("a barcode Excel turned into scientific notation is refused",
    sci.errors.some((e) => /lost digits|Text/.test(e.message)),
    errorsOf(sci).slice(0, 60));

  // ---- master data must exist ---------------------------------------------
  const badCat = await plan(row(`B${stamp}1`, "Coke", null, 10, null, 600, "Beverages Typo"));
  check("an unknown category is refused, not created",
    badCat.errors.some((e) => /Category .* is not in the item categories/.test(e.message)));

  const badWh = await plan(row(`B${stamp}1`, "Coke", "Nowhere Warehouse", 10, null, 600));
  check("an unknown warehouse is refused",
    badWh.errors.some((e) => /Warehouse .* does not exist/.test(e.message)));

  const inact = await plan(row(`B${stamp}1`, "Coke", inactive.name, 10, null, 600));
  check("an inactive warehouse is refused",
    inact.errors.some((e) => /inactive/.test(e.message)));

  const asBranch = await plan(row(`B${stamp}1`, "Coke", branch.name, 10, null, 600));
  check("a branch cannot be used as a warehouse",
    asBranch.errors.some((e) => /branch, not a warehouse/.test(e.message)));

  const badUnit = await plan(row(`B${stamp}1`, "Coke", null, 10, "Btl", 600));
  check("an abbreviated unit is refused rather than guessed",
    badUnit.errors.some((e) => /Unit .* is not a unit of measure/.test(e.message)));

  const badBrand = await plan(row(`B${stamp}1`, "Coke", null, 10, null, 600, null, "No Such Brand"));
  check("an unknown brand is refused",
    badBrand.errors.some((e) => /Brand .* is not in the brand list/.test(e.message)));

  const noBrand = await plan(`1,B${stamp}9,Coke,${grp.name},,${wh.name},10,${uom.name},600`);
  check("a blank brand is allowed, with a warning",
    noBrand.errors.length === 0 && noBrand.warnings.some((w) => /Brand is blank/.test(w.message)));

  // ---- quantity and cost --------------------------------------------------
  check("a non-numeric quantity is refused",
    (await plan(row(`B${stamp}1`, "Coke", null, "100 pcs", null, 600))).errors.some((e) => /not a number/.test(e.message)));
  check("a negative quantity is refused",
    (await plan(row(`B${stamp}1`, "Coke", null, -20, null, 600))).errors.some((e) => /cannot be negative/.test(e.message)));
  check("a missing cost is refused — stock valued at nothing is worse than no stock",
    (await plan(`1,B${stamp}1,Coke,${grp.name},${brand.name},${wh.name},10,${uom.name},`))
      .errors.some((e) => /Unit Cost is required/.test(e.message)));
  check("a zero cost is refused",
    (await plan(row(`B${stamp}1`, "Coke", null, 10, null, 0))).errors.some((e) => /greater than zero/.test(e.message)));

  // ---- the file disagreeing with itself -----------------------------------
  const dupPair = await plan(
    `${row(`B${stamp}1`, "Coke", null, 100, null, 600)}\n${row(`B${stamp}1`, "Coke", null, 50, null, 600)}`);
  check("the same item twice in the same warehouse is refused, not silently summed",
    dupPair.errors.some((e) => /already stocked into/.test(e.message)));

  const clash = await plan(
    `${row(`B${stamp}1`, "Coke 300ml", null, 10, null, 600)}\n${row(`B${stamp}1`, "Coke 500ml", null, 10, null, 600)}`);
  check("one barcode used for two different names is refused",
    clash.errors.some((e) => /is used for/.test(e.message)));

  // ---- the good file ------------------------------------------------------
  const [wh2] = await sql`
    select id, name from location
     where company_id = ${co.id} and is_stock_location and is_active and id <> ${wh.id} order by code limit 1`;

  const good = [
    row(`B${stamp}1`, "Coca-Cola 300ml", wh.name, 100, null, 600),
    row(`B${stamp}2`, "Sprite 300ml", wh.name, 80, null, 550),
    row(`B${stamp}1`, "Coca-Cola 300ml", wh2 ? wh2.name : wh.name, 50, null, 600),
  ];
  // The third row repeats barcode 1 at a different warehouse, which is the
  // ordinary case the spec calls out: one item, stock in two places.
  const ok = await plan(wh2 ? good.join("\n") : good.slice(0, 2).join("\n"));
  check("a correct file passes with no errors", ok.errors.length === 0, errorsOf(ok).slice(0, 80));
  check("one item counted once despite appearing in two warehouses",
    ok.summary.newItems === 2, `${ok.summary.newItems} new items`);

  // ---- what the preview will say ------------------------------------------
  // The heart of it: three rows, two products, 230 units. A file where the
  // same barcode appears in two warehouses must read as one item with two
  // balances, never as two items.
  if (wh2) {
    check("three rows read as two items", ok.items.length === 2, `${ok.items.length} items`);
    check("three stock records found", ok.summary.stockRows === 3, `${ok.summary.stockRows}`);
    check("total units add up across warehouses", ok.summary.totalUnits === 230, `${ok.summary.totalUnits}`);

    const coke = ok.items.find((i) => i.barcode === `B${stamp}1`);
    check("the repeated item is counted once, in two warehouses",
      coke && coke.locations === 2 && coke.totalQty === 150,
      coke ? `${coke.locations} warehouses, ${coke.totalQty} units` : "not found");
    check("both items are marked new", ok.items.every((i) => i.isNew === true));
    check("each planned row names its warehouse for the preview",
      ok.rows.every((r) => Boolean(r.locationName)) &&
      ok.rows.some((r) => r.locationName === wh.name) &&
      ok.rows.some((r) => r.locationName === wh2.name));
  }

  // ---- errors that explain themselves -------------------------------------
  const branchMsg = errorsOf(asBranch);
  check("naming a branch explains what a branch is and names its warehouses",
    /organisational unit/.test(branchMsg) && /Use "/.test(branchMsg),
    branchMsg.slice(0, 90));

  const nearMiss = await plan(row(`B${stamp}7`, "Coke", null, 10, null, 600, grp.name + "s"));
  check("a near-miss category suggests the right one",
    nearMiss.errors.some((e) => /Did you mean/.test(e.message)),
    errorsOf(nearMiss).slice(0, 80));

  const partialWh = await plan(row(`B${stamp}7`, "Coke", wh.name.split(" ")[0] + " WH", 10, null, 600));
  check("a shortened warehouse name suggests the full one",
    partialWh.errors.some((e) => /Did you mean/.test(e.message)),
    errorsOf(partialWh).slice(0, 80));

  check("an unknown unit explains why abbreviations are not guessed",
    /changes what the quantity means/.test(errorsOf(badUnit)));

  const done = await importItemsAndOpeningStock({
    companyId: co.id, docDate: new Date().toISOString().slice(0, 10),
    filename: "test.csv", rowCount: ok.summary.rows, rows: ok.rows,
  });
  console.log(`\n  imported ${done.ref}: ${done.documents.join(", ")}\n`);

  check("two items created, not three", done.itemsCreated === 2, String(done.itemsCreated));

  const [c1] = await sql`select id, code, name, barcode from item where company_id=${co.id} and barcode=${`B${stamp}1`}`;
  check("the barcode is stored on the item", Boolean(c1) && c1.barcode === `B${stamp}1`);
  check("the item code is still composed from the category, not the barcode",
    Boolean(c1) && c1.code.startsWith("IM"), c1?.code);

  const onHand = await sql`select fn_qty_on_hand(${co.id}, ${c1.id}, ${wh.id}) as q`;
  check("opening stock landed in the warehouse", n(onHand[0].q) === 100, String(n(onHand[0].q)));

  const lot = await sql`
    select unit_cost, qty_received from stock_lot
     where company_id = ${co.id} and item_id = ${c1.id} and location_id = ${wh.id}`;
  check("a FIFO layer exists at the imported cost",
    lot.length === 1 && n(lot[0].unit_cost) === 600 && n(lot[0].qty_received) === 100,
    lot.length ? `${n(lot[0].qty_received)} @ ${n(lot[0].unit_cost)}` : "no lot");

  const branchLines = await sql`
    select count(*)::int as c from journal_line jl
      join document d on d.import_batch_id = ${done.batchId}
      join journal_entry je on je.id = d.journal_entry_id and je.id = jl.journal_entry_id
     where jl.location_id is null`;
  check("every posted line carries the branch, taken from the warehouse",
    branchLines[0].c === 0, `${branchLines[0].c} unattributed`);

  // ---- importing the same file again --------------------------------------
  const again = await plan(wh2 ? good.join("\n") : good.slice(0, 2).join("\n"));
  check("re-importing the same file is refused — the balance is not doubled",
    again.errors.some((e) => /already holds stock/.test(e.message)),
    errorsOf(again).slice(0, 70));

  // ---- audit --------------------------------------------------------------
  const [b] = await sql`select ref, filename, row_count from import_batch where id = ${done.batchId}`;
  check("the import is recorded with its file and row count",
    b.ref === done.ref && b.filename === "test.csv" && n(b.row_count) === ok.summary.rows);
  const madeItems = await sql`select count(*)::int as c from item where import_batch_id = ${done.batchId}`;
  check("what it created can be listed afterwards", madeItems[0].c === 2, String(madeItems[0].c));

  // ---- invariants ---------------------------------------------------------
  const [tb] = await sql`select coalesce(sum(base_amount), 0) as t from journal_line where company_id = ${co.id}`;
  check("trial balance still nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  const recon = await sql`
    select count(*)::int as c from (
      select sm.item_id, sm.location_id, sum(sm.qty) as moved,
             fn_qty_on_hand(${co.id}, sm.item_id, sm.location_id) as on_hand
        from stock_movement sm where sm.company_id = ${co.id}
       group by sm.item_id, sm.location_id
    ) x where abs(moved - on_hand) > 0.0001`;
  check("inventory reconciles to the stock ledger", recon[0].c === 0);

  console.log(`\n  ${failures === 0 ? "all item import tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
