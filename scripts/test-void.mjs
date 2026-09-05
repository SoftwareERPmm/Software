// Voiding a posted document, and what must stop it.
//
//   npx tsx scripts/test-void.mjs
//
// A void is a reversal, not a deletion. The things worth asserting are that
// the ledger ends where it started, that nothing was rewritten to get there,
// and that a document with something built on top of it refuses to go —
// because the failure mode of a delete button in an accounting system is not
// an error message, it is a balance that quietly stops meaning anything.
//
// Writes documents. Run against a scratch database.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const { sql } = await import("../lib/db.ts");
const { planVoid } = await import("../lib/void.ts");
const { voidDocument, postCashVoucher, postGoodsReceipt, postPurchaseInvoice,
        postSupplierPayment } = await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

const balances = async (companyId) => {
  const rows = await sql`
    select account_id, sum(base_amount) as bal from journal_line
     where company_id = ${companyId} group by account_id having sum(base_amount) <> 0`;
  return new Map(rows.map((r) => [r.account_id, n(r.bal)]));
};
const sameBalances = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs(v - (b.get(k) ?? 0)) > 0.0001) return false;
  return true;
};

try {
  for (let i = 1; ; i++) {
    try { await sql`select 1`; break; }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const [cash] = await sql`
    select id from account where company_id = ${co.id} and is_cash_account and is_active limit 1`;
  const [income] = await sql`
    select id from account where company_id = ${co.id} and account_type = 'REVENUE'
      and is_postable and is_active limit 1`;

  // ---- the simple case: a voucher with nothing built on it ----------------
  console.log("  a cash receipt, voided\n");
  const before = await balances(co.id);

  const rec = await postCashVoucher({
    companyId: co.id, docDate: today, memo: "to be voided",
    lines: [{ accountId: cash.id, amount: 250000 }, { accountId: income.id, amount: -250000 }],
  });
  const after = await balances(co.id);
  check("posting moved the accounts", !sameBalances(before, after));

  const plan = await planVoid(rec.id);
  check("the plan says it can be voided", plan.canVoid === true,
    plan.blockers.map((b) => b.reason).join(" "));
  check("and says what voiding would do", plan.effects.length > 0, `${plan.effects.length} effects`);

  const done = await voidDocument({ documentId: rec.id, reason: "entered twice" });
  console.log(`    ${rec.docNo} voided by ${done.reversalNo}\n`);

  const restored = await balances(co.id);
  check("every account is back where it started", sameBalances(before, restored));

  // Nothing was rewritten to get there.
  const [orig] = await sql`
    select status, doc_no, gross_total, journal_entry_id, reversed_by_document_id,
           void_reason from document where id = ${rec.id}`;
  check("the original keeps its number", orig.doc_no === rec.docNo);
  check("and its total", n(orig.gross_total) === 250000, String(n(orig.gross_total)));
  check("and its journal entry", Boolean(orig.journal_entry_id));
  check("it is marked reversed", orig.status === "REVERSED", orig.status);
  check("and points at the reversal", orig.reversed_by_document_id === done.reversalId);
  check("the reason is kept", orig.void_reason === "entered twice", String(orig.void_reason));

  const origLines = await sql`
    select count(*)::int c from journal_line where journal_entry_id = ${orig.journal_entry_id}`;
  check("the original entry still has its lines", origLines[0].c === 2, String(origLines[0].c));

  const [rev] = await sql`
    select doc_no, gross_total, reverses_document_id, status from document where id = ${done.reversalId}`;
  check("the reversal is a document in its own right", Boolean(rev.doc_no), rev.doc_no);
  check("it carries the negated total", n(rev.gross_total) === -250000, String(n(rev.gross_total)));
  check("and names what it reverses", rev.reverses_document_id === rec.id);

  // ---- the history log ----------------------------------------------------
  const hist = await sql`
    select action, reason, related_id, detail, acted_by
      from document_history where document_id = ${rec.id}`;
  check("the void is in the history log", hist.length === 1 && hist[0].action === "VOID");
  check("with the reason and the reversal", hist[0].reason === "entered twice" &&
    hist[0].related_id === done.reversalId);
  check("and what the document said before", n(hist[0].detail?.gross_total) === 250000,
    JSON.stringify(hist[0].detail?.gross_total));
  check("acted_by is null until there are users to name",
    hist[0].acted_by === null);

  let refused = false;
  try { await sql`update document_history set reason = 'x' where document_id = ${rec.id}`; }
  catch { refused = true; }
  check("the log itself cannot be edited", refused);

  // ---- voiding twice ------------------------------------------------------
  let twice = null;
  try { await voidDocument({ documentId: rec.id }); }
  catch (e) { twice = e.message; }
  check("a voided document cannot be voided again", twice !== null, String(twice).slice(0, 50));

  // ---- the status cannot simply be flipped --------------------------------
  // The whole guard: hiding a document without the reversal is what made the
  // subledger and the control account disagree.
  const rec2 = await postCashVoucher({
    companyId: co.id, docDate: today, memo: "flip test",
    lines: [{ accountId: cash.id, amount: 10000 }, { accountId: income.id, amount: -10000 }],
  });
  let flipped = false;
  try { await sql`update document set status = 'REVERSED' where id = ${rec2.id}`; }
  catch { flipped = true; }
  check("status cannot be set to REVERSED without a reversal attached", flipped);
  let cancelled = false;
  try { await sql`update document set status = 'CANCELLED' where id = ${rec2.id}`; }
  catch { cancelled = true; }
  check("nor to CANCELLED, which used to hide a debt just as well", cancelled);
  let deleted = false;
  try { await sql`delete from document where id = ${rec2.id}`; }
  catch { deleted = true; }
  check("a posted document still cannot be deleted", deleted);

  // ---- something built on top of it ---------------------------------------
  console.log("\n  a document with dependants\n");
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"VD" + stamp}, 'x', ${"Void Test " + stamp}) returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, '001', ${"Void Item " + stamp}, ${uom.id}, true) returning id`;
  const [supplier] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"VS-" + stamp}, ${"Void Supplier " + stamp}, true) returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;

  const gr = await postGoodsReceipt({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitCost: 5000 }],
  });
  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    goodsReceiptId: gr.id, lines: [{ itemId: item.id, qty: 10, unitPrice: 5000 }],
  });

  const grPlan = await planVoid(gr.id);
  check("a receipt that has been billed refuses to void",
    grPlan.canVoid === false &&
    grPlan.blockers.some((b) => b.docNo === pi.docNo || /raised from/.test(b.reason)),
    grPlan.blockers.map((b) => b.reason).join(" | ").slice(0, 80));

  const [cashAcct] = await sql`
    select id from account where company_id = ${co.id} and is_cash_account and is_active limit 1`;
  await postSupplierPayment({
    companyId: co.id, partnerId: supplier.id, docDate: today, cashAccountId: cashAcct.id,
    allocations: [{ invoiceId: pi.id, amount: 20000 }],
  });
  const piPlan = await planVoid(pi.id);
  check("an invoice that has been paid refuses to void",
    piPlan.canVoid === false && piPlan.blockers.some((b) => /settled/.test(b.reason)),
    piPlan.blockers.map((b) => b.reason).join(" | ").slice(0, 80));

  // And the engine refuses it too, not only the screen.
  let blocked = null;
  try { await voidDocument({ documentId: pi.id }); } catch (e) { blocked = e.message; }
  check("and the engine refuses it, not just the preview", blocked !== null,
    String(blocked).slice(0, 60));

  // ---- voiding a payment ---------------------------------------------------
  // The case that looks fine and is not. Reversing a payment's journal lines
  // puts the money back on the control account, but payment_allocation is a
  // separate record and the aging is built from it — so unless the allocation
  // stops counting, AP says the bill is owed while payables aging says it is
  // settled. Neither report looks broken, which is what makes it dangerous.
  console.log("\n  voiding a payment\n");
  {
    const gr2 = await postGoodsReceipt({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      lines: [{ itemId: item.id, qty: 4, unitCost: 5000 }],
    });
    const bill = await postPurchaseInvoice({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      goodsReceiptId: gr2.id, lines: [{ itemId: item.id, qty: 4, unitPrice: 5000 }],
    });
    const pay = await postSupplierPayment({
      companyId: co.id, partnerId: supplier.id, docDate: today, cashAccountId: cash.id,
      allocations: [{ invoiceId: bill.id, amount: 20000 }],
    });

    const owed = async () => {
      const [r] = await sql`
        select coalesce(outstanding, 0) o from v_open_item where document_id = ${bill.id}`;
      return n(r?.o);
    };
    check("paid in full, the bill leaves the aging", (await owed()) === 0, String(await owed()));

    const payPlan = await planVoid(pay.id);
    check("a payment with nothing built on it can be voided", payPlan.canVoid === true,
      payPlan.blockers.map((b) => b.reason).join(" "));

    await voidDocument({ documentId: pay.id, reason: "paid the wrong supplier" });

    // The whole point of this section.
    check("voiding the payment puts the bill back in the aging",
      (await owed()) === 20000, `${await owed()} outstanding`);

    const [status] = await sql`
      select payment_status, paid from v_invoice_status where document_id = ${bill.id}`;
    check("and the invoice reads open again, not paid",
      status.payment_status === "OPEN" && n(status.paid) === 0,
      `${status.payment_status}, paid ${n(status.paid)}`);

    // The allocation row is kept — it records something that was done — but it
    // no longer counts. Deleting it would lose what the payment was applied to.
    const alloc = await sql`
      select count(*)::int c from payment_allocation where payment_id = ${pay.id}`;
    check("the allocation itself is kept as a record", alloc[0].c === 1);

    // And the bill can be paid again, which it could not if the voided
    // payment still reserved room against it.
    const again = await postSupplierPayment({
      companyId: co.id, partnerId: supplier.id, docDate: today, cashAccountId: cash.id,
      allocations: [{ invoiceId: bill.id, amount: 20000 }],
    });
    check("and the bill can be settled again", Boolean(again.docNo), again.docNo);
    check("which clears it once more", (await owed()) === 0, String(await owed()));

    // The control account and the subledger must agree throughout — that is
    // the invariant this whole feature turns on.
    const [ap] = await sql`
      select coalesce(sum(jl.base_amount), 0) bal
        from journal_line jl join account a on a.id = jl.account_id
       where jl.company_id = ${co.id} and a.is_control and a.account_type = 'LIABILITY'`;
    const [sub] = await sql`
      select coalesce(sum(outstanding), 0) o from v_open_item
       where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE'`;
    check("AP control agrees with the payables subledger",
      Math.abs(Math.abs(n(ap.bal)) - n(sub.o)) < 0.0001,
      `control ${Math.abs(n(ap.bal))} vs subledger ${n(sub.o)}`);
  }

  // ---- editing: void, repost, link ----------------------------------------
  // An edit is not an update. It is the void of what was entered and a fresh
  // document carrying the corrected figures, with the two joined so the UI
  // can show one thing with a history rather than two unrelated documents.
  console.log("\n  editing a posted document\n");
  {
    const { linkAmendment } = await import("../lib/posting.ts");

    const wrong = await postCashVoucher({
      companyId: co.id, docDate: today, memo: "rent — wrong amount",
      lines: [{ accountId: cash.id, amount: -300000 }, { accountId: income.id, amount: 300000 }],
    });
    const beforeEdit = await balances(co.id);

    await voidDocument({ documentId: wrong.id, reason: "amount was wrong" });
    const right = await postCashVoucher({
      companyId: co.id, docDate: today, memo: "rent — corrected",
      lines: [{ accountId: cash.id, amount: -350000 }, { accountId: income.id, amount: 350000 }],
    });
    const linked = await linkAmendment({
      companyId: co.id, originalId: wrong.id, replacementId: right.id,
      reason: "amount was wrong",
    });
    console.log(`    ${linked.originalNo} replaced by ${linked.replacementNo}\n`);

    const [repl] = await sql`
      select supersedes_document_id, gross_total from document where id = ${right.id}`;
    check("the replacement names what it replaces",
      repl.supersedes_document_id === wrong.id);
    check("and carries the corrected figure", n(repl.gross_total) === 350000,
      String(n(repl.gross_total)));

    const [old_] = await sql`select status, gross_total from document where id = ${wrong.id}`;
    check("the original is voided, not altered",
      old_.status === "REVERSED" && n(old_.gross_total) === 300000,
      `${old_.status} at ${n(old_.gross_total)}`);

    // The ledger should now differ from before the edit by exactly the
    // correction — not by the whole of either figure.
    const afterEdit = await balances(co.id);
    const delta = n(afterEdit.get(cash.id) ?? 0) - n(beforeEdit.get(cash.id) ?? 0);
    check("the net effect on cash is only the difference", Math.abs(delta - -50000) < 0.0001,
      String(delta));

    const amend = await sql`
      select action, detail, related_id from document_history
       where document_id = ${wrong.id} and action = 'AMEND'`;
    check("the edit is in the history log", amend.length === 1);
    check("showing what it went from and to",
      n(amend[0]?.detail?.total_before) === 300000 && n(amend[0]?.detail?.total_after) === 350000,
      `${amend[0]?.detail?.total_before} -> ${amend[0]?.detail?.total_after}`);

    // Linking a replacement to a document nobody voided would leave both
    // standing, which is a duplicate rather than an edit.
    const stray = await postCashVoucher({
      companyId: co.id, docDate: today, memo: "still standing",
      lines: [{ accountId: cash.id, amount: 1000 }, { accountId: income.id, amount: -1000 }],
    });
    let refusedLink = null;
    try {
      await linkAmendment({ companyId: co.id, originalId: stray.id, replacementId: right.id });
    } catch (e) { refusedLink = e.message; }
    check("a replacement cannot be linked to a document that was never voided",
      refusedLink !== null && /not been voided/.test(String(refusedLink)),
      String(refusedLink).slice(0, 60));
  }

  // ---- invariants ---------------------------------------------------------
  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  const recon = await sql`
    select count(*)::int c from (
      select sm.item_id, sm.location_id, sum(sm.qty) moved,
             fn_qty_on_hand(${co.id}, sm.item_id, sm.location_id) on_hand
        from stock_movement sm where sm.company_id = ${co.id}
       group by sm.item_id, sm.location_id
    ) x where abs(moved - on_hand) > 0.0001`;
  check("inventory reconciles to the stock ledger", recon[0].c === 0);

  console.log(`\n  ${failures === 0 ? "all void tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
