// The evil accountant: everything someone would try in order to make these
// books say something they should not.
//
//   node scripts/test-evil.mjs
//
// Posts real documents and tampers with real rows. Run against a scratch
// database — it deliberately attempts destructive things, and several of
// them are expected to be refused mid-transaction.
//
// This suite assumes the attacker already has full access, to the database
// as well as the app. There is no authentication here yet and that is
// deliberate, so "they could just log in as someone else" is not the point.
// The point is what the ledger refuses once they are inside: whether history
// can be rewritten, whether stock or money can be invented, and whether a
// figure can be made to disagree with the entries behind it.
//
// A FAIL here is a real finding, not a flaky test. Do not soften a check to
// make it pass — either the guard exists or the books can be edited.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const {
  postGoodsReceipt, postSalesInvoice, postSaleWithDelivery,
  postPurchaseInvoice, postStockAdjustment, postCashVoucher,
  postCustomerReceipt, postSupplierPayment, postDelivery,
} = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 5 });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

/** Passes when the attempt is refused. The refusal message is the evidence. */
const refuses = async (label, fn) => {
  try {
    await fn();
    check(label, false, "IT WENT THROUGH");
  } catch (err) {
    check(label, true, `refused: ${String(err.message).slice(0, 58)}`);
  }
};

/** Passes when the attempt succeeds — used for the things that must stay possible. */
const allows = async (label, fn) => {
  try {
    await fn();
    check(label, true);
  } catch (err) {
    check(label, false, `refused: ${String(err.message).slice(0, 58)}`);
  }
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  let [cust] = await sql`
    select id from business_partner where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!cust) {
    [cust] = await sql`insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
      values (${co.id}, 'EV-C', 'Evil Test Customer', true, 30) returning id`;
  }
  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'EV-S', 'Evil Test Supplier', true) returning id`;
  }
  let [item] = await sql`
    select id, code from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'EV', 'x', 'Evil Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'Evil Test Item', ${uom.id}) returning id, code`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const buy = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };
  const sell = { companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today };

  console.log(`\n  ${co.name}  ·  item ${item.code}  ·  ${loc.code}`);

  // Something real to attack.
  await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] });
  const sale = await postSaleWithDelivery({ ...sell, dueDate: null,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1500 }] });

  // ---- Rewriting what already happened -----------------------------------

  console.log("\n  rewriting history\n");

  const [jl] = await sql`
    select jl.id, jl.amount from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
     where je.source_id = ${sale.id} limit 1`;

  await refuses("a posted journal line cannot be edited",
    () => sql`update journal_line set amount = 1 where id = ${jl.id}`);
  await refuses("a posted journal line cannot be deleted",
    () => sql`delete from journal_line where id = ${jl.id}`);
  await refuses("a journal entry cannot be deleted",
    () => sql`delete from journal_entry where source_id = ${sale.id}`);
  await refuses("a journal entry cannot be re-dated into another period",
    () => sql`update journal_entry set entry_date = '2020-01-01' where source_id = ${sale.id}`);

  const [mv] = await sql`select id from stock_movement limit 1`;
  await refuses("a stock movement cannot be edited",
    () => sql`update stock_movement set qty = 9999 where id = ${mv.id}`);
  await refuses("a stock movement cannot be deleted",
    () => sql`delete from stock_movement where id = ${mv.id}`);

  // Deleting the document was the way round every line-level guard. The
  // entries survived, being protected in their own right — but the invoice
  // vanished from v_open_item, which is built from documents, while AR
  // control still carried the debt. The ledger and the aging then disagreed
  // and nothing looked wrong. Same for the lines, and same for quietly
  // restatusing a posted invoice, which hides it from the subledger just as
  // effectively.
  await refuses("a posted document cannot be deleted",
    () => sql`delete from document where id = ${sale.id}`);
  await refuses("a posted document's lines cannot be deleted",
    () => sql`delete from document_line where document_id = ${sale.id}`);
  await refuses("a posted document cannot be quietly restatused out of the subledger",
    () => sql`update document set status = 'CANCELLED' where id = ${sale.id}`);
  await refuses("nor can its total be edited after the fact",
    () => sql`update document set gross_total = 1 where id = ${sale.id}`);
  await refuses("nor its date moved into another period",
    () => sql`update document set posting_date = '2020-01-01' where id = ${sale.id}`);

  // ---- Posting into a period that is closed ------------------------------

  console.log("\n  posting into a closed period\n");

  const [period] = await sql`
    select id, status from fiscal_period
     where company_id = ${co.id} and ${today}::date between start_date and end_date`;
  if (period) {
    await sql`update fiscal_period set status = 'CLOSED' where id = ${period.id}`;
    try {
      await refuses("a sale cannot be posted into a closed period",
        () => postSaleWithDelivery({ ...sell, dueDate: null,
          lines: [{ itemId: item.id, qty: 1, unitPrice: 1500 }] }));
      await refuses("a stock adjustment cannot slip into a closed period",
        () => postStockAdjustment({ ...sell, lines: [{ itemId: item.id, qty: 5 }] }));
    } finally {
      await sql`update fiscal_period set status = ${period.status} where id = ${period.id}`;
    }
    await allows("and the period reopening lets it post again",
      () => postSaleWithDelivery({ ...sell, dueDate: null,
        lines: [{ itemId: item.id, qty: 1, unitPrice: 1500 }] }));
  } else {
    check("a fiscal period covers today", false, "none found — cannot test the lock");
  }

  // ---- Sending money somewhere it cannot be traced ------------------------

  console.log("\n  posting money where it does not belong\n");

  // The control account is not a system_account role — it is resolved per
  // partner through the posting rules, the same way a document resolves it.
  const [ctrlRow] = await sql`
    select fn_resolve_control_account(${co.id}, 'AR_CONTROL', ${cust.id}) as id`;
  const [cash] = await sql`
    select id, code from account
     where company_id = ${co.id} and is_postable and is_active and name ilike '%cash%'
     order by code limit 1`;

  // A missing fixture must fail the suite rather than quietly skip the
  // checks that depend on it. An earlier version gated six attacks behind a
  // lookup that returned nothing, and reported a clean run having tried none
  // of them.
  check("a cash account exists to post the other side of these attempts", !!cash);
  check("a receivables control account resolves", !!ctrlRow?.id);

  if (ctrlRow?.id && cash) {
    // Two separate barriers stand in front of the receivables control
    // account, and they refuse for different reasons, so both are worth
    // proving. A voucher trips the second: VoucherLine carries no partner at
    // all, so it can never satisfy the requirement that a control-account
    // line name the party it belongs to.
    await refuses("a voucher cannot reach the receivables control account",
      () => postCashVoucher({ companyId: co.id, docDate: today, memo: "quietly",
        lines: [{ accountId: ctrlRow.id, amount: 50000 }, { accountId: cash.id, amount: -50000 }] }));

    // The first barrier is the one that matters to someone writing SQL: a
    // hand-made entry belongs to no document, and posting one straight to AR
    // is how a subledger stops agreeing with the ledger without anything
    // looking wrong. Supplying a partner gets past the second rule and is
    // still refused by the first.
    const [fp] = await sql`
      select id from fiscal_period
       where company_id = ${co.id} and ${today}::date between start_date and end_date`;
    await refuses("nor can a hand-written journal entry, even naming the customer",
      () => sql.begin(async (tx) => {
        const [entry] = await tx`
          insert into journal_entry (company_id, entry_no, entry_date, fiscal_period_id, memo)
          values (${co.id}, ${'EVIL-' + Date.now()}, ${today}::date, ${fp.id}, 'adjustment')
          returning id`;
        await tx`
          insert into journal_line (company_id, journal_entry_id, line_no, account_id,
                                    amount, base_amount, currency, partner_id)
          values (${co.id}, ${entry.id}, 1, ${ctrlRow.id}, -50000, -50000, 'MMK', ${cust.id})`;
      }));
  }

  const [header] = await sql`
    select id, code from account where company_id = ${co.id} and not is_postable limit 1`;
  check("a heading account exists to try posting into", !!header);
  if (header && cash) {
    await refuses("a voucher cannot post to a heading account",
      () => postCashVoucher({ companyId: co.id, docDate: today, memo: "into a total",
        lines: [{ accountId: header.id, amount: 1000 }, { accountId: cash.id, amount: -1000 }] }));
  }

  const [spare] = await sql`
    select id from account where company_id = ${co.id} and is_postable and is_active
      and id <> ${cash?.id ?? null} and name ilike '%bank%' limit 1`;
  check("a second postable account exists to deactivate", !!spare);
  if (spare && cash) {
    await sql`update account set is_active = false where id = ${spare.id}`;
    try {
      await refuses("a voucher cannot post to a deactivated account",
        () => postCashVoucher({ companyId: co.id, docDate: today, memo: "to a dead account",
          lines: [{ accountId: spare.id, amount: 1000 }, { accountId: cash.id, amount: -1000 }] }));
    } finally {
      await sql`update account set is_active = true where id = ${spare.id}`;
    }
  }

  // ---- Inventing stock ---------------------------------------------------

  console.log("\n  inventing stock\n");

  const onHand = n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q);

  await refuses("stock that is not there cannot be delivered",
    () => postDelivery({ ...sell, lines: [{ itemId: item.id, qty: onHand + 1 }] }));
  await refuses("nor written down below zero by an adjustment",
    () => postStockAdjustment({ ...sell, lines: [{ itemId: item.id, qty: -(onHand + 1) }] }));

  const [nonStock] = await sql`
    select id from location where company_id = ${co.id} and not is_stock_location limit 1`;
  if (nonStock) {
    await refuses("stock cannot be moved into a location that holds none",
      () => sql`insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost)
                values (${co.id}, ${item.id}, ${nonStock.id}, ${today}, 5, 100, 500)`);
  }

  await refuses("goods cannot be received at a negative cost",
    () => postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 10, unitCost: -1000 }] }));
  await refuses("nor sold at a negative price",
    () => postSalesInvoice({ ...sell, dueDate: null, toDeliver: true,
      lines: [{ itemId: item.id, qty: 1, unitPrice: -1500 }] }));

  // ---- Inventing money ---------------------------------------------------

  console.log("\n  inventing money\n");

  const [inv] = await sql`
    select id, gross_total from document
     where doc_type = 'SALES_INVOICE' and status = 'POSTED' order by doc_no limit 1`;

  check("a posted sales invoice exists to over-allocate against", !!inv);
  if (inv && cash) {
    await refuses("a payment cannot be allocated beyond the invoice it settles",
      () => postCustomerReceipt({ companyId: co.id, partnerId: cust.id, docDate: today,
        cashAccountId: cash.id, amount: n(inv.gross_total) * 2,
        allocations: [{ invoiceId: inv.id, amount: n(inv.gross_total) * 2 }] }));

    await refuses("nor allocated as a negative amount",
      () => postCustomerReceipt({ companyId: co.id, partnerId: cust.id, docDate: today,
        cashAccountId: cash.id, amount: 1000,
        allocations: [{ invoiceId: inv.id, amount: -1000 }] }));

    await refuses("an allocation cannot be inserted straight past the engine",
      () => sql`insert into payment_allocation (company_id, payment_id, invoice_id, amount, base_amount)
                values (${co.id}, ${inv.id}, ${inv.id}, ${n(inv.gross_total) * 5}, ${n(inv.gross_total) * 5})`);
  }

  // ---- Settling the wrong kind of invoice --------------------------------

  console.log("\n  paying the wrong kind of invoice\n");

  // A trading partner is often both customer and supplier, which is what
  // makes this reachable without any tampering: the partner check passes.
  const [both] = await sql`
    insert into business_partner (company_id, code, name, is_customer, is_supplier)
    values (${co.id}, ${'EV-B' + Date.now().toString().slice(-5)}, 'Evil Both Ways', true, true)
    returning id`;

  const evSi = await postSaleWithDelivery({ companyId: co.id, partnerId: both.id,
    locationId: loc.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 2, unitPrice: 10000 }] });
  const evPi = await postPurchaseInvoice({ companyId: co.id, partnerId: both.id,
    locationId: loc.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 1, unitPrice: 500 }] });

  if (cash) {
    // The control account comes from the payment's own type while the
    // outstanding balance comes from the invoice's, so mismatching the pair
    // put the subledger and the ledger on opposite sides of one transaction:
    // AR kept the debt, AP took a debit for a supplier never involved,
    // v_open_item called the invoice settled, and the cash went out to
    // collect money owed to us. It balanced perfectly.
    await refuses("a supplier payment cannot settle a sales invoice",
      () => postSupplierPayment({ companyId: co.id, partnerId: both.id, docDate: today,
        cashAccountId: cash.id, allocations: [{ invoiceId: evSi.id, amount: 20000 }] }));

    await refuses("a customer receipt cannot settle a purchase invoice",
      () => postCustomerReceipt({ companyId: co.id, partnerId: both.id, docDate: today,
        cashAccountId: cash.id, allocations: [{ invoiceId: evPi.id, amount: 500 }] }));

    const [anyGr] = await sql`
      select id from document where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT' limit 1`;
    await refuses("nor anything that is not an invoice at all",
      () => postCustomerReceipt({ companyId: co.id, partnerId: both.id, docDate: today,
        cashAccountId: cash.id, allocations: [{ invoiceId: anyGr.id, amount: 100 }] }));

    await refuses("nor by inserting the allocation straight into the table",
      () => sql`insert into payment_allocation (company_id, payment_id, invoice_id, amount, base_amount)
                values (${co.id}, ${evPi.id}, ${evSi.id}, 100, 100)`);

    await allows("while the right pairing still settles normally",
      () => postCustomerReceipt({ companyId: co.id, partnerId: both.id, docDate: today,
        cashAccountId: cash.id, allocations: [{ invoiceId: evSi.id, amount: 20000 }] }));
  }

  // ---- Billing the same goods twice --------------------------------------

  console.log("\n  billing the same goods twice\n");

  const gr = await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 20, unitCost: 1000 }] });
  await postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 1000 }] });

  const grirBefore = n((await sql`select coalesce(sum(jl.amount),0) as v from journal_line jl
    join account a on a.id = jl.account_id where a.code = '1310'`)[0].v);

  await postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 1000 }] });

  const grirAfter = n((await sql`select coalesce(sum(jl.amount),0) as v from journal_line jl
    join account a on a.id = jl.account_id where a.code = '1310'`)[0].v);

  check("a second invoice for the same receipt clears nothing more from GR/IR",
    grirAfter === grirBefore, `${grirBefore} → ${grirAfter}`);
  check("and its value lands in variance where it is visible, not hidden in GR/IR",
    n((await sql`select coalesce(sum(jl.amount),0) as v from journal_line jl
        join account a on a.id = jl.account_id where a.code = '5200'`)[0].v) === 20000);

  // ---- Continuing a document that is not what it claims ------------------

  console.log("\n  attaching a document to the wrong document\n");

  const [supB] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${'EV-S2' + Date.now().toString().slice(-4)}, 'Evil Second Supplier', true)
    returning id`;

  const grOwn = await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 20, unitCost: 1000 }] });
  const grOther = await postGoodsReceipt({ companyId: co.id, partnerId: supB.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 20, unitCost: 1000 }] });
  const [grOtherLine] = await sql`
    select id from document_line where document_id = ${grOther.id} limit 1`;
  const [anySale] = await sql`
    select id from document where company_id = ${co.id} and doc_type = 'SALES_INVOICE'
       and status = 'POSTED' limit 1`;

  // The id was taken on trust, the named document's lines were read, and
  // money was posted against them — so a purchase invoice could relieve
  // GR/IR against a customer's invoice at sales prices, or settle a
  // different supplier's receipt while that supplier was still owed.
  await refuses("a purchase invoice cannot bill a sales invoice as if it were a receipt",
    () => postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: anySale.id,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 1000 }] }));

  await refuses("nor settle a different supplier's receipt",
    () => postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: grOther.id,
      lines: [{ itemId: item.id, qty: 5, unitPrice: 1000 }] }));

  await refuses("nor point a line at a line of some other document",
    () => postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: grOwn.id,
      lines: [{ itemId: item.id, qty: 5, unitPrice: 1000, sourceLineId: grOtherLine.id }] }));

  await refuses("a goods receipt cannot fulfil a sales invoice",
    () => postGoodsReceipt({ ...buy, sourceDocumentId: anySale.id,
      lines: [{ itemId: item.id, qty: 5, unitCost: 1000 }] }));

  await refuses("a sales invoice cannot bill a goods receipt",
    () => postSalesInvoice({ ...sell, dueDate: null, deliveryId: grOwn.id,
      lines: [{ itemId: item.id, qty: 1, unitPrice: 1500 }] }));

  await allows("while a receipt's own supplier can still bill it",
    () => postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: grOwn.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 1000 }] }));

  // ---- Two people at once ------------------------------------------------

  console.log("\n  two people posting at the same moment\n");

  const left = n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q);
  const race = await Promise.allSettled([
    postDelivery({ ...sell, lines: [{ itemId: item.id, qty: left }] }),
    postDelivery({ ...sell, lines: [{ itemId: item.id, qty: left }] }),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  check("only one of two simultaneous deliveries can take the last of the stock",
    won === 1, `${won} succeeded of 2`);
  check("and stock never went negative",
    n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q) >= 0);

  // GR/IR is decided by reading how much of a document is still unsettled
  // and then settling some of it, so the read and the write have to be one
  // indivisible act. Four invoices for the whole receipt must between them
  // take out of GR/IR exactly what the goods were received at, once.
  const raceGr = await postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] });
  await Promise.allSettled(Array.from({ length: 4 }, () =>
    postPurchaseInvoice({ ...buy, dueDate: null, goodsReceiptId: raceGr.id,
      lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] })));
  const relievedTogether = n((await sql`
    select coalesce(sum(jl.amount), 0) as v from journal_line jl
      join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.id = je.source_id
     where a.code = '1310' and d.doc_type = 'PURCHASE_INVOICE'
       and d.source_document_id = ${raceGr.id}`)[0].v);
  check("four invoices racing one receipt relieve GR/IR once, not four times",
    relievedTogether === 100000, `${relievedTogether} of 100000`);

  const racePi = await postPurchaseInvoice({ ...buy, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  await Promise.allSettled(Array.from({ length: 4 }, () =>
    postGoodsReceipt({ ...buy, sourceDocumentId: racePi.id,
      lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] })));
  const releasedTogether = n((await sql`
    select coalesce(sum(jl.amount), 0) as v from journal_line jl
      join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.id = je.source_id
     where a.code = '1310' and d.doc_type = 'GOODS_RECEIPT'
       and d.source_document_id = ${racePi.id}`)[0].v);
  check("and four receipts racing one invoice release it once",
    releasedTogether === -100000, `${releasedTogether} of -100000`);

  const numbers = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      postGoodsReceipt({ ...buy, lines: [{ itemId: item.id, qty: 1, unitCost: 1000 }] }))
  );
  const issued = numbers.filter((r) => r.status === "fulfilled").map((r) => r.value.docNo);
  check("simultaneous documents never share a number",
    new Set(issued).size === issued.length, issued.join(" "));

  // ---- What all of that leaves behind ------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("after every attempt, the trial balance still nets to zero",
    Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0
    ? "\n  the books held\n"
    : `\n  ${failures} way${failures === 1 ? "" : "s"} through — each one is a finding\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
