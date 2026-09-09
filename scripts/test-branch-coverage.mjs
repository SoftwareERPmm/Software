// Every branch, plus what belongs to none, adds up to the company.
//
//   npx tsx scripts/test-branch-coverage.mjs
//
// A branch report that comes to less than the company total, with nothing on
// screen saying why, reads as a broken filter. It was two things: opening
// balances carried no branch at all, and a voucher could be posted with
// "None" chosen. Both now name a branch, and whatever history already has
// none is at least visible and selectable rather than silently missing.

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
const sql = postgres(url, { ssl: url.includes("localhost") ? false : "require",
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });

const P = await import("../lib/posting.ts");
const Q = await import("../lib/queries.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const dr = (rows) => rows.reduce((s, r) => s + n(r.debit), 0);

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry, opening_batch
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const branches = await sql`select id, code from location
     where company_id = ${co.id} and parent_id is null and is_active order by code`;
  check("the company has more than one branch to add up", branches.length > 1,
    branches.map((b) => b.code).join(", "));

  const wh = await sql`select id, code, parent_id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  // Any postable cash account will do — this suite is about the branch
  // dimension, not about which account the money sits in.
  const [cash] = await sql`select id from account
     where company_id = ${co.id} and is_cash_account and is_postable and is_active
     order by code limit 1`;
  const [expense] = await sql`select id from account
     where company_id = ${co.id} and account_type = 'EXPENSE' and is_postable and is_active
     order by code limit 1`;

  const today = new Date().toISOString().slice(0, 10);

  // Activity in each branch's own warehouse.
  for (const w of wh) {
    await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: w.id,
      docDate: today, lines: [{ itemId: item.id, qty: 10, unitCost: 1000 }] });
  }

  // A voucher, at a branch.
  await P.postCashVoucher({ companyId: co.id, docDate: today, memo: "rent",
    locationId: branches[0].id,
    lines: [{ accountId: expense.id, amount: 50000 }, { accountId: cash.id, amount: -50000 }] });

  const all = await Q.getTrialBalanceAsOf(co.id, {});
  let summed = 0;
  for (const b of branches) {
    summed += dr(await Q.getTrialBalanceAsOf(co.id, { locationId: b.id }));
  }
  const none = dr(await Q.getTrialBalanceAsOf(co.id, { locationId: Q.UNASSIGNED_BRANCH }));

  check("with everything stamped, the branches add up on their own",
    Math.abs(dr(all) - summed) < 0.0001,
    `${summed.toLocaleString()} of ${dr(all).toLocaleString()}`);
  check("  and nothing is left over", none === 0, `${none.toLocaleString()} unassigned`);

  // Opening balances used to be the exception that broke it.
  await P.postOpeningBatch({
    companyId: co.id, cutoverDate: today, memo: "Opening balances",
    accounts: [
      { accountId: cash.id, amount: 300000, locationId: branches[0].id },
      { accountId: expense.id, amount: -300000, locationId: branches[0].id },
    ],
  });

  const all2 = await Q.getTrialBalanceAsOf(co.id, {});
  let summed2 = 0;
  for (const b of branches) {
    summed2 += dr(await Q.getTrialBalanceAsOf(co.id, { locationId: b.id }));
  }
  check("an opening batch that names a branch keeps them adding up",
    Math.abs(dr(all2) - summed2) < 0.0001,
    `${summed2.toLocaleString()} of ${dr(all2).toLocaleString()}`);

  const activity = await Q.getUnassignedBranchActivity(co.id);
  check("  and nothing reports as branchless", activity.lines === 0, `${activity.lines} lines`);

  // History that has none — everything posted before the branch dimension
  // existed, and the vouchers that took the "None" the form used to offer —
  // is visible rather than missing. The engine still accepts a voucher with
  // no branch; it is the form and the action that now insist, so this posts
  // the way that history did.
  await P.postJournalVoucher({
    companyId: co.id, docDate: today, memo: "posted before branches existed",
    locationId: null,
    lines: [{ accountId: expense.id, amount: 40000 }, { accountId: cash.id, amount: -40000 }],
  });
  const after = await Q.getUnassignedBranchActivity(co.id);
  check("a branchless entry is counted as such", after.lines === 2, `${after.lines} lines`);
  {
    const all3 = await Q.getTrialBalanceAsOf(co.id, {});
    let summed3 = 0;
    for (const b of branches) summed3 += dr(await Q.getTrialBalanceAsOf(co.id, { locationId: b.id }));
    const none3 = dr(await Q.getTrialBalanceAsOf(co.id, { locationId: Q.UNASSIGNED_BRANCH }));
    check("a branchless entry is reported, not lost",
      Math.abs(dr(all3) - summed3 - none3) < 0.0001,
      `${summed3.toLocaleString()} + ${none3.toLocaleString()} = ${dr(all3).toLocaleString()}`);
    check("  and the screens can say how much it is",
      Math.abs(after.debits - none3) < 0.0001,
      `${after.debits.toLocaleString()} reported, ${none3.toLocaleString()} in the trial balance`);
  }

  console.log(bad === 0
    ? "\n  the branches add up to the company\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
