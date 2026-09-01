// Delivery fees: income for carrying the goods, not part of what they sold for.
//
//   npx tsx scripts/test-delivery-fee.mjs
//
// The fee is entered on the delivery and posted on the sales invoice that
// bills it. That split is the point of most of these checks: revenue in this
// system is recognised when the customer is billed, so a fee posted at the
// delivery would be the one place income appeared with no invoice behind it
// and no receivable to age.
//
// The other point is which account it reaches. Sending carriage to Sales
// inflates revenue and flatters gross margin on the products themselves,
// which is the figure the business is actually judged on.
//
// Writes documents. Run against a scratch database.

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

const { postSaleWithDelivery, postPurchaseWithReceipt, postDelivery, postSalesInvoice } =
  await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, {
  ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1,
});

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;

  const stamp = Date.now().toString().slice(-5);
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, ${stamp}, 'Delivery Fee Test Item', ${uom.id}, true) returning id`;
  const [cust] = await sql`insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, ${'DF-C' + stamp}, 'Delivery Fee Customer', true, 30) returning id`;
  const [supp] = await sql`insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${'DF-S' + stamp}, 'Delivery Fee Supplier', true) returning id`;

  const today = new Date().toISOString().slice(0, 10);

  const [feeAcct] = await sql`
    select a.id, a.code, a.name from system_account s
      join account a on a.id = s.account_id
     where s.company_id = ${co.id} and s.role = 'DELIVERY_INCOME'`;
  check("an account is set for delivery income",
    Boolean(feeAcct), feeAcct ? `${feeAcct.code} ${feeAcct.name}` : "none");
  if (!feeAcct) throw new Error("DELIVERY_INCOME is not pointed at an account");

  await postPurchaseWithReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 200, unitPrice: 1000 }],
  });

  // ---- a sale carrying a fee ----------------------------------------------

  const sale = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today, dueDate: null,
    deliveryFee: 5000,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2000 }],
  });

  const jl = await sql`
    select a.code, a.name, a.account_type, jl.base_amount
      from document d
      join journal_entry je on je.id = d.journal_entry_id
      join journal_line jl on jl.journal_entry_id = je.id
      join account a on a.id = jl.account_id
     where d.id = ${sale.id}`;

  const amountOn = (accountId) =>
    n(jl.find((l) => l.code === accountId)?.base_amount);

  const revenue = jl.filter((l) => l.account_type === 'REVENUE');
  const feeLine = jl.find((l) => l.code === feeAcct.code);
  const salesLine = revenue.find((l) => l.code !== feeAcct.code);

  check("the fee is credited to the delivery income account",
    Boolean(feeLine) && n(feeLine.base_amount) === -5000,
    feeLine ? String(n(feeLine.base_amount)) : "no line");

  check("the goods are credited to sales at their own price, fee excluded",
    Boolean(salesLine) && n(salesLine.base_amount) === -20000,
    salesLine ? String(n(salesLine.base_amount)) : "no line");

  const arTotal = jl.filter((l) => l.account_type === 'ASSET').reduce((s, l) => s + n(l.base_amount), 0);
  check("the customer owes the goods plus the carriage as one sum",
    arTotal === 25000, String(arTotal));

  const [inv] = await sql`select net_total, delivery_fee from document where id = ${sale.id}`;
  check("the invoice records the fee it billed", n(inv.delivery_fee) === 5000, String(n(inv.delivery_fee)));
  check("and its total is goods plus fee", n(inv.net_total) === 25000, String(n(inv.net_total)));

  // ---- the delivery records it but never posts it -------------------------

  const [deliv] = await sql`
    select id, delivery_fee, journal_entry_id from document
     where source_document_id is null and doc_type = 'DELIVERY'
       and company_id = ${co.id}
     order by created_at desc limit 1`;
  check("the delivery carries the fee as a fact about itself",
    n(deliv.delivery_fee) === 5000, String(n(deliv.delivery_fee)));

  const delivIncome = await sql`
    select count(*)::int as c
      from journal_line jl
      join account a on a.id = jl.account_id
     where jl.journal_entry_id = ${deliv.journal_entry_id} and a.account_type = 'REVENUE'`;
  check("but the delivery posts no income of its own", delivIncome[0].c === 0);

  // ---- a fee entered at delivery time is billed by the invoice ------------

  const d2 = await postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
    deliveryFee: 3000,
    lines: [{ itemId: item.id, qty: 5 }],
  });
  const i2 = await postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today, dueDate: null,
    deliveryId: d2.id,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 2000 }],
  });
  const [i2doc] = await sql`select delivery_fee, net_total from document where id = ${i2.id}`;
  check("an invoice inherits the fee from the delivery it bills",
    n(i2doc.delivery_fee) === 3000, String(n(i2doc.delivery_fee)));
  check("so the charge entered when the goods went out is not lost",
    n(i2doc.net_total) === 13000, String(n(i2doc.net_total)));

  // ---- guards -------------------------------------------------------------

  check("a negative fee is refused",
    (await refused(() => postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today, dueDate: null,
      deliveryFee: -100,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 2000 }],
    }))) !== null);

  // Free goods plus a real carriage charge is a real invoice, not nothing.
  const [focReason] = await sql`select id from foc_reason where company_id = ${co.id} limit 1`;
  if (focReason) {
    const free = await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today, dueDate: null,
      deliveryFee: 2000,
      lines: [{ itemId: item.id, qty: 2, unitPrice: 2000, focReasonId: focReason.id }],
    });
    const [freeDoc] = await sql`select net_total from document where id = ${free.id}`;
    check("goods given away with carriage charged still invoices the carriage",
      n(freeDoc.net_total) === 2000, String(n(freeDoc.net_total)));
  }

  // ---- invariants ---------------------------------------------------------

  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) as total from journal_line where company_id = ${co.id}`;
  check("trial balance still nets to zero", Math.abs(n(tb.total)) < 0.0001, String(n(tb.total)));

  const unbalanced = await sql`
    select je.entry_no from journal_entry je
      join journal_line jl on jl.journal_entry_id = je.id
     where je.company_id = ${co.id}
     group by je.id, je.entry_no having abs(sum(jl.base_amount)) > 0.0001`;
  check("no unbalanced entries", unbalanced.length === 0);

  console.log(`\n  ${failures === 0 ? "all delivery fee tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
