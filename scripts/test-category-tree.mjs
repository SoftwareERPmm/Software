// Restructuring a category tree: inserting a level above an existing branch,
// re-parenting, and refusing moves that would detach the tree.

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

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, {
  ssl: local ? false : "require",
  prepare: !url.includes("-pooler."),
  onnotice: () => {}, max: 1,
});

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };

// Mirrors lib/actions.ts insertCategoryAbove.
async function insertAbove(co, targetId, code, name) {
  return sql.begin(async (tx) => {
    const [target] = await tx`select id, parent_id from item_group where id = ${targetId}`;
    const [created] = await tx`
      insert into item_group (company_id, parent_id, segment, code, name)
      values (${co}, ${target.parent_id}, ${code}, ${code}, ${name}) returning id`;
    await tx`update item_group set parent_id = ${created.id} where id = ${target.id}`;
    return created.id;
  });
}

// Mirrors lib/actions.ts moveCategory, including the cycle guard.
async function move(co, id, newParent) {
  if (newParent) {
    const cycle = await sql`
      with recursive descendants as (
        select id from item_group where id = ${id} and company_id = ${co}
        union all
        select g.id from item_group g join descendants d on g.parent_id = d.id
      )
      select 1 from descendants where id = ${newParent}`;
    if (cycle.length) throw new Error("would put the category inside its own branch");
  }
  await sql`update item_group set parent_id = ${newParent} where id = ${id}`;
}

const pathOf = async (id) => {
  const rows = await sql`
    with recursive up as (
      select id, parent_id, name from item_group where id = ${id}
      union all
      select g.id, g.parent_id, g.name from item_group g join up u on g.id = u.parent_id
    )
    select name from up`;
  return rows.map((r) => r.name).reverse().join(" > ");
};

try {
  const [co] = await sql`select id from company limit 1`;
  await sql`delete from item_group where segment like 'TT-%'`;

  const [bev] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'TT-BEV', 'x', 'Beverages') returning id`;
  const [soft] = await sql`
    insert into item_group (company_id, parent_id, segment, code, name)
    values (${co.id}, ${bev.id}, 'TT-SOFT', 'x', 'Soft drinks') returning id`;
  const [cola] = await sql`
    insert into item_group (company_id, parent_id, segment, code, name)
    values (${co.id}, ${soft.id}, 'TT-COLA', 'x', 'Cola') returning id`;

  console.log(`\n  built: ${await pathOf(cola.id)}\n`);
  check("starts three deep", (await pathOf(cola.id)) === "Beverages > Soft drinks > Cola");

  // The whole point: add a level ABOVE what already exists.
  const foodId = await insertAbove(co.id, bev.id, "TT-FOOD", "Food & Drink");

  check("new category is top level",
    (await sql`select parent_id from item_group where id = ${foodId}`)[0].parent_id === null);
  check("old top level now sits under it",
    (await sql`select parent_id from item_group where id = ${bev.id}`)[0].parent_id === foodId);
  check("branch below came along, now four deep",
    (await pathOf(cola.id)) === "Food & Drink > Beverages > Soft drinks > Cola",
    await pathOf(cola.id));

  // Inserting mid-tree, not just at the root.
  const midId = await insertAbove(co.id, cola.id, "TT-CARB", "Carbonated");
  check("insert above works mid-tree",
    (await pathOf(cola.id)) === "Food & Drink > Beverages > Soft drinks > Carbonated > Cola",
    await pathOf(cola.id));
  check("the inserted level took the target's old parent",
    (await sql`select parent_id from item_group where id = ${midId}`)[0].parent_id === soft.id);

  // Re-parenting.
  await move(co.id, soft.id, foodId);
  check("re-parent moves the whole branch",
    (await pathOf(cola.id)) === "Food & Drink > Soft drinks > Carbonated > Cola",
    await pathOf(cola.id));

  await move(co.id, soft.id, null);
  check("can be promoted back to top level",
    (await pathOf(cola.id)) === "Soft drinks > Carbonated > Cola");

  // The dangerous one.
  let refused = false;
  try {
    await move(co.id, soft.id, cola.id);
  } catch {
    refused = true;
  }
  check("refuses a move into its own descendant", refused);
  check("tree survived the refused move",
    (await pathOf(cola.id)) === "Soft drinks > Carbonated > Cola");

  const orphans = await sql`
    select count(*)::int as n from item_group g
     where g.parent_id is not null
       and not exists (select 1 from item_group p where p.id = g.parent_id)`;
  check("no orphaned categories", orphans[0].n === 0);

  await sql`delete from item_group where segment like 'TT-%'`;
  const left = await sql`select count(*)::int as n from item_group where segment like 'TT-%'`;
  check("test rows cleaned up", left[0].n === 0);

  console.log(bad === 0 ? "\n  tree restructuring is sound\n" : `\n  ${bad} failed\n`);
} catch (e) {
  console.error(`\n  error: ${e.message}\n`);
  bad++;
} finally {
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
