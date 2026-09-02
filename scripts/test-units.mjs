// Units of measure: retiring one, and what that must not disturb.
//
//   npx tsx scripts/test-units.mjs
//
// A unit is what every quantity of an item is counted in, so the question
// this suite answers is not "can I add one" — it is what happens to the
// items already counting in a unit when it is retired. The answer has to be
// "nothing", or deactivating a unit would silently restate stock.
//
// Writes a unit and an item. Run against a scratch database.

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

/** What a picker offers — the query every unit dropdown in the app runs. */
const picker = (companyId) =>
  sql`select id, code, name from uom where company_id = ${companyId} and is_active order by code`;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const stamp = Date.now().toString().slice(-6);

  // ---- the column exists and defaults the safe way ------------------------
  const col = await sql`
    select data_type, is_nullable, column_default
      from information_schema.columns
     where table_name = 'uom' and column_name = 'is_active'`;
  check("uom carries is_active", col.length === 1, col[0]?.data_type);
  check("it defaults to true, so migrating retires nothing",
    col.length === 1 && col[0].is_nullable === "NO" && /true/.test(col[0].column_default ?? ""),
    col[0]?.column_default);

  const stillActive = await sql`
    select count(*)::int as c from uom where company_id = ${co.id} and not is_active`;
  check("no existing unit was retired by the migration", stillActive[0].c === 0,
    `${stillActive[0].c} inactive`);

  // ---- a new unit ---------------------------------------------------------
  const CODE = `ZZ${stamp.slice(-4)}`;
  const [unit] = await sql`
    insert into uom (company_id, code, name, name_my)
    values (${co.id}, ${CODE}, ${"Test Bottle " + stamp}, 'ပုလင်း')
    returning id, code, name, is_active`;
  check("a new unit starts active", unit.is_active === true);

  const dup = await sql`
    select count(*)::int as c from uom where company_id = ${co.id} and code = ${CODE}`;
  check("the code is unique per company", dup[0].c === 1);

  // ---- an item counting in it ---------------------------------------------
  const [grp] = await sql`
    select id, name from item_group where company_id = ${co.id} and is_active order by code limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, ${"9" + stamp.slice(-2)}, ${"Unit Test Item " + stamp},
            ${unit.id}, true)
    returning id, name, base_uom_id`;
  check("an item can be created counting in it", item.base_uom_id === unit.id);

  // ---- retiring it --------------------------------------------------------
  await sql`update uom set is_active = false where id = ${unit.id}`;

  const offered = await picker(co.id);
  check("a retired unit is off the picker",
    !offered.some((u) => u.id === unit.id), `${offered.length} offered`);

  const [after] = await sql`
    select i.base_uom_id, u.name from item i join uom u on u.id = i.base_uom_id
     where i.id = ${item.id}`;
  check("the item still counts in it — retiring is not restating",
    after.base_uom_id === unit.id, after.name);

  // The importer reads the same active-only master data, so a sheet naming a
  // retired unit is refused rather than quietly resurrecting it.
  {
    const master = async () => {
      const [items, categories, brands, uoms] = await Promise.all([
        sql`select id, code, serial, name, barcode, item_group_id, brand_id, base_uom_id
              from item where company_id = ${co.id} and is_active`,
        sql`select id, code, name from item_group where company_id = ${co.id} and is_active`,
        sql`select id, code, name from brand where company_id = ${co.id} and is_active`,
        sql`select id, code, name from uom where company_id = ${co.id} and is_active`,
      ]);
      return { items, categories, brands, uoms };
    };
    const sheet = `No,Barcode,Stock ID,Stock Name,Category,Brand,Unit\n` +
                  `1,B${stamp}U,,Retired Unit Item,${grp.name},,${unit.name}`;
    const plan = planImport(parseCsv(sheet), await master());
    check("an import naming a retired unit is refused",
      plan.errors.some((e) => /is not a unit of measure/.test(e.message)),
      plan.errors.map((e) => e.message).join(" | ").slice(0, 60));
  }

  // ---- deleting -----------------------------------------------------------
  let refused = false;
  try {
    await sql`delete from uom where id = ${unit.id}`;
  } catch (e) {
    refused = /foreign key|violates/i.test(String(e.message ?? e));
  }
  check("a unit an item counts in cannot be deleted", refused);

  // Once nothing points at it, it can go.
  await sql`delete from item where id = ${item.id}`;
  await sql`delete from uom where id = ${unit.id}`;
  const gone = await sql`select count(*)::int as c from uom where id = ${unit.id}`;
  check("a unit nothing uses can be deleted", gone[0].c === 0);

  // ---- reactivating -------------------------------------------------------
  const [first] = await sql`
    select id, is_active from uom where company_id = ${co.id} order by code limit 1`;
  await sql`update uom set is_active = false where id = ${first.id}`;
  const without = await picker(co.id);
  await sql`update uom set is_active = true where id = ${first.id}`;
  const with_ = await picker(co.id);
  check("reactivating puts it back on the picker",
    with_.length === without.length + 1 && with_.some((u) => u.id === first.id),
    `${without.length} → ${with_.length}`);

  console.log(`\n  ${failures === 0 ? "all unit tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
