// An invoice that has shipped half of itself still owes the other half.
//
//   npx tsx scripts/test-pending-delivery.mjs
//
// "Waiting on delivery" used to mean no delivery existed. An invoice for
// 1,000 units with 100 shipped therefore left the list with 900 units owed
// to the customer and nothing on screen saying so — and because the test
// never looked at the delivery's status, voiding that delivery did not bring
// it back. "Deliver now" then shipped the invoiced quantity rather than the
// remaining one, so the way back onto the list was to send everything twice.

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
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, { ssl: local ? false : "require",
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
  const [cust] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  console.log(`\n  ${co.name}  ·  ${item.code}\n`);

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 1000, unitCost: 50 }] });

  // Billed now, delivered later — 1,000 units promised.
  const inv = await P.postSalesInvoice({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, toDeliver: true,
    lines: [{ itemId: item.id, qty: 1000, unitPrice: 90 }] });

  const pending = async () => (await Q.getPendingDeliveries(co.id)).find((d) => d.id === inv.id);
  check("an undelivered invoice is waiting", !!pending(), inv.docNo);
  check("  for everything on it", n((await pending())?.total_qty) === 1000,
    `${n((await pending())?.total_qty)} units`);

  // ---- a partial shipment -------------------------------------------------

  const part = await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, sourceDocumentId: inv.id,
    lines: [{ itemId: item.id, qty: 100 }] });

  const after = await pending();
  check("100 shipped leaves it waiting, not finished", !!after,
    after ? "still listed" : "DROPPED OFF — 900 units owed and nothing says so");
  check("  and it is waiting for the other 900", n(after?.total_qty) === 900,
    `${n(after?.total_qty)}`);

  // ---- "deliver now" ships what is left, not what was billed -------------

  const rest = await Q.getPendingDeliveryLines(co.id);
  const line = rest.find((d) => d.id === inv.id).lines[0];
  check("what deliver-now would send is the remainder", line.qty === 900, `${line.qty}`);
  check("  and it names the invoice line it answers", !!line.lineId);

  const second = await P.postDelivery({ companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, sourceDocumentId: inv.id,
    lines: [{ itemId: item.id, qty: line.qty, sourceLineId: line.lineId }] });
  check("shipping the remainder finishes it", !(await pending()),
    (await pending()) ? "still listed" : "off the list");
  check("  and 1,000 units left the shelf, not 1,900",
    n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q) === 0,
    `${n((await sql`select fn_qty_on_hand(${co.id}, ${item.id}, ${loc.id}) as q`)[0].q)} on hand of 1,000 received`);

  // ---- a shipment that never happened -------------------------------------
  //
  // The list counts POSTED deliveries only, which is worth stating because
  // the obvious way to reach the other case is closed: a delivery issued
  // stock, and voiding it would mean re-creating the FIFO layers it consumed.
  // That is refused, and a sales return is the way back. So the status filter
  // is a guard rather than a path anyone walks today — and if voiding a
  // delivery is ever built, the invoice has to reappear here rather than stay
  // hidden with goods billed and unshipped.

  let refused = null;
  try {
    await P.voidDocument({ documentId: second.id, reason: "customer refused the shipment" });
  } catch (e) { refused = e.message; }
  check("voiding a delivery is refused, so shipped stays shipped", refused !== null,
    refused ? refused.slice(0, 58) : "VOIDED — the invoice must come back onto the list");

  void part;

  // ---- invariants ---------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0
    ? "\n  a part-shipped invoice knows what it still owes\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
