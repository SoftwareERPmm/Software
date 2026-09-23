// Shows exactly which database the app is pointed at, and what state each
// known database is in. Answers "where does my data actually live?".
//
//   node scripts/where.mjs                    -- inspect DATABASE_URL / .env
//   node scripts/where.mjs <other-url> ...    -- also inspect these

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fromEnvFile() {
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const mask = (u) => u.replace(/:\/\/([^:]+):[^@]+@/, "://$1:****@");
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "?";
  }
};
const isLocal = (u) => u.includes("localhost") || u.includes("127.0.0.1");

async function inspect(url, label) {
  const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
  const sql = postgres(url, {
    ssl: isLocal(url) ? false : "require",
    prepare: !pooled,
    onnotice: () => {},
    max: 1,
    connect_timeout: 15,
  });

  console.log(`\n  ${label}`);
  console.log(`  ${mask(url)}`);
  console.log(`  host: ${host(url)}   ${isLocal(url) ? "LOCAL MACHINE" : "CLOUD"}`);

  try {
    const migs = await sql`select filename from schema_migration order by filename`;
    console.log(`  migrations: ${migs.length} applied, latest ${migs.at(-1)?.filename ?? "none"}`);

    const [c] = await sql`select count(*)::int as n from company`;
    const [d] = await sql`select count(*)::int as n from document`;
    const [j] = await sql`select count(*)::int as n from journal_entry`;
    const [i] = await sql`select count(*)::int as n from item`;
    const [p] = await sql`select count(*)::int as n from business_partner`;
    console.log(
      `  data: ${c.n} companies, ${p.n} partners, ${i.n} items, ${d.n} documents, ${j.n} journal entries`
    );
  } catch (err) {
    console.log(`  UNREACHABLE: ${err.message}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const active = process.env.DATABASE_URL ?? fromEnvFile();

console.log("\n  The app stores nothing on disk. All data lives in whatever");
console.log("  DATABASE_URL points at — one environment variable, same code.\n");
console.log("  " + "-".repeat(66));

if (active) {
  await inspect(active, process.env.DATABASE_URL ? "ACTIVE (from environment)" : "ACTIVE (from .env — this is what `npm run dev` uses)");
} else {
  console.log("\n  No DATABASE_URL set.");
}

for (const [n, url] of process.argv.slice(2).entries()) {
  await inspect(url, `OTHER #${n + 1}`);
}

console.log("\n  " + "-".repeat(66) + "\n");
