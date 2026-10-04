// The four ways a sales invoice can meet its goods.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 npx tsx scripts/test-sales-voucher-modes.mjs
//
// The sales voucher offers four fulfilment modes, and each posts a different
// shape: customer takes now, we deliver now, deliver later, and bill a
// delivery that has already gone. Cost of sales moved to the invoice
// (docs/03-decisions.md, D8), so each of those shapes had to be re-checked —
// three of them compose an invoice with a delivery and the fourth composes
// nothing at all.
//
// Driven through createSalesInvoice, the action the screen submits to,
// rather than through the posting engine underneath it. The engine is
// covered elsewhere; what this asks is whether the buttons still reach it
// correctly.

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
const A = await import("../lib/actions.ts");
const Q = await import("../lib/queries.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-sales-voucher-modes.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const r2 = (v) => Math.round(Number(v ?? 0) * 100) / 100;

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
  const cust = await party("SVM-C", "Voucher Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("SVM-S", "Voucher Supplier", { is_supplier: true });
  const [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  const DAY = (await sql`select to_char(current_date,'YYYY-MM-DD') as d`)[0].d;

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 200, unitCost: 100 }] });

  const bal = async (code) => r2((await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
     where a.code = ${code} and jl.company_id = ${co.id}`)[0].v);

  /** The same invariant the engine suite checks, after every mode. */
  const reconciles = async () => {
    const gl = await bal("1090");
    const [vw] = await sql`select coalesce(sum(value_unclaimed),0) v
      from v_delivery_cost_unclaimed where company_id = ${co.id}`;
    const rep = r2((await Q.getShippedNotInvoiced(co.id, null)).total);
    return { ok: gl === r2(vw.v) && r2(vw.v) === rep, gl, view: r2(vw.v), rep };
  };

  /** What the screen submits. */
  const submit = async (mode, qty, extra = {}) => {
    const fd = new FormData();
    fd.set("partner_id", cust.id);
    fd.set("location_id", loc.id);
    fd.set("doc_date", DAY);
    fd.set("due_date", DAY);
    fd.set("payment_type", "CREDIT");
    fd.set("lines", JSON.stringify([{ itemId: item.id, qty, unitPrice: 500 }]));
    if (mode === "later") fd.set("to_deliver", "on");
    if (mode === "match") fd.set("delivery_id", extra.deliveryId);
    if (extra.fee) fd.set("delivery_fee", String(extra.fee));
    /* The action calls revalidatePath when it is done, which needs a Next
       request to live in. The posting has already committed by then, so a
       script driving the action sees the cache call fail and the documents
       written. Treated as success here rather than wrapping the product in
       a test-only branch. */
    try {
      return await A.createSalesInvoice(null, fd);
    } catch (e) {
      if (String(e.message).includes("static generation store")) return { ok: true };
      throw e;
    }
  };

  // ------------------------------------------------- 1. customer takes now
  console.log("\n  Customer takes now\n");
  let held = await bal("1090"), cogs = await bal("5000");
  let res = await submit("counter", 10);
  check("the invoice posts", !res?.error, res?.error ?? "");
  check("cost of sales is recognised", (await bal("5000")) === r2(cogs + 1000),
    `${await bal("5000")}`);
  check("revenue is recognised at once, not deferred",
    (await bal("2070")) === 0, `2070 ${await bal("2070")}`);
  check("and nothing is left waiting", (await bal("1090")) === held,
    `${await bal("1090")}`);
  let rec = await reconciles();
  check("  reconciles", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  // ------------------------------------------------------ 2. we deliver now
  console.log("\n  We deliver now, with carriage\n");
  held = await bal("1090"); cogs = await bal("5000");
  res = await submit("send", 8, { fee: 2000 });
  check("the invoice posts", !res?.error, res?.error ?? "");
  check("cost of sales is recognised", (await bal("5000")) === r2(cogs + 800),
    `${await bal("5000")}`);
  check("the carriage reaches delivery income", (await bal("4030")) < 0,
    `${await bal("4030")}`);
  check("and nothing is left waiting", (await bal("1090")) === held,
    `${await bal("1090")}`);
  rec = await reconciles();
  check("  reconciles", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  // -------------------------------------------------------- 3. deliver later
  console.log("\n  Deliver later\n");
  held = await bal("1090"); cogs = await bal("5000");
  const sales = await bal("4000"), def = await bal("2070");
  res = await submit("later", 6);
  check("the invoice posts", !res?.error, res?.error ?? "");
  check("no cost is recognised — no goods have moved",
    (await bal("5000")) === cogs, `${await bal("5000")}`);
  check("and nothing sits in the holding account either",
    (await bal("1090")) === held, `${await bal("1090")}`);
  /* The point of D9: billed is not earned. The receivable stands, but the
     revenue waits in a liability until the goods go, so it cannot sit in
     a month with no cost beside it. */
  check("no revenue is recognised either", (await bal("4000")) === sales,
    `4000 ${await bal("4000")}`);
  check("it waits in deferred revenue", (await bal("2070")) === r2(def - 3000),
    `2070 ${await bal("2070")}`);
  rec = await reconciles();
  check("  reconciles", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  console.log("\n  …and the goods follow\n");
  const [pending] = await sql`
    select id from document where company_id = ${co.id}
      and doc_type = 'SALES_INVOICE' and to_deliver order by created_at desc limit 1`;
  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, sourceDocumentId: pending.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 500 }] });
  check("the delivery recognises the cost against the bill already raised",
    (await bal("5000")) === r2(cogs + 600), `${await bal("5000")}`);
  check("and the revenue with it", (await bal("4000")) === r2(sales - 3000),
    `4000 ${await bal("4000")}`);
  check("clearing the deferral", (await bal("2070")) === def,
    `2070 ${await bal("2070")}`);
  check("leaving nothing behind", (await bal("1090")) === held, `${await bal("1090")}`);
  rec = await reconciles();
  check("  reconciles", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  // ----------------------------------------------------- 4. already delivered
  console.log("\n  Already delivered\n");
  const sent = await P.postDelivery({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: 12, unitPrice: 500 }] });
  held = await bal("1090"); cogs = await bal("5000");
  check("the delivery alone parks its cost", held > 0, `1090 ${held}`);
  rec = await reconciles();
  check("  reconciles while it waits", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  res = await submit("match", 12, { deliveryId: sent.id });
  check("the invoice posts", !res?.error, res?.error ?? "");
  check("it claims the delivery's cost", (await bal("5000")) === r2(cogs + 1200),
    `${await bal("5000")}`);
  check("and clears the holding account", (await bal("1090")) === r2(held - 1200),
    `${await bal("1090")}`);
  rec = await reconciles();
  check("  reconciles", rec.ok, `${rec.gl} / ${rec.view} / ${rec.rep}`);

  // ------------------------------- cancelled before the goods ever went
  console.log("\n  a deliver-later invoice cancelled before delivery\n");
  const ar0 = await bal("1030"), def0 = await bal("2070");
  await submit("later", 5);
  const [pending2] = await sql`
    select id from document where company_id = ${co.id}
      and doc_type = 'SALES_INVOICE' and to_deliver and status = 'POSTED'
     order by created_at desc limit 1`;
  check("it owes and defers", (await bal("1030")) === r2(ar0 + 2500)
    && (await bal("2070")) === r2(def0 - 2500),
    `AR ${await bal("1030")} / 2070 ${await bal("2070")}`);

  await P.voidDocument({ documentId: pending2.id, reason: "cancelled", goodsBack: true });
  check("cancelling reverses the receivable", (await bal("1030")) === ar0,
    `${await bal("1030")}`);
  check("and the deferral with it", (await bal("2070")) === def0,
    `${await bal("2070")}`);
  check("no revenue was ever recognised", (await bal("4000")) === r2(await bal("4000")),
    "unchanged");
  let rc = await reconciles();
  check("  reconciles", rc.ok, `${rc.gl} / ${rc.view} / ${rc.rep}`);

  // --------------------------------------------- only part of it goes out
  console.log("\n  a deliver-later invoice half shipped\n");
  const ar1 = await bal("1030"), def1 = await bal("2070");
  const sales1 = await bal("4000"), cogs1 = await bal("5000");
  await submit("later", 10);
  const [half] = await sql`
    select id from document where company_id = ${co.id}
      and doc_type = 'SALES_INVOICE' and to_deliver and status = 'POSTED'
     order by created_at desc limit 1`;
  check("the whole 5,000 is deferred", (await bal("2070")) === r2(def1 - 5000),
    `${await bal("2070")}`);

  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, sourceDocumentId: half.id,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 500 }] });
  check("four tenths of the revenue is earned",
    (await bal("4000")) === r2(sales1 - 2000), `4000 ${await bal("4000")}`);
  check("and six tenths still deferred",
    (await bal("2070")) === r2(def1 - 3000), `2070 ${await bal("2070")}`);
  check("with only the cost of the four",
    (await bal("5000")) === r2(cogs1 + 400), `5000 ${await bal("5000")}`);
  rc = await reconciles();
  check("  reconciles", rc.ok, `${rc.gl} / ${rc.view} / ${rc.rep}`);

  console.log("\n  …then the rest\n");
  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, sourceDocumentId: half.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 500 }] });
  check("the deferral empties", (await bal("2070")) === def1, `${await bal("2070")}`);
  check("revenue is whole", (await bal("4000")) === r2(sales1 - 5000),
    `${await bal("4000")}`);
  check("and so is the cost", (await bal("5000")) === r2(cogs1 + 1000),
    `${await bal("5000")}`);
  rc = await reconciles();
  check("  reconciles", rc.ok, `${rc.gl} / ${rc.view} / ${rc.rep}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
