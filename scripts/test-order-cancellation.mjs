// Giving up an order, and asking for it back.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 ./node_modules/.bin/tsx scripts/test-order-cancellation.mjs
//
// Two different statements share one mechanism. An order with nothing
// received against it is cancelled outright; an order with forty of a hundred
// received has its remainder closed, and the forty still happened. The
// database writes one closure row either way, so which of the two it was has
// to be recorded when it happens.
//
// It cannot be worked out afterwards from what is fulfilled today. Fulfilment
// keeps moving — a receipt is linked later, a return sends goods back, the
// order itself is corrected — so an order cancelled with nothing received
// would start reading as a remainder closure the moment anything attached to
// it, rewriting its own history. That is the case this suite exists for.
//
// And closing gives up a commitment, nothing else: no stock is removed, no
// invoice cancelled, no payment refunded. Whatever stands against the order
// is still standing afterwards, which is why the preview lists it.

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
const Q = await import("../lib/queries.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.01;
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;

  /**
   * Two conditions, both required — not either one. See test-receipt-return
   * for the reasoning; the short version is that a name check alone empties
   * whatever a stale .env points at, and an override alone lets one variable
   * exported hours ago do the same.
   */
  const disposable = /—\s*DEV\b|\bDEV\b/i.test(String(co.name));
  const optedIn = process.env.ALLOW_DESTRUCTIVE_TESTS === "1";
  if (!disposable || !optedIn) {
    throw new Error(
      `This suite empties the transaction tables of whatever it runs against. `
      + (!disposable
        ? `"${co.name}" does not look like a disposable development database — `
          + `point .env at one. `
        : `"${co.name}" looks disposable. `)
      + (!optedIn ? `Set ALLOW_DESTRUCTIVE_TESTS=1 to say you mean it.` : ``)
    );
  }

  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [till] = await sql`select id from account
     where company_id = ${co.id} and is_cash_account and is_active order by code limit 1`;
  console.log(`\n  ${co.name}`);

  const wipe = () => sql.unsafe(`truncate table posting_attempt, document_history,
    fulfilment_link, order_closure, payment_allocation, stock_lot_adjustment,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  const fresh = async () => {
    await wipe();
    await sql`update number_series set next_value = 1`;
    return P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 100, unitPrice: 500 }] });
  };
  const closureOf = (id) => Q.getOrderClosure(id);
  const stateOf = (id) => Q.getOrderCancellation(co.id, id);

  // ---- nothing fulfilled: the whole commitment goes -----------------------

  console.log("\n  100 ordered, nothing received\n");

  const cancelled = await fresh();
  let st = await stateOf(cancelled.id);
  check("the order stands at 100 ordered, 0 fulfilled, 100 remaining",
    st.ordered === 100 && st.fulfilled === 0 && st.outstanding === 100,
    `${st.ordered}/${st.fulfilled}/${st.outstanding}`);

  const cancelResult = await P.closeOrderRemaining({ companyId: co.id,
    documentId: cancelled.id, reason: "entered twice" });
  check("cancelling records what was true at the time", cancelResult.fulfilled === 0
    && cancelResult.outstanding === 100, `${cancelResult.fulfilled}/${cancelResult.outstanding}`);

  st = await stateOf(cancelled.id);
  check("  nothing is outstanding afterwards", st.outstanding === 0, `${st.outstanding}`);
  check("  and the order is closed", st.isClosed === true);

  let cl = await closureOf(cancelled.id);
  check("  it reads as CANCELLED, not a remainder closure", cl.kind === "CANCELLED", cl.kind);
  check("  the snapshot says nothing had arrived", cl.fulfilledAtClosure === 0,
    `${cl.fulfilledAtClosure}`);
  check("  and that 100 was given up", cl.outstandingAtClosure === 100,
    `${cl.outstandingAtClosure}`);

  // History is retained: the order is still a posted document, not deleted.
  const [stillThere] = await sql`select status, doc_no from document where id = ${cancelled.id}`;
  check("  the order itself is kept, posted, with its number",
    stillThere.status === "POSTED" && stillThere.doc_no === cancelled.docNo,
    `${stillThere.status} ${stillThere.doc_no}`);
  check("  and the reason is on the closure", cl.reason === "entered twice", cl.reason);

  // ---- the snapshot is about that moment, not about now -------------------
  //
  // The case that decides whether the label can be derived at all. Goods
  // arrive against a cancelled order — late, or linked by mistake, or the
  // supplier shipped anyway. Today's fulfilment is now 40. The closure still
  // has to say what it said: nothing had arrived when it was made.

  console.log("\n  goods turn up against an order already cancelled\n");

  const lateGr = await P.postGoodsReceipt({ ...base, sourceDocumentId: cancelled.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  check("the receipt posts", !!lateGr.docNo, lateGr.docNo);

  st = await stateOf(cancelled.id);
  check("  today's fulfilment has moved to 40", st.fulfilled === 40, `${st.fulfilled}`);

  cl = await closureOf(cancelled.id);
  check("  but the closure still reads CANCELLED", cl.kind === "CANCELLED", cl.kind);
  check("  because its snapshot is still 0, not recomputed",
    cl.fulfilledAtClosure === 0, `${cl.fulfilledAtClosure}`);

  // ---- partly fulfilled: only the remainder goes --------------------------

  console.log("\n  100 ordered, 40 received, 60 called off\n");

  const partly = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: partly.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });

  st = await stateOf(partly.id);
  check("40 fulfilled, 60 remaining", st.fulfilled === 40 && st.outstanding === 60,
    `${st.fulfilled}/${st.outstanding}`);

  const closeResult = await P.closeOrderRemaining({ companyId: co.id,
    documentId: partly.id, reason: "customer cancelled the remainder" });
  check("closing records 40 fulfilled and 60 given up",
    closeResult.fulfilled === 40 && closeResult.outstanding === 60,
    `${closeResult.fulfilled}/${closeResult.outstanding}`);

  st = await stateOf(partly.id);
  check("  0 outstanding, and the 40 still stand",
    st.outstanding === 0 && st.fulfilled === 40, `${st.outstanding}/${st.fulfilled}`);

  cl = await closureOf(partly.id);
  check("  it reads as a remainder closure, not a cancellation",
    cl.kind === "REMAINDER_CLOSED", cl.kind);
  check("  with 40 recorded as fulfilled at the time", cl.fulfilledAtClosure === 40,
    `${cl.fulfilledAtClosure}`);

  // The goods that did arrive are untouched by any of it.
  const onHand = n((await sql`select coalesce(sum(qty), 0)::float q from stock_movement
    where company_id = ${co.id} and item_id = ${item.id}`)[0].q);
  check("  the 40 that arrived are still in stock", onHand === 40, `${onHand}`);

  // ---- what closing does not touch ----------------------------------------

  console.log("\n  a bill and a payment stand against the order\n");

  const entangled = await fresh();
  const gr = await P.postGoodsReceipt({ ...base, sourceDocumentId: entangled.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  const bill = await P.postPurchaseInvoice({ ...base, dueDate: today, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 500 }] });
  const pay = await P.postSupplierPayment({ companyId: co.id, partnerId: supp.id,
    docDate: today, cashAccountId: till.id,
    allocations: [{ invoiceId: bill.id, amount: 5000 }] });

  st = await stateOf(entangled.id);
  const shown = st.documents.map((d) => d.doc_no);
  check("the preview names the receipt", shown.includes(gr.docNo), shown.join(" "));
  check("  the bill raised from it", shown.includes(bill.docNo));
  check("  and the payment against the bill", shown.includes(pay.docNo));

  const payablesBefore = n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
     from journal_line jl join account a on a.id = jl.account_id
    where a.is_control and a.account_type = 'LIABILITY' and jl.company_id = ${co.id}`)[0].v);

  await P.closeOrderRemaining({ companyId: co.id, documentId: entangled.id,
    reason: "supplier discontinued the line" });

  const payablesAfter = n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
     from journal_line jl join account a on a.id = jl.account_id
    where a.is_control and a.account_type = 'LIABILITY' and jl.company_id = ${co.id}`)[0].v);
  check("closing leaves payables exactly where they were",
    near(payablesBefore, payablesAfter), `${payablesBefore} -> ${payablesAfter}`);

  const [billAfter] = await sql`select status from document where id = ${bill.id}`;
  check("  the bill is still posted", billAfter.status === "POSTED", billAfter.status);
  const [payAfter] = await sql`select status from document where id = ${pay.id}`;
  check("  the payment is still posted", payAfter.status === "POSTED", payAfter.status);
  const allocs = n((await sql`select count(*)::int c from payment_allocation
    where payment_id = ${pay.id}`)[0].c);
  check("  and the allocation is untouched", allocs === 1, `${allocs}`);
  const stock = n((await sql`select coalesce(sum(qty), 0)::float q from stock_movement
    where company_id = ${co.id} and item_id = ${item.id}`)[0].q);
  check("  the goods that arrived are still here", stock === 40, `${stock}`);

  // ---- reopening, checked against the order as it stands now --------------

  console.log("\n  asking for it back\n");

  const reopened = await fresh();
  const notClosed = await refused(() => P.reopenOrder({ companyId: co.id,
    documentId: reopened.id, reason: "changed my mind" }));
  check("an order that is not closed cannot be reopened", !!notClosed,
    notClosed?.slice(0, 60));

  await P.closeOrderRemaining({ companyId: co.id, documentId: reopened.id,
    reason: "supplier said no" });
  st = await stateOf(reopened.id);
  check("closed, it reports 0 outstanding", st.outstanding === 0, `${st.outstanding}`);
  check("  but reopening would restore 100", st.reopensTo === 100, `${st.reopensTo}`);

  const back = await P.reopenOrder({ companyId: co.id, documentId: reopened.id,
    reason: "supplier can supply after all" });
  check("  reopening says what it restored", back.outstanding === 100, `${back.outstanding}`);
  st = await stateOf(reopened.id);
  check("  and 100 is owed again", st.outstanding === 100 && st.isClosed === false,
    `${st.outstanding} closed=${st.isClosed}`);

  // Fulfilled in full while it was closed: there is nothing left to expect,
  // and reopening would show a commitment that no longer exists.
  const overtaken = await fresh();
  await P.closeOrderRemaining({ companyId: co.id, documentId: overtaken.id,
    reason: "not expected" });
  await P.postGoodsReceipt({ ...base, sourceDocumentId: overtaken.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  const nothingLeft = await refused(() => P.reopenOrder({ companyId: co.id,
    documentId: overtaken.id, reason: "expect it again" }));
  check("an order fulfilled in full while closed refuses to reopen", !!nothingLeft,
    nothingLeft?.slice(0, 70));
  check("  and it stays closed", (await stateOf(overtaken.id)).isClosed === true);

  // ---- a closure made before the snapshot existed -------------------------
  //
  // Null is not zero. Rows written before the column existed recorded nothing,
  // and reading them as "fulfilled 0" would label every one an outright
  // cancellation on no evidence.

  console.log("\n  a closure from before any of this was recorded\n");

  const old = await fresh();
  await P.closeOrderRemaining({ companyId: co.id, documentId: old.id, reason: "historic" });
  await sql`update order_closure
     set fulfilled_at_closure = null, outstanding_at_closure = null
   where document_id = ${old.id}`;
  cl = await closureOf(old.id);
  check("it reads as UNKNOWN, not CANCELLED", cl.kind === "UNKNOWN", cl.kind);
  check("  and claims no figure", cl.fulfilledAtClosure === null, `${cl.fulfilledAtClosure}`);

  await wipe();
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0
    ? "\n  a closure says what was true when it was made\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
