// Copies one company's entire dataset from one Neon branch into another.
//
//   DATABASE_URL="<target>" SOURCE_URL="<source>" \
//     node scripts/copy-company-data.mjs --confirm --host=<target host>
//
// Made for refreshing dev with the pilot tester's real data, which is far
// better material to develop against than anything invented: real charts of
// accounts, real sequences of documents, real awkward numbers.
//
// It REPLACES everything the target company owns. The target must therefore
// name itself twice — the host on the command line, the way clear.mjs and
// load-coa.mjs demand it — and must not be the pilot or production database,
// checked by company name as well as by host, because copying the wrong way
// round would overwrite the tester's live books with a development sandbox.
//
// The target keeps its own company row, and so its own name. That name is the
// only way to tell these databases apart from inside the app, and a copy that
// renamed dev to "MTK Co Ltd" would remove the one signal that says which
// database is on screen.
//
// Rows keep their original ids. Only company_id is remapped, so every
// reference between rows survives untouched and nothing has to be rewritten.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const namedHost = args.find((a) => a.startsWith("--host="))?.slice("--host=".length);

function envUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const targetUrl = envUrl();
const sourceUrl = process.env.SOURCE_URL;

if (!targetUrl) { console.error("DATABASE_URL (the target) is not set"); process.exit(1); }
if (!sourceUrl) { console.error("SOURCE_URL (the database to copy from) is not set"); process.exit(1); }

const targetHost = new URL(targetUrl).host;
const sourceHost = new URL(sourceUrl).host;

if (targetHost === sourceHost) {
  console.error("\n  Source and target are the same database.\n");
  process.exit(1);
}

const connect = (url) => postgres(url, {
  ssl: url.includes("localhost") ? false : "require",
  prepare: !url.includes("-pooler."),
  onnotice: () => {},
  max: 1,
});

const source = connect(sourceUrl);
const target = connect(targetUrl);

// Dependency order, worked out from the live schema rather than hardcoded, so
// a table added later is copied without anyone remembering to list it here.
async function tablesInOrder(sql) {
  const withCompany = (await sql`
    select c.table_name from information_schema.columns c
      join information_schema.tables t
        on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and c.column_name = 'company_id'
       and t.table_type = 'BASE TABLE'
     order by c.table_name`).map((r) => r.table_name);

  const fks = await sql`
    select tc.table_name as child, ccu.table_name as parent
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`;

  const deps = new Map(withCompany.map((t) => [t, new Set()]));
  for (const { child, parent } of fks) {
    if (deps.has(child) && deps.has(parent) && child !== parent) deps.get(child).add(parent);
  }

  const order = [];
  const done = new Set();
  while (order.length < withCompany.length) {
    const next = withCompany.filter(
      (t) => !done.has(t) && [...deps.get(t)].every((p) => done.has(p))
    );
    if (next.length === 0) {
      throw new Error(`Circular dependency among: ${withCompany.filter((t) => !done.has(t)).join(", ")}`);
    }
    for (const t of next) { order.push(t); done.add(t); }
  }
  return order;
}

/**
 * Columns pointing at the same table. A posted document cannot be edited
 * afterwards — the immutability trigger sees to that, quite rightly — so
 * these cannot be nulled on insert and patched later. The rows go in waves
 * instead: everything whose own reference is already satisfied, then again,
 * until none is left.
 */
async function selfRefColumns(sql, table) {
  const rows = await sql`
    select kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
       and tc.table_name = ${table} and ccu.table_name = ${table}`;
  return [...new Set(rows.map((r) => r.column_name))];
}

/**
 * Tables the copy leaves alone.
 *
 * posting_rule_change is the audit log of who changed which posting rule and
 * when. It is append-only by trigger — an audit trail nobody can quietly
 * erase is the entire point of it — so the target's rows cannot be deleted to
 * make room. Nor should they be: those entries record changes made in the
 * target database, and replacing them with another database's history would
 * assert edits that never happened there. Each database keeps its own.
 */
const LEAVE_ALONE = new Set(["posting_rule_change"]);

try {
  const [srcCo] = await source`select * from company order by created_at limit 1`;
  const [tgtCo] = await target`select * from company order by created_at limit 1`;

  if (!srcCo) throw new Error("The source has no company");
  if (!tgtCo) throw new Error("The target has no company — set it up before copying into it");

  console.log(`\n  FROM  ${sourceHost}\n        ${srcCo.name}`);
  console.log(`\n  INTO  ${targetHost}\n        ${tgtCo.name}\n`);

  // Two independent guards, because getting this backwards would overwrite
  // the tester's live books with a sandbox.
  if (namedHost !== targetHost) {
    console.error(
      `  REFUSING: name the target host to prove it is the one you mean.\n` +
      `  --host=${targetHost}\n`
    );
    process.exit(1);
  }
  if (!/DEV|UI/i.test(tgtCo.name)) {
    console.error(
      `  REFUSING: the target company is "${tgtCo.name}".\n` +
      `  This copy only writes into a development database, whose company name\n` +
      `  says DEV or UI. "MTK Co Ltd" is the tester's live data and "My Company"\n` +
      `  is reserved for real books.\n`
    );
    process.exit(1);
  }

  const order = (await tablesInOrder(source)).filter((t) => !LEAVE_ALONE.has(t));

  const counts = {};
  for (const t of order) {
    const [{ c }] = await source`select count(*)::int as c from ${source(t)} where company_id = ${srcCo.id}`;
    if (c) counts[t] = c;
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(`  ${order.length} tables, ${total} rows to copy:`);
  for (const [t, c] of Object.entries(counts)) console.log(`    ${t.padEnd(28)} ${c}`);

  if (!confirm) {
    console.log("\n  Nothing written. Re-run with --confirm to replace the target's data.\n");
    process.exit(0);
  }

  await target.begin(async (tx) => {
    // Out in reverse dependency order, so nothing is deleted while something
    // still points at it.
    for (const t of [...order].reverse()) {
      await tx`delete from ${tx(t)} where company_id = ${tgtCo.id}`;
    }

    for (const t of order) {
      const rows = await source`select * from ${source(t)} where company_id = ${srcCo.id}`;
      if (rows.length === 0) continue;

      const selfRefs = await selfRefColumns(source, t);
      const remaining = rows.map((r) => ({ ...r, company_id: tgtCo.id }));
      const placed = new Set();

      while (remaining.length > 0) {
        const ready = remaining.filter((r) =>
          selfRefs.every((col) => r[col] === null || r[col] === undefined || placed.has(r[col]))
        );
        if (ready.length === 0) {
          throw new Error(`${t}: rows reference each other in a cycle, cannot order them`);
        }
        for (const row of ready) {
          await tx`insert into ${tx(t)} ${tx(row)}`;
          if (row.id) placed.add(row.id);
        }
        const readySet = new Set(ready);
        for (let i = remaining.length - 1; i >= 0; i--) {
          if (readySet.has(remaining[i])) remaining.splice(i, 1);
        }
      }
      console.log(`    copied ${t.padEnd(28)} ${rows.length}`);
    }
  });

  console.log("\n  checking what landed:\n");
  let mismatch = 0;
  for (const [t, expected] of Object.entries(counts)) {
    const [{ c }] = await target`select count(*)::int as c from ${target(t)} where company_id = ${tgtCo.id}`;
    if (c !== expected) { mismatch++; console.log(`    MISMATCH ${t}: ${c} of ${expected}`); }
  }
  console.log(mismatch === 0 ? "    every table matches the source" : `    ${mismatch} table(s) differ`);

  const [srcTb] = await source`select coalesce(sum(base_amount),0) as t from journal_line where company_id = ${srcCo.id}`;
  const [tgtTb] = await target`select coalesce(sum(base_amount),0) as t from journal_line where company_id = ${tgtCo.id}`;
  console.log(`    trial balance  source ${Number(srcTb.t)}  target ${Number(tgtTb.t)}`);

  const [after] = await target`select name from company where id = ${tgtCo.id}`;
  console.log(`    company name still "${after.name}"`);
  console.log("");
} finally {
  await source.end();
  await target.end();
}
