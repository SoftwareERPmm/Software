// Removes demo data so you can tell your own entries apart from the seed.
//
//   node scripts/clear.mjs                 -- transactions only
//   node scripts/clear.mjs --all           -- transactions + demo masters
//   node scripts/clear.mjs --all --confirm -- actually do it
//
// Wiping anything other than the database in .env additionally needs the host
// named, so a pasted production URL cannot destroy the pilot tester's data by
// accident:
//
//   DATABASE_URL="<other>" node scripts/clear.mjs --all --confirm --host=<its host>
//
// Always kept: the company, chart of accounts, system accounts, account
// determination, fiscal calendar, locations, units, price levels, tax codes
// and FOC reasons. Without those nothing can post.
//
// Fully reversible: node scripts/migrate.mjs --reset --seed

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const url = envUrl();
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }

const all = process.argv.includes("--all");
const confirm = process.argv.includes("--confirm");
const local = url.includes("localhost") || url.includes("127.0.0.1");

/**
 * Wiping the database named in .env is routine — that is the development
 * branch, and clearing it is most of what this script is for. Wiping anything
 * else means a URL was passed on the command line, which is how the pilot
 * tester's data or the real books would get destroyed by a mispaste.
 *
 * A blanket "refuse anything not localhost" rule would be useless here: the
 * development branch is itself a cloud database, so the override would be
 * needed daily and would stop being read within a week. Instead the target
 * host has to be named, which cannot happen by accident.
 */
function envFileUrl() {
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const targetHost = new URL(url).host;
const envHost = envFileUrl() ? new URL(envFileUrl()).host : null;
const isEnvTarget = envHost !== null && targetHost === envHost;

const namedArg = process.argv.find((a) => a.startsWith("--host="));
const namedHost = namedArg ? namedArg.slice("--host=".length) : null;

if (confirm && !isEnvTarget && namedHost !== targetHost) {
  console.error(
    `\n  REFUSING to wipe a database that is not the one in .env.\n\n` +
    `    target   ${targetHost}\n` +
    `    .env     ${envHost ?? "(no .env found)"}\n\n` +
    `  If that is genuinely what you want, name it explicitly:\n\n` +
    `    --host=${targetHost}\n`
  );
  process.exit(1);
}
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

// Transactions are TRUNCATEd rather than DELETEd: journal entries and stock
// movements carry BEFORE DELETE triggers that refuse row deletion by design.
// TRUNCATE is a table-level operation and bypasses them, which is right for a
// deliberate wipe and still impossible to do by accident from the app.
const TXN = ["payment_allocation", "stock_movement", "document_line", "document", "journal_line", "journal_entry"];

// Master data is DELETEd, not TRUNCATEd. TRUNCATE ... CASCADE is table-level:
// truncating item_group would take every row of account_determination with it,
// including the company-wide posting rules that reference no group at all.
// Lose those and nothing can post again.
// Order matters: a table is deleted before anything it points at. item
// carries brand_id, so brand can only go once the items are gone.
const MASTER = ["consignment_agreement_line", "consignment_agreement",
                "item_alias", "item_uom", "item_reorder", "item_price", "item",
                "item_group", "brand", "business_partner", "salesman", "promotion",
                // Last: item and document both carry import_batch_id, so the
                // batches can only go once those are gone. Deliberately not in
                // TXN — truncating it there would CASCADE into item, which the
                // transactions-only mode is supposed to keep.
                "import_batch"];

try {
  // The company name is what actually distinguishes these databases from the
  // outside — they are otherwise identical and equally empty-looking. Printing
  // it is the last chance to notice that "MTK Co Ltd" is the tester's live
  // data and not "MTK Co Ltd — DEV".
  const [co] = await sql`select name from company`;
  console.log(
    `\n  ${local ? "LOCAL" : "CLOUD"}  ${targetHost}` +
    `\n  company     ${co?.name ?? "(none)"}` +
    `${isEnvTarget ? "" : "  <- NOT the database in .env"}\n`
  );

  const counts = async () => {
    const rows = await sql`
      select 'documents' as k, count(*)::int as n from document
      union all select 'journal entries', count(*)::int from journal_entry
      union all select 'stock movements', count(*)::int from stock_movement
      union all select 'partners', count(*)::int from business_partner
      union all select 'items', count(*)::int from item
      union all select 'categories', count(*)::int from item_group
      union all select 'brands', count(*)::int from brand`;
    return rows;
  };

  console.log("  before:");
  for (const r of await counts()) console.log(`    ${r.k.padEnd(18)} ${r.n}`);

  if (!confirm) {
    console.log(`\n  Nothing removed. Re-run with --confirm to wipe ${all ? "transactions and demo masters" : "transactions"}.\n`);
    await sql.end();
    process.exit(0);
  }

  await sql.unsafe(`truncate table ${TXN.join(", ")} restart identity cascade`);

  if (all) {
    await sql.begin(async (tx) => {
      // Posting rules scoped to a category go with it; the company-wide
      // fallbacks stay, so a cleared database can still post.
      await tx`delete from account_determination where item_group_id is not null`;
      await tx`delete from promotion`;
      // MASTER, not a second copy of it. There was one here, and the two
      // had already drifted: the list above named tables this loop never
      // deleted, so a table added to it looked handled and was not.
      for (const t of MASTER.filter((t) => t !== "promotion")) {
        await tx.unsafe(`delete from ${t}`);
      }
    });
  }

  // Document numbering starts from 1 again, so the first voucher you enter
  // is the first of its fiscal year — SI-2627-000001 — rather than
  // continuing the demo sequence.
  // Day counters are removed outright rather than reset: each is a row for a
  // date that now has no documents, and a fresh one is created the first time
  // something is posted on that day. The older per-fiscal-year rows are kept
  // and rewound, since those are the series the pre-0035 numbers came from.
  await sql`delete from number_series where series_date is not null`;
  await sql`update number_series set next_value = 1`;

  console.log("\n  after:");
  for (const r of await counts()) console.log(`    ${r.k.padEnd(18)} ${r.n}`);

  const kept = await sql`
    select 'accounts' as k, count(*)::int as n from account
    union all select 'system accounts', count(*)::int from system_account
    union all select 'posting rules', count(*)::int from account_determination
    union all select 'fiscal periods', count(*)::int from fiscal_period
    union all select 'locations', count(*)::int from location
    union all select 'units', count(*)::int from uom
    union all select 'FOC reasons', count(*)::int from foc_reason`;

  console.log("\n  kept (needed to post):");
  for (const r of kept) console.log(`    ${r.k.padEnd(18)} ${r.n}`);
  console.log("");
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
