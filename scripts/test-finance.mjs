// Cash book, bank, journal, interbranch transfer and opening balances.

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

const {
  postCashVoucher, postBankVoucher, postJournalVoucher,
  postCashTransfer, postAccountOpening,
} = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, {
  ssl: local ? false : "require",
  prepare: !url.includes("-pooler."),
  onnotice: () => {}, max: 1,
});

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };
const n = (v) => Number(v ?? 0);
const acct = async (code) =>
  (await sql`select id from account where code = ${code} limit 1`)[0]?.id;

try {
  const [co] = await sql`select id from company limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  // Chosen by what an account *is*, not by the code the demo seed gave it.
  // On the chart this ran against, 1110 is Building — so the old fixture was
  // one posting away from putting the month's rent into a fixed asset, and
  // the accounts it could not find at all left vouchers with a single line.
  const pick = async (where) => {
    const [a] = await where;
    if (!a) throw new Error("the chart has no account for this fixture");
    return a.id;
  };
  const cash = await pick(sql`
    select id from account where company_id = ${co.id}
       and is_cash_account and is_postable and is_active order by code limit 1`);
  const bank = await pick(sql`
    select id from account where company_id = ${co.id}
       and is_bank_account and is_postable and is_active order by code limit 1`);
  const [rent, salary] = (await sql`
    select id from account where company_id = ${co.id}
       and account_type = 'EXPENSE' and is_postable and is_active
       and not is_cash_account and not is_bank_account
     order by code limit 2`).map((a) => a.id);
  const capital = await pick(sql`
    select id from account where company_id = ${co.id}
       and account_type = 'EQUITY' and is_postable and is_active order by code limit 1`);
  if (!rent || !salary) throw new Error("the chart has no expense accounts to post to");
  const today = new Date().toISOString().slice(0, 10);
  console.log("");

  // ---- Account opening ---------------------------------------------------

  const ob = await postAccountOpening({
    companyId: co.id, docDate: today,
    lines: [
      { accountId: cash, amount: 200000 },
      { accountId: bank, amount: 3000000 },
    ],
  });
  check("opening balances post", Boolean(ob.docNo), ob.docNo);

  const obLines = await sql`
    select a.code, jl.base_amount from journal_line jl
      join account a on a.id = jl.account_id
     where jl.journal_entry_id = (select journal_entry_id from document where id = ${ob.id})`;
  const { accountsFor } = await import("./accounts.mjs");
  const OBE = await accountsFor(sql, co.id).role("OPENING_BALANCE_EQUITY");
  check("balancing figure went to Opening Balance Equity",
    obLines.some((l) => l.code === OBE && n(l.base_amount) === -3200000),
    obLines.map((l) => `${l.code}:${n(l.base_amount)}`).join(" "));

  // ---- Cash book ---------------------------------------------------------

  const cv = await postCashVoucher({
    companyId: co.id, docDate: today, memo: "August rent",
    lines: [
      { accountId: rent, amount: 150000 },
      { accountId: cash, amount: -150000 },
    ],
  });
  check("cash voucher posts", Boolean(cv.docNo), cv.docNo);
  // Type + date + daily sequence since 0035: a cash payment prints P, a cash
  // receipt R. The dashed CV-/BV-/JV- prefixes are three schemes ago.
  check("cash payment is numbered P + date", /^P\d{8}\d{3}$/.test(cv.docNo), cv.docNo);

  const [cashBal] = await sql`
    select coalesce(sum(base_amount), 0) as v from journal_line where account_id = ${cash}`;
  check("cash reduced by the payment", n(cashBal.v) === 50000, `${n(cashBal.v)}`);

  // ---- Bank --------------------------------------------------------------

  const bv = await postBankVoucher({
    companyId: co.id, docDate: today, memo: "August salaries",
    lines: [
      { accountId: salary, amount: 900000 },
      { accountId: bank, amount: -900000 },
    ],
  });
  check("bank payment is numbered BP + date", /^BP\d{8}\d{3}$/.test(bv.docNo), bv.docNo);

  // ---- Journal -----------------------------------------------------------

  const jv = await postJournalVoucher({
    companyId: co.id, docDate: today, memo: "Owner injects capital",
    lines: [
      { accountId: bank, amount: 500000 },
      { accountId: capital, amount: -500000 },
    ],
  });
  check("journal voucher is numbered J + date", /^J\d{8}\d{3}$/.test(jv.docNo), jv.docNo);

  let refusedUnbalanced = false;
  try {
    await postJournalVoucher({
      companyId: co.id, docDate: today,
      lines: [
        { accountId: bank, amount: 100 },
        { accountId: capital, amount: -99 },
      ],
    });
  } catch { refusedUnbalanced = true; }
  check("refuses an unbalanced journal", refusedUnbalanced);

  // A manual entry to a control account must still be refused by the database.
  const [arRow] = await sql`
    select fn_resolve_control_account(${co.id}, 'AR_CONTROL', null) as id`;
  const ar = arRow.id;
  let refusedControl = false;
  try {
    await postJournalVoucher({
      companyId: co.id, docDate: today,
      lines: [
        { accountId: ar, amount: 1000 },
        { accountId: capital, amount: -1000 },
      ],
    });
  } catch { refusedControl = true; }
  check("still refuses a manual entry to a control account", refusedControl);

  // ---- Interbranch transfer ----------------------------------------------

  const ct = await postCashTransfer({
    companyId: co.id, docDate: today,
    fromAccountId: bank, toAccountId: cash, amount: 300000,
    memo: "Cash drawn for Mandalay branch",
  });
  check("transfer is numbered CT + date", /^CT\d{8}\d{3}$/.test(ct.docNo), ct.docNo);

  const [cashAfter] = await sql`
    select coalesce(sum(base_amount), 0) as v from journal_line where account_id = ${cash}`;
  check("cash up by the transfer", n(cashAfter.v) === 350000, `${n(cashAfter.v)}`);

  let refusedSame = false;
  try {
    await postCashTransfer({
      companyId: co.id, docDate: today,
      fromAccountId: cash, toAccountId: cash, amount: 100,
    });
  } catch { refusedSame = true; }
  check("refuses a transfer to the same account", refusedSame);

  // ---- Account ledger ----------------------------------------------------

  const ledger = await sql`
    select entry_no, debit, credit, running_balance, doc_no
      from v_account_ledger
     where company_id = ${co.id} and account_id = ${cash}
     order by entry_date, entry_no`;

  console.log("\n  Cash in Hand");
  console.log("  " + "-".repeat(58));
  for (const r of ledger) {
    console.log(
      `  ${String(r.doc_no ?? "").padEnd(12)}` +
      `${(n(r.debit) ? n(r.debit).toLocaleString() : "").padStart(12)}` +
      `${(n(r.credit) ? n(r.credit).toLocaleString() : "").padStart(12)}` +
      `${n(r.running_balance).toLocaleString().padStart(14)}`
    );
  }
  console.log("");

  check("ledger shows every movement", ledger.length === 3, `${ledger.length}`);
  check("running balance ends at the account balance",
    n(ledger[ledger.length - 1].running_balance) === 350000,
    `${n(ledger[ledger.length - 1].running_balance)}`);

  // ---- Invariants --------------------------------------------------------

  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0 ? "  finance vouchers work\n" : `  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
