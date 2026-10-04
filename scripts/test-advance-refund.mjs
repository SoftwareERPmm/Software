// Advances: unapplied, partly applied, fully applied, and given back.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 npx tsx scripts/test-advance-refund.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database.
//
// Money taken before an invoice exists sits in Customer Advances (or, paid to
// a supplier, Supplier Advances) until somebody chooses to apply it to a bill
// or to hand it back. Applying is deliberate, never automatic, and may take
// only part. Refunding draws on the same balance. The case that matters is
// the one in the middle: a customer pays 1,000 up front, is billed 3,000,
// 600 is applied and 400 refunded — and every figure has to agree about it.

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

await takeTestLock(sql, "test-advance-refund.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return String(e.message ?? e); }
};
const r2 = (v) => Math.round(Number(v ?? 0) * 100) / 100;

try {
  const [co] = await sql`select id from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;
  const [bank] = await sql`
    select id, code from account where company_id = ${co.id}
       and is_cash_account and is_postable and is_active order by code limit 1`;
  await resetTransactions(sql);

  const party = async (code, name, cols) => {
    const [f] = await sql`select id from business_partner where company_id=${co.id} and code=${code}`;
    if (f) return f;
    return (await sql`insert into business_partner ${sql({ company_id: co.id, code, name, ...cols })}
      returning id`)[0];
  };
  const cust = await party("ADR-C", "Advance Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("ADR-S", "Advance Supplier", { is_supplier: true });
  const [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  const DAY = (await sql`select to_char(current_date,'YYYY-MM-DD') as d`)[0].d;

  const bal = async (code) => r2((await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
     where a.code = ${code} and jl.company_id = ${co.id}`)[0].v);
  const available = async (paymentId) => r2((await sql`
    select available from v_partner_advance where payment_id = ${paymentId}`)[0]?.available ?? 0);
  const outstanding = async (invId) => r2((await sql`
    select outstanding from v_open_item where document_id = ${invId}`)[0]?.outstanding ?? 0);

  // ================================================================ customer
  console.log("\n  a customer pays 1,000 before there is any invoice\n");
  const cash0 = await bal(bank.code);
  const adv = await P.postCustomerReceipt({ companyId: co.id, partnerId: cust.id,
    docDate: DAY, cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 1000, memo: "deposit" });
  check("the money is in the bank", (await bal(bank.code)) === r2(cash0 + 1000),
    `${await bal(bank.code)}`);
  check("and owed back to them as an advance", (await bal("2060")) === -1000,
    `2060 ${await bal("2060")}`);
  check("unapplied: all 1,000 available", (await available(adv.id)) === 1000,
    `${await available(adv.id)}`);

  console.log("\n  billed 3,000, and 600 of the advance applied to it\n");
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 100, unitCost: 100 }] });
  const inv = await P.postSaleWithDelivery({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: DAY, dueDate: DAY, paymentType: "CREDIT",
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });
  check("nothing is applied automatically", (await outstanding(inv.id)) === 3000,
    `${await outstanding(inv.id)}`);

  await P.applyAdvance({ companyId: co.id, invoiceId: inv.id, docDate: DAY,
    allocations: [{ paymentId: adv.id, amount: 600 }] });
  check("the invoice now owes 2,400", (await outstanding(inv.id)) === 2400,
    `${await outstanding(inv.id)}`);
  const [orig] = await sql`select gross_total from document where id = ${inv.id}`;
  check("  without its own value changing", r2(orig.gross_total) === 3000,
    `${r2(orig.gross_total)}`);
  check("partly applied: 400 still available", (await available(adv.id)) === 400,
    `${await available(adv.id)}`);
  check("the advance account carries only what is left", (await bal("2060")) === -400,
    `2060 ${await bal("2060")}`);

  console.log("\n  the other 400 handed back\n");
  const over = await refused(() => P.refundAdvance({ companyId: co.id, paymentId: adv.id,
    amount: 500, cashAccountId: bank.id, docDate: DAY }));
  check("more than is left cannot go back", over !== null, String(over).slice(0, 70));

  const cash1 = await bal(bank.code);
  const ref = await P.refundAdvance({ companyId: co.id, paymentId: adv.id,
    amount: 400, cashAccountId: bank.id, docDate: DAY, memo: "order cancelled" });
  check("the refund posts", !!ref.id, ref.docNo);
  check("  numbered as a refund, not as an application",
    String(ref.docNo).startsWith("RF"), ref.docNo);
  check("the money leaves the bank", (await bal(bank.code)) === r2(cash1 - 400),
    `${await bal(bank.code)}`);
  check("and nothing is owed back any more", (await bal("2060")) === 0,
    `2060 ${await bal("2060")}`);
  check("the advance is spent", (await available(adv.id)) === 0, `${await available(adv.id)}`);
  check("the invoice is untouched by it", (await outstanding(inv.id)) === 2400,
    `${await outstanding(inv.id)}`);

  const late = await refused(() => P.applyAdvance({ companyId: co.id, invoiceId: inv.id,
    docDate: DAY, allocations: [{ paymentId: adv.id, amount: 100 }] }));
  check("money handed back cannot then be applied", late !== null, String(late).slice(0, 70));

  console.log("\n  the refund voided\n");
  await P.voidDocument({ documentId: ref.id, reason: "refund not made" });
  check("the 400 is back on account", (await available(adv.id)) === 400,
    `${await available(adv.id)}`);
  check("and back in the bank", (await bal(bank.code)) === cash1, `${await bal(bank.code)}`);
  check("and owed back again", (await bal("2060")) === -400, `2060 ${await bal("2060")}`);

  console.log("\n  an advance given back in full\n");
  const adv2 = await P.postCustomerReceipt({ companyId: co.id, partnerId: cust.id,
    docDate: DAY, cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 250 });
  await P.refundAdvance({ companyId: co.id, paymentId: adv2.id, amount: 250,
    cashAccountId: bank.id, docDate: DAY });
  check("refunded: nothing left", (await available(adv2.id)) === 0,
    `${await available(adv2.id)}`);
  const again = await refused(() => P.refundAdvance({ companyId: co.id, paymentId: adv2.id,
    amount: 1, cashAccountId: bank.id, docDate: DAY }));
  check("and it cannot be refunded twice", again !== null, String(again).slice(0, 70));

  console.log("\n  an advance applied in full\n");
  const adv3 = await P.postCustomerReceipt({ companyId: co.id, partnerId: cust.id,
    docDate: DAY, cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 2400 });
  await P.applyAdvance({ companyId: co.id, invoiceId: inv.id, docDate: DAY,
    allocations: [{ paymentId: adv3.id, amount: 2400 }] });
  check("fully applied: the invoice is settled", (await outstanding(inv.id)) === 0,
    `${await outstanding(inv.id)}`);
  const applied = await refused(() => P.refundAdvance({ companyId: co.id, paymentId: adv3.id,
    amount: 1, cashAccountId: bank.id, docDate: DAY }));
  check("money that settled an invoice cannot also be refunded", applied !== null,
    String(applied).slice(0, 70));

  // ================================================================ supplier
  console.log("\n  we pay a supplier 500 up front\n");
  const sCash = await bal(bank.code);
  const sAdv = await P.postSupplierPayment({ companyId: co.id, partnerId: supp.id,
    docDate: DAY, cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 500, memo: "deposit on order" });
  check("the money leaves the bank", (await bal(bank.code)) === r2(sCash - 500),
    `${await bal(bank.code)}`);
  check("and is owed to us as a supplier advance", (await bal("1070")) === 500,
    `1070 ${await bal("1070")}`);

  console.log("\n  billed 2,000, 300 applied\n");
  const gr = await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY, lines: [{ itemId: item.id, qty: 20, unitCost: 100 }] });
  const [grLine] = await sql`select id from document_line where document_id = ${gr.id} limit 1`;
  const bill = await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY, dueDate: DAY, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: grLine.id }] });
  await P.applyAdvance({ companyId: co.id, invoiceId: bill.id, docDate: DAY,
    allocations: [{ paymentId: sAdv.id, amount: 300 }] });
  check("the bill now owes 1,700", (await outstanding(bill.id)) === 1700,
    `${await outstanding(bill.id)}`);
  check("200 of the deposit is left", (await available(sAdv.id)) === 200,
    `${await available(sAdv.id)}`);

  console.log("\n  the supplier returns the rest\n");
  const sOver = await refused(() => P.refundAdvance({ companyId: co.id, paymentId: sAdv.id,
    amount: 250, cashAccountId: bank.id, docDate: DAY }));
  check("more than is left cannot come back", sOver !== null, String(sOver).slice(0, 70));
  const sCash1 = await bal(bank.code);
  await P.refundAdvance({ companyId: co.id, paymentId: sAdv.id, amount: 200,
    cashAccountId: bank.id, docDate: DAY, memo: "supplier returned the balance" });
  check("the money comes back into the bank", (await bal(bank.code)) === r2(sCash1 + 200),
    `${await bal(bank.code)}`);
  check("and the supplier owes us nothing", (await bal("1070")) === 0,
    `1070 ${await bal("1070")}`);
  check("the bill is untouched by it", (await outstanding(bill.id)) === 1700,
    `${await outstanding(bill.id)}`);

  // ================================================================== ledger
  console.log("\n  and the books still balance\n");
  const [tb] = await sql`select coalesce(sum(base_amount),0) v from journal_line
     where company_id = ${co.id}`;
  check("trial balance nets to zero", r2(tb.v) === 0, `${r2(tb.v)}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
