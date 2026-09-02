// Importing the item master from a spreadsheet.
//
//   npx tsx scripts/test-item-import.mjs
//
// The importer's job is to refuse. Almost every check here is about a file
// that should not be allowed through, because the failure mode of an importer
// is not "it crashed" — it is master data quietly duplicated, discovered when
// two spellings of one category have half the sales each.
//
// The sheet sets up items only. Quantity, cost and warehouse are not on it,
// and the last section here proves the import writes no ledger entry and
// moves no stock: an item exists before it has any.
//
// Writes items. Run against a scratch database.

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
const { xlsxToRows, buildImportTemplate } = await import("../lib/read-spreadsheet.ts");
const { createMissingMasterData } = await import("../lib/actions.ts");
const ExcelJS = (await import("exceljs")).default;
const { importItems } = await import("../lib/posting.ts");

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

const HEADER = "No,Barcode,Stock ID,Stock Name,Category,Sub Category,Brand,Unit";

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const stamp = Date.now().toString().slice(-6);

  // ---- master data the sheet will refer to --------------------------------
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"IM" + stamp.slice(-2)}, 'x', ${"Import Test " + stamp})
    returning id, name, code`;
  const TEST_BRAND = "ZZ-TEST-BRAND";
  let [brand] = await sql`
    select id, name from brand where company_id = ${co.id} and code = ${TEST_BRAND}`;
  if (!brand) {
    [brand] = await sql`
      insert into brand (company_id, code, name)
      values (${co.id}, ${TEST_BRAND}, 'Test Brand') returning id, name`;
  }
  const [uom] = await sql`select id, code, name from uom where company_id = ${co.id} order by code limit 1`;

  const master = async () => {
    const [items, categories, brands, uoms] = await Promise.all([
      sql`select id, code, serial, name, barcode, item_group_id, brand_id, base_uom_id
            from item where company_id = ${co.id} and is_active`,
      sql`select id, code, name, parent_id from item_group where company_id = ${co.id} and is_active`,
      sql`select id, code, name from brand where company_id = ${co.id} and is_active`,
      sql`select id, code, name from uom where company_id = ${co.id}`,
    ]);
    return { items, categories, brands, uoms };
  };

  const plan = async (body) => planImport(parseCsv(`${HEADER}\n${body}`), await master());
  const errorsOf = (p) => p.errors.map((e) => e.message).join(" | ");
  const warningsOf = (p) => p.warnings.map((w) => w.message).join(" | ");
  const row = (bc, name, unit, cat, br, id, sub) =>
    `1,${bc},${id ?? ""},${name},${cat ?? grp.name},${sub ?? ""},${br ?? brand.name},${unit ?? uom.name}`;

  // ---- structure ----------------------------------------------------------
  check("a file with no Unit column is refused",
    planImport(parseCsv("No,Barcode,Stock ID,Stock Name,Category,Brand\n1,1,i,x,y,z"), await master())
      .errors.some((e) => /Unit/.test(e.message)));

  check("an empty file is refused",
    planImport(parseCsv(""), await master()).errors.length > 0);

  // ---- the stock columns are gone, and saying so beats ignoring them -------
  // Someone will upload last month's sheet. Those numbers meant something to
  // whoever typed them, and dropping them in silence would look like they
  // had landed somewhere.
  {
    const oldHeader = "No,Barcode,Stock ID,Stock Name,Category,Sub Category,Brand,Location,Qty,Unit,Unit Cost";
    const oldFile = planImport(parseCsv(
      `${oldHeader}\n1,B${stamp}O,,Old Sheet,${grp.name},,${brand.name},Main Warehouse,100,${uom.name},600`),
      await master());
    check("a sheet still carrying Qty, Unit Cost and Location still imports the items",
      oldFile.errors.length === 0 && oldFile.rows.length === 1, errorsOf(oldFile).slice(0, 70));
    check("and says those three columns were ignored",
      ["Qty", "Unit Cost", "Location"].every((c) =>
        oldFile.warnings.some((w) => w.column === c && /ignored/.test(w.message))),
      warningsOf(oldFile).slice(0, 70));
    check("the warning says where quantity and cost actually come from",
      /goods receipt|stock adjustment/.test(warningsOf(oldFile)));
  }

  // ---- the Excel barcode trap ---------------------------------------------
  const sci = await plan(row("8.85123E+12", "Coke"));
  check("a barcode Excel turned into scientific notation is refused",
    sci.errors.some((e) => /lost digits|Text/.test(e.message)),
    errorsOf(sci).slice(0, 60));

  // ---- master data must exist ---------------------------------------------
  const badCat = await plan(row(`B${stamp}1`, "Coke", null, "Beverages Typo"));
  check("an unknown category is refused, not created",
    badCat.errors.some((e) => /Category .* is not registered yet/.test(e.message)));

  const badUnit = await plan(row(`B${stamp}1`, "Coke", "Btl"));
  check("an abbreviated unit is refused rather than guessed",
    badUnit.errors.some((e) => /Unit .* is not a unit of measure/.test(e.message)));

  const badBrand = await plan(row(`B${stamp}1`, "Coke", null, null, "No Such Brand"));
  check("an unknown brand is refused",
    badBrand.errors.some((e) => /Brand .* is not registered yet/.test(e.message)));

  const noBrand = await plan(`1,B${stamp}9,,Coke,${grp.name},,,${uom.name}`);
  check("a blank brand is allowed, with a warning",
    noBrand.errors.length === 0 && noBrand.warnings.some((w) => /Brand is blank/.test(w.message)));

  // ---- missing values, column by column -----------------------------------
  // Two different kinds of missing: the column absent from the sheet
  // altogether, and the column present but the cell blank. Both have to be
  // caught, and neither may fall through into a row that gets imported.
  for (const column of ["Barcode", "Stock Name", "Category", "Unit"]) {
    const cols = HEADER.split(",");
    const keep = cols.filter((c) => c !== column);
    const idx = cols.indexOf(column);
    const full = `1,B${stamp}M,,Blank Test,${grp.name},,${brand.name},${uom.name}`.split(",");

    // (a) the column is not in the file at all
    const withoutCol = planImport(
      parseCsv(`${keep.join(",")}\n${full.filter((_, i) => i !== idx).join(",")}`), await master());
    check(`a file with no ${column} column is refused`,
      withoutCol.errors.some((e) => new RegExp(`Missing column.*${column}`).test(e.message)),
      withoutCol.errors[0]?.message?.slice(0, 50));

    // (b) the column is there but this row's cell is empty
    const blanked = full.map((v, i) => (i === idx ? "" : v));
    const withBlank = planImport(parseCsv(`${HEADER}\n${blanked.join(",")}`), await master());
    check(`a blank ${column} cell is refused`,
      withBlank.errors.length > 0 && withBlank.rows.length === 0,
      withBlank.errors[0]?.message?.slice(0, 55) ?? "no error raised");
  }

  // Brand is the one optional column, so dropping it entirely is legal.
  {
    const noBrandCol = planImport(
      parseCsv(`No,Barcode,Stock ID,Stock Name,Category,Unit\n1,B${stamp}NB,,No Brand Column,${grp.name},${uom.name}`),
      await master());
    check("a file with no Brand column at all is accepted",
      noBrandCol.errors.length === 0 && noBrandCol.rows.length === 1 &&
      noBrandCol.rows[0].brandId === null, errorsOf(noBrandCol).slice(0, 60));
  }

  // Whitespace is not a value. " " in a cell must read as empty, not as a
  // category named space.
  const spaces = await plan(`1,B${stamp}W,,Space Test,   ,,${brand.name},${uom.name}`);
  check("a cell holding only spaces counts as empty",
    spaces.errors.some((e) => /Category is empty/.test(e.message)));

  // A row that stops early — Excel does this when trailing cells were never
  // touched — must not read the next row's values into the gap.
  const short = planImport(parseCsv(`${HEADER}\n1,B${stamp}S,,Short Row,${grp.name}`), await master());
  check("a row with fewer cells than the header is refused, not misread",
    short.errors.length > 0 && short.rows.length === 0,
    short.errors[0]?.message?.slice(0, 50));

  // An entirely empty row between blocks of data is ignored rather than
  // reported as four separate failures.
  const withGap = planImport(parseCsv(
    `${HEADER}\n1,B${stamp}A,,Gap A,${grp.name},,${brand.name},${uom.name}\n,,,,,,\n` +
    `3,B${stamp}B,,Gap B,${grp.name},,${brand.name},${uom.name}`), await master());
  check("a completely blank row is skipped, not reported as errors",
    withGap.errors.length === 0 && withGap.rows.length === 2,
    `${withGap.errors.length} errors, ${withGap.rows.length} rows`);

  // ---- the file disagreeing with itself -----------------------------------
  // One row per item now, so a repeated barcode is a duplicate rather than a
  // second balance somewhere.
  const dupPair = await plan(
    `${row(`B${stamp}1`, "Coke")}\n2,B${stamp}1,,Coke,${grp.name},,${brand.name},${uom.name}`);
  check("the same barcode twice is refused as a duplicate row",
    dupPair.errors.some((e) => /already on row/.test(e.message)),
    errorsOf(dupPair).slice(0, 70));

  const clash = await plan(
    `${row(`B${stamp}1`, "Coke 300ml")}\n2,B${stamp}1,,Coke 500ml,${grp.name},,${brand.name},${uom.name}`);
  check("one barcode used for two different names is refused",
    clash.errors.some((e) => /already on row/.test(e.message)));

  // ---- the good file ------------------------------------------------------
  const good = [
    row(`B${stamp}1`, "Coca-Cola 300ml", null, null, null, `Item${stamp}A`),
    `2,B${stamp}2,Item${stamp}B,Sprite 300ml,${grp.name},,${brand.name},${uom.name}`,
    // Stock ID left blank on purpose: this one is given the next number.
    `3,B${stamp}3,,Fanta 300ml,${grp.name},,,${uom.name}`,
  ].join("\n");

  const ok = await plan(good);
  check("a correct file passes with no errors", ok.errors.length === 0, errorsOf(ok).slice(0, 80));
  check("three rows read as three new items",
    ok.rows.length === 3 && ok.summary.newItems === 3 && ok.summary.existingItems === 0,
    `${ok.rows.length} rows, ${ok.summary.newItems} new`);
  check("every row is marked new before anything is written",
    ok.rows.every((r) => r.isNew === true && r.itemId === null));
  check("each planned row carries its category and unit name for the preview",
    ok.rows.every((r) => r.categoryName === grp.name && r.unitName === uom.name));
  check("the unbranded row plans a null brand, not an invented one",
    ok.rows[2].brandId === null && ok.rows[2].brandName === null);

  // ---- the Stock ID and the code it composes ------------------------------
  // The database composes item.code as the category's code followed by the
  // item's own serial (migration 0012, fn_set_item_code). The sheet supplies
  // that serial, so what the preview shows has to be what the trigger will
  // produce — otherwise the user approves one identifier and gets another.
  check("a typed Stock ID becomes the item's own piece of the code",
    ok.rows[0].serial === `Item${stamp}A` && ok.rows[0].serialAssigned === false,
    `${ok.rows[0].serial} assigned=${ok.rows[0].serialAssigned}`);
  check("and the code is the category's code in front of it",
    ok.rows[0].code === `${grp.code}Item${stamp}A`, ok.rows[0].code);
  check("a blank Stock ID is given the next number in that category",
    ok.rows[2].serialAssigned === true && /^[0-9]{3}$/.test(ok.rows[2].serial),
    `${ok.rows[2].serial} assigned=${ok.rows[2].serialAssigned}`);
  check("an assigned number composes the same way",
    ok.rows[2].code === `${grp.code}${ok.rows[2].serial}`, ok.rows[2].code);

  {
    const twice = await plan(
      `1,B${stamp}D1,Same${stamp},First,${grp.name},,,${uom.name}\n` +
      `2,B${stamp}D2,Same${stamp},Second,${grp.name},,,${uom.name}`);
    check("two rows claiming one Stock ID in one category are refused",
      twice.errors.some((e) => /which row 2 already takes|already takes/.test(e.message)),
      twice.errors.map((e) => e.message).join(" | ").slice(0, 70));

    // The same Stock ID under a different category is a different code, so it
    // is perfectly legal — that is the whole point of composing them.
    const [grp2] = await sql`
      insert into item_group (company_id, segment, code, name)
      values (${co.id}, ${"IX" + stamp.slice(-2)}, 'x', ${"Import Test B " + stamp})
      returning id, name, code`;
    const across = await plan(
      `1,B${stamp}X1,Same${stamp},First,${grp.name},,,${uom.name}\n` +
      `2,B${stamp}X2,Same${stamp},Second,${grp2.name},,,${uom.name}`);
    check("the same Stock ID under two categories is fine — the codes differ",
      across.errors.length === 0 &&
      across.rows[0].code === `${grp.code}Same${stamp}` &&
      across.rows[1].code === `${grp2.code}Same${stamp}`,
      across.rows.map((r) => r.code).join(" vs "));

    const bad = await plan(row(`B${stamp}BAD`, "Bad Id", null, null, null, "AB 01"));
    check("a Stock ID with a space in it is refused — a code has to stay typeable",
      bad.errors.some((e) => /characters that are not allowed/.test(e.message)),
      bad.errors.map((e) => e.message).join(" | ").slice(0, 60));
  }

  // ---- errors that explain themselves -------------------------------------
  const nearMiss = await plan(row(`B${stamp}7`, "Coke", null, grp.name + "s"));
  check("a near-miss category suggests the right one",
    nearMiss.errors.some((e) => /Did you mean/.test(e.message)),
    errorsOf(nearMiss).slice(0, 80));

  check("an unknown unit explains why abbreviations are not guessed",
    /changes what every quantity of this item means/.test(errorsOf(badUnit)));

  // ---- the import itself --------------------------------------------------
  const done = await importItems({
    companyId: co.id, filename: "test.csv", rowCount: ok.summary.rows, rows: ok.rows,
  });
  console.log(`\n  imported ${done.ref}: ${done.itemsCreated} items\n`);

  check("three items created", done.itemsCreated === 3, String(done.itemsCreated));

  const [c1] = await sql`select id, code, serial, name, barcode, base_uom_id, brand_id, is_stocked
                           from item where company_id=${co.id} and barcode=${`B${stamp}1`}`;
  check("the barcode is stored on the item", Boolean(c1) && c1.barcode === `B${stamp}1`);
  check("the Stock ID from the sheet is the item's serial",
    Boolean(c1) && c1.serial === `Item${stamp}A`, c1?.serial);
  // The one that would bite: the preview promised a code, and the trigger
  // composes it independently. If those two ever disagree the user approves
  // one identifier and the catalogue gets another.
  check("the code the database composed is exactly the code the preview showed",
    Boolean(c1) && c1.code === ok.rows[0].code, `${c1?.code} vs ${ok.rows[0].code}`);
  check("the item code is still composed from the category, not the barcode",
    Boolean(c1) && c1.code.startsWith(grp.code), c1?.code);

  const [c3db] = await sql`select code, serial from item
                            where company_id=${co.id} and barcode=${`B${stamp}3`}`;
  check("the row with a blank Stock ID got the number the preview predicted",
    c3db.serial === ok.rows[2].serial && c3db.code === ok.rows[2].code,
    `${c3db?.code} vs ${ok.rows[2].code}`);
  check("the item carries the unit the sheet named", c1.base_uom_id === uom.id);
  check("the item is stocked, so it can be received and sold", c1.is_stocked === true);

  const [c3] = await sql`select brand_id from item where company_id=${co.id} and barcode=${`B${stamp}3`}`;
  check("the unbranded item has no brand rather than a made-up one", c3.brand_id === null);

  // ---- what the import must NOT do ----------------------------------------
  // The whole point of the change: setting up an item is not a stock event
  // and not an accounting event.
  {
    const docs = await sql`select count(*)::int as c from document where import_batch_id = ${done.batchId}`;
    check("the import creates no document", docs[0].c === 0, `${docs[0].c} documents`);

    const moves = await sql`
      select count(*)::int as c from stock_movement
       where company_id = ${co.id} and item_id in (
         select id from item where import_batch_id = ${done.batchId})`;
    check("no stock moves — a new item starts with none", moves[0].c === 0, `${moves[0].c} movements`);

    const lots = await sql`
      select count(*)::int as c from stock_lot
       where company_id = ${co.id} and item_id in (
         select id from item where import_batch_id = ${done.batchId})`;
    check("no FIFO layer is invented — cost arrives with a receipt", lots[0].c === 0, `${lots[0].c} lots`);

    const onHand = await sql`
      select coalesce(sum(qty_on_hand), 0) as q from v_stock_on_hand
       where company_id = ${co.id} and item_id = ${c1.id}`;
    check("the new item is on hand nowhere", n(onHand[0].q) === 0, String(n(onHand[0].q)));
  }

  // ---- importing the same file again --------------------------------------
  // Matched by barcode and left alone. Re-uploading a sheet after adding two
  // rows to it should add two items, not fail and not duplicate the rest.
  {
    const again = await plan(good);
    check("re-reading the same file finds the items already exist",
      again.errors.length === 0 && again.summary.newItems === 0 && again.summary.existingItems === 3,
      `${again.summary.newItems} new, ${again.summary.existingItems} existing`);
    check("and says so as a warning rather than an error",
      again.warnings.some((w) => /already exists/.test(w.message)));

    const rerun = await importItems({
      companyId: co.id, filename: "test-again.csv", rowCount: again.summary.rows, rows: again.rows,
    });
    check("re-importing creates nothing and duplicates nothing",
      rerun.itemsCreated === 0 && rerun.itemsMatched === 3,
      `${rerun.itemsCreated} created, ${rerun.itemsMatched} matched`);

    const dupes = await sql`
      select count(*)::int as c from item
       where company_id = ${co.id} and barcode = ${`B${stamp}1`}`;
    check("the barcode still belongs to exactly one item", dupes[0].c === 1, String(dupes[0].c));

    // A renamed row is refused rather than quietly rewriting the item.
    const renamed = await plan(`1,B${stamp}1,,Coca-Cola 500ml,${grp.name},,${brand.name},${uom.name}`);
    check("renaming an existing barcode is refused, not applied",
      renamed.errors.some((e) => /already belongs to/.test(e.message)),
      errorsOf(renamed).slice(0, 70));
  }

  // ---- audit --------------------------------------------------------------
  const [b] = await sql`select ref, filename, row_count from import_batch where id = ${done.batchId}`;
  check("the import is recorded with its file and row count",
    b.ref === done.ref && b.filename === "test.csv" && n(b.row_count) === ok.summary.rows);
  const madeItems = await sql`select count(*)::int as c from item where import_batch_id = ${done.batchId}`;
  check("what it created can be listed afterwards", madeItems[0].c === 3, String(madeItems[0].c));

  // ---- reading a real workbook --------------------------------------------
  // The reason .xlsx is accepted at all: a barcode Excel merely *displays* as
  // 8.85E+12 is stored exactly, so opening the workbook gets the real digits.
  // Going via CSV is what can write the display out and lose them.
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADER.split(","));
    const big = 8851234567890;
    const r1 = ws.addRow([1, big, "", "Workbook Coke", grp.name, "", brand.name, uom.name]);
    r1.getCell(2).numFmt = "0.00E+00";              // shown as 8.85E+12
    ws.addRow([2, "0123456789012", "", "Leading Zero", grp.name, "", "", uom.name]);

    const rows = await xlsxToRows(Buffer.from(await wb.xlsx.writeBuffer()).toString("base64"));

    check("a workbook reads back the barcode Excel only displayed as 8.85E+12",
      rows[1][1] === String(big), rows[1]?.[1]);
    check("a text barcode keeps its leading zero",
      rows[2][1] === "0123456789012", rows[2]?.[1]);

    const wbPlan = planImport(rows, await master());
    check("a workbook validates with no errors", wbPlan.errors.length === 0,
      wbPlan.errors.map((e) => e.message).join(" | ").slice(0, 80));
    check("and is read as two items", wbPlan.rows.length === 2, `${wbPlan.rows.length} rows`);

    // A blank cell mid-row must not shift later values into the wrong column.
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("S");
    ws2.addRow(HEADER.split(","));
    ws2.addRow([3, `B${stamp}G`, "", "Gap Item", grp.name, "", "", uom.name]);
    const gapRows = await xlsxToRows(Buffer.from(await wb2.xlsx.writeBuffer()).toString("base64"));
    check("a blank Brand cell does not shift the Unit after it",
      gapRows[1][7] === uom.name,
      `unit="${gapRows[1]?.[7]}"`);
  }

  // ---- brands the file names but the master does not have -----------------
  // Brand is optional, and a brand that is given must exist. The importer
  // never creates one on its way past — that is how a chart ends up holding
  // Coca-Cola, Coca Cola and COKE — but it does say which are missing so the
  // remedy is one deliberate action rather than a hunt through Master data.
  {
    const newBrands = [`Zed Cola ${stamp}`, `Zed Fizz ${stamp}`];
    const body = [
      `1,B${stamp}Z1,,Zed Cola Can,${grp.name},,${newBrands[0]},${uom.name}`,
      `2,B${stamp}Z2,,Zed Fizz Can,${grp.name},,${newBrands[1]},${uom.name}`,
      // the same unknown brand twice — reported once, not twice
      `3,B${stamp}Z3,,Zed Cola Bottle,${grp.name},,${newBrands[0]},${uom.name}`,
    ].join("\n");

    const before = await plan(body);
    check("an unregistered brand is refused, not invented",
      before.errors.some((e) => /is not registered yet/.test(e.message)));
    check("the missing brands are listed once each, by name",
      before.missing.length === 2 &&
      before.missing.every((m) => m.kind === "brand" && newBrands.includes(m.name)),
      before.missing.map((m) => m.name).join(", "));

    const made = await createMissingMasterData(before.missing);
    check("registering them creates one brand per name",
      made.ok === true && made.created === 2, JSON.stringify(made));

    const after = await plan(body);
    check("the same file then validates with no errors",
      after.errors.length === 0 && after.missing.length === 0,
      errorsOf(after).slice(0, 70));
    check("and the items now point at a brand rather than carrying text",
      after.rows.every((r) => Boolean(r.brandId)));

    // Asked twice, the second time is a no-op rather than a duplicate.
    const twice = await createMissingMasterData(before.missing);
    check("registering the same brands again creates nothing",
      twice.ok === true && twice.created === 0, JSON.stringify(twice));

    const codes = await sql`select code, name from brand
      where company_id = ${co.id} and name = any(${newBrands}) order by code`;
    check("each generated code is typeable and unique",
      codes.length === 2 && codes.every((c) => /^[A-Z0-9]+$/.test(c.code)),
      codes.map((c) => c.code).join(", "));

    // Blank stays blank: an item with no brand must not acquire one.
    const blank = await plan(`1,B${stamp}Z9,,No Brand Item,${grp.name},,,${uom.name}`);
    check("a blank brand is still allowed and creates nothing",
      blank.errors.length === 0 && blank.missing.length === 0 &&
      blank.rows[0].brandId === null);
  }

  // ---- categories, sub categories, and registering them -------------------
  // The importer still never invents master data on its way past. What it now
  // does is say exactly what is missing, so registering it is one deliberate
  // act rather than a trip to another screen and back.
  {
    const catName = `Zed Cat ${stamp}`;
    const subName = `Zed Sub ${stamp}`;

    const before = await plan(
      `1,B${stamp}C1,,Cat Item,${catName},${subName},,${uom.name}`);
    check("an unregistered category is refused, not invented",
      before.errors.some((e) => /Category .* is not registered yet/.test(e.message)));
    check("the category and its sub category are both offered for registration",
      before.missing.length === 2 &&
      before.missing[0].kind === "category" && before.missing[0].name === catName &&
      before.missing[1].kind === "subcategory" && before.missing[1].name === subName,
      before.missing.map((m) => `${m.kind}:${m.name}`).join(", "));
    check("the sub category names the category it will go under",
      before.missing[1].parent === catName, before.missing[1].parent);
    check("each missing name carries the rows that asked for it",
      before.missing.every((m) => m.rows.length === 1 && m.rows[0] === 2));

    // Category before sub category, so registering the list in order always
    // has a parent to attach to.
    const made = await createMissingMasterData(before.missing);
    check("registering creates the category and the sub category",
      made.ok === true && made.created === 2, JSON.stringify(made));

    const [madeCat] = await sql`
      select id, code, parent_id from item_group
       where company_id = ${co.id} and name = ${catName}`;
    const [madeSub] = await sql`
      select id, code, parent_id from item_group
       where company_id = ${co.id} and name = ${subName}`;
    check("the category is a root", Boolean(madeCat) && madeCat.parent_id === null);
    check("the sub category hangs off it", Boolean(madeSub) && madeSub.parent_id === madeCat.id);
    check("the sub category's code is composed from its parent's",
      madeSub.code.startsWith(madeCat.code), `${madeCat?.code} -> ${madeSub?.code}`);

    const after = await plan(
      `1,B${stamp}C1,,Cat Item,${catName},${subName},,${uom.name}`);
    check("the same sheet then validates with nothing missing",
      after.errors.length === 0 && after.missing.length === 0,
      errorsOf(after).slice(0, 70));
    check("the item is filed under the sub category, not the category",
      after.rows[0].categoryId === madeSub.id);
    check("and its code is composed from the sub category",
      after.rows[0].code.startsWith(madeSub.code), after.rows[0].code);
    check("the preview shows both levels",
      after.rows[0].categoryName === catName && after.rows[0].subCategoryName === subName,
      `${after.rows[0].categoryName} / ${after.rows[0].subCategoryName}`);

    // Registering twice is a no-op rather than a duplicate.
    const twice = await createMissingMasterData(before.missing);
    check("registering the same names again creates nothing",
      twice.ok === true && twice.created === 0, JSON.stringify(twice));

    // Sub category is optional: no column, no cell, either is fine.
    const noSub = await plan(`1,B${stamp}C2,,No Sub Item,${catName},,,${uom.name}`);
    check("a blank sub category files the item under the category itself",
      noSub.errors.length === 0 && noSub.rows[0].categoryId === madeCat.id &&
      noSub.rows[0].subCategoryName === null, errorsOf(noSub).slice(0, 60));

    // A sub category under the wrong parent is not silently accepted.
    const [otherCat] = await sql`
      select name from item_group where company_id = ${co.id}
        and parent_id is null and id <> ${madeCat.id} limit 1`;
    if (otherCat) {
      const wrongParent = await plan(
        `1,B${stamp}C3,,Wrong Parent,${otherCat.name},${subName},,${uom.name}`);
      check("a sub category is not accepted under a category it does not belong to",
        wrongParent.errors.some((e) => /not registered under/.test(e.message)),
        errorsOf(wrongParent).slice(0, 70));
    }
  }

  // ---- the duplicate a near-identical name would create --------------------
  // The real failure mode is not a name that is obviously new. It is "Coca
  // Cola" arriving where "Coca-Cola" already exists: registering it is legal,
  // silent, and leaves two brands splitting one product's sales.
  {
    const near = await plan(
      `1,B${stamp}N1,,Near Miss,${grp.name},,${brand.name.toUpperCase().replace(/ /g, "")},${uom.name}`);
    const entry = near.missing.find((m) => m.kind === "brand");
    check("a brand a keystroke from an existing one is flagged, not just offered",
      Boolean(entry) && entry.similarTo === brand.name,
      entry ? `${entry.name} ~ ${entry.similarTo}` : "not offered");
    check("and it is still refused rather than quietly matched to the existing one",
      near.errors.some((e) => /is not registered yet/.test(e.message)));
  }

  // ---- the template ------------------------------------------------------
  // The template is the real fix for the barcode problem: it arrives with the
  // column already formatted as Text, so the damage never happens. Worth
  // proving it survives a round trip rather than assuming the format sticks.
  {
    const tpl64 = await buildImportTemplate();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl64, "base64"));
    const ws = wb.worksheets[0];

    const head = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c) => head.push(String(c.value ?? "")));
    check("the template's columns match what the importer expects",
      head.slice(0, 8).join(",") === HEADER, head.slice(0, 8).join(","));
    check("the template carries no Qty, Unit Cost or Location column",
      !/Qty|Unit Cost|Location/.test(head.join(",")), head.join(","));

    check("its Barcode column is formatted as Text, so Excel will not mangle one",
      ws.getColumn(2).numFmt === "@", String(ws.getColumn(2).numFmt));

    // A 13-digit barcode typed into that column must come back whole.
    ws.addRow([9, "8851234567899", "T001", "Typed In", grp.name, "", brand.name, uom.name]);
    const rows = await xlsxToRows(Buffer.from(await wb.xlsx.writeBuffer()).toString("base64"));
    const typed = rows.find((r) => r[3] === "Typed In");
    check("a barcode typed into the template survives the round trip",
      Boolean(typed) && typed[1] === "8851234567899", typed?.[1]);
  }

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
