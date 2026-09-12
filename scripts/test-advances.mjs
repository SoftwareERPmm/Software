// Money that arrives before there is anything to apply it to.
//
//   npx tsx scripts/test-advances.mjs
//
// A customer pays a deposit; a supplier wants paying up front. The money is
// real and has to be in the books, but there is no invoice to put it against
// — and it must not be parked in receivables, where it would have no open item
// and would put the ledger and the subledger out of step from the moment it
// was taken.
//
//   receive an advance     Dr Cash              Cr Customer Advances
//   apply it to a bill     Dr Customer Advances Cr Accounts Receivable
//
// Applying writes the same payment_allocation rows an ordinary settlement
// writes, so the invoice's outstanding falls through the mechanism every
// screen already reads — and the money is never recorded twice.

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

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.01;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [bank] = await sql`select id from account
     where company_id = ${co.id} and is_bank_account and is_active order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  const today = new Date().toISOString().slice(0, 10);

  const balance = async (code) => {
    const [r] = await sql`select coalesce(sum(jl.base_amount), 0)::float as v
       from journal_line jl join account a on a.id = jl.account_id
      where jl.company_id = ${co.id} and a.code = ${code}`;
    return n(r.v);
  };
  const available = async (partnerId) => {
    const [r] = await sql`select coalesce(sum(available), 0)::float as v
       from v_partner_advance where company_id = ${co.id} and partner_id = ${partnerId}`;
    return n(r.v);
  };
  const owes = async (docId) => {
    const [r] = await sql`select outstanding::float as v from v_open_item where document_id = ${docId}`;
    return n(r?.v ?? 0);
  };
  const invariants = async (label) => {
    check(`  ${label}: the books hold`,
      (await sql`select 1 from v_check_unbalanced_entries`).length === 0
      && (await sql`select 1 from v_check_control_reconciliation`).length === 0
      && Math.abs(n((await sql`select coalesce(sum(balance),0) v from v_trial_balance`)[0].v)) < 0.0001);
  };

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 200, unitCost: 400 }] });

  // ---- a customer pays before there is anything to pay for ---------------

  console.log("  a customer pays 20,000 with no invoice yet\n");

  const adv = await P.postCustomerReceipt({
    companyId: co.id, partnerId: cust.id, docDate: today,
    cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 20000, memo: "Advance for next purchase",
  });
  check("the receipt posts with no invoice at all", !!adv.docNo, adv.docNo);
  check("  the money is held as a liability, not as a receivable",
    near(await balance("2060"), -20000) && near(await balance("1030"), 0),
    `2060 ${await balance("2060")} · AR ${await balance("1030")}`);
  check("  and it shows as available on account", near(await available(cust.id), 20000),
    `${await available(cust.id)}`);
  await invariants("after taking it");

  // ---- the invoice arrives later -----------------------------------------

  console.log("\n  the invoice comes later, for 55,550\n");

  const inv = await P.postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: today, toDeliver: true,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 5555 }],
  });
  check("the invoice owes its full amount to begin with", near(await owes(inv.id), 55550),
    `${await owes(inv.id)}`);

  const applied = await P.applyAdvance({
    companyId: co.id, invoiceId: inv.id, docDate: today,
    allocations: [{ paymentId: adv.id, amount: 20000 }],
  });
  check("applying the advance posts its own document", !!applied.docNo, applied.docNo);
  check("  the invoice now owes 35,550", near(await owes(inv.id), 35550), `${await owes(inv.id)}`);
  check("  the advance is spent", near(await available(cust.id), 0), `${await available(cust.id)}`);
  check("  the liability is gone", near(await balance("2060"), 0), `${await balance("2060")}`);
  check("  and no second receipt was created",
    n((await sql`select count(*)::int c from document
        where doc_type = ${"CUSTOMER_RECEIPT"}`)[0].c) === 1);
  check("  the cash is counted once", near(await balance(
    (await sql`select code from account where id = ${bank.id}`)[0].code), 20000));
  await invariants("after applying it");

  // ---- what cannot happen -------------------------------------------------

  console.log("\n  what cannot happen\n");

  const adv2 = await P.postCustomerReceipt({
    companyId: co.id, partnerId: cust.id, docDate: today,
    cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 5000,
  });

  let over = null;
  try {
    await P.applyAdvance({ companyId: co.id, invoiceId: inv.id, docDate: today,
      allocations: [{ paymentId: adv2.id, amount: 9000 }] });
  } catch (e) { over = e.message; }
  check("more than the advance holds cannot be applied", over !== null,
    over ? over.slice(0, 52) : "APPLIED — money that was never received");

  let wrongPartner = null;
  const [other] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer and id <> ${cust.id} limit 1`;
  if (other) {
    const theirs = await P.postCustomerReceipt({
      companyId: co.id, partnerId: other.id, docDate: today,
      cashAccountId: bank.id, locationId: loc.id, allocations: [], advance: 3000 });
    try {
      await P.applyAdvance({ companyId: co.id, invoiceId: inv.id, docDate: today,
        allocations: [{ paymentId: theirs.id, amount: 3000 }] });
    } catch (e) { wrongPartner = e.message; }
    check("one customer's money cannot settle another's bill", wrongPartner !== null,
      wrongPartner ? wrongPartner.slice(0, 52) : "APPLIED — the wrong customer paid");
  }

  let both = null;
  try {
    await P.postCustomerReceipt({ companyId: co.id, partnerId: cust.id, docDate: today,
      cashAccountId: bank.id, locationId: loc.id, advance: 1000,
      allocations: [{ invoiceId: inv.id, amount: 1000 }] });
  } catch (e) { both = e.message; }
  check("a receipt is either settling or on account, not both", both !== null,
    both ? both.slice(0, 52) : "POSTED — half allocated, half floating");

  let noBranch = null;
  try {
    await P.postCustomerReceipt({ companyId: co.id, partnerId: cust.id, docDate: today,
      cashAccountId: bank.id, allocations: [], advance: 1000 });
  } catch (e) { noBranch = e.message; }
  check("an advance must say which branch took it", noBranch !== null,
    noBranch ? noBranch.slice(0, 52) : "POSTED — cash in no branch at all");

  // ---- the supplier side --------------------------------------------------

  console.log("\n  paying a supplier up front\n");

  const paid = await P.postSupplierPayment({
    companyId: co.id, partnerId: supp.id, docDate: today,
    cashAccountId: bank.id, locationId: loc.id,
    allocations: [], advance: 30000, memo: "Deposit on next order",
  });
  check("it is held as an asset, not as a payable",
    near(await balance("1070"), 30000) && near(await available(supp.id), 30000),
    `1070 ${await balance("1070")} · available ${await available(supp.id)}`);

  const bill = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 400 }],
  });
  await P.applyAdvance({ companyId: co.id, invoiceId: bill.id, docDate: today,
    allocations: [{ paymentId: paid.id, amount: 30000 }] });
  check("applying it relieves the bill", near(await owes(bill.id), 10000), `${await owes(bill.id)}`);
  check("  and the asset is used up", near(await balance("1070"), 0), `${await balance("1070")}`);
  await invariants("after the supplier side");

  // ---- part of an advance, kept for next time -----------------------------

  console.log("\n  what is left stays for next time\n");

  const inv2 = await P.postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: today, toDeliver: true,
    lines: [{ itemId: item.id, qty: 1, unitPrice: 2000 }],
  });
  await P.applyAdvance({ companyId: co.id, invoiceId: inv2.id, docDate: today,
    allocations: [{ paymentId: adv2.id, amount: 2000 }] });
  check("only part of an advance need be used", near(await owes(inv2.id), 0), `${await owes(inv2.id)}`);
  check("  and the rest is still on account", near(await available(cust.id), 3000),
    `${await available(cust.id)}`);
  await invariants("at the end");

  // ---- undoing an application ---------------------------------------------

  console.log("\n  taking an application back\n");
  {
    const a = await P.postCustomerReceipt({
      companyId: co.id, partnerId: cust.id, docDate: today,
      cashAccountId: bank.id, locationId: loc.id, allocations: [], advance: 8000 });
    const i = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: true,
      lines: [{ itemId: item.id, qty: 2, unitPrice: 6000 }] });
    const app = await P.applyAdvance({ companyId: co.id, invoiceId: i.id, docDate: today,
      allocations: [{ paymentId: a.id, amount: 8000 }] });

    check("applied, the invoice owes 4,000", near(await owes(i.id), 4000), `${await owes(i.id)}`);

    await P.voidDocument({ companyId: co.id, documentId: app.id, reason: "applied by mistake" });

    check("voiding the application puts the invoice back to 12,000",
      near(await owes(i.id), 12000), `${await owes(i.id)}`);
    check("  and the money back on account",
      near(await available(cust.id), 8000 + 3000), `${await available(cust.id)}`);
    await invariants("after undoing it");

    // And the receipt underneath can then be voided too.
    await P.voidDocument({ companyId: co.id, documentId: a.id, reason: "money returned" });
    check("  the receipt can then be voided", near(await available(cust.id), 3000),
      `${await available(cust.id)}`);
    await invariants("after voiding the receipt");
  }

  // ---- the receipt cannot be pulled out from under a live application -----

  console.log("\n  what an application protects\n");
  {
    const a = await P.postCustomerReceipt({
      companyId: co.id, partnerId: cust.id, docDate: today,
      cashAccountId: bank.id, locationId: loc.id, allocations: [], advance: 5000 });
    const i = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: true,
      lines: [{ itemId: item.id, qty: 2, unitPrice: 6000 }] });
    const app = await P.applyAdvance({ companyId: co.id, invoiceId: i.id, docDate: today,
      allocations: [{ paymentId: a.id, amount: 5000 }] });

    let blocked = null;
    try {
      await P.voidDocument({ companyId: co.id, documentId: a.id, reason: "pulling it out" });
    } catch (e) { blocked = e.message; }
    check("a spent advance cannot be voided under its application", blocked !== null,
      blocked ? blocked.slice(0, 60) : "VOIDED — the application now credits money that is gone");
    check("  and the invoice is untouched by the attempt",
      near(await owes(i.id), 7000), `${await owes(i.id)}`);
    check("  the message names the application to void first",
      blocked !== null && blocked.includes(app.docNo), app.docNo);
    await invariants("after the refusal");
  }

  // ---- one branch's money paying another branch's bill --------------------

  console.log("\n  money taken in one branch, a bill raised in another\n");
  {
    const branches = await sql`select id, code from location
       where company_id = ${co.id} and is_stock_location and is_active order by code limit 2`;
    if (branches.length === 2) {
      const [yangon, mandalay] = branches;
      const per = async (code, locId) => {
        const [r] = await sql`select coalesce(sum(jl.base_amount),0)::float v
           from journal_line jl join account acc on acc.id = jl.account_id
          where jl.company_id = ${co.id} and acc.code = ${code}
            and jl.location_id = ${locId}`;
        return n(r.v);
      };

      const a = await P.postCustomerReceipt({
        companyId: co.id, partnerId: cust.id, docDate: today,
        cashAccountId: bank.id, locationId: yangon.id, allocations: [], advance: 9000 });
      const i = await P.postSalesInvoice({
        companyId: co.id, partnerId: cust.id, locationId: mandalay.id,
        docDate: today, dueDate: today, toDeliver: true,
        lines: [{ itemId: item.id, qty: 2, unitPrice: 6000 }] });

      // Measured across the application alone. Earlier sections of this suite
      // left advances of their own sitting in the same branch, so an absolute
      // balance here would be reading their residue rather than this.
      const yangonBefore = await per("2060", yangon.id);
      const mandalayBefore = await per("2060", mandalay.id);

      await P.applyAdvance({ companyId: co.id, invoiceId: i.id, docDate: today,
        allocations: [{ paymentId: a.id, amount: 9000 }] });

      check("the advance clears in the branch that took it",
        near((await per("2060", yangon.id)) - yangonBefore, 9000),
        `Yangon 2060 moved ${(await per("2060", yangon.id)) - yangonBefore}`);
      check("  and the branch that raised the bill is untouched by it",
        near((await per("2060", mandalay.id)) - mandalayBefore, 0),
        `Mandalay 2060 moved ${(await per("2060", mandalay.id)) - mandalayBefore}`);
      check("  the receivable clears where the invoice was raised",
        near(await owes(i.id), 3000), `${await owes(i.id)}`);
      await invariants("across branches");
    }
  }


  // ---- the list of advances, and what became of each ----------------------
  // v_partner_advance answers a different question — what is still available
  // to apply — so it drops an advance the moment nothing is left of it. That
  // is right for the panel offering money to spend, and wrong for anybody
  // asking what happened to a deposit: the fully spent one is exactly where
  // "when was it applied" is the whole question.

  console.log("\n  the advances list\n");
  {
    const Q = await import("../lib/queries.ts");

    const deposit = await P.postCustomerReceipt({
      companyId: co.id, partnerId: cust.id, docDate: today,
      cashAccountId: bank.id, locationId: loc.id, allocations: [], advance: 5000 });
    const bill = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: true,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 5000 }] });
    const app = await P.applyAdvance({ companyId: co.id, invoiceId: bill.id,
      docDate: today, allocations: [{ paymentId: deposit.id, amount: 5000 }] });

    const listed = async (side = "CUSTOMER") =>
      (await Q.getAdvanceLedger(co.id, side)).find((r) => r.id === deposit.id);
    let row = await listed();

    check("a fully applied advance is still listed", !!row);
    check("  stating what was taken", row && near(row.taken, 5000), `${row?.taken}`);
    check("  and that none of it is left", row && near(row.remaining, 0), `${row?.remaining}`);
    check("  which the apply panel's view no longer carries",
      (await sql`select 1 from v_partner_advance where payment_id = ${deposit.id}`).length === 0);
    check("  it names the invoice the money went to",
      !!row?.applications.some((a) => a.invoice_id === bill.id && near(a.amount, 5000)));
    check("  and the application that did it, with its date",
      !!row?.applications.some((a) => a.application_no === app.docNo && a.applied_on === today),
      row?.applications.map((a) => `${a.application_no} ${a.applied_on}`).join(" · "));

    // An ordinary receipt settles an invoice on the spot. It posts to the
    // control account, not the advances account, and is not an advance.
    const openBill = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: true,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 4000 }] });
    const plain = await P.postCustomerReceipt({
      companyId: co.id, partnerId: cust.id, docDate: today, cashAccountId: bank.id,
      allocations: [{ invoiceId: openBill.id, amount: 4000 }] });
    check("an ordinary receipt is not listed as an advance",
      !(await Q.getAdvanceLedger(co.id, "CUSTOMER")).some((r) => r.id === plain.id));

    check("a customer's deposit is not on the supplier list", !(await listed("SUPPLIER")));

    // Taking the application back puts the money back on account — and takes
    // the application off the advance it once spent, rather than leaving a
    // row that says the money went somewhere it no longer has.
    await P.voidDocument({ documentId: app.id, reason: "applied to the wrong bill" });
    row = await listed();
    check("voiding the application puts what it spent back", near(row?.remaining, 5000),
      `${row?.remaining}`);
    check("  and stops listing it under the advance", row?.applications.length === 0,
      `${row?.applications.length} still listed`);

    // The two figures are read from the same allocations, so they cannot
    // drift: the card is the sum of the list.
    const kpis = await Q.getKpis(co.id);
    const onAccount = (await Q.getAdvanceLedger(co.id, "CUSTOMER"))
      .reduce((t, r) => t + r.remaining, 0);
    check("the list and the dashboard agree on what is on account",
      near(onAccount, n(kpis.advances.customer)),
      `list ${onAccount} vs card ${n(kpis.advances.customer)}`);

    await invariants("after listing advances");
  }

  console.log(bad === 0
    ? "\n  money can arrive before the invoice does\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
