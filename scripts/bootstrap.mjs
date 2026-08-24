// Creates a company on whatever DATABASE_URL points at, without going
// through the setup screen. Useful for onboarding a client from the command
// line, or for getting into a fresh deployment quickly.
//
//   node scripts/bootstrap.mjs "Company Name" CODE [fiscal-year-start]
//
// Everything it creates can be renamed afterwards.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  const m = readFileSync(join(root, ".env"), "utf8").match(/DATABASE_URL\s*=\s*(.+)/);
  if (m) process.env.DATABASE_URL = m[1].trim();
}

const [name, code, fyStart] = process.argv.slice(2);

if (!name || !code) {
  console.error('usage: node scripts/bootstrap.mjs "Company Name" CODE [yyyy-mm-dd]');
  process.exit(1);
}

// Default to the April start Myanmar currently uses, for the year we are in.
const now = new Date();
const year = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
const start = fyStart ?? `${year}-04-01`;

const { scaffoldCompany } = await import("../lib/setup.ts");

try {
  const co = await scaffoldCompany({
    code,
    name,
    baseCurrency: "MMK",
    fiscalYearStartMonth: Number(start.slice(5, 7)),
    fiscalYearStart: start,
    officeName: "Head Office",
    warehouseName: "Main Warehouse",
  });

  console.log(`\n  created "${co.name}"`);
  console.log(`  financial year opens ${start}`);
  console.log(`  chart of accounts, posting rules, units and numbering are in place`);
  console.log(`  no customers, products or transactions\n`);
  process.exit(0);
} catch (e) {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
}
