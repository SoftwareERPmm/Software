// Cost of sales recognised on the invoice, not the delivery.
//
//   npx tsx scripts/test-posting-switch.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database. See docs/03-decisions.md, D8.
//
// One invariant decides whether the change is working, and it is checked
// after every scenario below rather than once at the end:
//
//     1090 GL balance = v_delivery_cost_unclaimed = Shipped Not Invoiced
//
// Three independent routes to the same figure: what the ledger says, what
// the allocation rows say is unclaimed, and what the document links say was
// never billed. A bug that moves cost to the wrong account breaks the first;
// a bug in claiming or releasing breaks the second; a bug in matching breaks
// the third. Agreeing by accident is not plausible.
//
// The other invariant, which the ledger cannot catch on its own: inventory
// is relieved exactly once per sale. An invoice crediting 1040 instead of
// 1090 balances perfectly and leaves the trial balance netting to zero.

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
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const P = await import("../lib/posting.ts");
const Q = await import("../lib/queries.ts");
const { getShippedNotInvoiced } = Q;

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-posting-switch.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);
const r2 = (v) => Math.round(n(v) * 100) / 100;

try {
  const [co] = await sql`select id from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await resetTransactions(sql);

  const party = async (code, name, cols) => {
    const [f] = await sql`select id from business_partner where company_id=${co.id} and code=${code}`;
    if (f) return f;
    return (await sql`insert into business_partner ${sql({ company_id: co.id, code, name, ...cols })}
      returning id`)[0];
  };
  const cust = await party("PSW-C", "Switch Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("PSW-S", "Switch Supplier", { is_supplier: true });
  /* Its own items, not whichever rows the catalogue happens to hold.
     Picking "the first stocked item" made the suite unrepeatable: the item
     this creates sorts ahead of the seeded one, so on the second run the
     two scenarios below shared a single item and the layered case
     inherited the other's leftovers. */
  const ensureItem = async (code, name) => {
    /* Found by serial, not code: a trigger builds item.code from the
       category and serial, so the code that comes back is not the one
       handed in. */
    const [found] = await sql`
      select id from item where company_id = ${co.id} and serial = ${code}`;
    if (found) return found;
    const [grp] = await sql`select id from item_group where company_id = ${co.id} limit 1`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
    return (await sql`
      insert into item (company_id, item_group_id, code, name, base_uom_id, serial, is_stocked)
      values (${co.id}, ${grp.id}, ${code}, ${name}, ${uom.id}, ${code}, true)
      returning id`)[0];
  };

  const item = await ensureItem("PSW-MAIN", "Switch probe");
  const [promo] = await sql`
    select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;

  const DAY = (await sql`select to_char(current_date,'YYYY-MM-DD') as d`)[0].d;
  const base = { companyId: co.id, partnerId: cust.id, locationId: loc.id };
  const buy = (qty, cost) => P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY, lines: [{ itemId: item.id, qty, unitCost: cost }] });
  const ship = (qty, extra = {}) => P.postDelivery({ ...base, docDate: DAY,
    lines: [{ itemId: item.id, qty, unitPrice: 300, ...extra }] });
  const bill = (qty, deliveryId) => P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId, lines: [{ itemId: item.id, qty, unitPrice: 300 }] });

  const balance = async (code) => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0) as v
        from journal_line jl join account a on a.id = jl.account_id
       where a.company_id = ${co.id} and a.code = ${code}`;
    return r2(r.v);
  };
  const viewTotal = async () => {
    const [r] = await sql`select coalesce(sum(value_unclaimed), 0) as v
      from v_delivery_cost_unclaimed where company_id = ${co.id}`;
    return r2(r.v);
  };

  /** The whole point. Three routes to one figure, after every scenario. */
  const reconcile = async (label) => {
    const gl = await balance("1090");
    const view = await viewTotal();
    const report = r2((await getShippedNotInvoiced(co.id, null)).total);
    check(`    reconciles — 1090 = view = report`,
      gl === view && view === report, `${gl} / ${view} / ${report}`);
    return gl;
  };

  /** Inventory must be relieved once per sale, never twice. */
  const inventoryOut = async () => r2(-(await balance("1040")) + (await (async () => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0) as v
        from journal_line jl
        join account a on a.id = jl.account_id
        join journal_entry je on je.id = jl.journal_entry_id
        join document d on d.journal_entry_id = je.id
       where a.code = '1040' and d.doc_type = 'GOODS_RECEIPT'`;
    return r2(r.v);
  })()));

  // ------------------------------------------------- full ship, full bill
  console.log("\n  a delivery billed in full\n");
  await buy(100, 100);
  const d1 = await ship(10);
  check("the delivery puts cost in 1090, not cost of sales",
    (await balance("1090")) === 1000 && (await balance("5000")) === 0,
    `1090 ${await balance("1090")} / 5000 ${await balance("5000")}`);
  await reconcile();

  await bill(10, d1.id);
  check("the invoice moves it to cost of sales",
    (await balance("1090")) === 0 && (await balance("5000")) === 1000,
    `1090 ${await balance("1090")} / 5000 ${await balance("5000")}`);
  check("and inventory was relieved once, not twice",
    (await inventoryOut()) === 1000, `${await inventoryOut()}`);
  await reconcile();

  // --------------------------------------------------------- part billed
  console.log("\n  deliver 10 costing 1,000, invoice 6\n");
  const d2 = await ship(10);
  await bill(6, d2.id);
  check("cost of sales is the cost of the six",
    (await balance("5000")) === 1000 + 600, `${await balance("5000")}`);
  check("the other four stay in 1090",
    (await balance("1090")) === 400, `${await balance("1090")}`);
  await reconcile();

  console.log("\n  then the rest of it\n");
  await bill(4, d2.id);
  check("1090 empties", (await balance("1090")) === 0, `${await balance("1090")}`);
  check("cost of sales has the whole delivery",
    (await balance("5000")) === 2000, `${await balance("5000")}`);
  await reconcile();

  // ------------------------------------------- layers at different costs
  /* Its own item, so the two layers are the only stock there is and the
     delivery is forced to straddle them. */
  console.log("\n  a delivery drawing two layers, billed in part\n");
  const item2 = await ensureItem("PSW-LAYERS", "Two-layer probe");
  const buy2 = (qty, cost) => P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY, lines: [{ itemId: item2.id, qty, unitCost: cost }] });
  const ship2 = (qty) => P.postDelivery({ ...base, docDate: DAY,
    lines: [{ itemId: item2.id, qty, unitPrice: 900 }] });
  const bill2 = (qty, deliveryId) => P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId, lines: [{ itemId: item2.id, qty, unitPrice: 900 }] });

  await buy2(5, 100);
  await buy2(5, 400);
  const d3 = await ship2(10);
  check("the delivery cost is both layers",
    (await balance("1090")) === 5 * 100 + 5 * 400, `${await balance("1090")}`);
  const before5000 = await balance("5000");
  await bill2(6, d3.id);
  check("six units take the cheap layer first, not an average",
    r2((await balance("5000")) - before5000) === 5 * 100 + 1 * 400,
    `${r2((await balance("5000")) - before5000)} (an average would be 1,500)`);
  check("and what is left is the dearer layer",
    (await balance("1090")) === 4 * 400, `${await balance("1090")}`);
  await reconcile();

  await bill2(4, d3.id);
  check("billing the rest empties it", (await balance("1090")) === 0,
    `${await balance("1090")}`);
  await reconcile();

  // ------------------------------------------------------- a giveaway
  console.log("\n  a giveaway still goes to its own account\n");
  const held = await balance("1090");
  const cogs = await balance("5000");
  await ship(3, { focReasonId: promo.id, unitPrice: 0 });
  check("nothing reaches 1090", (await balance("1090")) === held,
    `${await balance("1090")}`);
  check("nor cost of sales", (await balance("5000")) === cogs, `${await balance("5000")}`);
  check("it went to promotion expense", (await balance("6320")) > 0,
    `${await balance("6320")}`);
  await reconcile();

  // --------------------------------------------------- a counter sale
  console.log("\n  a counter sale, goods and bill in one act\n");
  await P.postSaleWithDelivery({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", lines: [{ itemId: item.id, qty: 5, unitPrice: 300 }] });
  check("leaves nothing in 1090", (await balance("1090")) === 0,
    `${await balance("1090")}`);
  await reconcile();

  // ------------------------------------------------------- voiding a bill
  console.log("\n  voiding an invoice gives the cost back\n");
  const d4 = await ship(10);
  const inv4 = await bill(10, d4.id);
  check("the invoice took the cost", (await balance("1090")) === 0,
    `${await balance("1090")}`);
  const cogsBefore = await balance("5000");

  await P.voidDocument({ documentId: inv4.id, reason: "test", goodsBack: true });
  check("cost of sales gives it back",
    r2(cogsBefore - (await balance("5000"))) === 1000,
    `${r2(cogsBefore - (await balance("5000")))}`);
  check("and it is sitting in 1090 again", (await balance("1090")) === 1000,
    `${await balance("1090")}`);
  const [rel] = await sql`select count(*)::int as n from sales_cost_allocation
     where reverses_id is not null`;
  check("released, not deleted — the history is still there", rel.n > 0, `${rel.n} releases`);
  await reconcile();

  console.log("\n  and the goods can be billed again\n");
  await bill(10, d4.id);
  check("the second invoice takes the same cost",
    (await balance("5000")) === cogsBefore, `${await balance("5000")}`);
  check("1090 empties again", (await balance("1090")) === 0, `${await balance("1090")}`);
  await reconcile();

  // ------------------------------------------------------ part, then void
  console.log("\n  voiding one of two invoices against a delivery\n");
  const d5 = await ship(10);
  const partA = await bill(6, d5.id);
  await bill(4, d5.id);
  check("both together clear it", (await balance("1090")) === 0,
    `${await balance("1090")}`);
  await P.voidDocument({ documentId: partA.id, reason: "test", goodsBack: true });
  check("voiding the six returns only the six",
    (await balance("1090")) === 600, `${await balance("1090")}`);
  await reconcile();

  // --------------------------------------------------- amending an invoice
  console.log("\n  amending an invoice down from 10 to 4\n");
  const d6 = await ship(10);
  const inv6 = await bill(10, d6.id);
  check("it claimed the lot", (await balance("1090")) === 600, `${await balance("1090")}`);
  await P.amendDocument({
    companyId: co.id, documentId: inv6.id, reason: "billed too many",
    repost: (tx, identity) => P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
      paymentType: "CREDIT", deliveryId: d6.id, identity,
      lines: [{ itemId: item.id, qty: 4, unitPrice: 300 }] }, tx),
  });
  check("only four units of cost stay claimed",
    (await balance("1090")) === 600 + 600, `${await balance("1090")}`);
  await reconcile();

  // -------------------------------------------------- reversing a delivery
  console.log("\n  voiding a delivery nobody billed\n");
  const held6 = await balance("1090");
  const d7 = await ship(5);
  check("it adds to 1090", (await balance("1090")) === held6 + 500,
    `${await balance("1090")}`);
  await P.voidDocument({ documentId: d7.id, reason: "test", goodsBack: true });
  check("voiding it takes the cost back out",
    (await balance("1090")) === held6, `${await balance("1090")}`);
  await reconcile();

  // ------------------------------------------------ the bill comes first
  console.log("\n  invoiced first, goods sent afterwards\n");
  const held7 = await balance("1090");
  const cogs7 = await balance("5000");
  const pending = await P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", toDeliver: true,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 300 }] });
  check("the bill alone costs nothing — no goods have moved",
    (await balance("5000")) === cogs7 && (await balance("1090")) === held7,
    `5000 ${await balance("5000")} / 1090 ${await balance("1090")}`);
  await reconcile();

  await P.postDelivery({ ...base, docDate: DAY, sourceDocumentId: pending.id,
    lines: [{ itemId: item.id, qty: 5, unitPrice: 300 }] });
  check("sending them recognises the cost against the bill already raised",
    r2((await balance("5000")) - cogs7) === 500,
    `${r2((await balance("5000")) - cogs7)}`);
  check("and leaves nothing behind in 1090",
    (await balance("1090")) === held7, `${await balance("1090")}`);
  await reconcile();

  // ---------------------------------------------------------- a return
  console.log("\n  a customer sends some back\n");
  const d8 = await ship(10);
  await bill(10, d8.id);
  const cogs8 = await balance("5000");
  await P.postSalesReturn({ ...base, docDate: DAY,
    lines: [{ itemId: item.id, qty: 3, unitPrice: 300 }] });
  check("the cost of what came back leaves cost of sales",
    (await balance("5000")) < cogs8, `${await balance("5000")}`);
  await reconcile();

  // ------------------------------------------- write-off and internal move
  console.log("\n  a write-off and a move between our own shelves\n");
  const held9 = await balance("1090");
  await P.postStockAdjustment({ companyId: co.id, locationId: loc.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: -2, reason: "damaged" }] });
  check("a write-off never reaches 1090", (await balance("1090")) === held9,
    `${await balance("1090")}`);
  const other = await sql`select id from location where company_id = ${co.id}
     and is_stock_location and id <> ${loc.id} limit 1`;
  if (other.length > 0) {
    await P.postStockTransfer({ companyId: co.id, fromLocationId: loc.id,
      toLocationId: other[0].id, docDate: DAY, lines: [{ itemId: item.id, qty: 2 }] });
    check("nor does a transfer", (await balance("1090")) === held9,
      `${await balance("1090")}`);
  }
  await reconcile();

  // -------------------------------------------- goods out one month, bill the next
  console.log("\n  delivered in one month, billed in the next\n");
  const LAST = (await sql`select to_char(current_date - 40, 'YYYY-MM-DD') as d`)[0].d;
  const held10 = await balance("1090");
  const dLate = await P.postDelivery({ ...base, docDate: LAST,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 300 }] });
  check("last month's delivery holds its cost",
    (await balance("1090")) === held10 + 600, `${await balance("1090")}`);
  await reconcile();

  await bill(6, dLate.id);
  check("this month's invoice takes it",
    (await balance("1090")) === held10, `${await balance("1090")}`);
  check("and cost of sales lands in the month that billed it",
    r2((await sql`select coalesce(sum(jl.base_amount),0) v
        from journal_line jl join account a on a.id=jl.account_id
        join journal_entry je on je.id=jl.journal_entry_id
       where a.code='5000' and je.entry_date = current_date`)[0].v) > 0,
    "posted today");
  await reconcile();

  // --------------------------------- one invoice, goods sent in two loads
  /* Billed from the order rather than from either delivery, which is the
     path `deliveriesBilledBy` exists for: the invoice names the order, the
     deliveries name the order, and nothing names anything else. A claim
     that only looked at the delivery an invoice points to would find none
     and leave the whole cost stranded. */
  console.log("\n  one invoice billing two deliveries, through the order\n");
  const heldTwo = await balance("1090");
  const cogsTwo = await balance("5000");
  const order = await P.postSalesOrder({ ...base, docDate: DAY, dueDate: DAY,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });
  await P.postDelivery({ ...base, docDate: DAY, sourceDocumentId: order.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 300 }] });
  await P.postDelivery({ ...base, docDate: DAY, sourceDocumentId: order.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 300 }] });
  check("both loads wait in the holding account",
    (await balance("1090")) === r2(heldTwo + 1000), `${await balance("1090")}`);
  await reconcile();

  /* Billed from the order: the link lives on the line, which is the only
     way an invoice can name an order at all. */
  const [orderLine] = await sql`
    select id from document_line where document_id = ${order.id} limit 1`;
  await P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT",
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300, sourceLineId: orderLine.id }] });
  check("one invoice claims the cost of both",
    (await balance("5000")) === r2(cogsTwo + 1000), `${await balance("5000")}`);
  check("and the holding account empties",
    (await balance("1090")) === heldTwo, `${await balance("1090")}`);
  await reconcile();

  // ------------------------------------------- goods that were never there
  /* Neither of these was in this suite when it first went green, and both
     turned out to be real bugs that the older suites caught instead. They
     are here now because the invariant above cannot see a problem it never
     exercises. */
  console.log("\n  goods issued before they were received\n");
  const heldNoStock = await balance("1090");
  const cogsNoStock = await balance("5000");
  const short = await P.postDelivery({ ...base, docDate: DAY,
    allowNegativeStock: true, negativeStockReason: "counted, not yet booked in",
    lines: [{ itemId: item2.id, qty: 50, unitPrice: 900 }] });
  check("their cost does not wait in 1090 — nothing could ever claim it",
    (await balance("1090")) === heldNoStock, `${await balance("1090")}`);
  check("it goes straight to cost of sales",
    (await balance("5000")) > cogsNoStock, `${await balance("5000")}`);
  await reconcile();

  console.log("\n  and the receipt that finally arrives\n");
  await buy2(50, 500);
  check("trues the difference up in cost of sales, not the holding account",
    (await balance("1090")) === heldNoStock, `${await balance("1090")}`);
  await reconcile();
  await P.voidDocument({ documentId: short.id, reason: "tidy", goodsBack: true })
    .catch(() => {});

  // ------------------------------------------- a cost corrected after the sale
  console.log("\n  a receipt repriced after the goods were sold\n");
  const item3 = await ensureItem("PSW-REPRICE", "Repriced probe");
  const grWrong = await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY,
    lines: [{ itemId: item3.id, qty: 10, unitCost: 100 }] });
  const [grLine] = await sql`
    select id from document_line where document_id = ${grWrong.id} limit 1`;
  const dRe = await P.postDelivery({ ...base, docDate: DAY,
    lines: [{ itemId: item3.id, qty: 10, unitPrice: 400 }] });
  await P.postSalesInvoice({ ...base, docDate: DAY, dueDate: DAY,
    paymentType: "CREDIT", deliveryId: dRe.id,
    lines: [{ itemId: item3.id, qty: 10, unitPrice: 400 }] });
  const cogsSold = await balance("5000");
  const heldSold = await balance("1090");

  // The supplier's bill says they cost 130, not the 100 that was guessed.
  await P.postPurchaseInvoice({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: DAY, dueDate: DAY, goodsReceiptId: grWrong.id,
    lines: [{ itemId: item3.id, qty: 10, unitPrice: 130, sourceLineId: grLine.id }] });
  check("the correction reaches cost of sales",
    (await balance("5000")) === r2(cogsSold + 300),
    `${await balance("5000")} vs ${r2(cogsSold + 300)}`);
  check("and not the holding account, where it would be stranded",
    (await balance("1090")) === heldSold, `${await balance("1090")}`);
  await reconcile();

  // --------------------------------------------------------- the statements
  console.log("\n  the income statement follows the invoice, not the delivery\n");
  const YEAR = ["2026-01-01", "2026-12-31"];
  const isLine = async (code) => {
    const rows = await Q.getIncomeStatement(co.id, YEAR[0], YEAR[1], null);
    const r = rows.find((x) => x.code === code);
    return r2(r?.amount ?? 0);
  };
  const bsLine = async (code) => {
    const [rows] = await Promise.all([Q.getBalanceSheet(co.id, YEAR[1], null)]);
    const r = (Array.isArray(rows) ? rows : rows.rows ?? []).find?.((x) => x.code === code);
    return r2(r?.amount ?? 0);
  };

  const heldNow = await balance("1090");
  const cogsNow = await balance("5000");
  const dStmt = await ship(8);
  check("a delivery alone adds nothing to cost of sales",
    (await isLine("5000")) === r2(cogsNow), `${await isLine("5000")} vs ${r2(cogsNow)}`);
  check("but it does show on the balance sheet at 1090",
    (await bsLine("1090")) === r2(heldNow + 800), `${await bsLine("1090")}`);
  await reconcile();

  await bill(8, dStmt.id);
  check("the invoice puts it into cost of sales",
    (await isLine("5000")) === r2(cogsNow + 800), `${await isLine("5000")}`);
  check("and 1090 clears back down",
    (await bsLine("1090")) === r2(heldNow), `${await bsLine("1090")}`);
  await reconcile();

  // ------------------------------------------------ the reconciliation report
  console.log("\n  the reconciliation shows the two steps\n");
  const recon2 = await Q.getInventoryCogsReconciliation(co.id, YEAR[0], YEAR[1], null);
  check("it knows the holding account", !!recon2.heldId);
  check("1090's balance equals what no invoice has claimed",
    r2(recon2.held.closing) === r2(recon2.held.unclaimed),
    `${r2(recon2.held.closing)} vs ${r2(recon2.held.unclaimed)}`);
  check("what was released equals what cost of sales shows",
    r2(recon2.held.invoiced_out) === r2(recon2.held.cogs_from_sales),
    `${r2(recon2.held.invoiced_out)} vs ${r2(recon2.held.cogs_from_sales)}`);
  check("and shipped less released is what is still held",
    r2(n(recon2.held.shipped_in) - n(recon2.held.invoiced_out))
      === r2(n(recon2.held.closing) - n(recon2.held.opening)),
    `${r2(n(recon2.held.shipped_in) - n(recon2.held.invoiced_out))}`);

  // ---------------------------------------------------- sales profitability
  console.log("\n  the sales report takes cost from the invoice\n");
  for (const bs of ["period", "profitability"]) {
    const cuts = [];
    for (const by of ["item", "customer", "category", "brand"]) {
      const rows = await Q.getSalesBreakdown(co.id, YEAR[0], YEAR[1], by, null, bs);
      cuts.push(r2(rows.reduce((t, r) => t + r.cost, 0)));
    }
    check(`  ${bs}: every cut shows the same cost`,
      cuts.every((c) => c === cuts[0]), cuts.join(" / "));
  }
  const period = await Q.getSalesBreakdown(co.id, YEAR[0], YEAR[1], "item", null, "period");
  const periodCost = r2(period.reduce((t, r) => t + r.cost, 0));
  check("and it equals cost of sales in the ledger",
    periodCost === r2(recon2.held.cogs_from_sales),
    `${periodCost} vs ${r2(recon2.held.cogs_from_sales)}`);

  // ------------------------------------------------------- branch filter
  console.log("\n  filtered to a branch\n");
  const branches = await Q.getBranches(co.id);
  if (branches.length > 0) {
    const b = branches[0].id;
    const glB = r2((await sql`
      select coalesce(sum(jl.base_amount),0) v from journal_line jl
      join account a on a.id=jl.account_id
      where a.code='1090' and (jl.location_id = ${b} or exists (
        select 1 from location l where l.id = jl.location_id and l.parent_id = ${b}))`)[0].v);
    const repB = r2((await getShippedNotInvoiced(co.id, b)).total);
    check("1090 and the report agree for one branch", glB === repB, `${glB} / ${repB}`);
  } else {
    check("1090 and the report agree for one branch", true, "no branches configured");
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
