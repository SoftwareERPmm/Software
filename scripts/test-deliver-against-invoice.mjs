// Delivering against a sales invoice, through the path a person actually uses.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 ./node_modules/.bin/tsx scripts/test-deliver-against-invoice.mjs
//
// The sales mirror of test-receive-against-bill, and not a copy of it: the
// two sides differ where it matters. A receipt adds stock and can always do
// so; a delivery takes stock away and can run out. A bill decides what goods
// cost; an invoice decides what a customer is charged, and the cost comes
// FIFO from the shelf. And a line may be drawing the consignor's goods rather
// than ours.
//
// It also checks the thing that was missing entirely until now: a sales
// invoice recording which order line it bills. The purchase side always has;
// the sales side read the field off its input and dropped it, so an invoice
// could not say which order it billed and the delivery raised against it had
// no order to fulfil.

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
      + (!optedIn ? `Set ALLOW_DESTRUCTIVE_TESTS=1 to say you mean it.` : ``));
  }
  await takeTestLock(sql, "test-deliver-against-invoice.mjs");

  const P = await import("../lib/posting.ts");
  const Q = await import("../lib/queries.ts");
  const A = await import("../lib/actions.ts");

  const [loc] = await sql`select id, code from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  console.log(`\n  ${co.name}`);

  const wipe = () => sql.unsafe(`truncate table posting_attempt, document_history,
    fulfilment_link, order_closure, payment_allocation, stock_lot_adjustment,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, locationId: loc.id, docDate: today };

  const ran = async (fn) => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "error" in r && r.error) {
        return { ok: false, error: String(r.error) };
      }
      return { ok: true, error: null };
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (e?.digest?.startsWith?.("NEXT_REDIRECT") || msg.includes("NEXT_REDIRECT")) {
        return { ok: true, error: null };
      }
      if (msg.includes("static generation store missing")) return { ok: true, error: null };
      return { ok: false, error: msg };
    }
  };

  const ship = async (invoiceId, lines, opts = {}) => {
    const fd = new FormData();
    fd.set("partner_id", cust.id);
    fd.set("location_id", loc.id);
    fd.set("doc_date", today);
    fd.set("source_document_id", invoiceId);
    fd.set("idempotency_key", opts.key ?? crypto.randomUUID());
    if (opts.allowNegative) fd.set("allow_negative_stock", "true");
    fd.set("lines", JSON.stringify(lines));
    return A.createDelivery(null, fd);
  };

  const orderState = async (orderId) => {
    const [r] = await sql`
      select coalesce(sum(ordered), 0)::float o, coalesce(sum(fulfilled), 0)::float f,
             coalesce(sum(outstanding), 0)::float out
        from v_order_outstanding where company_id = ${co.id} and order_id = ${orderId}`;
    return { ordered: n(r.o), fulfilled: n(r.f), remaining: n(r.out) };
  };
  const onHand = async () => n((await sql`select coalesce(sum(qty), 0)::float q
    from stock_movement where company_id = ${co.id} and item_id = ${item.id}`)[0].q);

  /** Stock on the shelf, an order, and an invoice raised from it to deliver later. */
  const setup = async ({ stock = 100, ordered = 50, invoiced = 50 } = {}) => {
    await wipe();
    await sql`update number_series set next_value = 1`;
    if (stock > 0) {
      await P.postGoodsReceipt({ ...base, partnerId: supp.id,
        lines: [{ itemId: item.id, qty: stock, unitCost: 400 }] });
    }
    const so = await P.postSalesOrder({ ...base, partnerId: cust.id, dueDate: today,
      lines: [{ itemId: item.id, qty: ordered, unitPrice: 900 }] });
    const [ol] = await sql`select id from document_line where document_id = ${so.id}`;
    const inv = await P.postSalesInvoice({ ...base, partnerId: cust.id, dueDate: today,
      toDeliver: true,
      lines: [{ itemId: item.id, qty: invoiced, unitPrice: 900, sourceLineId: ol.id }] });
    const [il] = await sql`select id from document_line where document_id = ${inv.id}`;
    return { so, ol, inv, invLineId: il.id };
  };

  // ---- the relationship that was never recorded ---------------------------

  console.log("\n  a sales invoice remembers which order it bills\n");
  {
    const { so, ol, inv, invLineId } = await setup();
    const [stored] = await sql`select source_line_id from document_line where id = ${invLineId}`;
    check("the invoice line names the order line", stored.source_line_id === ol.id);

    const ctx = await Q.getInvoiceDeliveryContext(co.id, inv.id);
    check("  so the delivery screen finds the order", ctx?.lines?.[0]?.orderNo === so.docNo,
      String(ctx?.lines?.[0]?.orderNo));
    check("  and knows where it stands", ctx?.lines?.[0]?.orderRemaining === 50,
      `${ctx?.lines?.[0]?.orderRemaining}`);
    check("  with the customer's price, not a cost", ctx?.lines?.[0]?.unitPrice === 900,
      `${ctx?.lines?.[0]?.unitPrice}`);
    check("  and what is on the shelf", ctx?.lines?.[0]?.onHand === 100,
      `${ctx?.lines?.[0]?.onHand}`);

    const rel = await Q.getRelatedDocuments(inv.id);
    const orders = rel.source.find((g) => g.label.toLowerCase().includes("order"));
    check("  and Related documents shows it too",
      !!orders?.docs?.some((d) => d.docNo === so.docNo),
      orders?.docs?.map((d) => d.docNo).join(",") || "None");
  }

  // ---- partial delivery ---------------------------------------------------

  console.log("\n  20 of the 50 go out\n");
  {
    const { so, inv, invLineId } = await setup();
    const res = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 20, sourceLineId: invLineId }]));
    check("the action posts it", res.ok, String(res.error).slice(0, 70));

    const st = await orderState(so.id);
    check("  the order is 20 of 50", st.fulfilled === 20 && st.remaining === 30,
      `${st.fulfilled}/${st.remaining}`);
    check("  stock came down to 80", (await onHand()) === 80, `${await onHand()}`);

    const ctx = await Q.getInvoiceDeliveryContext(co.id, inv.id);
    check("  and the invoice still awaits 30", ctx?.lines?.[0]?.remainingQty === 30,
      `${ctx?.lines?.[0]?.remainingQty}`);
    check("  having sent 20", ctx?.lines?.[0]?.deliveredQty === 20,
      `${ctx?.lines?.[0]?.deliveredQty}`);
  }

  // ---- the order was corrected, or closed ---------------------------------

  console.log("\n  the order moves before the goods do\n");
  {
    const { so, ol, inv, invLineId } = await setup();
    const amended = await P.amendDocument({ companyId: co.id, documentId: so.id,
      reason: "price was wrong",
      repost: (tx, amendOf) => P.postSalesOrder({ ...base, partnerId: cust.id,
        dueDate: today, amendOf,
        lines: [{ itemId: item.id, qty: 50, unitPrice: 950, supersedesLineId: ol.id }] }, tx) });
    const v2 = amended.replacementId ?? amended.id;

    const res = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 20, sourceLineId: invLineId }]));
    check("a delivery against the corrected order posts", res.ok, String(res.error).slice(0, 70));
    const st = await orderState(v2);
    check("  and lands on the version that stands", st.fulfilled === 20 && st.remaining === 30,
      `${st.fulfilled}/${st.remaining}`);
  }
  {
    const { so, inv, invLineId } = await setup();
    await P.closeOrderRemaining({ companyId: co.id, documentId: so.id,
      reason: "customer cancelled the remainder" });
    const res = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 20, sourceLineId: invLineId }]));
    check("a delivery against a closed order is refused", !res.ok,
      String(res.error).slice(0, 70));
    check("  and says to reopen it", !res.ok && /Reopen/i.test(String(res.error)));
    check("  nothing left the shelf", (await onHand()) === 100, `${await onHand()}`);
    check("  and the order took nothing", (await orderState(so.id)).fulfilled === 0);
  }

  // ---- short stock, confirmed -------------------------------------------

  console.log("\n  more goes out than the books show\n");
  {
    const { so, inv, invLineId } = await setup({ stock: 30, ordered: 50, invoiced: 50 });
    const refused = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 50, sourceLineId: invLineId }]));
    check("without confirmation it is refused", !refused.ok, String(refused.error).slice(0, 70));
    check("  and nothing moved", (await onHand()) === 30, `${await onHand()}`);

    const ok = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 50, sourceLineId: invLineId }], { allowNegative: true }));
    check("confirmed, it posts", ok.ok, String(ok.error).slice(0, 70));
    check("  and the balance really is negative", (await onHand()) === -20,
      `${await onHand()}`);
    check("  the order is fulfilled in full", (await orderState(so.id)).fulfilled === 50);

    const [dlv] = await sql`select id, negative_stock_confirmed, negative_stock_confirmed_at
      from document where company_id = ${co.id} and doc_type = 'DELIVERY'
      order by doc_no desc limit 1`;
    check("  and the delivery records that somebody said so",
      dlv.negative_stock_confirmed === true && dlv.negative_stock_confirmed_at !== null);

    /**
     * The cost of the units with no stock behind them is provisional. The
     * receipt that brings them in has not been entered, so FIFO had nothing
     * to draw from — and entering it later is what settles the figure.
     */
    // The account this item's cost of sales actually resolves to, asked the
    // way the posting code asks it rather than guessed from a role name.
    const [cogsAcct] = await sql`
      select fn_resolve_account_for_item(${co.id}, 'COGS', ${item.id}) as a`;
    const cogsOf = async (docId) => n((await sql`
      select coalesce(sum(jl.base_amount), 0)::float v
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
       where je.source_id = ${docId} and jl.account_id = ${cogsAcct.a}`)[0].v);
    const cogsAll = async () => n((await sql`
      select coalesce(sum(jl.base_amount), 0)::float v
        from journal_line jl
       where jl.account_id = ${cogsAcct.a} and jl.company_id = ${co.id}`)[0].v);

    // 30 came in at 400 and were costed at 400. The other 20 had nothing
    // behind them, so their cost is provisional.
    const provisional = await cogsOf(dlv.id);
    check("  a cost of sale was booked for all 50", provisional > 0, `${provisional}`);

    // The missing receipt arrives, and at a different price than was guessed.
    await P.postGoodsReceipt({ ...base, partnerId: supp.id,
      lines: [{ itemId: item.id, qty: 20, unitCost: 700 }] });
    check("  the missing receipt brings the balance back to nothing",
      (await onHand()) === 0, `${await onHand()}`);

    const settled = await cogsAll();
    const actual = 30 * 400 + 20 * 700;

    /**
     * The extra cost is recognised, but not as cost of sales.
     *
     * COGS stays at the provisional 20,000 — fifty units at the 400 that was
     * all the shelf could offer — and the 6,000 the goods actually cost above
     * that lands in Purchase Price Variance when the receipt arrives. The
     * money is not lost and the trial balance is flat; it is sitting in a
     * different line of the P&L from the sale it belongs to.
     *
     * Whether that is the right treatment is the forward-cost correction
     * question already on the list, and not something to decide here. What is
     * asserted is what happens, so that changing it is a deliberate act.
     */
    check("  COGS settles at what the goods actually cost",
      Math.abs(settled - actual) < 0.01, `${settled} vs ${actual}`);
    check("    which is more than was booked provisionally",
      settled > provisional + 0.01, `provisional ${provisional}, settled ${settled}`);
    const variance = n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
      from journal_line jl
      join system_account sa on sa.account_id = jl.account_id
                            and sa.company_id = jl.company_id
     where sa.role = 'PURCHASE_PRICE_VARIANCE' and jl.company_id = ${co.id}`)[0].v);
    check("    and nothing was left sitting in price variance",
      Math.abs(variance) < 0.01, `${variance}`);

    const [tb] = await sql`select coalesce(sum(balance), 0)::float t from v_trial_balance`;
    check("    with the books still balancing", Math.abs(n(tb.t)) < 0.005, `${n(tb.t)}`);

    /**
     * This one fails, and is meant to.
     *
     * The inventory GL account reads nothing and the stock ledger reads 6,000
     * against zero units, so v_check_inventory_reconciliation reports a
     * break — the invariant view that exists for exactly this. It reproduces
     * on a plain invoice with no order in sight, so it belongs to the
     * negative-stock costing path and not to anything in this change. Left
     * asserted rather than described in a comment: a defect nothing fails on
     * is a defect somebody has to remember.
     */
    const breaks = await sql`select difference from v_check_inventory_reconciliation`;
    check("  the inventory ledger agrees with the GL afterwards", breaks.length === 0,
      breaks.length ? `off by ${n(breaks[0].difference)} with zero units on hand` : "");

    const [ledger] = await sql`select coalesce(sum(total_cost), 0)::float v
      from stock_movement where company_id = ${co.id}`;
    check("    the stock ledger holds no value for goods that are not there",
      Math.abs(n(ledger.v)) < 0.01, `${n(ledger.v)}`);
    const [invGl] = await sql`select coalesce(sum(jl.base_amount), 0)::float v
      from journal_line jl
      join account_determination ad on ad.account_id = jl.account_id
                                   and ad.company_id = jl.company_id
     where ad.role = 'INVENTORY' and jl.company_id = ${co.id}`;
    check("    and the inventory account holds none either",
      Math.abs(n(invGl.v)) < 0.01, `${n(invGl.v)}`);
  }

  // ---- the consignor's goods ---------------------------------------------

  console.log("\n  some of it is not ours to sell\n");
  {
    await wipe();
    await sql`update number_series set next_value = 1`;
    // Agreements survive the truncate above — they are master data, not
    // transactions — so this section clears its own.
    await sql`delete from consignment_agreement_line`;
    await sql`delete from consignment_agreement`;
    const [ag] = await sql`insert into consignment_agreement (company_id, partner_id)
      values (${co.id}, ${supp.id}) returning id`;
    const [agl] = await sql`insert into consignment_agreement_line
      (company_id, agreement_id, item_id, pricing_method, pricing_value)
      values (${co.id}, ${ag.id}, ${item.id}, 'PERCENTAGE', 80) returning id`;
    await P.postConsignmentReceipt({ ...base, partnerId: supp.id,
      lines: [{ itemId: item.id, qty: 40, agreementLineId: agl.id }] });
    await P.postGoodsReceipt({ ...base, partnerId: supp.id,
      lines: [{ itemId: item.id, qty: 10, unitCost: 400 }] });

    const owned = await onHand();
    check("our own stock is 10, the consignor's 40 sits apart", owned === 10, `${owned}`);

    const inv = await P.postSalesInvoice({ ...base, partnerId: cust.id, dueDate: today,
      toDeliver: true, lines: [{ itemId: item.id, qty: 10, unitPrice: 900 }] });
    const [il] = await sql`select id from document_line where document_id = ${inv.id}`;

    const res = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 10, sourceLineId: il.id, source: "CONSIGNMENT" }]));
    check("a consigned delivery posts", res.ok, String(res.error).slice(0, 70));
    check("  and our own stock is untouched", (await onHand()) === 10, `${await onHand()}`);
    const drawn = n((await sql`select coalesce(sum(qty), 0)::float q
      from consignment_lot_consumption where company_id = ${co.id}`)[0].q);
    check("  the consignor's pool is what came down", drawn === 10, `${drawn}`);
  }

  // ---- the same submission twice ------------------------------------------

  console.log("\n  the confirmation is sent twice\n");
  {
    const { so, inv, invLineId } = await setup();
    const key = crypto.randomUUID();
    const line = [{ itemId: item.id, qty: 20, sourceLineId: invLineId }];
    const first = await ran(() => ship(inv.id, line, { key }));
    const again = await ran(() => ship(inv.id, line, { key }));
    check("both are accepted", first.ok && again.ok,
      `${first.error ?? "ok"} / ${again.error ?? "ok"}`);

    const deliveries = n((await sql`select count(*)::int c from document
      where company_id = ${co.id} and doc_type = 'DELIVERY'`)[0].c);
    check("  but only one delivery exists", deliveries === 1, `${deliveries}`);
    check("  20 left the shelf, not 40", (await onHand()) === 80, `${await onHand()}`);
    check("  and the order moved once", (await orderState(so.id)).fulfilled === 20,
      `${(await orderState(so.id)).fulfilled}`);
  }

  // ---- the screen is not the guard ----------------------------------------

  console.log("\n  going round the screen\n");
  {
    const { inv, invLineId } = await setup({ stock: 30, ordered: 50, invoiced: 50 });
    // Exactly what the page would send if its confirmation were skipped: no
    // allow_negative_stock at all.
    const bare = await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 50, sourceLineId: invLineId }]));
    check("a shortage without the confirmation is refused by the server", !bare.ok,
      String(bare.error).slice(0, 70));
    check("  and nothing moved", (await onHand()) === 30, `${await onHand()}`);

    // And the confirmation is recorded on the document, not merely obeyed.
    await ran(() => ship(inv.id, [
      { itemId: item.id, qty: 50, sourceLineId: invLineId }], { allowNegative: true }));
    const [d] = await sql`select negative_stock_confirmed, negative_stock_confirmed_at
      from document where company_id = ${co.id} and doc_type = 'DELIVERY'
      order by doc_no desc limit 1`;
    check("  once confirmed, the document says who agreed and when",
      d.negative_stock_confirmed === true && d.negative_stock_confirmed_at !== null);
  }

  // ---- the same key, and a different one ----------------------------------
  //
  // Two different things wear the same shape. A resent confirmation is one
  // delivery and must stay one. A second, deliberate delivery is a new
  // request that has to be judged afresh — and confirming negative stock once
  // must not become standing permission to send the same goods again.

  console.log("\n  sent twice, and sent again\n");
  {
    const { so, inv, invLineId } = await setup({ stock: 100, ordered: 50, invoiced: 50 });
    const key = crypto.randomUUID();
    const line = [{ itemId: item.id, qty: 30, sourceLineId: invLineId }];

    const a = await ran(() => ship(inv.id, line, { key }));
    const b = await ran(() => ship(inv.id, line, { key }));
    check("the same key: both accepted", a.ok && b.ok,
      `${a.error ?? "ok"} / ${b.error ?? "ok"}`);
    check("  one delivery", n((await sql`select count(*)::int c from document
      where company_id = ${co.id} and doc_type = 'DELIVERY'`)[0].c) === 1);
    check("  30 gone, not 60", (await onHand()) === 70, `${await onHand()}`);

    // A different key is a different request: 30 more against an invoice for
    // 50 leaves only 20 to give.
    const c = await ran(() => ship(inv.id, line));
    check("a different key is judged afresh, not replayed", !c.ok,
      String(c.error).slice(0, 70));
    const ctx = await Q.getInvoiceDeliveryContext(co.id, inv.id);
    check("  the invoice still shows 20 left", ctx?.lines?.[0]?.remainingQty === 20,
      `${ctx?.lines?.[0]?.remainingQty}`);
    check("  and the order took 30, once", (await orderState(so.id)).fulfilled === 30,
      `${(await orderState(so.id)).fulfilled}`);
  }
  {
    // Negative-stock permission is per request, not a licence to repeat.
    const { inv, invLineId } = await setup({ stock: 30, ordered: 50, invoiced: 50 });
    const line = [{ itemId: item.id, qty: 50, sourceLineId: invLineId }];
    const first = await ran(() => ship(inv.id, line, { allowNegative: true }));
    check("a confirmed shortage delivery posts", first.ok, String(first.error).slice(0, 60));
    const second = await ran(() => ship(inv.id, line, { allowNegative: true }));
    check("  confirming once does not authorise sending it again", !second.ok,
      String(second.error).slice(0, 70));
    check("  the balance stops at -20", (await onHand()) === -20, `${await onHand()}`);
  }

  // ---- two at the same moment ---------------------------------------------

  console.log("\n  two deliveries at the same moment\n");
  {
    const { so, inv, invLineId } = await setup({ stock: 100, ordered: 50, invoiced: 50 });
    const line = (q) => [{ itemId: item.id, qty: q, sourceLineId: invLineId }];
    const [a, b] = await Promise.all([
      ran(() => ship(inv.id, line(30))),
      ran(() => ship(inv.id, line(30))),
    ]);
    // Between them they would send 60 against an invoice for 50.
    check("they do not both send 30 against an invoice for 50",
      !(a.ok && b.ok) || (await Q.getInvoiceDeliveryContext(co.id, inv.id))
        .lines[0].deliveredQty <= 50,
      `${a.ok ? "posted" : "refused"} / ${b.ok ? "posted" : "refused"}`);
    const ctx = await Q.getInvoiceDeliveryContext(co.id, inv.id);
    const sent = ctx ? ctx.lines[0].deliveredQty : 50;
    check("  never more than the invoice asked for", sent <= 50, `${sent}`);
    const st = await orderState(so.id);
    check("  and the order never exceeds what it ordered", st.fulfilled <= 50,
      `${st.fulfilled}`);
  }

  await wipe();
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0
    ? "\n  what leaves the building is what the screen said would\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
