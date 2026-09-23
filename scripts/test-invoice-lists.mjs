// The Sales/Purchase Invoices lists and the Receivables/Payables rollups:
// every payment status, the KPI totals, and the per-partner aggregation.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
import { resetTransactions } from "./test-reset.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { postSaleWithDelivery, postCustomerReceipt } = await import("../lib/posting.ts");
const { invoiceDisplayStatus } = await import("../lib/format.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });


// One suite at a time: these share a database and empty it, so a second
// runner is refused rather than left to collide. See scripts/test-lock.mjs.
await takeTestLock(sql, "test-invoice-lists.mjs");
let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };
const n = (v) => Number(v ?? 0);

try {
  const [co] = await sql`select id from company limit 1`;

  await resetTransactions(sql);
  await sql`delete from business_partner where code in ('IL-A', 'IL-B')`;
  await sql`delete from item where code like 'IL%'`;
  await sql`delete from item_group where code like 'IL%'`;

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'IL', 'x', 'Invoice List Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'Test Item', ${uom.id}) returning id`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;
  const [cash] = await sql`select id from account where company_id = ${co.id} and code = '1110'`;

  const [custA] = await sql`
    insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, 'IL-A', 'Overdue Customer', true, 0) returning id`;
  const [custB] = await sql`
    insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, 'IL-B', 'Current Customer', true, 30) returning id`;

  // Bring in enough stock for three sales.
  await sql`
    insert into stock_lot (company_id, item_id, location_id, received_date, unit_cost, qty_received)
    values (${co.id}, ${item.id}, ${loc.id}, '2026-01-01', 1000, 1000)`;
  await sql`
    insert into stock_movement (company_id, item_id, location_id, movement_date, occurred_at, qty, unit_cost, total_cost)
    values (${co.id}, ${item.id}, ${loc.id}, '2026-01-01', '2026-01-01T00:00:00Z', 1000, 1000, 1000000)`;

  // Overdue: due yesterday, nothing paid.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const overdue = await postSaleWithDelivery({
    companyId: co.id, partnerId: custA.id, locationId: loc.id,
    docDate: yesterday, dueDate: yesterday,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }],
  });

  // Partially paid: due in a week (due soon), half paid.
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const partial = await postSaleWithDelivery({
    companyId: co.id, partnerId: custB.id, locationId: loc.id,
    docDate: today, dueDate: soon,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }],
  });
  await postCustomerReceipt({
    companyId: co.id, partnerId: custB.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: partial.id, amount: 10000 }],
  });

  // Fully paid: due next month, paid in full.
  const later = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const paid = await postSaleWithDelivery({
    companyId: co.id, partnerId: custB.id, locationId: loc.id,
    docDate: today, dueDate: later,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 2000 }],
  });
  await postCustomerReceipt({
    companyId: co.id, partnerId: custB.id, docDate: today,
    cashAccountId: cash.id, allocations: [{ invoiceId: paid.id, amount: 10000 }],
  });

  console.log(`\n  ${overdue.docNo} overdue, ${partial.docNo} partial, ${paid.docNo} paid\n`);

  // ---- getInvoiceList: every status is correctly derived ------------------

  const list = await sql`
    select document_id, doc_no, gross_total, paid, outstanding, 'POSTED' as doc_status,
           payment_status, days_overdue
      from v_invoice_status
     where company_id = ${co.id} and doc_type = 'SALES_INVOICE'
     order by doc_no`;

  const statusOf = (row) => invoiceDisplayStatus({
    docStatus: row.doc_status, paymentStatus: row.payment_status,
    outstanding: row.outstanding, daysOverdue: row.days_overdue,
  });

  const overdueRow = list.find((r) => r.document_id === overdue.id);
  const partialRow = list.find((r) => r.document_id === partial.id);
  const paidRow = list.find((r) => r.document_id === paid.id);

  check("overdue invoice reads OVERDUE", statusOf(overdueRow) === "OVERDUE", statusOf(overdueRow));
  check("partially paid invoice reads PARTIALLY_PAID", statusOf(partialRow) === "PARTIALLY_PAID", statusOf(partialRow));
  check("fully paid invoice reads PAID", statusOf(paidRow) === "PAID", statusOf(paidRow));

  check("overdue outstanding is the full 20,000", n(overdueRow.outstanding) === 20000);
  check("partial outstanding is 10,000 after a 10,000 payment", n(partialRow.outstanding) === 10000);
  check("paid outstanding is zero", n(paidRow.outstanding) === 0);

  // ---- v_partner_balance: rollup by customer --------------------------

  const balances = await sql`
    select partner_id, partner_code, open_invoices, invoiced, paid, outstanding, overdue, due_soon, credit_limit
      from v_partner_balance
     where company_id = ${co.id} and doc_type = 'SALES_INVOICE'
     order by partner_code`;

  const balA = balances.find((r) => r.partner_code === "IL-A");
  const balB = balances.find((r) => r.partner_code === "IL-B");

  check("Customer A rolls up to one open invoice", balA?.open_invoices === 1, `${balA?.open_invoices}`);
  check("Customer A's whole balance is overdue", n(balA?.outstanding) === 20000 && n(balA?.overdue) === 20000);

  check("Customer B rolls up two open invoices (paid one drops off)",
    balB?.open_invoices === 1, `${balB?.open_invoices}  (only the partial one still has a balance)`);
  check("Customer B's outstanding is just the partial invoice's 10,000",
    n(balB?.outstanding) === 10000, `${n(balB?.outstanding)}`);
  check("Customer B's due-soon bucket catches the invoice due in 3 days",
    n(balB?.due_soon) === 10000, `${n(balB?.due_soon)}`);
  check("Customer B has nothing overdue", n(balB?.overdue) === 0);

  // ---- KPI totals a list page would compute ------------------------------

  const totalInvoiced = list.reduce((s, r) => s + n(r.gross_total), 0);
  const totalOutstanding = list.reduce((s, r) => s + n(r.outstanding), 0);
  const totalOverdue = list.filter((r) => statusOf(r) === "OVERDUE").reduce((s, r) => s + n(r.outstanding), 0);
  const totalPaid = list.reduce((s, r) => s + n(r.paid), 0);

  // 20,000 (overdue) + 20,000 (partial) + 10,000 (paid) = 50,000.
  check("Total Invoiced = 50,000 across all three", totalInvoiced === 50000, `${totalInvoiced}`);
  check("Outstanding = 30,000 (20,000 + 10,000)", totalOutstanding === 30000, `${totalOutstanding}`);
  check("Overdue = 20,000", totalOverdue === 20000, `${totalOverdue}`);
  // 0 (overdue) + 10,000 (partial) + 10,000 (paid) = 20,000.
  check("Paid = 20,000", totalPaid === 20000, `${totalPaid}`);
  check("Invoiced = Outstanding + Paid, always", totalInvoiced === totalOutstanding + totalPaid);

  await resetTransactions(sql);
  await sql`delete from business_partner where code in ('IL-A', 'IL-B')`;
  await sql`delete from item where code like 'IL%'`;
  await sql`delete from item_group where code like 'IL%'`;

  console.log(bad === 0 ? "\n  invoice lists and partner rollups are correct\n" : `\n  ${bad} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  bad++;
} finally {
  await releaseTestLock(sql);
  await sql.end({ timeout: 5 });
}

process.exit(bad === 0 ? 0 : 1);
