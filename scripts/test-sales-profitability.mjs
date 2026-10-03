// The two bases a sales report can be read on.
//
//   npx tsx scripts/test-sales-profitability.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database.
//
// The report offers two answers to "what did we make", and they are both
// right. On the accounting-period basis revenue is what was invoiced in the
// window and cost is what the deliveries consumed in the same window; it ties
// to the income statement and says nothing about whether the two describe the
// same goods. On the profitability basis the invoices in the window are set
// against the goods that actually went out for them — whenever they went out
// — and revenue with nothing behind it is reported outside the margin.
//
// So these cases are the ones where the two must disagree, and disagree by a
// knowable amount: goods out in one month billed in the next, a bill with
// nothing shipped against it, a part shipment, and one delivery billed twice.
// A naive implementation passes the first case and fails every other.

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
const { getSalesBreakdown, getSalesOverview } = await import("../lib/queries.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-sales-profitability.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);
const r4 = (v) => Math.round(n(v) * 10000) / 10000;

const JUNE = "2026-06-10";
const JULY = "2026-07-10";
const Q2 = ["2026-04-01", "2026-06-30"];
const Q3 = ["2026-07-01", "2026-09-30"];
const YEAR = ["2026-01-01", "2026-12-31"];

try {
  const [co] = await sql`select id from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await resetTransactions(sql);

  const party = async (code, name, cols) => {
    const [found] = await sql`
      select id from business_partner where company_id = ${co.id} and code = ${code}`;
    if (found) return found;
    return (await sql`
      insert into business_partner ${sql({ company_id: co.id, code, name, ...cols })}
      returning id`)[0];
  };
  const cust = await party("SPB-C", "Basis Customer", { is_customer: true, payment_terms_days: 30 });
  const other = await party("SPB-D", "Basis Customer Two", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("SPB-S", "Basis Supplier", { is_supplier: true });

  const [item] = await sql`
    select id, code from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) throw new Error("This suite needs one stocked item.");

  const base = { companyId: co.id, locationId: loc.id };
  const buy = (qty, cost, day) => P.postGoodsReceipt({
    ...base, partnerId: supp.id, docDate: day,
    lines: [{ itemId: item.id, qty, unitCost: cost }] });

  /** Every cut of the report, on one basis, as one set of totals. */
  const totals = async (basis, [from, to]) => {
    const cuts = {};
    for (const by of ["item", "customer", "category", "brand"]) {
      const rows = await getSalesBreakdown(co.id, from, to, by, null, basis);
      cuts[by] = {
        revenue: r4(rows.reduce((t, r) => t + r.revenue, 0)),
        cost: r4(rows.reduce((t, r) => t + r.cost, 0)),
        unmatched: r4(rows.reduce((t, r) => t + r.unmatched, 0)),
        qty: r4(rows.reduce((t, r) => t + r.qty, 0)),
        matchedQty: r4(rows.reduce((t, r) => t + r.matchedQty, 0)),
        freeQty: r4(rows.reduce((t, r) => t + r.freeQty, 0)),
        rows,
      };
    }
    return { ...cuts.item, cuts };
  };

  /** The same figure however the report is sliced, or the report is lying. */
  const agrees = (t, label) => {
    const keys = ["revenue", "cost", "unmatched", "qty", "matchedQty"];
    const bad = Object.entries(t.cuts).filter(([, c]) =>
      keys.some((k) => c[k] !== t.cuts.item[k]));
    check(`${label}: every cut shows the same totals`, bad.length === 0,
      bad.map(([k, c]) => `${k} ${c.revenue}/${c.cost}`).join(" "));
  };

  // ----------------------------------------------- goods and bill together
  console.log("\n  a counter sale, where nothing is out of step\n");
  await buy(100, 1000, JUNE);
  await P.postSaleWithDelivery({ ...base, partnerId: cust.id, docDate: JUNE, dueDate: JUNE,
    paymentType: "CREDIT", lines: [{ itemId: item.id, qty: 10, unitPrice: 2500 }] });

  let per = await totals("period", Q2);
  let pro = await totals("profitability", Q2);
  check("both bases see the revenue", per.revenue === 25000 && pro.revenue === 25000,
    `${per.revenue} / ${pro.revenue}`);
  check("both bases see the cost", per.cost === 10000 && pro.cost === 10000,
    `${per.cost} / ${pro.cost}`);
  check("nothing is unmatched", pro.unmatched === 0, `${pro.unmatched}`);
  agrees(pro, "counter sale");

  // ------------------------------------------- goods in June, bill in July
  console.log("\n  goods out in June, billed in July\n");
  const juneDelivery = await P.postDelivery({ ...base, partnerId: cust.id, docDate: JUNE,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 2500 }] });
  await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: JULY, dueDate: JULY,
    paymentType: "CREDIT", deliveryId: juneDelivery.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 2500 }] });

  per = await totals("period", Q3);
  pro = await totals("profitability", Q3);
  check("the period basis books July's revenue with no cost behind it",
    per.revenue === 50000 && per.cost === 0, `${per.revenue} / ${per.cost}`);
  check("the profitability basis reaches back for June's cost",
    pro.revenue === 50000 && pro.cost === 20000, `${pro.revenue} / ${pro.cost}`);
  check("and counts none of it unmatched", pro.unmatched === 0, `${pro.unmatched}`);

  per = await totals("period", Q2);
  pro = await totals("profitability", Q2);
  check("the period basis leaves June holding cost it never earned on",
    per.revenue === 25000 && per.cost === 30000, `${per.revenue} / ${per.cost}`);
  check("the profitability basis gives June only its own sale",
    pro.revenue === 25000 && pro.cost === 10000, `${pro.revenue} / ${pro.cost}`);
  agrees(pro, "June");

  // ---------------------------------------------- a bill with nothing sent
  console.log("\n  a bill with nothing shipped against it\n");
  await P.postSalesInvoice({ ...base, partnerId: other.id, docDate: JULY, dueDate: JULY,
    paymentType: "CREDIT", toDeliver: true,
    lines: [{ itemId: item.id, qty: 8, unitPrice: 3000 }] });

  pro = await totals("profitability", Q3);
  check("the revenue is held outside the margin", pro.revenue === 50000 && pro.unmatched === 24000,
    `matched ${pro.revenue} unmatched ${pro.unmatched}`);
  check("no cost is invented for it", pro.cost === 20000, `${pro.cost}`);
  check("the units are counted but not matched",
    pro.qty === 28 && pro.matchedQty === 20, `${pro.qty} / ${pro.matchedQty}`);
  const unbilled = pro.cuts.customer.rows.find((r) => r.code === "SPB-D");
  check("the customer who was billed shows no margin at all",
    unbilled && unbilled.revenue === 0 && unbilled.marginPct === null,
    `${unbilled?.revenue} ${unbilled?.marginPct}`);
  agrees(pro, "undelivered bill");

  // ------------------------------------------------------- a part shipment
  console.log("\n  half the goods go out\n");
  const [pending] = await sql`
    select id from document where company_id = ${co.id}
      and doc_type = 'SALES_INVOICE' and partner_id = ${other.id}`;
  await P.postDelivery({ ...base, partnerId: other.id, docDate: JULY,
    sourceDocumentId: pending.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 3000 }] });

  pro = await totals("profitability", Q3);
  check("six eighths of what was charged is earned",
    pro.revenue === 50000 + 18000, `${pro.revenue}`);
  check("two eighths of it is still owed as goods",
    pro.unmatched === 6000, `${pro.unmatched}`);
  check("and the cost is the cost of the six", pro.cost === 20000 + 6000, `${pro.cost}`);
  agrees(pro, "part shipment");

  // --------------------------------------------- one delivery, two invoices
  console.log("\n  one delivery billed across two invoices\n");
  const split = await P.postDelivery({ ...base, partnerId: cust.id, docDate: JULY,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 2500 }] });
  for (const qty of [4, 6]) {
    await P.postSalesInvoice({ ...base, partnerId: cust.id, docDate: JULY, dueDate: JULY,
      paymentType: "CREDIT", deliveryId: split.id,
      lines: [{ itemId: item.id, qty, unitPrice: 2500 }] });
  }

  const after = await totals("profitability", Q3);
  check("the goods are costed once, not once per invoice",
    after.cost === 26000 + 10000, `${after.cost}`);
  check("and both invoices are earned in full",
    after.revenue === 68000 + 25000 && after.unmatched === 6000,
    `${after.revenue} / ${after.unmatched}`);
  agrees(after, "split billing");

  // -------------------------------------------------------- a giveaway
  console.log("\n  a giveaway, which earns nothing and costs elsewhere\n");
  const [promo] = await sql`
    select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;
  await P.postDelivery({ ...base, partnerId: cust.id, docDate: JULY,
    lines: [{ itemId: item.id, qty: 5, focReasonId: promo.id }] });

  const gift = await totals("profitability", Q3);
  check("it changes neither revenue nor cost of sales",
    gift.revenue === after.revenue && gift.cost === after.cost,
    `${gift.revenue} / ${gift.cost}`);

  // --------------------------------------------------- the whole year ties
  console.log("\n  over a window wide enough to hold both halves\n");
  const yearPer = await totals("period", YEAR);
  const yearPro = await totals("profitability", YEAR);
  check("the period basis counts every invoice and every delivery",
    yearPer.revenue === 124000 && yearPer.cost === 46000,
    `${yearPer.revenue} / ${yearPer.cost}`);
  check("the profitability basis earns all but the undelivered two",
    yearPro.revenue === 118000 && yearPro.unmatched === 6000,
    `${yearPro.revenue} / ${yearPro.unmatched}`);
  check("the two bases differ by exactly what has not shipped",
    r4(yearPer.revenue - yearPro.revenue) === yearPro.unmatched,
    `${yearPer.revenue} - ${yearPro.revenue} vs ${yearPro.unmatched}`);
  check("and the profitability cost is the period cost less the giveaway",
    yearPro.cost === 46000, `${yearPro.cost}`);
  agrees(yearPro, "year");

  // ------------------------------------------------------------- overview
  console.log("\n  the overview reads the same basis as the tables\n");
  const ovPer = await getSalesOverview(co.id, YEAR[0], YEAR[1], null, "period");
  const ovPro = await getSalesOverview(co.id, YEAR[0], YEAR[1], null, "profitability");
  check("the period overview matches the period tables",
    r4(ovPer.now.net) === yearPer.revenue && r4(ovPer.now.cost) === yearPer.cost,
    `${r4(ovPer.now.net)} / ${r4(ovPer.now.cost)}`);
  check("the profitability overview matches the profitability tables",
    r4(ovPro.now.net) === yearPro.revenue && r4(ovPro.now.cost) === yearPro.cost,
    `${r4(ovPro.now.net)} / ${r4(ovPro.now.cost)}`);
  check("and carries the unmatched revenue with it",
    r4(ovPro.now.unmatched) === yearPro.unmatched, `${r4(ovPro.now.unmatched)}`);
  const monthNet = r4(ovPro.series.reduce((t, m) => t + n(m.net), 0));
  check("the monthly series adds up to the period",
    monthNet === yearPro.revenue, `${monthNet} vs ${yearPro.revenue}`);
  const july = ovPro.series.find((m) => m.month === "2026-07");
  check("July carries the revenue that was billed in July",
    r4(july.net) === 93000, `${r4(july.net)}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
