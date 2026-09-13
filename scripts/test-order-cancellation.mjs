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

  // ---- a cancelled order is not quietly receiving goods -------------------
  //
  // Closing says the rest is not expected. Goods landing against it anyway
  // make that statement meaningless the moment it is inconvenient, and do it
  // silently: the person receiving never learns the order was called off, and
  // whoever called it off never learns it continued. The way back in is
  // Reopen, which records who expected the goods again and why.

  console.log("\n  goods turn up against an order already cancelled\n");

  const shutOut = await refused(() => P.postGoodsReceipt({ ...base,
    sourceDocumentId: cancelled.id, lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] }));
  check("receiving against it is refused", !!shutOut, shutOut?.slice(0, 80));
  check("  and the refusal says to reopen it",
    !!shutOut && /reopen/i.test(shutOut));
  check("  and names why it was closed",
    !!shutOut && shutOut.includes("entered twice"));
  check("  nothing arrived", (await stateOf(cancelled.id)).fulfilled === 0);

  // Linking an existing receipt is the other way in, and it is shut too.
  const loose = await P.postGoodsReceipt({ ...base,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  const [looseLine] = await sql`select id from document_line where document_id = ${loose.id}`;
  const [orderLine] = await sql`select id from document_line where document_id = ${cancelled.id}`;
  const linkShut = await refused(() => P.linkFulfilmentToOrder({ companyId: co.id,
    lines: [{ fulfilmentLineId: looseLine.id, orderLineId: orderLine.id, qty: 40 }],
    reason: "these are the ones" }));
  check("linking an existing receipt to it is refused too", !!linkShut,
    linkShut?.slice(0, 80));

  // ---- the snapshot is about that moment, not about now -------------------
  //
  // Reopened and then received against, which is the legitimate route. The
  // closure that was made when nothing had arrived still has to say so:
  // today's fulfilment has moved, and it is not where the label comes from.

  console.log("\n  reopened, then received against\n");

  await P.reopenOrder({ companyId: co.id, documentId: cancelled.id,
    reason: "supplier shipped after all" });
  const lateGr = await P.postGoodsReceipt({ ...base, sourceDocumentId: cancelled.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  check("once reopened, the receipt posts", !!lateGr.docNo, lateGr.docNo);

  st = await stateOf(cancelled.id);
  check("  today's fulfilment has moved to 40", st.fulfilled === 40, `${st.fulfilled}`);

  const [firstClosure] = await sql`
    select fulfilled_at_closure from order_closure
     where document_id = ${cancelled.id} and not is_open
     order by closed_at limit 1`;
  check("  but the cancellation's own snapshot is still 0, not recomputed",
    n(firstClosure.fulfilled_at_closure) === 0, `${firstClosure.fulfilled_at_closure}`);

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

  // Nothing left to expect: reopening would show a commitment that no longer
  // exists. Reached by closing an order that was already fulfilled in full —
  // goods can no longer arrive against a closed order, so this is now the way
  // in rather than receiving after the fact.
  const overtaken = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: overtaken.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  await P.closeOrderRemaining({ companyId: co.id, documentId: overtaken.id,
    reason: "tidying up a finished order" });
  const nothingLeft = await refused(() => P.reopenOrder({ companyId: co.id,
    documentId: overtaken.id, reason: "expect it again" }));
  check("an order fulfilled in full while closed refuses to reopen", !!nothingLeft,
    nothingLeft?.slice(0, 70));
  check("  and it stays closed", (await stateOf(overtaken.id)).isClosed === true);

  // ---- receiving and closing at the same moment ---------------------------
  //
  // Whichever commits first has to decide the figures the other sees and
  // records. Both take the order row — requireSource locks it for a receipt
  // naming the order, closeOrderRemaining locks it before reading what is
  // fulfilled — so the second one waits, and there is no window where the
  // closure snapshots a quantity that a receipt is halfway through changing.
  //
  // Forced rather than hoped for: one transaction is held open on its own
  // connection while the other runs, so the interleaving is the bad one every
  // time instead of whenever the scheduler feels like it.

  console.log("\n  receiving and closing at the same moment\n");

  const other = postgres(url, { ssl: url.includes("localhost") ? false : "require",
    prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });
  try {
    // Warmed before the race. A cold pool spends a TLS handshake getting to
    // Neon, which is long enough for the other side to take the lock first
    // and turn a test of the engine into a test of connection latency.
    await other`select 1`;
    // Receipt first: it commits, and the closure that was waiting must
    // snapshot 40 fulfilled and 60 given up — not the 0 and 100 that were
    // true when it started trying.
    const raceA = await fresh();
    let release;
    const held = new Promise((r) => { release = r; });
    const receiptRunning = other.begin(async (tx) => {
      // Taken explicitly and first, so the interleaving under test is the one
      // intended rather than whichever side happened to get there.
      await tx`select id from document where id = ${raceA.id} for update`;
      await P.postGoodsReceipt({ ...base, sourceDocumentId: raceA.id,
        lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] }, tx);
      await held;              // hold the lock on the order row
      return "receipt committed";
    });
    await new Promise((r) => setTimeout(r, 600));

    let closureDone = false;
    const closing = P.closeOrderRemaining({ companyId: co.id, documentId: raceA.id,
      reason: "called off mid-delivery" }).then((r) => { closureDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    check("the closure waits while the receipt holds the order", closureDone === false);

    release();
    await receiptRunning;
    const closed = await closing;
    check("  once the receipt commits, the closure records what it did",
      closed.fulfilled === 40 && closed.outstanding === 60,
      `${closed.fulfilled}/${closed.outstanding}`);
    cl = await closureOf(raceA.id);
    check("  so it reads as a remainder closure, not a cancellation",
      cl.kind === "REMAINDER_CLOSED", cl.kind);
    check("  and nothing is outstanding now", (await stateOf(raceA.id)).outstanding === 0);

    // The other order: the closure commits first, and the receipt that was
    // waiting is refused outright by the rule above rather than landing
    // against an order that has just been given up.
    const raceB = await fresh();
    let release2;
    const held2 = new Promise((r) => { release2 = r; });
    await other`select 1`;
    const closingFirst = other.begin(async (tx) => {
      await tx`select id from document where id = ${raceB.id} for update`;
      await tx`insert into order_closure
        (company_id, document_id, reason, closed_by, is_open,
         fulfilled_at_closure, outstanding_at_closure)
        values (${co.id}, ${raceB.id}, 'called off first', null, false, 0, 100)`;
      await held2;
      return "closure committed";
    });
    await new Promise((r) => setTimeout(r, 300));

    let receiptSettled = null;
    const receiving = P.postGoodsReceipt({ ...base, sourceDocumentId: raceB.id,
      lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] })
      .then(() => { receiptSettled = "posted"; })
      .catch((e) => { receiptSettled = e.message; });
    await new Promise((r) => setTimeout(r, 300));
    check("the receipt waits while the closure holds the order", receiptSettled === null);

    release2();
    await closingFirst;
    await receiving;
    check("  once the closure commits, the receipt is refused",
      typeof receiptSettled === "string" && receiptSettled !== "posted",
      String(receiptSettled).slice(0, 70));
    check("  and nothing arrived", (await stateOf(raceB.id)).fulfilled === 0,
      `${(await stateOf(raceB.id)).fulfilled}`);
  } finally {
    await other.end();
  }

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
