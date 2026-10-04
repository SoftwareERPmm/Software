// Consigned goods: the sale earns a commission, not a sale.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 npx tsx scripts/test-consignment-recognition.mjs
//
// Consigned stock is never the company's, so a delivery of it moves nothing
// in the ledger and there is no cost of sales when it sells. What the
// customer paid splits instead (migration 0120):
//
//     Dr Cash / Receivable        the price
//     Cr Commission Revenue       what the company keeps
//     Cr Payable to Consignors    what the consignor is owed
//
// — on the document that completes the sale: the invoice, or, where the
// invoice came first, the delivery. These cases take each fulfilment mode in
// turn, then partial billing, discounts, a void, and a payment that clears
// an ordinary bill in 2000 and a settlement in 2080 at once.

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

const P = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled,
  onnotice: () => {}, max: 1, connect_timeout: 30 });

await takeTestLock(sql, "test-consignment-recognition.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const r2 = (v) => Math.round(Number(v ?? 0) * 100) / 100;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;
  await resetTransactions(sql);
  await sql`delete from consignment_agreement_line`;
  await sql`delete from consignment_agreement`;

  const [grp] = await sql`select id from item_group where company_id = ${co.id} limit 1`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const stamp = Date.now().toString().slice(-6);
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code, is_stocked)
    values (${co.id}, ${grp.id}, ${"cr" + stamp}, 'Consigned probe', ${uom.id}, ${"cr" + stamp}, true)
    returning id`;
  const party = async (code, name, flag) => (await sql`
    insert into business_partner (company_id, code, name, ${sql(flag)}, payment_terms_days)
    values (${co.id}, ${code + stamp}, ${name}, true, 30) returning id`)[0];
  const consignor = await party("CRN", "Consignor", "is_supplier");
  const cust = await party("CRC", "Consignment buyer", "is_customer");

  const DAY = (await sql`select to_char(current_date,'YYYY-MM-DD') as d`)[0].d;
  const base = { companyId: co.id, locationId: loc.id };

  // The consignor is owed 80% of whatever each unit sells for.
  const [ag] = await sql`insert into consignment_agreement (company_id, partner_id)
    values (${co.id}, ${consignor.id}) returning id`;
  const [agLine] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${ag.id}, ${item.id}, 'PERCENTAGE', 80) returning id`;
  await P.postConsignmentReceipt({ ...base, partnerId: consignor.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: 200, agreementLineId: agLine.id }] });

  const bal = async (code) => r2((await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
     where a.code = ${code} and jl.company_id = ${co.id}`)[0].v);
  const owedTo = async () => r2((await sql`
    select coalesce(sum(o.outstanding), 0) as v from v_open_item o
      join document d on d.id = o.document_id
     where d.partner_id = ${consignor.id} and o.doc_type = 'PURCHASE_INVOICE'`)[0].v);
  const snap = async () => ({
    sales: await bal("4000"), cogs: await bal("5000"), held: await bal("1090"),
    def: await bal("2070"), inv: await bal("1040"), owed: await owedTo(),
    comm: await bal("4040"), c2080: await bal("2080"), ap: await bal("2000"),
    disc: await bal("4020"),
  });
  // Movement on each account, signed so that "earned" and "owed" read positive.
  const delta = (a, b) => ({
    sales: r2(a.sales - b.sales), comm: r2(a.comm - b.comm), cogs: r2(b.cogs - a.cogs),
    owed: r2(b.owed - a.owed), c2080: r2(a.c2080 - b.c2080), ap: r2(a.ap - b.ap),
    def: r2(a.def - b.def), held: r2(b.held - a.held), inv: r2(b.inv - a.inv),
    disc: r2(b.disc - a.disc),
  });
  const agentChecks = (d, price, kept) => {
    check(`no product revenue stays in Sales`, d.sales === 0, `4000 moved ${d.sales}`);
    check(`commission earned: ${kept}`, d.comm === kept, `${d.comm}`);
    check(`no cost of sales`, d.cogs === 0, `${d.cogs}`);
    check(`consignor owed ${price - kept}, in 2080`, d.c2080 === price - kept, `${d.c2080}`);
    check(`  and in the payables subledger`, d.owed === price - kept, `${d.owed}`);
    check(`  and none of it in Accounts Payable`, d.ap === 0, `2000 moved ${d.ap}`);
    check(`none of our inventory moved`, d.inv === 0, `${d.inv}`);
  };

  // ------------------------------------------------------- customer takes now
  console.log("\n  consigned goods sold over the counter\n");
  let s0 = await snap();
  await P.postSaleWithDelivery({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, source: "CONSIGNMENT" }] });
  let s1 = await snap();
  agentChecks(delta(s0, s1), 10000, 2000);
  check("and nothing waits in either holding account",
    s1.held === s0.held && s1.def === s0.def, `1090 ${s1.held} / 2070 ${s1.def}`);

  // --------------------------------------------- delivered first, billed after
  console.log("\n  consigned goods delivered, then billed\n");
  s0 = await snap();
  const dlv = await P.postDelivery({ ...base, partnerId: cust.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 1000, source: "CONSIGNMENT" }] });
  s1 = await snap();
  check("the delivery alone recognises nothing",
    s1.sales === s0.sales && s1.comm === s0.comm && s1.owed === s0.owed,
    `sales ${s1.sales} comm ${s1.comm} owed ${s1.owed}`);
  check("  and parks nothing in 1090, because the goods are not ours",
    s1.held === s0.held, `${s1.held}`);
  await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId: dlv.id,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 1000 }] });
  agentChecks(delta(s0, await snap()), 5000, 1000);

  // -------------------------------------------------- billed first, sent later
  console.log("\n  consigned goods invoiced first, delivered later\n");
  s0 = await snap();
  const pending = await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: DAY,
    dueDate: DAY, paymentType: "CREDIT", toDeliver: true,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 1000 }] });
  s1 = await snap();
  check("the invoice alone earns nothing — nothing has gone",
    s1.sales === s0.sales && s1.comm === s0.comm, `4000 ${s1.sales} 4040 ${s1.comm}`);
  check("  it waits in deferred revenue", r2(s0.def - s1.def) === 4000, `${r2(s0.def - s1.def)}`);
  check("  and nobody is owed yet", s1.owed === s0.owed, `owed ${s1.owed}`);

  await P.postDelivery({ ...base, partnerId: cust.id, docDate: DAY,
    sourceDocumentId: pending.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 1000, source: "CONSIGNMENT" }] });
  s1 = await snap();
  agentChecks(delta(s0, s1), 4000, 800);
  check("  clearing the deferral", s1.def === s0.def, `2070 ${s1.def}`);

  // ------------------------------------------------------- owned and consigned
  console.log("\n  one sale mixing owned and consigned goods, invoiced first\n");
  const [own] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code, is_stocked)
    values (${co.id}, ${grp.id}, ${"co" + stamp}, 'Owned probe', ${uom.id}, ${"co" + stamp}, true)
    returning id`;
  const supp = await party("CRS", "Owned supplier", "is_supplier");
  await P.postGoodsReceipt({ ...base, partnerId: supp.id, docDate: DAY,
    lines: [{ itemId: own.id, qty: 50, unitCost: 300 }] });
  s0 = await snap();
  const mixed = await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: DAY,
    dueDate: DAY, paymentType: "CREDIT", toDeliver: true,
    lines: [{ itemId: own.id, qty: 2, unitPrice: 700 },
            { itemId: item.id, qty: 3, unitPrice: 1000 }] });
  await P.postDelivery({ ...base, partnerId: cust.id, docDate: DAY,
    sourceDocumentId: mixed.id,
    lines: [{ itemId: own.id, qty: 2, unitPrice: 700 },
            { itemId: item.id, qty: 3, unitPrice: 1000, source: "CONSIGNMENT" }] });
  s1 = await snap();
  let d = delta(s0, s1);
  check("only the owned half is product revenue", d.sales === 1400, `${d.sales}`);
  check("the consigned half is commission", d.comm === 600, `${d.comm}`);
  check("the deferral clears entirely", s1.def === s0.def, `2070 ${s1.def}`);
  check("cost of sales is only the owned FIFO cost", d.cogs === 600, `${d.cogs}`);
  check("the consignor is owed 80% of their half", d.c2080 === 2400, `${d.c2080}`);
  check("only the owned goods left our inventory", d.inv === 600, `${d.inv}`);
  check("and nothing is stranded in 1090", s1.held === s0.held, `${s1.held}`);

  // ------------------------------------------- one delivery, billed in two
  console.log("\n  ten consigned units delivered, billed four then six\n");
  s0 = await snap();
  const big = await P.postDelivery({ ...base, partnerId: cust.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, source: "CONSIGNMENT" }] });
  await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId: big.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 1000 }] });
  s1 = await snap();
  d = delta(s0, s1);
  check("the first bill settles only its four", d.c2080 === 3200 && d.comm === 800,
    `2080 ${d.c2080} 4040 ${d.comm}`);
  check("  and Sales is left with none of it", d.sales === 0, `${d.sales}`);
  await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId: big.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 1200 }] });
  d = delta(s0, await snap());
  check("the second settles the other six, at its own price",
    d.c2080 === 3200 + 5760 && d.comm === 800 + 1440, `2080 ${d.c2080} 4040 ${d.comm}`);
  check("  Sales still untouched", d.sales === 0, `${d.sales}`);
  const [left] = await sql`select coalesce(sum(qty),0)::float q from v_consignment_unsettled
    where delivery_document_id = ${big.id}`;
  check("  and nothing on the delivery is left unsettled", r2(left.q) === 0, `${left.q}`);

  // ------------------------------------------------------------- a discount
  console.log("\n  consigned goods sold at 10% off\n");
  s0 = await snap();
  await P.postSaleWithDelivery({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT",
    lines: [{ itemId: item.id, qty: 5, unitPrice: 1000, discountPct: 10, source: "CONSIGNMENT" }] });
  d = delta(s0, await snap());
  check("the discount stays in Sales Discount", d.disc === 500, `${d.disc}`);
  check("  and Sales is cleared at the full price", d.sales === 0, `${d.sales}`);
  check("the consignor shares in what was paid: 80% of 4,500", d.c2080 === 3600, `${d.c2080}`);
  check("commission is the price less the share", d.comm === 1400, `${d.comm}`);
  check("so what we kept is 900 — the 4,500 paid less 3,600",
    r2(d.comm - d.disc) === 900, `${r2(d.comm - d.disc)}`);

  // -------------------------------------------------- a fixed price, at a loss
  console.log("\n  a fixed consignor price above what the goods sold for\n");
  const [fixed] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code, is_stocked)
    values (${co.id}, ${grp.id}, ${"cf" + stamp}, 'Fixed probe', ${uom.id}, ${"cf" + stamp}, true)
    returning id`;
  const [fxLine] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${ag.id}, ${fixed.id}, 'FIXED', 900) returning id`;
  await P.postConsignmentReceipt({ ...base, partnerId: consignor.id, docDate: DAY,
    lines: [{ itemId: fixed.id, qty: 10, agreementLineId: fxLine.id }] });
  s0 = await snap();
  await P.postSaleWithDelivery({ ...base, partnerId: cust.id, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", lines: [{ itemId: fixed.id, qty: 2, unitPrice: 800, source: "CONSIGNMENT" }] });
  d = delta(s0, await snap());
  check("the consignor is owed their fixed 1,800", d.c2080 === 1800, `${d.c2080}`);
  check("commission goes negative by the 200 lost", d.comm === -200, `${d.comm}`);

  // ------------------------------------------------------- void and resettle
  console.log("\n  a settlement voided and raised again\n");
  const [lastSettle] = await sql`
    select id, source_document_id from document
     where partner_id = ${consignor.id} and doc_type = 'PURCHASE_INVOICE'
       and status = 'POSTED' and reverses_document_id is null
     order by created_at desc limit 1`;
  s0 = await snap();
  await P.voidDocument({ documentId: lastSettle.id, reason: "test" });
  d = delta(s0, await snap());
  check("voiding puts the price back in Sales", d.sales === 1600 && d.comm === 200 && d.c2080 === -1800,
    `4000 ${d.sales} 4040 ${d.comm} 2080 ${d.c2080}`);
  const again = await P.resettleConsignmentSale({ companyId: co.id,
    salesInvoiceId: lastSettle.source_document_id, docDate: DAY });
  d = delta(s0, await snap());
  check("re-settling restores it exactly", again.length === 1 && d.sales === 0 && d.comm === 0 && d.c2080 === 0,
    `raised ${again.length}, 4000 ${d.sales} 4040 ${d.comm} 2080 ${d.c2080}`);

  // ---------------------------------------- one payment, two kinds of bill
  console.log("\n  the consignor also sells to us outright; one payment clears both\n");
  const gr = await P.postGoodsReceipt({ ...base, partnerId: consignor.id, docDate: DAY,
    lines: [{ itemId: own.id, qty: 10, unitCost: 300 }] });
  const [grLine] = await sql`select id from document_line where document_id = ${gr.id} limit 1`;
  const bill = await P.postPurchaseInvoice({ ...base, partnerId: consignor.id, docDate: DAY,
    dueDate: DAY, goodsReceiptId: gr.id,
    lines: [{ itemId: own.id, qty: 10, unitPrice: 300, sourceLineId: grLine.id }] });
  const [settle] = await sql`
    select id, gross_total::float g from document
     where partner_id = ${consignor.id} and doc_type = 'PURCHASE_INVOICE'
       and status = 'POSTED' and reverses_document_id is null and id <> ${bill.id}
     order by created_at limit 1`;
  const [bank] = await sql`select id from account
     where company_id = ${co.id} and is_bank_account and is_active order by code limit 1`;
  s0 = await snap();
  await P.postSupplierPayment({ companyId: co.id, partnerId: consignor.id, docDate: DAY,
    cashAccountId: bank.id,
    allocations: [{ invoiceId: bill.id, amount: 3000 }, { invoiceId: settle.id, amount: settle.g }] });
  s1 = await snap();
  check("the ordinary bill comes off Accounts Payable", r2(s1.ap - s0.ap) === 3000, `${r2(s1.ap - s0.ap)}`);
  check("the settlement comes off Payable to Consignors", r2(s1.c2080 - s0.c2080) === settle.g,
    `${r2(s1.c2080 - s0.c2080)} of ${settle.g}`);

  console.log("\n  a supplier advance applied to a settlement\n");
  const [settle2] = await sql`
    select d.id, o.outstanding::float g from document d join v_open_item o on o.document_id = d.id
     where d.partner_id = ${consignor.id} and d.doc_type = 'PURCHASE_INVOICE' and o.outstanding > 0
     order by d.created_at limit 1`;
  const adv = await P.postSupplierPayment({ companyId: co.id, partnerId: consignor.id,
    docDate: DAY, cashAccountId: bank.id, locationId: loc.id, allocations: [], advance: 500 });
  s0 = await snap();
  await P.applyAdvance({ companyId: co.id, invoiceId: settle2.id, docDate: DAY,
    allocations: [{ paymentId: adv.id, amount: 500 }] });
  s1 = await snap();
  check("it clears 2080, not 2000", r2(s1.c2080 - s0.c2080) === 500 && s1.ap === s0.ap,
    `2080 ${r2(s1.c2080 - s0.c2080)} 2000 ${r2(s1.ap - s0.ap)}`);

  const [rec] = await sql`select side, gl_balance::float g, sub_balance::float s
    from v_check_control_reconciliation where company_id = ${co.id} and side = 'AP'`;
  check("\n  payables ledger and subledger agree", rec && r2(rec.g) === r2(rec.s),
    rec ? `GL ${rec.g} / sub ${rec.s}` : "no row");

  const [tb] = await sql`select coalesce(sum(base_amount),0) v from journal_line where company_id = ${co.id}`;
  check("\n  trial balance nets to zero", r2(tb.v) === 0, `${r2(tb.v)}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
