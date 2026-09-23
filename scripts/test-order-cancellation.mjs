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

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
import { resetTransactions } from "./test-reset.mjs";
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


// One suite at a time: these share a database and empty it, so a second
// runner is refused rather than left to collide. See scripts/test-lock.mjs.
await takeTestLock(sql, "test-order-cancellation.mjs");
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
     where company_id = ${co.id} and is_stocked and is_active
     -- A plain item first. These suites test ordering and fulfilment,
     -- not batch tracking, and a tracked item makes every receipt
     -- demand a lot number the suite has no reason to care about.
     order by tracks_batch, code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [till] = await sql`select id from account
     where company_id = ${co.id} and is_cash_account and is_active order by code limit 1`;
  console.log(`\n  ${co.name}`);

  const wipe = () => resetTransactions(sql);
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
  // exists. No route through the engine reaches this any more — goods cannot
  // arrive against a closed order, and an order with nothing outstanding
  // cannot be closed — so the closure row is written directly, standing in
  // for one made before either guard existed. The check is kept because a
  // defence that is only unreachable today is not the same as one that is
  // unnecessary.
  const overtaken = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: overtaken.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  await sql`insert into order_closure
    (company_id, document_id, reason, closed_by, is_open,
     fulfilled_at_closure, outstanding_at_closure)
    values (${co.id}, ${overtaken.id}, 'closed before the guards existed',
            null, false, 0, 100)`;
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

  // ---- the confirmation cannot promise one thing and record another -------
  //
  // The panel reads the order when the page renders; the closure reads it
  // again when it commits, and a receipt can land between the two. Recording
  // the fresh figure is right — it is what actually happened — but doing it
  // silently leaves a confirmation that said "close 60 remaining" beside a
  // record saying 20 was given up, with nobody told the two disagreed.

  console.log("\n  the order moves between showing and deciding\n");

  const moved = await fresh();
  // What a panel rendered a moment ago would have shown.
  const asShown = { fulfilled: 0, outstanding: 100 };
  await P.postGoodsReceipt({ ...base, sourceDocumentId: moved.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });

  const stale = await refused(() => P.closeOrderRemaining({ companyId: co.id,
    documentId: moved.id, reason: "close the rest", saw: asShown }));
  check("closing on figures that have gone stale is refused", !!stale,
    stale?.slice(0, 90));
  check("  and the refusal says what it stands at now",
    !!stale && stale.includes("40") && stale.includes("60"));
  check("  nothing was closed", (await stateOf(moved.id)).isClosed === false);

  // On the figures as they are now, it goes through.
  const fine = await P.closeOrderRemaining({ companyId: co.id, documentId: moved.id,
    reason: "close the rest", saw: { fulfilled: 40, outstanding: 60 } });
  check("  on current figures it closes", fine.fulfilled === 40 && fine.outstanding === 60,
    `${fine.fulfilled}/${fine.outstanding}`);

  // Reopen is compared against what it would restore, not against the
  // order's outstanding, which reads 0 while it stays closed.
  const staleReopen = await refused(() => P.reopenOrder({ companyId: co.id,
    documentId: moved.id, reason: "expect it again",
    saw: { fulfilled: 0, outstanding: 100 } }));
  check("reopening on stale figures is refused too", !!staleReopen,
    staleReopen?.slice(0, 70));
  const okReopen = await P.reopenOrder({ companyId: co.id, documentId: moved.id,
    reason: "expect it again", saw: { fulfilled: 40, outstanding: 60 } });
  check("  and goes through on current ones", okReopen.outstanding === 60,
    `${okReopen.outstanding}`);

  // A call with no screen behind it — a script, an import — is unaffected.
  const headless = await fresh();
  const quiet = await P.closeOrderRemaining({ companyId: co.id,
    documentId: headless.id, reason: "no screen involved" });
  check("a call with nothing shown to compare still works", quiet.outstanding === 100,
    `${quiet.outstanding}`);

  // ---- correcting a closed order does not reopen it -----------------------
  //
  // Correcting an order does not edit it: the version is cancelled and the
  // next is posted under the same number, with a new id. A closure naming the
  // old id then named a version that was no longer live, and the live one had
  // no closure at all — so fixing a price on a cancelled order quietly
  // restored the commitment. Nobody reopened it and nobody was told.

  console.log("\n  a closed order, then corrected\n");

  const corrected = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: corrected.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  await P.closeOrderRemaining({ companyId: co.id, documentId: corrected.id,
    reason: "customer cancelled the remainder" });

  const [oldLine] = await sql`select id, item_id, base_qty from document_line
    where document_id = ${corrected.id}`;
  const amended = await P.amendDocument({ companyId: co.id, documentId: corrected.id,
    reason: "the price was wrong",
    repost: (tx, amendOf) => P.postPurchaseOrder({ ...base, dueDate: today, amendOf,
      lines: [{ itemId: oldLine.item_id, qty: Number(oldLine.base_qty), unitPrice: 600,
                supersedesLineId: oldLine.id }] }, tx) });
  const v2 = amended.replacementId ?? amended.id;
  check("the correction posts a new version", v2 !== corrected.id, String(v2).slice(0, 8));

  st = await stateOf(co.id ? v2 : v2);
  check("  the new version is still closed", st.isClosed === true);
  check("  and still owes nothing", st.outstanding === 0, `${st.outstanding}`);
  cl = await closureOf(v2);
  check("  the closure carries across, reason and all",
    !!cl && cl.reason === "customer cancelled the remainder", cl?.reason);
  check("  reading as the remainder closure it was", cl?.kind === "REMAINDER_CLOSED", cl?.kind);
  check("  on the snapshot taken against the version it was made on",
    cl?.fulfilledAtClosure === 40 && cl?.outstandingAtClosure === 60,
    `${cl?.fulfilledAtClosure}/${cl?.outstandingAtClosure}`);

  const stillShut = await refused(() => P.postGoodsReceipt({ ...base,
    sourceDocumentId: v2, lines: [{ itemId: item.id, qty: 10, unitCost: 600 }] }));
  check("  and it is still not receiving goods", !!stillShut, stillShut?.slice(0, 60));

  // Reopening the corrected version works, and lifts the closure made
  // against the one before it.
  const lifted = await P.reopenOrder({ companyId: co.id, documentId: v2,
    reason: "supplier can supply after all" });
  check("  reopening the new version lifts it", lifted.outstanding === 60,
    `${lifted.outstanding}`);
  check("  and it is open again", (await stateOf(v2)).isClosed === false);

  // ---- closing what cannot be closed --------------------------------------
  //
  // The screen hides both of these, which is not the same as impossible: a
  // script, an import or a replayed submission calls the function directly.

  console.log("\n  closing what cannot be closed\n");

  const once = await fresh();
  await P.closeOrderRemaining({ companyId: co.id, documentId: once.id, reason: "called off" });
  const twice = await refused(() => P.closeOrderRemaining({ companyId: co.id,
    documentId: once.id, reason: "called off again" }));
  check("an order already closed refuses to close again", !!twice, twice?.slice(0, 60));
  const rows = n((await sql`select count(*)::int c from order_closure
    where document_id = ${once.id}`)[0].c);
  check("  and only one closure was written", rows === 1, `${rows}`);

  const complete = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: complete.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  const nothingToClose = await refused(() => P.closeOrderRemaining({ companyId: co.id,
    documentId: complete.id, reason: "tidying up" }));
  check("an order with nothing outstanding refuses too", !!nothingToClose,
    nothingToClose?.slice(0, 70));
  check("  and stays open, because there is nothing to close",
    (await stateOf(complete.id)).isClosed === false);

  // ---- the whole chain, not just the next link ----------------------------
  //
  // One correction was the reported case; a second is where a fix that only
  // looked one step back would give up. And a closure written against v3 has
  // to outrank one written against v1, because the chain is a history, not a
  // set.

  console.log("\n  closed, then corrected twice\n");

  const chain = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: chain.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  await P.closeOrderRemaining({ companyId: co.id, documentId: chain.id,
    reason: "customer cancelled the remainder" });

  const nextVersion = async (id, price) => {
    const [l] = await sql`select id, item_id, base_qty from document_line where document_id = ${id}`;
    const done = await P.amendDocument({ companyId: co.id, documentId: id,
      reason: `price to ${price}`,
      repost: (tx, amendOf) => P.postPurchaseOrder({ ...base, dueDate: today, amendOf,
        lines: [{ itemId: l.item_id, qty: Number(l.base_qty), unitPrice: price,
                  supersedesLineId: l.id }] }, tx) });
    return done.replacementId ?? done.id;
  };

  const v2b = await nextVersion(chain.id, 600);
  const v3 = await nextVersion(v2b, 700);
  check("three versions, all distinct",
    v3 !== v2b && v2b !== chain.id, `${String(chain.id).slice(0,8)} → ${String(v2b).slice(0,8)} → ${String(v3).slice(0,8)}`);

  st = await stateOf(v3);
  check("  v3 is still closed two corrections later", st.isClosed === true);
  check("  and still owes nothing", st.outstanding === 0, `${st.outstanding}`);
  cl = await closureOf(v3);
  check("  with the original reason intact",
    cl?.reason === "customer cancelled the remainder", cl?.reason);
  check("  and the snapshot taken against v1",
    cl?.fulfilledAtClosure === 40 && cl?.outstandingAtClosure === 60,
    `${cl?.fulfilledAtClosure}/${cl?.outstandingAtClosure}`);

  const reopenedV3 = await P.reopenOrder({ companyId: co.id, documentId: v3,
    reason: "supplier can supply the remainder" });
  check("reopening v3 restores what is genuinely left", reopenedV3.outstanding === 60,
    `${reopenedV3.outstanding}`);
  st = await stateOf(v3);
  check("  and v3 owes 60 again", st.outstanding === 60 && st.isClosed === false,
    `${st.outstanding} closed=${st.isClosed}`);

  const closedAgain = await P.closeOrderRemaining({ companyId: co.id, documentId: v3,
    reason: "called off for good" });
  check("closing v3 again is allowed once it is open", closedAgain.outstanding === 60,
    `${closedAgain.outstanding}`);
  cl = await closureOf(v3);
  check("  and the latest word across the chain wins",
    cl?.reason === "called off for good", cl?.reason);
  check("  v3 is closed", (await stateOf(v3)).isClosed === true);

  // ---- a sales order too --------------------------------------------------

  console.log("\n  the same on the sales side\n");

  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  await wipe();
  await sql`update number_series set next_value = 1`;
  // Stock to deliver from, so a refusal below is about the closure and not
  // about an empty shelf.
  await P.postGoodsReceipt({ ...base, lines: [{ itemId: item.id, qty: 200, unitCost: 500 }] });
  const so = await P.postSalesOrder({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 900 }] });
  // postDelivery, not postSaleWithDelivery: the voucher creates its own
  // delivery for a counter sale and never names the order, so it is the wrong
  // door. Delivering against an order is what the Fulfil form posts.
  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, sourceDocumentId: so.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 900 }] });
  st = await stateOf(so.id);
  check("a sales order with 40 delivered has 60 remaining",
    st.fulfilled === 40 && st.outstanding === 60, `${st.fulfilled}/${st.outstanding}`);

  await P.closeOrderRemaining({ companyId: co.id, documentId: so.id,
    reason: "customer cancelled the remainder" });
  const soShut = await refused(() => P.postDelivery({ companyId: co.id,
    partnerId: cust.id, locationId: loc.id, docDate: today,
    sourceDocumentId: so.id, lines: [{ itemId: item.id, qty: 10, unitPrice: 900 }] }));
  check("  delivering against it once closed is refused", !!soShut, soShut?.slice(0, 70));
  check("  and it says deliveries, not goods",
    !!soShut && /deliveries/.test(soShut));
  check("  nothing left", (await stateOf(so.id)).fulfilled === 40);

  // ---- two people closing it at the same moment ---------------------------

  console.log("\n  two people closing it at once\n");

  const contested = await fresh();
  await P.postGoodsReceipt({ ...base, sourceDocumentId: contested.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });

  const rival = postgres(url, { ssl: url.includes("localhost") ? false : "require",
    prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });
  try {
    await rival`select 1`;
    let letGo;
    const holding = new Promise((r) => { letGo = r; });
    const firstClose = rival.begin(async (tx) => {
      await P.closeOrderRemaining({ companyId: co.id, documentId: contested.id,
        reason: "first to press it" }, tx);
      await holding;
      return "committed";
    });
    await new Promise((r) => setTimeout(r, 600));

    let second = null;
    const racing = P.closeOrderRemaining({ companyId: co.id, documentId: contested.id,
      reason: "second to press it" })
      .then(() => { second = "accepted"; })
      .catch((e) => { second = e.message; });
    await new Promise((r) => setTimeout(r, 400));

    // The evidence, not the inference. While that transaction is open its
    // closure must be invisible to everyone else — if it had already
    // committed, the second call would be refused instantly by the
    // already-closed guard and this test would pass while proving nothing.
    // That is exactly what it did while closeOrderRemaining quietly ignored
    // the transaction it was handed and opened its own.
    const seenOutside = await closureOf(contested.id);
    check("the first closure is invisible outside its transaction",
      seenOutside === null, seenOutside ? `leaked: ${seenOutside.reason}` : "");
    check("  so the second is waiting on the row, not refused by the guard",
      second === null, String(second).slice(0, 40));

    letGo();
    await firstClose;
    await racing;
    check("  and is refused once the first commits",
      typeof second === "string" && second !== "accepted", String(second).slice(0, 50));
    const written = n((await sql`select count(*)::int c from order_closure
      where document_id = ${contested.id}`)[0].c);
    check("  exactly one closure was recorded", written === 1, `${written}`);
    cl = await closureOf(contested.id);
    check("  and it is the first one", cl?.reason === "first to press it", cl?.reason);
  } finally {
    await rival.end();
  }

  // ---- a closed order with a bill on it, corrected ------------------------
  //
  // Correcting at the order is how a wrong price reaches the invoice raised
  // through it. That has to keep working on a closed order — the forty that
  // arrived were still billed, and billed wrongly — without the correction
  // itself reopening the sixty that were called off.

  console.log("\n  correcting the price of a closed order that has been billed\n");

  const billed = await fresh();
  const bgr = await P.postGoodsReceipt({ ...base, sourceDocumentId: billed.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500 }] });
  const binv = await P.postPurchaseInvoice({ ...base, dueDate: today, goodsReceiptId: bgr.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 500 }] });
  await P.closeOrderRemaining({ companyId: co.id, documentId: billed.id,
    reason: "supplier discontinued the line" });

  const [bline] = await sql`select id, item_id, base_qty from document_line
    where document_id = ${billed.id}`;
  const cascaded = await P.amendOrder({ companyId: co.id, documentId: billed.id,
    reason: "agreed price was 550", cascade: true,
    order: { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      dueDate: today,
      lines: [{ itemId: bline.item_id, qty: Number(bline.base_qty), unitPrice: 550,
                supersedesLineId: bline.id }] } });
  const billedV2 = cascaded.replacementId;
  check("the correction posts", !!billedV2, String(billedV2).slice(0, 8));

  const [invNow] = await sql`select fn_current_document(${binv.id}) as id`;
  const [invDoc] = await sql`select doc_no, gross_total, status from document where id = ${invNow.id}`;
  check("  the invoice was carried along to the new price",
    near(invDoc.gross_total, 40 * 550), `${n(invDoc.gross_total)}`);
  check("  and is the version that stands now", invDoc.status === "POSTED", invDoc.status);

  st = await stateOf(billedV2);
  check("  and the order is still closed", st.isClosed === true);
  check("  still owing nothing", st.outstanding === 0, `${st.outstanding}`);
  cl = await closureOf(billedV2);
  check("  on the reason it was closed for",
    cl?.reason === "supplier discontinued the line", cl?.reason);

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
  await releaseTestLock(sql);
  await sql.end({ timeout: 5 });
}
