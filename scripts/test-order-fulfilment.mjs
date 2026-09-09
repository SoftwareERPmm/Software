// Which order the goods that arrived were actually for.
//
//   npx tsx scripts/test-order-fulfilment.mjs
//
// PO for 100. Goods received against the invoice that billed for them.
// Invoice paid. And the order still read "received 0", turned overdue on its
// own Needed-by date, and stayed that way for good — because a receipt names
// one source, it named the invoice, and a purchase invoice may only name a
// receipt, so nothing anywhere connected the goods to the order.
//
// Three answers, and they are different answers:
//
//   the receipt says which order line it fulfils, as it is posted
//   an existing receipt is linked to an order afterwards, to repair history
//   the remainder is closed, when the rest is genuinely not coming
//
// The last one is not a substitute for the first two. Closing an order whose
// goods did arrive silences the warning and leaves the received quantity
// wrong, which is a report that looks tidy and is false.

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

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  console.log(`\n  ${co.name}  ·  ${item.code}\n`);

  await sql.unsafe(`truncate table fulfilment_link, order_closure, payment_allocation,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const past = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: past };

  const state = async (orderId) => {
    const rows = await sql`
      select coalesce(sum(ordered), 0)::float as ordered,
             coalesce(sum(fulfilled), 0)::float as fulfilled,
             coalesce(sum(outstanding), 0)::float as outstanding,
             bool_or(is_closed) as closed
        from v_order_outstanding where order_id = ${orderId}`;
    return rows[0];
  };
  const overdue = async () => n((await Q.getActionItems(co.id)).purchaseOrders.overdue);

  // ---- the reported case, posted the way it happens ----------------------

  console.log("  bill first: PO for 100, goods received against the invoice\n");

  const po = await P.postPurchaseOrder({ ...base, dueDate: past,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 500 }] });
  const [poLine] = await sql`select id from document_line where document_id = ${po.id}`;

  const pi = await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id,
    docDate: past, dueDate: null, lines: [{ itemId: item.id, qty: 100, unitPrice: 500 }] });

  await P.postGoodsReceipt({ ...base, sourceDocumentId: pi.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });

  const stranded = await state(po.id);
  check("the order reads nothing received, though 100 arrived",
    stranded.fulfilled === 0, `${stranded.fulfilled} of ${stranded.ordered}`);
  check("  and counts as overdue", (await overdue()) === 1, `${await overdue()}`);

  // ---- 2. link the existing receipt ---------------------------------------

  console.log("\n  linking the receipt that already exists\n");

  const [grLine] = await sql`
    select dl.id, dl.base_qty from document_line dl
      join document d on d.id = dl.document_id
     where d.company_id = ${co.id} and d.doc_type = 'GOODS_RECEIPT'
     order by d.created_at desc limit 1`;

  await P.linkFulfilmentToOrder({
    companyId: co.id,
    lines: [{ fulfilmentLineId: grLine.id, orderLineId: poLine.id, qty: 100 }],
    reason: "goods received against the supplier's invoice",
  });

  const repaired = await state(po.id);
  check("the order now reads fully received", repaired.fulfilled === 100,
    `${repaired.fulfilled} of ${repaired.ordered}`);
  check("  with nothing outstanding", repaired.outstanding === 0, `${repaired.outstanding}`);
  check("  and it is no longer overdue", (await overdue()) === 0, `${await overdue()}`);
  check("  while the receipt still moved stock exactly once",
    n((await sql`select coalesce(sum(qty), 0) as q from stock_movement
                  where company_id = ${co.id} and item_id = ${item.id}`)[0].q) === 100,
    `${n((await sql`select coalesce(sum(qty), 0) as q from stock_movement
                     where company_id = ${co.id} and item_id = ${item.id}`)[0].q)} on hand`);
  check("  and the link says why and when",
    !!(await sql`select reason, created_at from fulfilment_link limit 1`)[0].reason);

  // The same goods cannot answer a second order.
  const po2 = await P.postPurchaseOrder({ ...base, dueDate: past,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 500 }] });
  const [po2Line] = await sql`select id from document_line where document_id = ${po2.id}`;
  let twice = null;
  try {
    await P.linkFulfilmentToOrder({ companyId: co.id,
      lines: [{ fulfilmentLineId: grLine.id, orderLineId: po2Line.id, qty: 100 }] });
  } catch (e) { twice = e.message; }
  check("the same goods cannot be allocated to a second order", twice !== null,
    twice ? twice.slice(0, 62) : "LINKED TWICE — one shipment would close two orders");

  // Nor more than the order is still waiting for.
  const gr2 = await P.postGoodsReceipt({ ...base, lines: [{ itemId: item.id, qty: 500, unitCost: 500 }] });
  const [gr2Line] = await sql`select id from document_line where document_id = ${gr2.id}`;
  let tooMuch = null;
  try {
    await P.linkFulfilmentToOrder({ companyId: co.id,
      lines: [{ fulfilmentLineId: gr2Line.id, orderLineId: po2Line.id, qty: 500 }] });
  } catch (e) { tooMuch = e.message; }
  check("  nor more than the order is still waiting for", tooMuch !== null,
    tooMuch ? tooMuch.slice(0, 62) : "LINKED — 500 against an order for 100");

  // A link is append-only.
  let rewritten = null;
  try {
    await sql`update fulfilment_link set qty = qty + 1
               where id = (select id from fulfilment_link limit 1)`;
  } catch (e) { rewritten = e.message; }
  check("  and a link cannot be quietly rewritten", rewritten !== null,
    rewritten ? rewritten.slice(0, 52) : "UPDATED — it should not have");

  // ---- 1. the receipt naming the order line as it posts -------------------

  console.log("\n  a receipt that names both its invoice and its order\n");

  const po3 = await P.postPurchaseOrder({ ...base, dueDate: past,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 500 }] });
  const [po3Line] = await sql`select id from document_line where document_id = ${po3.id}`;
  const pi3 = await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id,
    docDate: past, dueDate: null, lines: [{ itemId: item.id, qty: 40, unitPrice: 500 }] });

  await P.postGoodsReceipt({ ...base, sourceDocumentId: pi3.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 500, orderLineId: po3Line.id }] });

  const both = await state(po3.id);
  check("the order is fulfilled without anybody linking it afterwards",
    both.fulfilled === 40 && both.outstanding === 0,
    `${both.fulfilled} of ${both.ordered}, ${both.outstanding} outstanding`);
  check("  and the receipt still names the invoice it clears",
    (await sql`select src.doc_no from document d join document src on src.id = d.source_document_id
                where d.company_id = ${co.id} and d.doc_type = 'GOODS_RECEIPT'
                order by d.created_at desc limit 1`)[0].doc_no === pi3.docNo);

  // ---- 3. closing what is not coming --------------------------------------

  console.log("\n  closing an order whose remainder is not coming\n");

  const beforeClose = await state(po2.id);
  check("the second order is still waiting", beforeClose.outstanding === 100,
    `${beforeClose.outstanding}`);

  let noReason = null;
  try {
    await P.closeOrderRemaining({ companyId: co.id, documentId: po2.id, reason: "  " });
  } catch (e) { noReason = e.message; }
  check("closing without a reason is refused", noReason !== null,
    noReason ? noReason.slice(0, 44) : "CLOSED with no reason given");

  await P.closeOrderRemaining({ companyId: co.id, documentId: po2.id,
    reason: "supplier discontinued the line" });
  const closed = await state(po2.id);
  check("closed, so nothing is outstanding", closed.outstanding === 0, `${closed.outstanding}`);
  check("  and it is flagged as closed rather than as delivered",
    closed.closed === true && closed.fulfilled === 0,
    `closed ${closed.closed}, received ${closed.fulfilled}`);
  check("  which is the distinction that matters: received stays honest",
    closed.fulfilled !== closed.ordered);
  check("  and it drops off the overdue count", (await overdue()) === 0, `${await overdue()}`);
  check("  and off the list of orders to receive against",
    !(await Q.getOpenPurchaseOrders(co.id)).some((r) => r.order_id === po2.id));

  await P.reopenOrder({ companyId: co.id, documentId: po2.id, reason: "supplier will ship after all" });
  check("re-opening puts it back", n((await state(po2.id)).outstanding) === 100,
    `${n((await state(po2.id)).outstanding)}`);

  // ---- the books are untouched by any of it -------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);
  check("linking created no journal entry of its own",
    n((await sql`select count(*)::int as n from journal_entry
                  where company_id = ${co.id} and source_type = 'FULFILMENT_LINK'`)[0].n) === 0);

  console.log(bad === 0
    ? "\n  the goods that arrived say which order they answered\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
