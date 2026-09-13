// Goods that never arrived.
//
//   ./node_modules/.bin/tsx scripts/test-receipt-reversal.mjs
//
// A receipt entered by mistake, or the same delivery entered twice, is not a
// return. A return records stock leaving the warehouse and the supplier owing
// a credit; here nothing left, because nothing was ever there, and the
// supplier owes nothing because they were never billed. The app used to offer
// only the return, so somebody undoing a typo was asked to record a fiction.
//
// Reversal is allowed only while every layer the receipt created is exactly as
// it was created. Its own layers, not enough units of that item somewhere: a
// later purchase must not make an already-used receipt reversible. A transfer
// consumes the lot it moves, so it fails this too — the goods are elsewhere.
//
// Where the layers are gone, what took them is named. "Use a return" would
// not explain how thirty units that never arrived came to be sold.

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
const V = await import("../lib/void.ts");
const Q = await import("../lib/queries.ts");
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
  if (!/—\s*DEV\b|\bDEV\b/i.test(String(co.name)) && process.env.ALLOW_DESTRUCTIVE_TESTS !== "1") {
    throw new Error(
      `This suite empties the transaction tables, and "${co.name}" does not look like a `
      + `disposable development database. Set ALLOW_DESTRUCTIVE_TESTS=1 to say you mean it.`);
  }
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const locs = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 2`;
  const [item] = await sql`select id from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  const wipe = () => sql.unsafe(`truncate table posting_attempt, document_history,
    fulfilment_link, order_closure, payment_allocation, stock_lot_adjustment,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  await wipe();
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };
  const receive = (qty, cost, extra = {}) => P.postGoodsReceipt({
    ...base, ...extra, lines: [{ itemId: item.id, qty, unitCost: cost }] });

  const world = async () => {
    const [st] = await sql`select coalesce(sum(qty), 0)::float q from stock_movement
       where company_id = ${co.id} and item_id = ${item.id}`;
    const [lots] = await sql`select coalesce(sum(qty_remaining), 0)::float q
       from v_stock_lot_open where item_id = ${item.id}`;
    const [grir] = await sql`select coalesce(sum(jl.base_amount), 0)::float v from journal_line jl
       join system_account s on s.account_id = jl.account_id and s.role = 'GRIR_CLEARING'
       where jl.company_id = ${co.id}`;
    const awaiting = (await Q.getOpenGoodsReceipts(co.id))
      .reduce((s, r) => s + r.lines.reduce((x, l) => x + l.qty, 0), 0);
    return { stock: n(st.q), lots: n(lots.q), grir: n(grir.v), awaiting };
  };

  // ---- nothing arrived ----------------------------------------------------

  console.log("  a receipt for goods that never arrived\n");

  const gr = await receive(100, 500);
  const before = await world();
  check("the receipt puts 100 on the shelf", before.stock === 100 && before.lots === 100);
  check("  accrues what will be owed for them", near(before.grir, -50000), `${before.grir}`);
  check("  and offers them to be billed", before.awaiting === 100);

  const plan = await V.planVoid(gr.id);
  check("it can be reversed", plan.canVoid === true,
    plan.blockers.map((b) => b.reason.slice(0, 40)).join("; "));
  check("  and says what that will do",
    plan.effects.some((e) => /back off the shelf/i.test(e)),
    plan.effects.join(" | ").slice(0, 60));

  await P.voidDocument({ documentId: gr.id, reason: "nothing ever arrived" });
  const after = await world();

  check("the goods come back off the shelf", after.stock === 0, `${after.stock}`);
  check("  the layers close with them", after.lots === 0, `${after.lots}`);
  check("  the accrual goes with it", near(after.grir, 0), `${after.grir}`);
  check("  and nothing is left awaiting a bill", after.awaiting === 0, `${after.awaiting}`);

  const [orig] = await sql`select status from document where id = ${gr.id}`;
  const [hist] = await sql`select action, reason from document_history
     where document_id = ${gr.id} order by acted_at desc limit 1`;
  check("the receipt itself is kept, marked reversed", orig.status === "REVERSED", orig.status);
  check("  with the reason it was given", hist?.reason === "nothing ever arrived", hist?.reason);

  // ---- the same delivery entered twice ------------------------------------

  console.log("\n  the same delivery entered twice\n");

  const real = await receive(40, 250);
  const duplicate = await receive(40, 250);
  check("both receipts are on the shelf", (await world()).stock === 80);

  await P.voidDocument({ documentId: duplicate.id, reason: "entered twice" });
  const afterDup = await world();
  check("reversing the duplicate leaves the real one alone",
    afterDup.stock === 40 && afterDup.lots === 40, `${afterDup.stock} on hand`);
  check("  and the real receipt still stands",
    (await sql`select status from document where id = ${real.id}`)[0].status === "POSTED");

  // ---- goods that were used ------------------------------------------------

  console.log("\n  a receipt whose goods have gone\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const used = await receive(100, 500);
  const sale = await P.postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 30, unitPrice: 900 }] });

  const usedPlan = await V.planVoid(used.id);
  const stockBefore = (await world()).stock;
  let refused = null;
  try { await P.voidDocument({ documentId: used.id, reason: "probe" }); }
  catch (e) { refused = e.message; }

  check("a receipt whose goods have been sold cannot be reversed",
    usedPlan.canVoid === false && !!refused);
  check("  and what took them is named, not answered with 'use a return'",
    usedPlan.blockers.some((b) => /took 30 of what this receipt brought in/i.test(b.reason)),
    usedPlan.blockers.map((b) => b.reason.slice(0, 44)).join(" | "));
  check("  the refusal moves nothing", (await world()).stock === stockBefore);
  void sale;

  // ---- goods that moved warehouse -----------------------------------------

  if (locs.length === 2) {
    console.log("\n  a receipt whose goods were transferred away\n");

    await wipe();
    await sql`update number_series set next_value = 1`;
    const moved = await receive(50, 300);
    await P.postStockTransfer({ companyId: co.id, docDate: today,
      fromLocationId: locs[0].id, toLocationId: locs[1].id,
      lines: [{ itemId: item.id, qty: 50 }] });

    const movedPlan = await V.planVoid(moved.id);
    check("a receipt whose goods were moved elsewhere cannot be reversed",
      movedPlan.canVoid === false,
      movedPlan.blockers.map((b) => b.reason.slice(0, 40)).join(" | "));
  }

  // ---- a receipt with a bill on it ----------------------------------------

  console.log("\n  a receipt that has been billed\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const billed = await receive(20, 100);
  const [bl] = await sql`select id from document_line where document_id = ${billed.id}`;
  await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today, goodsReceiptId: billed.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: bl.id }] });

  const billedPlan = await V.planVoid(billed.id);
  check("a receipt with a bill on it is blocked, naming the bill",
    billedPlan.canVoid === false
    && billedPlan.blockers.some((b) => /was raised from this document/i.test(b.reason)),
    billedPlan.blockers.map((b) => b.reason.slice(0, 44)).join(" | "));

  // ---- the confirmation sent twice ----------------------------------------

  console.log("\n  the reversal confirmed twice\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const twice = await receive(10, 100);
  const reverseOnce = (key) => postOnce(co.id, key, async (tx) => {
    const out = await P.voidDocument({ documentId: twice.id, reason: "entered by mistake" }, tx);
    return { ...out, id: out.id, docNo: out.docNo };
  });

  const first = await reverseOnce("reverse-key");
  const again = await reverseOnce("reverse-key");
  const [reversals] = await sql`select count(*)::int n from document
     where company_id = ${co.id} and reverses_document_id = ${twice.id}`;

  check("the retry is handed the first reversal", again.id === first.id);
  check("  and there is only one of them", reversals.n === 1, `${reversals.n}`);
  check("  with the stock taken off once", (await world()).stock === 0, `${(await world()).stock}`);

  // ---- left as found -------------------------------------------------------
  await wipe();
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0
    ? "\n  goods that never arrived can be taken back\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
