// The cash flow statement, against the shapes that used to break it.
//
//   npx tsx scripts/test-cash-flow.mjs
//
// Two properties, both of which failed on 2026-09-07:
//
//   Every movement of cash is counted exactly once. The old query joined each
//   cash line to every contra line and summed the contra, so an entry with
//   two cash lines reported its contra twice — 100,000 of capital arriving
//   across a till and a bank account read as 200,000 of financing inflow.
//
//   Beginning cash plus what the statement explains equals ending cash.
//   Ending cash is read straight from the ledger while the movements are
//   classified from it, so the two are arrived at independently and agreeing
//   is the only evidence the classification is complete.

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
const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, { ssl: local ? false : "require",
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });

const P = await import("../lib/posting.ts");
const Q = await import("../lib/queries.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v).toLocaleString();

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const today = new Date().toISOString().slice(0, 10);
  const FROM = "2000-01-01", TO = "2099-12-31";
  console.log(`\n  ${co.name}\n`);

  const one = async (q) => (await q)[0];
  const cash = await one(sql`select id, code from account where company_id = ${co.id}
     and is_cash_account and not is_bank_account and is_postable and is_active order by code limit 1`);
  const bank = await one(sql`select id, code from account where company_id = ${co.id}
     and is_bank_account and is_postable and is_active order by code limit 1`);
  const equity = await one(sql`select id, code from account where company_id = ${co.id}
     and account_type = 'EQUITY' and is_postable and is_active and subledger is null order by code limit 1`);
  const expense = await one(sql`select id, code from account where company_id = ${co.id}
     and account_type = 'EXPENSE' and is_postable and is_active and subledger is null order by code limit 1`);
  for (const [label, a] of [["cash", cash], ["bank", bank], ["equity", equity], ["expense", expense]]) {
    if (!a) throw new Error(`this chart has no postable ${label} account`);
  }

  const classified = async (branchId = null) => {
    const cf = await Q.getCashFlowStatement(co.id, FROM, TO, branchId);
    return {
      total: cf.rows.reduce((s, r) => s + Number(r.amount), 0),
      beginning: Number(cf.beginningCash),
      ending: Number(cf.endingCash),
      rows: cf.rows,
    };
  };

  // ---- one entry, two cash accounts --------------------------------------

  console.log("  capital arriving across a till and a bank account\n");

  const before = await classified();
  await P.postJournalVoucher({
    companyId: co.id, docDate: today, memo: "split cash test",
    lines: [{ accountId: cash.id, amount: 60000 },
            { accountId: bank.id, amount: 40000 },
            { accountId: equity.id, amount: -100000 }],
  });
  const after = await classified();

  check("100,000 of cash across two accounts is classified as 100,000",
    Math.abs((after.total - before.total) - 100000) < 0.01,
    `${n(after.total - before.total)}`);

  // ---- one cash line, two contras ----------------------------------------

  console.log("\n  one payment split between an expense and equity\n");

  const before2 = await classified();
  await P.postJournalVoucher({
    companyId: co.id, docDate: today, memo: "split contra test",
    lines: [{ accountId: expense.id, amount: 30000 },
            { accountId: equity.id, amount: 20000 },
            { accountId: cash.id, amount: -50000 }],
  });
  const after2 = await classified();

  check("50,000 paid against two contras is classified as 50,000 out",
    Math.abs((after2.total - before2.total) + 50000) < 0.01,
    `${n(after2.total - before2.total)}`);
  check("  and splits in the ratio of the contras, not evenly",
    Math.abs(
      (after2.rows.filter((r) => r.section === "operating").reduce((s, r) => s + Number(r.amount), 0)
       - before2.rows.filter((r) => r.section === "operating").reduce((s, r) => s + Number(r.amount), 0))
      + 30000) < 0.01,
    "30,000 of it operating");

  // ---- a transfer between the company's own accounts ---------------------

  console.log("\n  moving money between the company's own accounts\n");

  const before3 = await classified();
  await P.postCashTransfer({
    companyId: co.id, docDate: today, amount: 10000,
    fromAccountId: cash.id, toAccountId: bank.id, memo: "transfer test",
  });
  const after3 = await classified();
  check("an internal transfer is not an inflow or an outflow",
    Math.abs(after3.total - before3.total) < 0.01, `${n(after3.total - before3.total)}`);

  // ---- the statement's own proof -----------------------------------------

  console.log("\n  and the whole thing reconciles\n");

  const final = await classified();
  const expected = final.beginning + final.total;
  check("beginning cash plus classified movements equals ending cash",
    Math.abs(expected - final.ending) < 0.01,
    `${n(final.beginning)} + ${n(final.total)} = ${n(expected)} vs ${n(final.ending)}`);

  console.log(bad === 0
    ? "\n  cash actually moved is what the statement says\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
