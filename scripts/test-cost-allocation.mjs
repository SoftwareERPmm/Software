// Goods can be claimed once, and a release puts back exactly what it took.
//
//   npx tsx scripts/test-cost-allocation.mjs
//
// Posts real documents and empties the transaction tables first. Run against
// a scratch database.
//
// Nothing posts against sales_cost_allocation yet — cost of sales is still
// recognised on the delivery. This covers the table on its own, before
// anything depends on it, because it is the piece the whole change rests on:
// once an invoice posts cost of sales, a claim is a ledger fact, and the
// guards here are what stop two invoices taking the same goods or a void
// putting back more than it ever took.
//
// See docs/03-decisions.md, D8.

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

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

await takeTestLock(sql, "test-cost-allocation.mjs");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
/** Runs it, and hands back the error message if the database refused. */
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return String(e.message ?? e); }
};
const n = (v) => Number(v ?? 0);

const DAY = "2026-06-01";

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
  const cust = await party("SCA-C", "Allocation Customer", { is_customer: true, payment_terms_days: 30 });
  const supp = await party("SCA-S", "Allocation Supplier", { is_supplier: true });
  const [item] = await sql`
    select id from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) throw new Error("This suite needs one stocked item.");

  // ---------------------------------------------------- the account and role
  console.log("\n  somewhere for shipped-not-billed cost to sit\n");
  const [acct] = await sql`
    select a.id, a.name, a.account_type, a.is_postable
      from account a where a.company_id = ${co.id} and a.code = '1090'`;
  check("1090 exists", !!acct, acct?.name);
  check("  and is an asset, not an expense",
    acct?.account_type === "ASSET", String(acct?.account_type));
  const [role] = await sql`
    select s.account_id from system_account s
     where s.company_id = ${co.id} and s.role = 'SHIPPED_NOT_INVOICED'`;
  check("the role points at it", role?.account_id === acct?.id);

  console.log("\n  and a delivery puts the cost of the goods there\n");
  // Two layers at different costs, so a claim that averaged them would be
  // visibly wrong rather than accidentally right.
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 10, unitCost: 1000 }] });
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 10, unitCost: 1500 }] });
  const delivery = await P.postDelivery({ companyId: co.id, partnerId: cust.id,
    locationId: loc.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: 15, unitPrice: 3000 }] });

  const [posted] = await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl where jl.account_id = ${acct.id}`;
  // 10 at 1,000 then 5 at 1,500, drawn oldest first for 15 units.
  check("the delivery debits 1090 with what the goods cost",
    n(posted.v) === 10 * 1000 + 5 * 1500, String(posted.v));

  const consumption = await sql`
    select c.id, c.qty, c.unit_cost
      from stock_lot_consumption c
      join stock_movement sm on sm.id = c.stock_movement_id
     where sm.document_id = ${delivery.id}
     order by c.unit_cost`;
  check("the delivery drew from both layers", consumption.length === 2,
    consumption.map((c) => `${n(c.qty)}@${n(c.unit_cost)}`).join(" "));

  const [invLine] = await sql`
    select dl.id from document_line dl where dl.document_id = ${delivery.id} limit 1`;
  const first = consumption[0];
  /* posted_by_document_id names the entry that carried the cost to 5000.
     Nothing is being posted here — this suite exercises the table's own
     guards — so the delivery stands in for it. */
  const claim = (qty, reverses = null) => sql`
    insert into sales_cost_allocation
      (company_id, invoice_line_id, consumption_id, qty, unit_cost, reverses_id,
       posted_by_document_id)
    values (${co.id}, ${invLine.id}, ${first.id}, ${qty}, ${first.unit_cost}, ${reverses},
            ${delivery.id})
    returning id`;

  // ------------------------------------------------------- claiming the cost
  console.log("\n  goods can be claimed once\n");
  const [a1] = await claim(6);
  check("a claim within what moved is accepted", !!a1.id);

  const over = await refused(() => claim(n(first.qty) - 6 + 0.001));
  check("a claim beyond it is refused", over !== null, String(over).slice(0, 64));

  const [a2] = await claim(n(first.qty) - 6);
  check("but claiming exactly the rest is fine", !!a2.id);

  const second = await refused(() => claim(0.001));
  check("a second invoice cannot take what is already taken",
    second !== null, String(second).slice(0, 64));

  // ------------------------------------------------------------- releasing it
  console.log("\n  and a release puts back what it took, no more\n");
  const [r1] = await claim(-2, a1.id);
  check("a release naming its claim is accepted", !!r1.id);

  const [free] = await sql`
    select qty_unclaimed from v_delivery_cost_unclaimed where consumption_id = ${first.id}`;
  check("  and the goods are available again", n(free?.qty_unclaimed) === 2,
    String(free?.qty_unclaimed));

  const tooMuch = await refused(() => claim(-5, a1.id));
  check("a release larger than its claim is refused",
    tooMuch !== null, String(tooMuch).slice(0, 64));

  const unsigned = await refused(() => claim(-1));
  check("a negative row with no claim to name is refused",
    unsigned !== null, String(unsigned).slice(0, 64));

  const positive = await refused(() => claim(1, a1.id));
  check("so is a positive row pretending to be a release",
    positive !== null, String(positive).slice(0, 64));

  // --------------------------------------------------------------- append-only
  console.log("\n  a claim that happened cannot be edited away\n");
  const edited = await refused(() =>
    sql`update sales_cost_allocation set qty = 1 where id = ${a1.id}`);
  check("updating is refused", edited !== null, String(edited).slice(0, 48));
  const deleted = await refused(() =>
    sql`delete from sales_cost_allocation where id = ${a1.id}`);
  check("deleting is refused", deleted !== null, String(deleted).slice(0, 48));

  // ------------------------------------------------------------- the worklist
  console.log("\n  what is still unbilled is readable\n");
  const unclaimed = await sql`
    select coalesce(sum(qty_unclaimed), 0) as qty, coalesce(sum(value_unclaimed), 0) as val
      from v_delivery_cost_unclaimed where company_id = ${co.id}`;
  // 15 delivered, 10 of the cheap layer claimed and 2 of those released back.
  check("the view shows exactly what no invoice has taken",
    n(unclaimed[0].qty) === 7, String(unclaimed[0].qty));
  check("  valued at the layers it actually came from",
    n(unclaimed[0].val) === 2 * 1000 + 5 * 1500, String(unclaimed[0].val));

  // ------------------------------------------- what the view must not count
  console.log("\n  and counts only cost that is waiting on an invoice\n");
  // The view exists for one invariant: once cost of sales moves to the
  // invoice, 1090 must equal it. Anything in here that will never reach
  // 1090 breaks that before it is ever tested.
  const viewFor = async () => {
    const [r] = await sql`
      select coalesce(sum(value_unclaimed), 0) as v
        from v_delivery_cost_unclaimed where item_id = ${item.id}`;
    return n(r.v);
  };

  // Enough on the shelf for the three movements below. A receipt adds a
  // layer and consumes nothing, so it cannot move the figure being watched.
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 20, unitCost: 1200 }] });

  const before = await viewFor();

  const [promo2] = await sql`
    select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;
  await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: DAY, lines: [{ itemId: item.id, qty: 2, focReasonId: promo2.id }] });
  check("a giveaway is not waiting on a bill", (await viewFor()) === before,
    `${await viewFor()} vs ${before}`);

  await P.postStockAdjustment({ companyId: co.id, locationId: loc.id, docDate: DAY,
    lines: [{ itemId: item.id, qty: -2, reason: "damaged" }] });
  check("nor is a write-off", (await viewFor()) === before, `${await viewFor()}`);

  const elsewhere = await sql`
    select id from location where company_id = ${co.id} and is_stock_location
       and id <> ${loc.id} limit 1`;
  if (elsewhere.length > 0) {
    await P.postStockTransfer({ companyId: co.id, fromLocationId: loc.id,
      toLocationId: elsewhere[0].id, docDate: DAY,
      lines: [{ itemId: item.id, qty: 2 }] });
    check("nor are goods moved between our own shelves",
      (await viewFor()) === before, `${await viewFor()}`);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
