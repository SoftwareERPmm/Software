// Goods that left and were never billed, and how long ago.
//
//   npx tsx scripts/test-shipped-not-invoiced.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database.
//
// The report is a worklist, so the way it fails is by being quietly wrong in
// one direction: a sale that was billed on a separate document reads as
// forgotten, or a giveaway reads as a sale nobody invoiced. Both make the
// list untrustworthy, and a worklist nobody trusts is not worked.
//
// So the cases are the ones where "unbilled" is not simply "no invoice
// exists": billed on a later document, billed in part, billed across two
// invoices, given away, and sent on consignment.

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
const { getShippedNotInvoiced } = await import("../lib/queries.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-shipped-not-invoiced.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

/** A posting date this many days before today, so the bands are exercised. */
const daysAgo = async (d) =>
  (await sql`select to_char(current_date - ${d}::int, 'YYYY-MM-DD') as d`)[0].d;

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
  const cust = await party("SNI-C", "Unbilled Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("SNI-S", "Unbilled Supplier", { is_supplier: true });
  const [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) throw new Error("This suite needs one stocked item.");

  const base = { companyId: co.id, partnerId: cust.id, locationId: loc.id };
  const TODAY = await daysAgo(0);
  const D3 = await daysAgo(3);
  const D45 = await daysAgo(45);
  const D100 = await daysAgo(100);
  // Far enough back to precede every delivery, and no further: the fiscal
  // calendar starts where it starts, and a receipt outside it is refused.
  const D150 = await daysAgo(150);

  // Bought before any of it ships, at one cost so the arithmetic is
  // checkable by eye.
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: D150, lines: [{ itemId: item.id, qty: 500, unitCost: 100 }] });

  const report = () => getShippedNotInvoiced(co.id, null);
  const band = (r, b) => r.buckets.find((x) => x.bucket === b);

  // ----------------------------------------------- a delivery nobody billed
  console.log("\n  goods that left with no invoice behind them\n");
  await P.postDelivery({ ...base, docDate: D100,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 300 }] });

  let r = await report();
  check("it is listed", r.deliveries === 1, `${r.deliveries}`);
  check("  valued at what the goods cost, not what they sell for",
    r.total === 2000, `${r.total}`);
  check("  and aged into the band it belongs in",
    n(band(r, "90+")?.value) === 2000 && n(band(r, "0-7")?.value) === 0,
    `90+ ${n(band(r, "90+")?.value)}`);

  // ------------------------------------------------ billed on a later paper
  console.log("\n  a delivery billed later, on its own document\n");
  const sent = await P.postDelivery({ ...base, docDate: D45,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });
  let mid = await report();
  check("before the invoice it is listed", mid.deliveries === 2, `${mid.deliveries}`);

  await P.postSalesInvoice({ ...base, docDate: TODAY, dueDate: TODAY,
    paymentType: "CREDIT", deliveryId: sent.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });

  r = await report();
  check("afterwards it is gone from the list", r.deliveries === 1, `${r.deliveries}`);
  check("  and the total drops by exactly its cost", r.total === 2000, `${r.total}`);

  // ------------------------------------------------------- billed in part
  console.log("\n  a delivery billed in part\n");
  const half = await P.postDelivery({ ...base, docDate: D3,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });
  await P.postSalesInvoice({ ...base, docDate: TODAY, dueDate: TODAY,
    paymentType: "CREDIT", deliveryId: half.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 300 }] });

  r = await report();
  const partial = r.rows.find((x) => x.deliveryId === half.id);
  check("only the unbilled part is left", n(partial?.qty) === 6, `${partial?.qty}`);
  check("  valued at the cost of those units", n(partial?.value) === 600, `${partial?.value}`);
  check("  and aged from when the goods left, not when it was billed",
    partial?.bucket === "0-7", String(partial?.bucket));

  // ------------------------------------------- one delivery, two invoices
  console.log("\n  one delivery billed across two invoices\n");
  const split = await P.postDelivery({ ...base, docDate: D3,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 300 }] });
  for (const q of [3, 7]) {
    await P.postSalesInvoice({ ...base, docDate: TODAY, dueDate: TODAY,
      paymentType: "CREDIT", deliveryId: split.id,
      lines: [{ itemId: item.id, qty: q, unitPrice: 300 }] });
  }
  r = await report();
  check("it clears once both invoices exist",
    !r.rows.some((x) => x.deliveryId === split.id), "still listed");

  // ------------------------------------------- what is not awaiting a bill
  console.log("\n  and what was never going to be invoiced\n");
  const [promo] = await sql`
    select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;
  await P.postDelivery({ ...base, docDate: D3,
    lines: [{ itemId: item.id, qty: 5, focReasonId: promo.id }] });

  const gift = await report();
  check("a giveaway is not a forgotten sale",
    gift.total === 2600, `${gift.total}`);

  // --------------------------------------------------------- a counter sale
  console.log("\n  a counter sale never appears at all\n");
  await P.postSaleWithDelivery({ ...base, docDate: TODAY, dueDate: TODAY,
    paymentType: "CREDIT", lines: [{ itemId: item.id, qty: 8, unitPrice: 300 }] });

  const after = await report();
  check("goods and bill in one act leave nothing behind",
    after.total === 2600, `${after.total}`);

  // ------------------------------------------------------------- the bands
  console.log("\n  the bands add up to the total\n");
  const summed = after.buckets.reduce((t, b) => t + b.value, 0);
  check("every row lands in exactly one band", summed === after.total,
    `${summed} vs ${after.total}`);
  const counted = after.buckets.reduce((t, b) => t + b.deliveries, 0);
  check("  and is counted exactly once", counted === after.deliveries,
    `${counted} vs ${after.deliveries}`);
  check("the oldest is the oldest still unbilled", after.oldestDays === 100,
    `${after.oldestDays}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
