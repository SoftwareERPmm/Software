// One submission, one posting.
//
//   ./node_modules/.bin/tsx scripts/test-idempotency.mjs
//
// A double-clicked button, a browser resending a request it could not
// confirm, a platform retry — each arrives as a second identical request, and
// every posting path here was free to turn it into a second document with its
// own stock movements and its own journal entry.
//
// Not to be confused with the same goods genuinely arriving twice, which is a
// fact and must stay postable. That is a deliberate second transaction and
// carries a key of its own; these tests check both halves.

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
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 4 });

const P = await import("../lib/posting.ts");
const { postOnce } = await import("../lib/idempotency.ts");

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
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table posting_attempt, document_history, fulfilment_link,
    order_closure, payment_allocation, stock_lot_adjustment, stock_lot_consumption,
    stock_lot, stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const receive = (key) => postOnce(co.id, key, (tx) => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitCost: 100 }],
  }, tx));

  const counts = async () => {
    const [d] = await sql`select count(*)::int n from document
       where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'`;
    const [s] = await sql`select coalesce(sum(qty), 0)::float q from stock_movement
       where company_id = ${co.id} and item_id = ${item.id}`;
    const [j] = await sql`select count(*)::int n from journal_entry
       where company_id = ${co.id}`;
    return { docs: d.n, stock: n(s.q), entries: j.n };
  };

  // ---- the same submission, sent twice -----------------------------------

  console.log("  the same submission, sent twice\n");

  const first = await receive("attempt-A");
  const one = await counts();
  const again = await receive("attempt-A");
  const two = await counts();

  check("the retry is handed the document the first one posted",
    again.id === first.id, `${again.docNo} vs ${first.docNo}`);
  check("  and says it was a repeat", again.repeated === true);
  check("  no second document", two.docs === one.docs, `${one.docs} → ${two.docs}`);
  check("  no second stock movement", two.stock === one.stock, `${one.stock} → ${two.stock}`);
  check("  no second journal entry", two.entries === one.entries,
    `${one.entries} → ${two.entries}`);

  // ---- a deliberate second transaction -----------------------------------

  console.log("\n  a deliberate second transaction\n");

  const other = await receive("attempt-B");
  const three = await counts();
  check("a new key posts a new document", other.id !== first.id, other.docNo);
  check("  and the goods really arrive", three.stock === one.stock + 10,
    `${one.stock} → ${three.stock}`);
  check("  with a journal entry of its own", three.entries === one.entries + 1);

  // ---- two requests at once ----------------------------------------------
  // The double-click that lands twice before the first has finished. Settled
  // by the database, not by hoping they do not overlap.

  console.log("\n  two requests at once\n");

  const before = await counts();
  const [a, b] = await Promise.all([receive("attempt-C"), receive("attempt-C")]);
  const after = await counts();

  check("both requests get the same document", a.id === b.id, `${a.docNo} / ${b.docNo}`);
  check("  exactly one was posted", after.docs === before.docs + 1,
    `${before.docs} → ${after.docs}`);
  check("  and the stock moved once", after.stock === before.stock + 10,
    `${before.stock} → ${after.stock}`);
  check("  one of them knows it was the repeat",
    (a.repeated === true) !== (b.repeated === true));

  // ---- a posting that was refused ----------------------------------------
  // A claim is not a posted document. If the posting fails, the key must be
  // free for the correction that follows.

  console.log("\n  a refusal does not burn the key\n");

  let refused = null;
  try {
    await postOnce(co.id, "attempt-D", (tx) => P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: -5, unitCost: 100 }],
    }, tx));
  } catch (e) { refused = e.message; }
  check("the refusal is passed through", !!refused, refused?.slice(0, 50));

  const retried = await postOnce(co.id, "attempt-D", (tx) => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 5, unitCost: 100 }],
  }, tx));
  check("  and the same key may be used again once it is corrected", !!retried.id,
    retried.docNo);

  // ---- the posting commits, the bookkeeping does not ---------------------
  // The hole the first version had: it posted, committed, and then recorded
  // the result separately. Anything going wrong in between released the key,
  // and the retry posted everything a second time. Now the claim, the
  // documents and the record of them are one transaction — if the attempt row
  // is not there, neither is the document.

  console.log("\n  a posting that cannot be recorded is not a posting\n");

  const beforeTorn = await counts();
  let torn = null;
  try {
    await postOnce(co.id, "attempt-E", async (tx) => {
      const r = await P.postGoodsReceipt({
        companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
        lines: [{ itemId: item.id, qty: 7, unitCost: 100 }],
      }, tx);
      // Whatever might go wrong between posting and recording it.
      throw new Error("connection lost after posting");
    });
  } catch (e) { torn = e.message; }
  const afterTorn = await counts();

  check("the failure is passed through", !!torn, torn?.slice(0, 40));
  check("  and the goods it posted went back with it",
    afterTorn.docs === beforeTorn.docs && afterTorn.stock === beforeTorn.stock,
    `${beforeTorn.docs}/${beforeTorn.stock} → ${afterTorn.docs}/${afterTorn.stock}`);
  check("  leaving no claim on a document that does not exist",
    n((await sql`select count(*)::int n from posting_attempt
                  where key = 'attempt-E'`)[0].n) === 0);

  const afterRetry = await postOnce(co.id, "attempt-E", (tx) => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 7, unitCost: 100 }],
  }, tx));
  check("  so the retry posts it once", !!afterRetry.id
    && n((await counts()).docs) === beforeTorn.docs + 1, afterRetry.docNo);


  // ---- a correction confirmed twice ---------------------------------------
  //
  // The confirmation button pressed again, or the request resent. Without a
  // key this posts a second correction: v2 becomes v3, for a change nobody
  // asked for twice. And the check that the plan is still current makes it
  // worse — by the time the retry arrives the document *has* moved, because
  // this retry's own first attempt moved it, so the reader is told their
  // correction is out of date rather than that it worked.

  console.log("\n  a correction confirmed twice\n");

  const order = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }],
  });
  const [ordLine] = await sql`select id from document_line where document_id = ${order.id}`;

  const correct = (key) => postOnce(co.id, key, async (tx) => {
    const done = await P.amendOrder({
      companyId: co.id, documentId: order.id, reason: "price to 1,200",
      order: { companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 1200, supersedesLineId: ordLine.id }] },
      cascade: true,
    }, tx);
    return { ...done, id: done.replacementId, docNo: done.docNo ?? "" };
  });

  const corrected = await correct("confirm-A");
  const versionsAfterOne = n((await sql`select count(*)::int n from document
     where doc_no = ${order.docNo}`)[0].n);

  const confirmedAgain = await correct("confirm-A");
  const versionsAfterTwo = n((await sql`select count(*)::int n from document
     where doc_no = ${order.docNo}`)[0].n);

  check("the retry is handed the correction that went through",
    confirmedAgain.id === corrected.id);
  check("  and says it was a repeat", confirmedAgain.repeated === true);
  check("  no second version of the order", versionsAfterTwo === versionsAfterOne,
    `${versionsAfterOne} → ${versionsAfterTwo}`);
  check("  the order stands at v2, not v3",
    n((await sql`select version from document where doc_no = ${order.docNo}
                  and superseded_by_document_id is null`)[0].version) === 2);


  // ---- two confirmations at once, through the server action ---------------
  //
  // The case a sequential retry cannot reach. alreadyPosted() answers the
  // second press once the first has committed — but two requests arriving
  // together both look before either has finished, both find nothing, and
  // both go on. What stops the second is the claim: its insert blocks on the
  // first, and when the first commits the second is handed what it did.
  //
  // Through the action itself, not the helper, because the action is what a
  // browser reaches: the staleness check, the correction and the redirect all
  // have to survive the race together.

  console.log("\n  two confirmations at once, through the action\n");

  const A = await import("../lib/actions.ts");

  const raced = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 500 }],
  });
  const [racedLine] = await sql`select id from document_line where document_id = ${raced.id}`;

  const confirmation = () => {
    const fd = new FormData();
    fd.set("document_id", raced.id);
    fd.set("reason", "price corrected to 550");
    fd.set("idempotency_key", "race-key");
    fd.set("lines", JSON.stringify([
      { lineId: racedLine.id, itemId: item.id, qty: 4, unitPrice: 550 },
    ]));
    return fd;
  };

  // A server action ends in a redirect, which throws. Both outcomes are read
  // from the documents themselves rather than from what came back.
  const settle = async (fd) => {
    try { return { value: await A.correctOrder(null, fd) }; }
    catch (e) { return { thrown: e }; }
  };
  const [raceA, raceB] = await Promise.all([settle(confirmation()), settle(confirmation())]);

  /**
   * An action ends by revalidating and redirecting, and both of those want a
   * request context this script does not have — so each call ends in Next's
   * own complaint about that, thrown after the correction has been made and
   * committed. What matters here is that neither ended in a refusal of its
   * own, which is what the documents are read for below.
   */
  const finishedTheWork = (r) =>
    !!r.thrown && /NEXT_REDIRECT|static generation store/.test(
      String(r.thrown.digest ?? r.thrown.message ?? ""));
  const errored = (r) => r.value && typeof r.value === "object" && "error" in r.value;

  const versions = await sql`select id, version, status from document
     where doc_no = ${raced.docNo} order by version`;
  const [live] = await sql`select version, gross_total::float g from document
     where doc_no = ${raced.docNo} and superseded_by_document_id is null`;

  check("neither confirmation comes back an error",
    !errored(raceA) && !errored(raceB),
    [raceA, raceB].map((r) => errored(r) ? r.value.error.slice(0, 40) : "ok").join(" / "));
  check("  neither is told its plan is stale",
    !(raceA.value?.stale || raceB.value?.stale));
  check("  both get past the correction rather than failing on it",
    finishedTheWork(raceA) && finishedTheWork(raceB),
    [raceA, raceB].map((r) => finishedTheWork(r) ? "done" : (r.thrown?.message?.slice(0, 40) ?? "value")).join(" / "));
  check("  the order is corrected once, to v2", n(live?.version) === 2,
    `v${live?.version} of ${versions.length} versions`);
  check("  and it says what the correction said", near(live?.g, 2200), `${live?.g}`);

  // ---- no key at all ------------------------------------------------------
  // Scripts, imports and the suites post directly. A missing key must never
  // become a silent refusal to post.

  console.log("\n  no key at all\n");

  const p1 = await receive(null);
  const p2 = await receive(undefined);
  check("two keyless postings are two documents", p1.id !== p2.id);

  console.log(bad === 0 ? "\n  one submission, one posting\n" : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
