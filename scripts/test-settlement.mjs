// Settling invoices: the invoice is never edited, a payment document is
// allocated against it, and status is derived from what has been applied.

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

const { postPurchaseInvoice, postSalesInvoice, postSupplierPayment, postCustomerReceipt } =
  await import("../lib/posting.ts");

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

const statusOf = async (id) =>
  (await sql`select payment_status, paid, outstanding from v_invoice_status
              where document_id = ${id}`)[0];

try {
  const [co] = await sql`select id from company limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from item where code like '88%'`;
  await sql`delete from item_group where code like '88%'`;
  await sql`delete from business_partner where code in ('T-SUP', 'T-CUS')`;

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, '88', 'x', 'Settlement Test') returning id, code`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'Test Widget', ${uom.id}) returning id`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;
  const [cash] = await sql`
    select id, code from account where company_id = ${co.id} and is_cash_account order by code limit 1`;

  const [sup] = await sql`
    insert into business_partner (company_id, code, name, is_supplier, payment_terms_days)
    values (${co.id}, 'T-SUP', 'Test Supplier', true, 30) returning id`;
  const [cus] = await sql`
    insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, 'T-CUS', 'Test Customer', true, 30) returning id`;

  const today = new Date().toISOString().slice(0, 10);
  console.log("");

  // ---- PURCHASE: 100,000 on credit, paid 40,000 then 60,000 ---------------

  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: sup.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }],
  });
  check("purchase invoice of 100,000 posted", Boolean(pi.docNo), pi.docNo);

  let st = await statusOf(pi.id);
  check("starts OPEN with nothing paid", st.payment_status === "OPEN" && n(st.paid) === 0);

  const pay1 = await postSupplierPayment({
    companyId: co.id, partnerId: sup.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: pi.id, amount: 40000 }],
  });
  check("part payment posted", Boolean(pay1.docNo), pay1.docNo);

  st = await statusOf(pi.id);
  check("becomes PARTIALLY_PAID", st.payment_status === "PARTIALLY_PAID", st.payment_status);
  check("outstanding is 60,000", n(st.outstanding) === 60000, `${n(st.outstanding)}`);

  const [invoiceRow] = await sql`select gross_total, status from document where id = ${pi.id}`;
  check("the invoice itself was not edited",
    n(invoiceRow.gross_total) === 100000 && invoiceRow.status === "POSTED");

  const payJournal = await sql`
    select account_code, debit, credit from v_journal_line where source_id = ${pay1.id}`;
  check("payment debits payables", payJournal.some((l) => n(l.debit) === 40000 && l.account_code === "2100"));
  check("payment credits the bank", payJournal.some((l) => n(l.credit) === 40000 && l.account_code === cash.code));

  const pay2 = await postSupplierPayment({
    companyId: co.id, partnerId: sup.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: pi.id, amount: 60000 }],
  });
  st = await statusOf(pi.id);
  check("second payment closes it as PAID", st.payment_status === "PAID", st.payment_status);
  check("nothing left outstanding", n(st.outstanding) === 0);
  check("it drops off the open list",
    (await sql`select 1 from v_open_item where document_id = ${pi.id}`).length === 0);

  // ---- Overpaying and cross-partner payment must be refused --------------

  let refusedOver = false;
  try {
    await postSupplierPayment({
      companyId: co.id, partnerId: sup.id, docDate: today,
      cashAccountId: cash.id, allocations: [{ invoiceId: pi.id, amount: 1 }],
    });
  } catch { refusedOver = true; }
  check("refuses to overpay a settled invoice", refusedOver);

  // ---- SALES: 250,000, customer pays 100,000 ----------------------------

  const si = await postSalesInvoice({
    companyId: co.id, partnerId: cus.id, locationId: loc.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 5000 }],
  });

  let refusedCross = false;
  try {
    await postCustomerReceipt({
      companyId: co.id, partnerId: sup.id, docDate: today,
      cashAccountId: cash.id, allocations: [{ invoiceId: si.id, amount: 100 }],
    });
  } catch { refusedCross = true; }
  check("refuses a payment against another partner's invoice", refusedCross);

  const rc = await postCustomerReceipt({
    companyId: co.id, partnerId: cus.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: si.id, amount: 100000 }],
  });
  const sst = await statusOf(si.id);
  check("receipt leaves 150,000 outstanding",
    sst.payment_status === "PARTIALLY_PAID" && n(sst.outstanding) === 150000,
    `${sst.payment_status} ${n(sst.outstanding)}`);

  const rcJournal = await sql`
    select account_code, debit, credit from v_journal_line where source_id = ${rc.id}`;
  check("receipt debits cash", rcJournal.some((l) => n(l.debit) === 100000 && l.account_code === cash.code));
  check("receipt credits receivables", rcJournal.some((l) => n(l.credit) === 100000 && l.account_code === "1200"));

  // ---- Balances and invariants -------------------------------------------

  const bal = await sql`
    select doc_type, outstanding from v_partner_balance where company_id = ${co.id}`;
  check("partner balance shows what is still owed",
    bal.some((b) => b.doc_type === "SALES_INVOICE" && n(b.outstanding) === 150000));

  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory reconciles",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from item where code like '88%'`;
  await sql`delete from item_group where code like '88%'`;
  await sql`delete from business_partner where code in ('T-SUP', 'T-CUS')`;

  console.log(bad === 0 ? "\n  settlement works\n" : `\n  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await sql.end();
}

process.exit(bad === 0 ? 0 : 1);
