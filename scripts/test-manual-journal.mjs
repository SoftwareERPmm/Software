// What a manual voucher may and may not post to.
//
//   npx tsx scripts/test-manual-journal.mjs
//
// The rule: a Journal, Cash or Bank voucher is for accounting events no
// document produces — depreciation, accruals, reclassification, year-end
// adjustments. A balance a subledger owns must move through the transaction
// that owns it, or the general ledger and the subledger stop agreeing with
// no error to say so.
//
// This posts through lib/posting.ts, which is the API a form uses, and then
// again through raw SQL, because the UI filtering control accounts out of a
// picker is convenience — the database is the authority, and anything that
// can be reached by an import, a script or a future screen has to be refused
// there too.

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

const { postJournalVoucher, postCashVoucher, postAccountOpening } =
  await import("../lib/posting.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n  ${co.name}\n`);

  // Accounts by the role that defines them, never by code: 1300 is Inventory
  // on the demo chart and Software on the customer's.
  const byRole = async (role) => (await sql`
    select a.id, a.code, a.name from account a
      join account_determination d on d.account_id = a.id
     where d.company_id = ${co.id} and d.role = ${role} limit 1`)[0];
  const bySystem = async (role) => (await sql`
    select a.id, a.code, a.name from account a
      join system_account s on s.account_id = a.id
     where s.company_id = ${co.id} and s.role = ${role} limit 1`)[0];
  const free = async (where) => (await sql`
    select id, code, name from account
     where company_id = ${co.id} and is_postable and is_active
       and subledger is null and ${where} order by code limit 1`)[0];

  const ar    = await byRole("AR_CONTROL");
  const ap    = await byRole("AP_CONTROL");
  const inv   = await byRole("INVENTORY");
  const rev   = await byRole("REVENUE");
  const grir  = await bySystem("GRIR_CLEARING");
  const cash  = await free(sql`is_cash_account`);
  const equity = await free(sql`account_type = 'EQUITY'`);
  const expenses = await sql`
    select id, code, name from account
     where company_id = ${co.id} and is_postable and is_active
       and subledger is null and account_type = 'EXPENSE' order by code limit 2`;

  for (const [label, a] of [["AR", ar], ["AP", ap], ["inventory", inv],
                            ["GR/IR", grir], ["revenue", rev], ["cash", cash],
                            ["equity", equity]]) {
    if (!a) throw new Error(`this chart resolves no ${label} account`);
  }
  if (expenses.length < 2) throw new Error("this chart has fewer than two free expense accounts");

  // ---- what the subledgers own -------------------------------------------

  console.log("  the subledgers own their balances\n");

  const refuses = async (label, drAccount, crAccount, expect) => {
    let msg = null;
    try {
      await postJournalVoucher({
        companyId: co.id, docDate: today, memo: "guard test",
        lines: [{ accountId: drAccount.id, amount: 1000 },
                { accountId: crAccount.id, amount: -1000 }],
      });
    } catch (e) { msg = e.message; }
    check(label, msg !== null && msg.includes(expect),
      msg ? msg.slice(0, 72) : "POSTED — it should not have");
  };

  await refuses("a journal voucher cannot debit receivables", ar, rev, "customer subledger");
  await refuses("a journal voucher cannot credit payables", ap, rev, "supplier subledger");
  await refuses("a journal voucher cannot revalue inventory", inv, equity, "inventory subledger");
  await refuses("a journal voucher cannot touch GR/IR", grir, equity, "matching");

  // A cash voucher is the same free-form entry with one side pinned to cash,
  // so it has to be refused on the same terms. This is the gap that would
  // reopen the hole if the rule keyed on the journal voucher alone.
  let cashMsg = null;
  try {
    await postCashVoucher({
      companyId: co.id, docDate: today, memo: "guard test",
      lines: [{ accountId: inv.id, amount: 1000 }, { accountId: cash.id, amount: -1000 }],
    });
  } catch (e) { cashMsg = e.message; }
  check("a cash voucher cannot revalue inventory either",
    cashMsg !== null && cashMsg.includes("inventory subledger"),
    cashMsg ? cashMsg.slice(0, 72) : "POSTED — it should not have");

  // An opening balance is a manual journal wearing a document type, and it
  // was exempted from the rule until 0046. Dr Inventory / Cr Opening Balance
  // Equity balanced perfectly, posted, and moved no stock — general ledger
  // inventory 1,077,000 against a stock ledger of 77,000.
  let openMsg = null;
  try {
    await postAccountOpening({
      companyId: co.id, docDate: today, memo: "guard test",
      lines: [{ accountId: inv.id, amount: 1000000 }],
    });
  } catch (e) { openMsg = e.message; }
  check("an opening balance cannot open inventory either",
    openMsg !== null && openMsg.includes("inventory subledger"),
    openMsg ? openMsg.slice(0, 72) : "POSTED — it should not have");

  // ---- what a manual voucher is for --------------------------------------

  console.log("\n  and everything a document does not produce still posts\n");

  const posts = async (label, drAccount, crAccount) => {
    try {
      const v = await postJournalVoucher({
        companyId: co.id, docDate: today, memo: "guard test",
        lines: [{ accountId: drAccount.id, amount: 1000 },
                { accountId: crAccount.id, amount: -1000 }],
      });
      check(label, true, v.docNo);
    } catch (e) { check(label, false, e.message.slice(0, 72)); }
  };

  try {
    const ob = await postAccountOpening({
      companyId: co.id, docDate: today, memo: "guard test",
      lines: [{ accountId: cash.id, amount: 5000 }],
    });
    check("an opening balance for cash still posts", true, ob.docNo);
  } catch (e) { check("an opening balance for cash still posts", false, e.message.slice(0, 72)); }

  await posts("depreciation: expense against equity", expenses[0], equity);
  await posts("an accrual between two expense accounts", expenses[0], expenses[1]);
  await posts("cash against revenue — an adjustment, not a duplicate invoice", cash, rev);

  // ---- the database is the authority, not the picker ----------------------

  console.log("\n  refused below the API as well as through it\n");

  let rawMsg = null;
  try {
    await sql.begin(async (tx) => {
      const [je] = await tx`
        insert into journal_entry (company_id, entry_no, entry_date, source_type, memo)
        values (${co.id}, ${"RAW-" + Date.now()}, ${today}::date, 'JOURNAL_VOUCHER', 'raw insert')
        returning id`;
      // Straight at the table, with a partner supplied, which is what the old
      // rule's partner check was accidentally relying on to refuse this.
      const [p] = await tx`
        select id from business_partner where company_id = ${co.id} and is_customer limit 1`;
      await tx`
        insert into journal_line (company_id, journal_entry_id, line_no, account_id,
                                  currency, amount, exchange_rate, base_amount, partner_id)
        values (${co.id}, ${je.id}, 1, ${ar.id}, 'MMK', 1000, 1, 1000, ${p?.id ?? null})`;
    });
  } catch (e) { rawMsg = e.message; }
  check("a raw insert to receivables is refused even with a partner named",
    rawMsg !== null && rawMsg.includes("customer subledger"),
    rawMsg ? rawMsg.slice(0, 72) : "INSERTED — it should not have");

  // ---- the invariants still hold -----------------------------------------

  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(Number(tb.t)) < 0.0001, String(Number(tb.t)));

  const [recon] = await sql`select count(*)::int n from v_check_inventory_reconciliation`;
  check("inventory still reconciles to the stock ledger", recon.n === 0, String(recon.n));

  console.log(bad === 0
    ? "\n  subledger-owned accounts are protected\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
