// Accounts Payable through a purchase and a part payment.
//
//   Purchase on credit   Cr AP 500,000
//   Pay supplier          Dr AP  50,000
//   ------------------------------------
//   AP closing                  450,000 credit
//
// The point being tested is that nothing overwrites AP. The 450,000 is the
// sum of two entries, and the invoice still reads 500,000.

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

const { postPurchaseInvoice, postSupplierPayment } = await import("../lib/posting.ts");

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
const m = (v) => n(v).toLocaleString("en-US");

try {
  const [co] = await sql`select id from company limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from item where code like '99%'`;
  await sql`delete from item_group where code like '99%'`;
  await sql`delete from business_partner where code = 'AP-SUP'`;

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, '99', 'x', 'AP Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'AP Test Item', ${uom.id}) returning id`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;
  const [cash] = await sql`
    select id, code from account where company_id = ${co.id} and code = '1110'`;
  const [sup] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, 'AP-SUP', 'AP Test Supplier', true) returning id`;

  const today = new Date().toISOString().slice(0, 10);

  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: sup.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 500, unitPrice: 1000 }],
  });

  const pay = await postSupplierPayment({
    companyId: co.id, partnerId: sup.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: pi.id, amount: 50000 }],
  });

  console.log(`\n  ${pi.docNo} purchase on credit, then ${pay.docNo} paying 50,000\n`);

  // ---- every movement on AP, in order ------------------------------------

  const apLines = await sql`
    select je.entry_no, je.source_type, jl.debit, jl.credit
      from v_journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.code = '2100'
     order by je.entry_no`;

  console.log("  Accounts Payable movements");
  console.log("  " + "-".repeat(58));
  console.log(`  ${"entry".padEnd(12)}${"source".padEnd(20)}${"debit".padStart(12)}${"credit".padStart(12)}`);
  for (const l of apLines) {
    console.log(
      `  ${l.entry_no.padEnd(12)}${String(l.source_type).toLowerCase().replace(/_/g, " ").padEnd(20)}` +
      `${(n(l.debit) ? m(l.debit) : "").padStart(12)}${(n(l.credit) ? m(l.credit) : "").padStart(12)}`
    );
  }

  const totalDr = apLines.reduce((s, l) => s + n(l.debit), 0);
  const totalCr = apLines.reduce((s, l) => s + n(l.credit), 0);
  console.log("  " + "-".repeat(58));
  console.log(`  ${"".padEnd(32)}${m(totalDr).padStart(12)}${m(totalCr).padStart(12)}`);
  console.log(`  closing balance: ${m(totalCr - totalDr)} credit\n`);

  check("two separate movements, nothing overwritten", apLines.length === 2, `${apLines.length}`);
  check("invoice credited AP 500,000", totalCr === 500000, m(totalCr));
  check("payment debited AP 50,000", totalDr === 50000, m(totalDr));
  check("AP closes at 450,000 credit", totalCr - totalDr === 450000, m(totalCr - totalDr));

  const [inv] = await sql`
    select gross_total, paid, outstanding, payment_status
      from v_invoice_status where document_id = ${pi.id}`;
  check("the invoice still reads 500,000", n(inv.gross_total) === 500000, m(inv.gross_total));
  check("paid 50,000, outstanding 450,000",
    n(inv.paid) === 50000 && n(inv.outstanding) === 450000,
    `${m(inv.paid)} / ${m(inv.outstanding)}`);
  check("status is PARTIALLY_PAID", inv.payment_status === "PARTIALLY_PAID", inv.payment_status);

  // The subledger and the control account must agree.
  const [ctrl] = await sql`
    select coalesce(sum(-jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.code = '2100'`;
  const [sub] = await sql`
    select coalesce(sum(outstanding), 0) as v from v_invoice_status
     where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE'`;
  check("AP control equals the sum of open supplier items",
    n(ctrl.v) === n(sub.v), `GL ${m(ctrl.v)} vs subledger ${m(sub.v)}`);

  // ---- how the trial balance presents it ---------------------------------

  const tb = await sql`
    select a.code, a.name, sum(t.debit) as debit, sum(t.credit) as credit,
           case when sum(t.balance) > 0 then  sum(t.balance) else 0 end as closing_debit,
           case when sum(t.balance) < 0 then -sum(t.balance) else 0 end as closing_credit
      from v_trial_balance t join account a on a.id = t.account_id
     where t.company_id = ${co.id}
     group by a.code, a.name having sum(t.balance) <> 0
     order by a.code`;

  console.log("  Trial balance");
  console.log("  " + "-".repeat(72));
  console.log(`  ${"".padEnd(30)}${"debit".padStart(11)}${"credit".padStart(11)}${"close Dr".padStart(11)}${"close Cr".padStart(11)}`);
  for (const r of tb) {
    console.log(
      `  ${r.code.padEnd(6)}${r.name.padEnd(24)}` +
      `${(n(r.debit) ? m(r.debit) : "").padStart(11)}` +
      `${(n(r.credit) ? m(r.credit) : "").padStart(11)}` +
      `${(n(r.closing_debit) ? m(r.closing_debit) : "").padStart(11)}` +
      `${(n(r.closing_credit) ? m(r.closing_credit) : "").padStart(11)}`
    );
  }
  const tDr = tb.reduce((s, r) => s + n(r.closing_debit), 0);
  const tCr = tb.reduce((s, r) => s + n(r.closing_credit), 0);
  console.log("  " + "-".repeat(72));
  console.log(`  ${"".padEnd(52)}${m(tDr).padStart(11)}${m(tCr).padStart(11)}
`);

  const ap = tb.find((r) => r.code === "2100");
  check("AP shows 50,000 in the debit column", n(ap.debit) === 50000);
  check("AP shows 500,000 in the credit column", n(ap.credit) === 500000);
  check("AP closing sits on the credit side, not as a negative",
    n(ap.closing_credit) === 450000 && n(ap.closing_debit) === 0,
    `Cr ${m(ap.closing_credit)}`);
  check("the two closing columns agree", tDr === tCr, `${m(tDr)} vs ${m(tCr)}`);

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from item where code like '99%'`;
  await sql`delete from item_group where code like '99%'`;
  await sql`delete from business_partner where code = 'AP-SUP'`;

  console.log(bad === 0 ? "  AP is derived from the ledger, not overwritten\n" : `  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
