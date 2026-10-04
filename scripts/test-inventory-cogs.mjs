// Inventory and cost of sales, reconciled two ways.
//
//   npx tsx scripts/test-inventory-cogs.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database.
//
// The report this covers exists because the traditional
//
//     COGS = opening inventory + purchases - closing inventory
//
// is not how a perpetual FIFO ledger computes anything, and a tester checking
// the books that way finds figures that look wrong and are not. What the
// report must prove is that the identity holds once every non-sale release is
// named: a giveaway, a write-off and a purchase return all satisfy "opening
// plus purchases less closing" and not one of them is cost of goods sold.
//
// So these cases are chosen to break a naive implementation: each one moves
// stock for a reason that is not a sale, or moves it without moving money, or
// moves money without moving stock.

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

const {
  postGoodsReceipt, postSaleWithDelivery, postPurchaseInvoice, postDelivery,
  postStockAdjustment, postStockTransfer, postSalesReturn, postPurchaseReturn,
} = await import("../lib/posting.ts");
const { getInventoryCogsReconciliation } = await import("../lib/queries.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-inventory-cogs.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);
const r4 = (v) => Math.round(n(v) * 10000) / 10000;

const FROM = "2026-01-01";
const TO = "2026-12-31";
const DAY = "2026-06-01";

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const locs = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code`;
  const loc = locs[0];
  const other = locs[1] ?? null;

  await resetTransactions(sql);

  const party = async (code, name, cols) => {
    const [found] = await sql`
      select id from business_partner where company_id = ${co.id} and code = ${code}`;
    if (found) return found;
    return (await sql`
      insert into business_partner ${sql({ company_id: co.id, code, name, ...cols })}
      returning id`)[0];
  };
  const cust = await party("ICR-C", "Recon Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("ICR-S", "Recon Supplier", { is_supplier: true });

  const [item] = await sql`
    select id, code, name from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) throw new Error("This suite needs one stocked item.");

  const recon = () => getInventoryCogsReconciliation(co.id, FROM, TO, null);
  const released = (r, code) =>
    r.movement.filter((m) => m.code === code).reduce((s, m) => s + n(m.out_of_stock), 0);
  const addedFrom = (r, code) =>
    r.movement.filter((m) => m.code === code).reduce((s, m) => s + n(m.into_stock), 0);

  // ---------------------------------------------------------------- buy/sell
  console.log("\n  a plain purchase and sale\n");
  await postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] });
  await postSaleWithDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, dueDate: DAY, paymentType: "CREDIT",
    lines: [{ itemId: item.id, qty: 30, unitPrice: 2500 }] });

  let r = await recon();
  let opening = n(r.bal.opening), closing = n(r.bal.closing);
  let additions = r.movement.reduce((s, m) => s + n(m.into_stock), 0);
  let releases = r.movement.reduce((s, m) => s + n(m.out_of_stock), 0);
  check("opening + additions - releases = closing",
    r4(opening + additions - releases) === r4(closing),
    `${opening} + ${additions} - ${releases} = ${closing}`);
  check("cost of sales is the released cost", r4(releases) === 30000, `${releases}`);
  check("FIFO value equals the inventory account",
    r4(n(r.fifo.value) - n(r.negative.value)) === r4(closing),
    `FIFO ${n(r.fifo.value)} vs GL ${closing}`);
  check("calculated COGS equals posted COGS",
    r4(r.consumption.reduce((s, c) => s + n(c.value), 0) - n(r.returnedToCogs.value))
      === r4(n(r.postedCogs.value)),
    `${r4(r.consumption.reduce((s, c) => s + n(c.value), 0))} vs ${r4(n(r.postedCogs.value))}`);

  // ------------------------------------------------------------- a giveaway
  console.log("\n  a giveaway, which is not cost of sales\n");
  const [promo] = await sql`select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;
  // A wholly free invoice is refused by design — a giveaway is recorded by
  // the delivery, which is what sends its cost to the promotion account.
  await postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 5, focReasonId: promo.id }] });

  r = await recon();
  const cogsCode = (await sql`select code from account where id = ${r.cogsId}`)[0].code;
  /* The stock ledger still records cost of sales against every issue — that
     is where the cost is destined, and where a later correction must find
     it. What changed is where it waits: a delivery debits the holding
     account until an invoice bills the goods (docs/03-decisions.md, D8), so
     the counter-account the journal shows on an issue is 1090 even though
     the consumption says 5000. */
  const heldCode = (await sql`select code from account where id = ${r.heldId}`)[0].code;
  const toHeld = released(r, heldCode);
  const toPromo = released(r, "6320");
  check("the giveaway leaves stock", r4(toPromo) === 5000, `${toPromo}`);
  check("and is not counted as the cost of goods sold",
    r4(toHeld) === 30000, `shipped-not-invoiced still ${toHeld}`);
  check("so the naive formula overstates COGS by the giveaway",
    r4(n(r.bal.opening) + r.movement.reduce((s, m) => s + n(m.into_stock), 0)
       - n(r.bal.closing)) === r4(toHeld + toPromo),
    `${toHeld} + ${toPromo}`);

  // ---------------------------------------------------------- invoice-first
  console.log("\n  an invoice with no receipt behind it yet\n");
  const before = await recon();
  await postPurchaseInvoice({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, dueDate: DAY, lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }] });
  r = await recon();
  check("an unreceived invoice does not move inventory",
    r4(n(r.bal.closing)) === r4(n(before.bal.closing)),
    `${n(before.bal.closing)} -> ${n(r.bal.closing)}`);

  // ------------------------------------------------------- a stock write-off
  console.log("\n  a write-off\n");
  await postStockAdjustment({ companyId: co.id, locationId: loc.id, docDate: DAY,
    reason: "Damaged in the warehouse",
    lines: [{ itemId: item.id, qty: -4 }] });
  r = await recon();
  const toAdj = released(r, "5300");
  check("the write-off leaves stock", toAdj > 0, `${toAdj}`);
  check("and is not the cost of goods sold", r4(released(r, heldCode)) === 30000);

  // ----------------------------------------------------------- sales return
  console.log("\n  a customer returns goods\n");
  await postSalesReturn({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 2, unitPrice: 2500 }] });
  r = await recon();
  // Its entry credits cost of sales, credits the return account and debits a
  // customer advance, so there is no single counter-account. But exactly one
  // of them offsets the stock coming back, and that is where it belongs.
  const backFromReturn = r.movement
    .filter((m) => m.source_type === "SALES_RETURN")
    .reduce((s2, m) => s2 + n(m.into_stock), 0);
  check("the return puts stock back", r4(backFromReturn) === 2000, `${backFromReturn}`);
  check("and it is attributed to cost of sales, which it exactly offsets",
    r.movement.some((m) => m.source_type === "SALES_RETURN"
                        && m.code === cogsCode && r4(n(m.into_stock)) === 2000),
    r.movement.filter((m) => m.source_type === "SALES_RETURN")
      .map((m) => `${m.code ?? "by document"} ${r4(n(m.into_stock))}`).join(", "));

  // -------------------------------------------------------- purchase return
  console.log("\n  goods go back to the supplier\n");
  await postPurchaseReturn({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 3, unitPrice: 1000 }] });
  r = await recon();
  // Against Accounts Payable, not a purchase-return account: the goods go
  // back and so does the debt. Either way it is not cost of sales.
  check("it leaves stock against the supplier, not cost of sales",
    released(r, "2000") > 0 && r4(released(r, heldCode)) === 30000,
    `to AP ${released(r, "2000")}, sold still ${released(r, heldCode)}`);

  // -------------------------------------------------------------- transfers
  if (other) {
    console.log("\n  a transfer between warehouses\n");
    const beforeT = await recon();
    await postStockTransfer({ companyId: co.id, fromLocationId: loc.id, toLocationId: other.id,
      docDate: DAY, lines: [{ itemId: item.id, qty: 5 }] });
    r = await recon();
    check("a transfer does not change company inventory",
      r4(n(r.bal.closing)) === r4(n(beforeT.bal.closing)),
      `${n(beforeT.bal.closing)} -> ${n(r.bal.closing)}`);
  }

  // ------------------------------------------------------- the whole period
  console.log("\n  and the whole period still ties\n");
  r = await recon();
  opening = n(r.bal.opening); closing = n(r.bal.closing);
  additions = r.movement.reduce((s, m) => s + n(m.into_stock), 0);
  releases = r.movement.reduce((s, m) => s + n(m.out_of_stock), 0);
  check("opening + additions - releases = closing",
    r4(opening + additions - releases) === r4(closing),
    `${opening} + ${additions} - ${releases} = ${closing}`);
  check("FIFO value still equals the inventory account",
    r4(n(r.fifo.value) - n(r.negative.value)) === r4(closing),
    `FIFO ${r4(n(r.fifo.value) - n(r.negative.value))} vs GL ${r4(closing)}`);
  /* The layers the sales consumed, which now carry the holding account
     rather than cost of sales, less what came back on the return. Equal to
     the ledger's cost of sales because every sale here is a counter sale:
     the goods and the bill move together, so everything that reached 1090
     left it again in the same breath. Where they do not move together, the
     two steps separate — which is what test-posting-switch.mjs covers. */
  const calc = r4(
    r.consumption.filter((c) => c.code === cogsCode).reduce((s, c) => s + n(c.value), 0)
    - n(r.returnedToCogs.value));
  check("calculated cost of sales still equals the ledger's",
    calc === r4(n(r.postedCogs.value)), `${calc} vs ${r4(n(r.postedCogs.value))}`);

  check("and nothing is left waiting in the holding account",
    r4(n(r.held.closing)) === 0, `1090 holds ${r4(n(r.held.closing))}`);

  console.log(failures === 0
    ? "\n  all inventory/COGS reconciliation tests pass\n"
    : `\n  ${failures} FAILED\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures > 0 ? 1 : 0);
