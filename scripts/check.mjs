// Health check: runs the accounting invariants against whatever DATABASE_URL
// points at. Every check must come back clean.
//
//   node scripts/check.mjs
//   DATABASE_URL=... node scripts/check.mjs
//
// Exits non-zero if any invariant is violated, so it can gate a deploy.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const url = loadEnv();
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const local = url.includes("localhost") || url.includes("127.0.0.1");

// Pooled endpoints are PgBouncer in transaction mode and reject prepared
// statements, which postgres.js uses by default.
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");

const sql = postgres(url, {
  ssl: local ? false : "require",
  prepare: !pooled,
  onnotice: () => {},
  max: 1,
});

const info = [
  ["company", "select name as v from company limit 1"],
  ["documents", "select count(*)::text as v from document"],
  ["journal entries", "select count(*)::text as v from journal_entry"],
  ["stock value", "select to_char(coalesce(sum(value_on_hand),0),'FM999,999,999') as v from v_stock_on_hand"],
  ["AR outstanding", "select to_char(coalesce(sum(outstanding),0),'FM999,999,999') as v from v_open_item where doc_type='SALES_INVOICE'"],
  ["AP outstanding", "select to_char(coalesce(sum(outstanding),0),'FM999,999,999') as v from v_open_item where doc_type='PURCHASE_INVOICE'"],
];

// Each must return 0, or the ledger is not trustworthy.
const invariants = [
  ["trial balance nets to zero", "select coalesce(sum(balance),0)::text as v from v_trial_balance"],
  ["unbalanced entries", "select count(*)::text as v from v_check_unbalanced_entries"],
  ["inventory reconciliation breaks", "select count(*)::text as v from v_check_inventory_reconciliation"],
];

let failed = 0;

try {
  console.log(`\n  ${local ? "local" : "remote"} database\n`);

  for (const [label, q] of info) {
    const [row] = await sql.unsafe(q);
    console.log(`  ${label.padEnd(34)} ${row?.v ?? "—"}`);
  }

  console.log("");

  for (const [label, q] of invariants) {
    const [row] = await sql.unsafe(q);
    const ok = Number(row.v) === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${row.v}`);
  }

  console.log(failed === 0 ? "\n  all invariants hold\n" : `\n  ${failed} invariant(s) violated\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(failed === 0 ? 0 : 1);
