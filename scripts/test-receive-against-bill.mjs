// Receiving against a supplier bill, through the path a person actually uses.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 ./node_modules/.bin/tsx scripts/test-receive-against-bill.mjs
//
// Every other suite calls the posting functions directly, which is the right
// way to test what the ledger does and the wrong way to find out whether the
// screen can reach it. This one goes form → action → parser → posting, because
// that is where the gap was: the engine had always read orderLineId to join a
// receipt to the order behind its bill, and the action's line parser dropped
// the field on the floor. Goods received against a bill left that order at
// zero received, permanently, with nothing in the record joining the two.
//
// Worth being exact about the blast radius, because "any screen" was wrong.
// Receiving from the order itself names the order as its source document and
// has never needed this — that path was always fine. Linking a receipt
// afterwards repairs a missing link. It is receiving against a bill, where
// source_document_id is already spoken for by the invoice, that depended on
// the field nobody passed.
//
// And passing it through is not enough. The caller says which order line the
// goods answer, and a caller is not to be believed: the server has to check
// the named line is one the bill was actually raised from, or a wrong link
// closes the wrong order and nothing downstream reveals which.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";

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

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const round = (v) => Math.round(Number(v) * 10000) / 10000;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
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
  await takeTestLock(sql, "test-receive-against-bill.mjs");

  const P = await import("../lib/posting.ts");
  const Q = await import("../lib/queries.ts");
  const A = await import("../lib/actions.ts");

  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const items = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 2`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const item = items[0];
  console.log(`\n  ${co.name}`);

  const wipe = () => sql.unsafe(`truncate table posting_attempt, document_history,
    fulfilment_link, order_closure, payment_allocation, stock_lot_adjustment,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  /**
   * The form's submission, as FormData. Not a call into postGoodsReceipt:
   * the whole point is to cross the parser that was dropping the field.
   */
  const submit = async (billId, lines, opts = {}) => {
    const fd = new FormData();
    fd.set("partner_id", supp.id);
    fd.set("location_id", loc.id);
    fd.set("doc_date", today);
    fd.set("source_document_id", billId ?? "");
    fd.set("idempotency_key", opts.attemptKey ?? crypto.randomUUID());
    fd.set("lines", JSON.stringify(lines));
    return A.createGoodsReceipt(null, fd);
  };
  /**
   * What the action did, told apart from how it ended.
   *
   * A server action reports a refusal by returning { error }, and reports
   * success by redirecting — which throws a Next.js control-flow error rather
   * than returning at all. Outside a request there is a third ending: the
   * posting commits and then revalidatePath throws for want of a request
   * context. Reading any throw as failure called successful posts failures,
   * and reading a returned { error } as success called refusals posts. Both
   * happened here before this was written properly.
   */
  const ran = async (fn) => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "error" in r && r.error) {
        return { ok: false, error: String(r.error) };
      }
      return { ok: true, error: null };
    } catch (e) {
      const msg = String(e?.message ?? e);
      // Redirected: posted, and went somewhere.
      if (e?.digest?.startsWith?.("NEXT_REDIRECT") || msg.includes("NEXT_REDIRECT")) {
        return { ok: true, error: null };
      }
      // Posted, then failed to tell the cache about it. Not a refusal: the
      // document is in the ledger by this point.
      if (msg.includes("static generation store missing")) return { ok: true, error: null };
      return { ok: false, error: msg };
    }
  };

  const orderState = async (orderId) => {
    const [r] = await sql`
      select coalesce(sum(ordered), 0)::float o, coalesce(sum(fulfilled), 0)::float f,
             coalesce(sum(outstanding), 0)::float out
        from v_order_outstanding where company_id = ${co.id} and order_id = ${orderId}`;
    return { ordered: n(r.o), fulfilled: n(r.f), remaining: n(r.out) };
  };

  /** An order, a bill raised from it, and part of it already received. */
  const setup = async ({ ordered = 50, billed = 50, already = 0 } = {}) => {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const po = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: ordered, unitPrice: 1000 }] });
    const [ol] = await sql`select id from document_line where document_id = ${po.id}`;
    const bill = await P.postPurchaseInvoice({ ...base, dueDate: today,
      sourceDocumentId: po.id,
      lines: [{ itemId: item.id, qty: billed, unitPrice: 1000, sourceLineId: ol.id }] });
    if (already > 0) {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: po.id,
        lines: [{ itemId: item.id, qty: already, unitCost: 1000, sourceLineId: ol.id }] });
    }
    const [bl] = await sql`select id from document_line where document_id = ${bill.id}`;
    return { po, ol, bill, billLineId: bl.id };
  };

  // ---- the whole path, end to end ----------------------------------------

  console.log("\n  50 ordered, 30 already in, the last 20 received against the bill\n");
  {
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 30 });
    let st = await orderState(po.id);
    check("the order starts at 30 of 50", st.fulfilled === 30 && st.remaining === 20,
      `${st.fulfilled}/${st.remaining}`);

    // What the form would send, taken from the query that feeds it rather
    // than hand-written, so the test breaks if that query stops carrying it.
    const open = await Q.getOpenPurchaseInvoices(co.id);
    const asShown = open.find((b) => b.id === bill.id);
    check("  the form is given the order line behind the bill line",
      asShown?.lines?.[0]?.orderLineId === ol.id,
      String(asShown?.lines?.[0]?.orderLineId).slice(0, 8));

    const r = await ran(() => submit(bill.id, [{
      itemId: item.id, qty: 20, unitCost: 1000,
      sourceLineId: billLineId,
    }]));
    check("  the action posts it", r.ok, String(r.error).slice(0, 70));

    st = await orderState(po.id);
    check("  the order is now 50 received, 0 remaining",
      st.fulfilled === 50 && st.remaining === 0, `${st.fulfilled}/${st.remaining}`);

    const links = n((await sql`select count(*)::int c from fulfilment_link
      where order_line_id = ${ol.id}`)[0].c);
    check("  and the fulfilment link exists", links === 1, `${links}`);
  }

  // ---- a partial receipt --------------------------------------------------

  console.log("\n  the same, but only 10 arrive\n");
  {
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 30 });
    const r = await ran(() => submit(bill.id, [{
      itemId: item.id, qty: 10, unitCost: 1000, sourceLineId: billLineId,
    }]));
    check("the action posts it", r.ok, String(r.error).slice(0, 70));
    const st = await orderState(po.id);
    check("  40 received, 10 remaining", st.fulfilled === 40 && st.remaining === 10,
      `${st.fulfilled}/${st.remaining}`);
  }

  // ---- one bill, lines from two different orders --------------------------

  console.log("\n  one bill covering lines from two orders\n");
  {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const itemB = items[1] ?? item;
    const poA = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 40, unitPrice: 1000 }] });
    const poB = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: itemB.id, qty: 60, unitPrice: 1000 }] });
    const [olA] = await sql`select id from document_line where document_id = ${poA.id}`;
    const [olB] = await sql`select id from document_line where document_id = ${poB.id}`;

    // One bill, two lines, each naming the order line it came from.
    const bill = await P.postPurchaseInvoice({ ...base, dueDate: today,
      lines: [
        { itemId: item.id, qty: 40, unitPrice: 1000, sourceLineId: olA.id },
        { itemId: itemB.id, qty: 60, unitPrice: 1000, sourceLineId: olB.id },
      ] });
    const bls = await sql`select id, item_id from document_line
      where document_id = ${bill.id} order by line_no`;

    const r = await ran(() => submit(bill.id, [
      { itemId: item.id, qty: 15, unitCost: 1000, sourceLineId: bls[0].id },
      { itemId: itemB.id, qty: 25, unitCost: 1000, sourceLineId: bls[1].id },
    ]));
    check("the action posts it", r.ok, String(r.error).slice(0, 70));

    const a = await orderState(poA.id);
    const b = await orderState(poB.id);
    check("  the first order takes only its own 15", a.fulfilled === 15 && a.remaining === 25,
      `${a.fulfilled}/${a.remaining}`);
    check("  and the second only its own 25", b.fulfilled === 25 && b.remaining === 35,
      `${b.fulfilled}/${b.remaining}`);
  }

  // ---- a caller naming an order line that has nothing to do with the bill --

  console.log("\n  a caller names somebody else's order line\n");
  {
    // Not through the action: the line parser does not carry orderLineId, and
    // that is itself the protection — no screen can make this claim. The
    // check exists for callers that reach the engine directly, so that is
    // where it is asked.
    const { bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 0 });
    const other = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 50, unitPrice: 1000 }] });
    const [strayLine] = await sql`select id from document_line where document_id = ${other.id}`;

    let refused = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 1000,
                  sourceLineId: billLineId, orderLineId: strayLine.id }] });
    } catch (e) { refused = e.message; }

    check("naming an order line the bill was not raised from is refused",
      refused !== null, String(refused).slice(0, 80));
    check("  and the innocent order is untouched",
      (await orderState(other.id)).fulfilled === 0);
    const receipts = n((await sql`select count(*)::int c from document
      where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'`)[0].c);
    check("  nothing was posted", receipts === 0, `${receipts}`);
  }
  {
    // And a line the bill WAS raised from allocates once, not twice — the
    // explicit claim and the bill's own trail lead to the same order line.
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 0 });
    let err = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
        lines: [{ itemId: item.id, qty: 20, unitCost: 1000,
                  sourceLineId: billLineId, orderLineId: ol.id }] });
    } catch (e) { err = e.message; }
    check("naming the right order line explicitly still posts", err === null,
      String(err).slice(0, 70));
    const st = await orderState(po.id);
    check("  and allocates 20 once, not 40 twice",
      st.fulfilled === 20 && st.remaining === 30, `${st.fulfilled}/${st.remaining}`);
    const allocated = n((await sql`select coalesce(sum(qty), 0)::float q
      from fulfilment_link where order_line_id = ${ol.id}`)[0].q);
    check("  with one allocation of 20", allocated === 20, `${allocated}`);
  }

  // ---- the order moved between loading the form and submitting it ---------

  console.log("\n  the order is corrected, or closed, before the form is sent\n");
  {
    // Corrected: the order line the form was given is superseded, and the
    // quantity must still land on the version that now stands.
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 0 });
    const amended = await P.amendDocument({ companyId: co.id, documentId: po.id,
      reason: "price was wrong",
      repost: (tx, amendOf) => P.postPurchaseOrder({ ...base, dueDate: today, amendOf,
        lines: [{ itemId: item.id, qty: 50, unitPrice: 1100, supersedesLineId: ol.id }] }, tx) });
    const v2 = amended.replacementId ?? amended.id;

    const r = await ran(() => submit(bill.id, [{
      itemId: item.id, qty: 20, unitCost: 1000, sourceLineId: billLineId,
    }]));
    check("a receipt naming the old version still posts", r.ok, String(r.error).slice(0, 70));
    const st = await orderState(v2);
    check("  and lands on the version that stands now",
      st.fulfilled === 20 && st.remaining === 30, `${st.fulfilled}/${st.remaining}`);
  }
  {
    // Closed: the order is not expecting anything, whichever door the goods
    // come to.
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 0 });
    await P.closeOrderRemaining({ companyId: co.id, documentId: po.id,
      reason: "supplier discontinued the line" });
    const r = await ran(() => submit(bill.id, [{
      itemId: item.id, qty: 20, unitCost: 1000, sourceLineId: billLineId,
    }]));
    check("a receipt against a closed order is refused", !r.ok, String(r.error).slice(0, 70));
    check("  and nothing arrived", (await orderState(po.id)).fulfilled === 0);
  }
  {
    // More than the order has left, through the bill.
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 30 });
    const r = await ran(() => submit(bill.id, [{
      itemId: item.id, qty: 40, unitCost: 1000, sourceLineId: billLineId,
    }]));
    /**
     * Intentional over-receipt, which the design allows. Four different
     * quantities live in this one case and describing them loosely gets them
     * confused, so each is asked for on its own:
     *
     *   50 ordered, of which 30 arrived earlier, against the order itself.
     *   This receipt brings 40 more, against the bill.
     *   The order can still take 20, so 20 of this receipt answers it.
     *   The other 20 of this receipt answer nothing.
     *
     * "Matched to the bill" and "allocated to the order" are not the same
     * number and must not be reported as one: all 40 of this receipt match
     * the bill, and only 20 of it reaches the order.
     */
    check("more than the order has left still posts", r.ok, String(r.error).slice(0, 70));

    const [rec] = await sql`select id, doc_no from document
      where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'
        and source_document_id = ${bill.id} order by doc_no desc limit 1`;

    const thisReceipt = n((await sql`select coalesce(sum(base_qty), 0)::float q
      from document_line where document_id = ${rec.id}`)[0].q);
    check("  this receipt records 40", thisReceipt === 40, `${thisReceipt}`);

    const thisAllocation = n((await sql`select coalesce(sum(fl.qty), 0)::float q
      from fulfilment_link fl
      join document_line dl on dl.id = fl.fulfilment_line_id
     where dl.document_id = ${rec.id}`)[0].q);
    check("  of which 20 is newly allocated to the order", thisAllocation === 20,
      `${thisAllocation}`);
    check("  leaving 20 of this receipt allocated to no order",
      round(thisReceipt - thisAllocation) === 20, `${round(thisReceipt - thisAllocation)}`);

    // All 40 answer the bill, even the 20 the order could not take. Matching
    // a bill and answering an order are separate statements.
    const matchedToBill = thisReceipt;
    check("  while all 40 match the bill", matchedToBill === 40, `${matchedToBill}`);

    /**
     * The earlier 30 are not in fulfilment_link, and looking for them there
     * found nothing — which is worth saying plainly, because it is easy to
     * assume every allocation lives in one table.
     *
     * Fulfilment is recorded two ways, by route. A receipt raised from the
     * order names the order's line on its own line, and v_order_outstanding
     * counts that directly. A receipt raised from a bill cannot — its lines
     * already name the bill's lines — so the link is written to
     * fulfilment_link instead. Both are verified links; neither is a guess;
     * and the order's total is the two summed, which is what the view does.
     */
    const earlier = n((await sql`select coalesce(sum(dl.base_qty), 0)::float q
      from document_line dl
      join document d on d.id = dl.document_id
     where d.doc_type = 'GOODS_RECEIPT' and d.status = 'POSTED'
       and dl.document_id <> ${rec.id} and dl.source_line_id = ${ol.id}`)[0].q);
    check("  the earlier receipt's 30 are recorded on its own lines, not as links",
      earlier === 30, `${earlier}`);

    const viaLinks = n((await sql`select coalesce(sum(qty), 0)::float q
      from fulfilment_link where order_line_id = ${ol.id}`)[0].q);
    check("  fulfilment_link holds only this receipt's 20", viaLinks === 20, `${viaLinks}`);
    check("  and the two routes together make the order's 50",
      round(earlier + viaLinks) === 50, `${round(earlier + viaLinks)}`);

    const st = await orderState(po.id);
    check("  and the order reads 50 of 50, nothing remaining",
      st.fulfilled === 50 && st.remaining === 0, `${st.fulfilled}/${st.remaining}`);

    const onShelf = n((await sql`select coalesce(sum(qty), 0)::float q from stock_movement
      where company_id = ${co.id} and item_id = ${item.id}`)[0].q);
    check("  with all 70 physically on the shelf", onShelf === 70, `${onShelf}`);
  }

  // ---- the two ways of counting must not count the same goods twice -------

  console.log("\n  one receipt, two routes to the same order line\n");
  {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const po = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
    const [ol] = await sql`select id from document_line where document_id = ${po.id}`;

    // v_order_outstanding adds the two routes together. A line that names the
    // order AND claims it explicitly was counted twice: 20 arrived and the
    // order read 40 received.
    let err = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: po.id,
        lines: [{ itemId: item.id, qty: 20, unitCost: 1000,
                  sourceLineId: ol.id, orderLineId: ol.id }] });
    } catch (e) { err = e.message; }
    check("naming the order and claiming it by hand is refused", err !== null,
      String(err).slice(0, 70));
    check("  and nothing was counted at all",
      (await orderState(po.id)).fulfilled === 0);

    // Receiving against it the ordinary way still works, counted once.
    const r2 = await ran(() => {
      const fd = new FormData();
      fd.set("partner_id", supp.id); fd.set("location_id", loc.id);
      fd.set("doc_date", today); fd.set("source_document_id", po.id);
      fd.set("idempotency_key", crypto.randomUUID());
      fd.set("lines", JSON.stringify([
        { itemId: item.id, qty: 20, unitCost: 1000, sourceLineId: ol.id }]));
      return A.createGoodsReceipt(null, fd);
    });
    check("  the ordinary route posts", r2.ok, String(r2.error).slice(0, 60));
    check("  and 20 is counted once, not twice",
      (await orderState(po.id)).fulfilled === 20,
      `${(await orderState(po.id)).fulfilled}`);
  }

  // ---- two receipt lines, one claimed by hand and one left to the bill -----

  console.log("\n  two lines on one receipt, answering the same order line\n");
  {
    const { po, ol, bill } = await setup({ ordered: 100, billed: 100, already: 0 });
    const bls = await sql`select id from document_line where document_id = ${bill.id}
      order by line_no`;
    // One bill line, two receipt lines of 10 each against it: the first
    // claimed explicitly, the second left to the automatic trail.
    let err = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
        lines: [
          { itemId: item.id, qty: 10, unitCost: 1000,
            sourceLineId: bls[0].id, orderLineId: ol.id },
          { itemId: item.id, qty: 10, unitCost: 1000, sourceLineId: bls[0].id },
        ] });
    } catch (e) { err = e.message; }
    check("both lines post", err === null, String(err).slice(0, 70));

    const st = await orderState(po.id);
    check("  the order is credited with all 20, not just the claimed 10",
      st.fulfilled === 20, `${st.fulfilled}`);
    const onShelf = n((await sql`select coalesce(sum(qty), 0)::float q from stock_movement
      where company_id = ${co.id} and item_id = ${item.id}`)[0].q);
    check("  and stock and fulfilment agree", onShelf === 20 && st.fulfilled === 20,
      `stock ${onShelf}, fulfilled ${st.fulfilled}`);
  }

  // ---- one bill, the same item from two orders ----------------------------

  console.log("\n  one bill carrying the same item from two orders\n");
  {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const poA = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 40, unitPrice: 1000 }] });
    const poB = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 60, unitPrice: 1000 }] });
    const [olA] = await sql`select id from document_line where document_id = ${poA.id}`;
    const [olB] = await sql`select id from document_line where document_id = ${poB.id}`;
    const bill = await P.postPurchaseInvoice({ ...base, dueDate: today,
      lines: [
        { itemId: item.id, qty: 40, unitPrice: 1000, sourceLineId: olA.id },
        { itemId: item.id, qty: 60, unitPrice: 1000, sourceLineId: olB.id },
      ] });
    const bls = await sql`select id from document_line where document_id = ${bill.id}
      order by line_no`;

    // Receiving against the line billed from A while claiming B. Both order
    // lines are on this bill, so a bill-wide membership test lets it through.
    let err = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 1000,
                  sourceLineId: bls[0].id, orderLineId: olB.id }] });
    } catch (e) { err = e.message; }
    check("claiming the other order's line is refused", err !== null,
      String(err).slice(0, 80));
    check("  neither order moved",
      (await orderState(poA.id)).fulfilled === 0
      && (await orderState(poB.id)).fulfilled === 0);

    // The honest claim is accepted.
    let ok = null;
    try {
      await P.postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
        lines: [{ itemId: item.id, qty: 10, unitCost: 1000,
                  sourceLineId: bls[0].id, orderLineId: olA.id }] });
    } catch (e) { ok = e.message; }
    check("  claiming its own order's line posts", ok === null, String(ok).slice(0, 70));
    check("  and only that order takes the 10",
      (await orderState(poA.id)).fulfilled === 10
      && (await orderState(poB.id)).fulfilled === 0,
      `${(await orderState(poA.id)).fulfilled}/${(await orderState(poB.id)).fulfilled}`);
  }

  // ---- a bill covering two orders, one of them closed ---------------------

  console.log("\n  one bill, two orders, one of them closed\n");
  {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const itemB = items[1] ?? item;
    const openPo = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: item.id, qty: 40, unitPrice: 1000 }] });
    const shutPo = await P.postPurchaseOrder({ ...base, dueDate: today,
      lines: [{ itemId: itemB.id, qty: 60, unitPrice: 1000 }] });
    const [olOpen] = await sql`select id from document_line where document_id = ${openPo.id}`;
    const [olShut] = await sql`select id from document_line where document_id = ${shutPo.id}`;
    const bill = await P.postPurchaseInvoice({ ...base, dueDate: today,
      lines: [
        { itemId: item.id, qty: 40, unitPrice: 1000, sourceLineId: olOpen.id },
        { itemId: itemB.id, qty: 60, unitPrice: 1000, sourceLineId: olShut.id },
      ] });
    const bls = await sql`select id, item_id from document_line
      where document_id = ${bill.id} order by line_no`;
    await P.closeOrderRemaining({ companyId: co.id, documentId: shutPo.id,
      reason: "supplier discontinued the line" });

    const r = await ran(() => submit(bill.id, [
      { itemId: item.id, qty: 15, unitCost: 1000, sourceLineId: bls[0].id },
      { itemId: itemB.id, qty: 25, unitCost: 1000, sourceLineId: bls[1].id },
    ]));
    check("the whole receipt is refused, not just the closed half", !r.ok,
      String(r.error).slice(0, 80));
    check("  and it says which order to reopen",
      !r.ok && /Reopen/.test(String(r.error)) && String(r.error).includes("PO"));

    const receipts = n((await sql`select count(*)::int c from document
      where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'`)[0].c);
    check("  no receipt was left behind", receipts === 0, `${receipts}`);
    const moves = n((await sql`select count(*)::int c from stock_movement
      where company_id = ${co.id}`)[0].c);
    check("  no stock moved", moves === 0, `${moves}`);
    check("  and the open order took nothing either",
      (await orderState(openPo.id)).fulfilled === 0);
  }

  // ---- the same submission twice ------------------------------------------

  console.log("\n  the confirmation is sent twice\n");
  {
    const { po, ol, bill, billLineId } = await setup({ ordered: 50, billed: 50, already: 30 });
    const key = crypto.randomUUID();
    const line = [{ itemId: item.id, qty: 20, unitCost: 1000, sourceLineId: billLineId }];

    const first = await ran(() => submit(bill.id, line, { attemptKey: key }));
    const again = await ran(() => submit(bill.id, line, { attemptKey: key }));
    check("both submissions are accepted", first.ok && again.ok,
      `${first.error ?? "ok"} / ${again.error ?? "ok"}`);

    const receipts = n((await sql`select count(*)::int c from document
      where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'
        and source_document_id = ${bill.id}`)[0].c);
    check("  but only one receipt exists", receipts === 1, `${receipts}`);
    const moves = n((await sql`select count(*)::int c from stock_movement sm
      join document d on d.id = sm.document_id
     where d.doc_type = 'GOODS_RECEIPT' and d.source_document_id = ${bill.id}`)[0].c);
    check("  one set of stock movements", moves === 1, `${moves}`);
    const allocs = n((await sql`select count(*)::int c from fulfilment_link
      where order_line_id = ${ol.id}`)[0].c);
    check("  one set of fulfilment allocations", allocs === 1, `${allocs}`);
    const links = n((await sql`select coalesce(sum(qty), 0)::float q from fulfilment_link
      where order_line_id = ${ol.id}`)[0].q);
    check("  and the order was fulfilled once, not twice", links === 20, `${links}`);
    const st = await orderState(po.id);
    check("  leaving 50 of 50", st.fulfilled === 50 && st.remaining === 0,
      `${st.fulfilled}/${st.remaining}`);
  }

  await wipe();
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0
    ? "\n  the screen can reach what the engine always did\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
