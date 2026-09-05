// Loads the MTK chart of accounts, replacing whatever chart is there.
//
//   node scripts/load-coa.mjs                 -- dry run, shows the target
//   node scripts/load-coa.mjs --confirm       -- replace the chart
//
// Against anything other than the database in .env, name the host too, the
// same way scripts/clear.mjs does:
//
//   DATABASE_URL="<other>" node scripts/load-coa.mjs --confirm --host=<its host>
//
// REFUSES to run if anything has been posted. Replacing a chart under
// existing journal lines would leave those lines pointing at accounts that no
// longer exist, or — worse — at accounts that now mean something else.
//
// Why this file exists: the chart is not seed data. It replaces the chart on
// a database that already exists, which the seed cannot do.
//
// db/seed.sql now builds this same chart, generated from the CHART array
// below, so the demo and a real company are the same shape. Keep the two in
// step: change this array and regenerate that block, never one alone. What
// used to keep them apart — suites asserting on the seed's own account codes
// — is gone; they resolve accounts through scripts/accounts.mjs instead.
//
// Three accounts marked `added: true` are not in the customer's chart. Every
// other role the engine resolves was pointed at an account the chart already
// has, so these three are what genuinely has no home in it:
//
//   1060 GR/IR Clearing         holds a receipt between the goods arriving
//                               and the bill for them. Without it a receipt
//                               would have to credit Payables, claiming a
//                               debt the supplier has not invoiced.
//   3030 Opening Balance Equity balances opening balances and nets to zero
//                               once they are all in. Posting them against
//                               Owner's Capital instead would overstate it.
//   5050 Purchase Price Variance absorbs a bill that differs from the
//                               receipt it settles. Folding it into Purchase
//                               would hide the difference inside cost.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { CHART, SYSTEM, DETERMINATION } from "../db/chart.mjs";

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

function envFileUrl() {
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

const confirm = process.argv.includes("--confirm");
const targetHost = new URL(url).host;
const envHost = envFileUrl() ? new URL(envFileUrl()).host : null;
const named = process.argv.find((a) => a.startsWith("--host="))?.slice("--host=".length);

if (confirm && targetHost !== envHost && named !== targetHost) {
  console.error(
    `\n  REFUSING to replace the chart on a database that is not the one in .env.\n\n` +
    `    target   ${targetHost}\n    .env     ${envHost ?? "(none)"}\n\n` +
    `  If that is genuinely what you want, name it:  --host=${targetHost}\n`
  );
  process.exit(1);
}

// The old chart's accounts, mapped to their home in the new one, so free-of-
// charge reasons keep writing off to the same kind of account.
const FOC_REMAP = { "5300": "5300", "6100": "6320" };

const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  if (!co) { console.error("\n  No company exists yet.\n"); process.exit(1); }

  const [j] = await sql`select count(*)::int as c from journal_line`;
  const [a] = await sql`select count(*)::int as c from account where company_id = ${co.id}`;

  console.log(`\n  ${targetHost}`);
  console.log(`  company        ${co.name}`);
  console.log(`  accounts now   ${a.c}`);
  console.log(`  journal lines  ${j.c}`);

  if (j.c > 0) {
    console.error(
      `\n  REFUSING: this database has ${j.c} posted journal lines.\n` +
      `  Replacing the chart under them would orphan every one.\n`
    );
    process.exit(1);
  }

  if (!confirm) {
    const added = CHART.filter((r) => r[4]?.added).map((r) => `${r[0]} ${r[1]}`);
    console.log(`\n  Would load ${CHART.length} accounts (${CHART.filter((r) => !r[3]).length} sections),`);
    console.log(`  including ${added.length} the posting engine requires:\n`);
    for (const x of added) console.log(`    ${x}`);
    console.log(`\n  Nothing changed. Re-run with --confirm.\n`);
    process.exit(0);
  }

  // foc_reason.account_id is NOT NULL, so those rows cannot be parked while
  // the chart is replaced — they are captured, dropped and recreated against
  // the new accounts.
  const focBefore = await sql`
    select f.code, f.name, f.name_my, a.code as acct
      from foc_reason f join account a on a.id = f.account_id
     where f.company_id = ${co.id} order by f.code`;

  await sql.begin(async (tx) => {
    await tx`delete from foc_reason where company_id = ${co.id}`;
    await tx`update tax_code set output_account_id = null, input_account_id = null where company_id = ${co.id}`;
    await tx`update business_partner set ar_control_id = null, ap_control_id = null where company_id = ${co.id}`;
    await tx`delete from account_determination where company_id = ${co.id}`;
    await tx`delete from system_account where company_id = ${co.id}`;
    await tx`delete from account where company_id = ${co.id}`;

    const id = new Map();
    let section = null;
    for (const [code, name, type, postable, flags = {}] of CHART) {
      const parent = postable ? section : (flags.under ? id.get(flags.under) : null);
      const [row] = await tx`
        insert into account (company_id, parent_id, code, name, account_type,
                             is_postable, is_control, is_cash_account, is_bank_account, is_active)
        values (${co.id}, ${parent}, ${code}, ${name}, ${type}::account_type,
                ${postable}, ${!!flags.control}, ${!!flags.cash}, ${!!flags.bank}, true)
        returning id`;
      id.set(code, row.id);
      if (!postable) section = row.id;
    }

    for (const [role, code] of Object.entries(SYSTEM)) {
      await tx`insert into system_account (company_id, role, account_id)
               values (${co.id}, ${role}, ${id.get(code)})`;
    }
    for (const [role, code] of Object.entries(DETERMINATION)) {
      await tx`insert into account_determination (company_id, role, account_id)
               values (${co.id}, ${role}, ${id.get(code)})`;
    }
    for (const f of focBefore) {
      const target = id.get(FOC_REMAP[f.acct] ?? f.acct);
      if (!target) throw new Error(`FOC reason ${f.code} used account ${f.acct}, which the new chart has no home for`);
      await tx`insert into foc_reason (company_id, code, name, name_my, account_id)
               values (${co.id}, ${f.code}, ${f.name}, ${f.name_my}, ${target})`;
    }
  });

  const [after] = await sql`select count(*)::int as c from account where company_id = ${co.id}`;
  const [heads] = await sql`select count(*)::int as c from account where company_id = ${co.id} and not is_postable`;
  const missing = [];
  for (const role of Object.keys(SYSTEM)) {
    const [x] = await sql`select 1 as ok from system_account where company_id = ${co.id} and role = ${role}`;
    if (!x) missing.push(role);
  }
  for (const role of Object.keys(DETERMINATION)) {
    const [x] = await sql`select 1 as ok from account_determination where company_id = ${co.id} and role = ${role}`;
    if (!x) missing.push(role);
  }

  console.log(`\n  loaded ${after.c} accounts, ${heads.c} sections`);
  console.log(`  every posting role resolves: ${missing.length === 0 ? "yes" : "NO — " + missing.join(", ")}`);
  console.log(`\n  Now prove it still posts:  npx tsx scripts/test-empty.mjs\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
