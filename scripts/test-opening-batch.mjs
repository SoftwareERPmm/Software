// The cutover: what a business already had, entered once.
//
//   npx tsx scripts/test-opening-batch.mjs
//
// The properties that make an opening position correct rather than merely
// balanced. Every route that existed before this one balanced perfectly and
// was still wrong:
//
//   a stock adjustment credits Inventory Adjustment, which is cost of sales,
//   so opening stock made the first period's cost negative by its value;
//
//   a sales invoice credits revenue, so last year's unpaid sales became this
//   year's turnover;
//
//   a manual journal into Inventory moved no stock at all.
//
// So the tests are: both ledgers move together, nothing lands in revenue or
// cost of sales, the debts can actually be settled, and it cannot be done
// twice.

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

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const fmt = (v) => n(v).toLocaleString();

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry, opening_batch
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const one = async (q) => (await q)[0];
  const wh = await one(sql`select id from location where company_id = ${co.id}
     and is_stock_location and is_active order by code limit 1`);
  const uom = await one(sql`select id from uom where company_id = ${co.id} order by code limit 1`);
  let grp = await one(sql`select id from item_group where company_id = ${co.id} order by code limit 1`);
  if (!grp) grp = await one(sql`insert into item_group (company_id, segment, code, name)
     values (${co.id}, 'OB', 'x', 'Opening test') returning id`);
  let item = await one(sql`select id from item where company_id = ${co.id} and is_stocked limit 1`);
  if (!item) item = await one(sql`insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
     values (${co.id}, ${grp.id}, '901', 'Opening test item', ${uom.id}, true) returning id`);
  let cust = await one(sql`select id from business_partner where company_id = ${co.id} and is_customer limit 1`);
  if (!cust) cust = await one(sql`insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
     values (${co.id}, 'OB-C', 'Opening customer', true, 30) returning id`);
  let supp = await one(sql`select id from business_partner where company_id = ${co.id} and is_supplier limit 1`);
  if (!supp) supp = await one(sql`insert into business_partner (company_id, code, name, is_supplier)
     values (${co.id}, 'OB-S', 'Opening supplier', true) returning id`);
  const cash = await one(sql`select id from account where company_id = ${co.id}
     and is_cash_account and is_postable and is_active order by code limit 1`);

  // ---- the cutover --------------------------------------------------------

  console.log("  200 units at 600, one customer owing, one supplier owed, cash in the till\n");

  const batch = await P.postOpeningBatch({
    companyId: co.id, cutoverDate: "2026-09-01", memo: "test cutover",
    stock: [{ itemId: item.id, locationId: wh.id, qty: 200, unitCost: 600 }],
    receivables: [{ partnerId: cust.id, reference: "INV-8842", amount: 450000, dueDate: "2026-09-20" }],
    payables: [{ partnerId: supp.id, reference: "ABC-1177", amount: 300000, dueDate: "2026-09-15" }],
    accounts: [{ accountId: cash.id, amount: 1200000 }],
  });

  check("the batch posts", Boolean(batch.batchId), `${batch.documents.length} documents`);
  check("dated the day before trading starts", batch.docDate === "2026-08-31", batch.docDate);

  // ---- both ledgers, together ---------------------------------------------

  const stock = await one(sql`select coalesce(sum(qty_on_hand), 0) as qty,
      coalesce(sum(value_on_hand), 0) as value
    from v_stock_on_hand where company_id = ${co.id}`);
  const invAcct = await one(sql`select a.id from account a
      join account_determination d on d.account_id = a.id
     where d.company_id = ${co.id} and d.role = 'INVENTORY' limit 1`);
  const invGl = await one(sql`select coalesce(sum(base_amount), 0) as v from journal_line
     where company_id = ${co.id} and account_id = ${invAcct.id}`);

  check("stock quantity is on the shelf", n(stock.qty) === 200, `${n(stock.qty)} units`);
  check("and the general ledger agrees with it",
    Math.abs(n(stock.value) - n(invGl.v)) < 0.01,
    `stock ${fmt(stock.value)} vs ledger ${fmt(invGl.v)}`);
  check("  which is what no previous route managed",
    n(invGl.v) === 120000, fmt(invGl.v));

  const recon = await one(sql`select count(*)::int as n from v_check_inventory_reconciliation`);
  check("the reconciliation view is clean", recon.n === 0, String(recon.n));

  // ---- nothing that would double last year's trading ----------------------

  const wrong = await sql`
    select a.account_type, coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl
      join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.id = je.source_id
     where jl.company_id = ${co.id} and d.opening_batch_id is not null
       and a.account_type in ('REVENUE', 'COGS')
     group by a.account_type`;
  check("no revenue was recorded", !wrong.some((r) => r.account_type === "REVENUE"),
    wrong.map((r) => `${r.account_type} ${fmt(r.v)}`).join(" ") || "none");
  check("no cost of sales was recorded", !wrong.some((r) => r.account_type === "COGS"));

  const grir = await one(sql`select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl
      join system_account s on s.account_id = jl.account_id and s.role = 'GRIR_CLEARING'
     where jl.company_id = ${co.id}`);
  check("GR/IR was not touched", n(grir.v) === 0, fmt(grir.v));

  // ---- the debts are real open items --------------------------------------

  const open = await sql`
    select o.doc_type, o.outstanding, o.due_date, d.reference
      from v_open_item o join document d on d.id = o.document_id
     where o.company_id = ${co.id} order by o.doc_type`;
  check("the customer's debt is an open item", open.some((o) =>
    o.doc_type === "SALES_INVOICE" && n(o.outstanding) === 450000));
  check("  carrying their own invoice number", open.some((o) => o.reference === "INV-8842"));
  check("  and its due date", open.some((o) =>
    o.doc_type === "SALES_INVOICE" && String(o.due_date).startsWith("2026-09-20")
      || String(new Date(o.due_date).toISOString()).startsWith("2026-09-20")));
  check("the supplier's is too", open.some((o) =>
    o.doc_type === "PURCHASE_INVOICE" && n(o.outstanding) === 300000));

  // ---- and they behave like any other invoice -----------------------------

  const inv = open.find((o) => o.doc_type === "SALES_INVOICE");
  const invId = await one(sql`select document_id from v_open_item
     where company_id = ${co.id} and doc_type = 'SALES_INVOICE' limit 1`);
  await P.postCustomerReceipt({
    companyId: co.id, partnerId: cust.id, docDate: "2026-09-03",
    cashAccountId: cash.id, allocations: [{ invoiceId: invId.document_id, amount: 450000 }],
  });
  const settled = await one(sql`select coalesce(sum(outstanding), 0) as v from v_open_item
     where company_id = ${co.id} and document_id = ${invId.document_id}`);
  check("an ordinary receipt settles the opening receivable", n(settled.v) === 0,
    `${fmt(inv.outstanding)} -> ${fmt(settled.v)}`);

  // ---- a sale draws the cost the stock actually came in at ----------------

  const sale = await P.postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id,
    docDate: "2026-09-04", dueDate: null,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1500 }],
  });
  const cogs = await one(sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl
      join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.id = je.source_id
     where jl.company_id = ${co.id} and a.account_type = 'COGS'
       and d.doc_type = 'DELIVERY'`);
  check("selling out of opening stock draws its real cost",
    n(cogs.v) === 30000, `${fmt(cogs.v)} for 50 at 600`);

  // ---- once, and only once ------------------------------------------------

  let second = null;
  try {
    await P.postOpeningBatch({
      companyId: co.id, cutoverDate: "2026-09-01",
      accounts: [{ accountId: cash.id, amount: 1 }],
    });
  } catch (e) { second = e.message; }
  check("a second cutover is refused", second !== null,
    second ? second.slice(0, 64) : "POSTED — it should not have");

  // ---- and the books balance ---------------------------------------------

  const tb = await one(sql`select coalesce(sum(base_amount), 0) as v
     from journal_line where company_id = ${co.id}`);
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, fmt(tb.v));

  console.log(bad === 0
    ? "\n  the books open on what the business actually had\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
