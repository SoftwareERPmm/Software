// Whose goods left the shelf.
//
//   npx tsx scripts/test-consignment-source.mjs
//
// A hundred shirts in one warehouse can be sixty of yours and forty split
// between two consignors, and nothing about the shelf says which is which.
// Sell one of theirs and your inventory must not move — what moves is what
// you now owe them, and it is owed to a particular consignor.
//
// So the line names its pool, and where the pool is consigned it names whose.
// Before this, a consigned draw ran FIFO across every consignor at the
// location: with ABC and XYZ both holding stock the system picked by receipt
// date, and the consignor whose shirt left is the one who gets paid for it.

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
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table payment_allocation, consignment_lot_consumption,
    consignment_lot, consignment_agreement_line, consignment_agreement,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry, opening_batch restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const one = async (q) => (await q)[0];
  const wh = await one(sql`select id from location where company_id = ${co.id}
     and is_stock_location and is_active order by code limit 1`);
  const uom = await one(sql`select id from uom where company_id = ${co.id} order by code limit 1`);
  let grp = await one(sql`select id from item_group where company_id = ${co.id} order by code limit 1`);
  if (!grp) grp = await one(sql`insert into item_group (company_id, segment, code, name)
     values (${co.id}, 'CN', 'x', 'Consignment test') returning id`);
  const item = await one(sql`insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
     values (${co.id}, ${grp.id}, ${"S" + Date.now().toString().slice(-5)}, 'Shirt A', ${uom.id}, true)
     returning id, code`);

  const partner = async (code, name, flags) => one(sql`
    insert into business_partner (company_id, code, name, is_customer, is_supplier)
    values (${co.id}, ${code + Date.now().toString().slice(-4)}, ${name},
            ${flags.customer ?? false}, ${flags.supplier ?? false}) returning id, name`);
  const cust = await partner("C", "Diamond", { customer: true });
  const abc = await partner("ABC", "ABC Trading", { supplier: true });
  const xyz = await partner("XYZ", "XYZ Co Ltd", { supplier: true });

  // The receipt names the agreement line it arrives under, so the settlement
  // rate is frozen per shipment rather than read from the agreement later.
  const agree = async (p) => {
    const a = await one(sql`
      insert into consignment_agreement (company_id, partner_id, memo)
      values (${co.id}, ${p.id}, ${p.name + " consignment"}) returning id`);
    return one(sql`insert into consignment_agreement_line (company_id, agreement_id, item_id,
                pricing_method, pricing_value, is_active)
              values (${co.id}, ${a.id}, ${item.id}, 'PERCENTAGE', 70, true) returning id`);
  };
  const abcLine = await agree(abc);
  const xyzLine = await agree(xyz);

  // ---- the shelf ---------------------------------------------------------

  const supplier = await partner("SUP", "Buy From", { supplier: true });
  await P.postGoodsReceipt({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 60, unitCost: 12000 }],
  });
  await P.postConsignmentReceipt({
    companyId: co.id, partnerId: abc.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 40, agreementLineId: abcLine.id }],
  });
  await P.postConsignmentReceipt({
    companyId: co.id, partnerId: xyz.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 20, agreementLineId: xyzLine.id }],
  });

  const split = await Q.getStockByOwnership(co.id, item.id, wh.id);
  console.log("  60 ours, 40 ABC's, 20 XYZ's — all on one shelf\n");
  check("owned stock is sixty", split.owned === 60, String(split.owned));
  check("two consignors are holding stock here", split.consigned.length === 2,
    split.consigned.map((c) => `${c.name} ${c.qty}`).join(", "));

  // ---- selling ours ------------------------------------------------------

  const invAcct = await one(sql`select a.id from account a
      join account_determination d on d.account_id = a.id
     where d.company_id = ${co.id} and d.role = 'INVENTORY' limit 1`);
  const invValue = async () => n((await one(sql`
    select coalesce(sum(base_amount), 0) as v from journal_line
     where company_id = ${co.id} and account_id = ${invAcct.id}`)).v);

  const before = await invValue();
  await P.postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, source: "OWNED" }],
  });
  const afterOwned = await invValue();
  check("selling ours reduces inventory", Math.abs((before - afterOwned) - 120000) < 0.01,
    `${(before - afterOwned).toLocaleString()} at 12,000 each`);

  // ---- selling XYZ's, when ABC's arrived first ---------------------------

  const beforeC = await invValue();
  await P.postDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 5, source: "CONSIGNMENT", consignorId: xyz.id }],
  });
  check("selling consigned stock leaves inventory alone",
    Math.abs((await invValue()) - beforeC) < 0.01, "no change");

  const after = await Q.getStockByOwnership(co.id, item.id, wh.id);
  const abcLeft = after.consigned.find((c) => c.consignorId === abc.id)?.qty ?? 0;
  const xyzLeft = after.consigned.find((c) => c.consignorId === xyz.id)?.qty ?? 0;
  check("XYZ's stock went down", xyzLeft === 15, `${xyzLeft} left of 20`);
  check("  and ABC's did not, though theirs arrived first",
    abcLeft === 40, `${abcLeft} left of 40`);

  // ---- and it cannot quietly borrow from the other pool ------------------

  let overdrawn = null;
  try {
    await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today,
      lines: [{ itemId: item.id, qty: 100, source: "CONSIGNMENT", consignorId: xyz.id }],
    });
  } catch (e) { overdrawn = e.message; }
  check("issuing more than a consignor has is refused", overdrawn !== null,
    overdrawn ? overdrawn.slice(0, 60) : "POSTED — it should not have");
  check("  and it does not reach into owned stock to cover it",
    (await Q.getStockByOwnership(co.id, item.id, wh.id)).owned === 50,
    `${(await Q.getStockByOwnership(co.id, item.id, wh.id)).owned} owned`);

  // ---- voiding a settlement gives the sale back --------------------------
  //
  // The consumption stamp is never cleared: consumption is append-only and a
  // void is recorded rather than erased. So "settled" has to mean settled by
  // something that still stands, or a voided settlement leaves the
  // consignor's goods sold, their payable reversed, and no way for a later
  // settlement to find the sale again.

  console.log("\n  voiding the settlement of a consigned sale\n");

  // A delivery alone owes the consignor nothing — settlement happens when the
  // sale is invoiced, at the price the customer is actually charged.
  await P.postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 6000,
              source: "CONSIGNMENT", consignorId: xyz.id }],
  });

  const P2 = P;
  const settleDoc = await one(sql`
    select id, doc_no, gross_total from document
     where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE' and status = 'POSTED'
     order by created_at desc limit 1`);

  check("invoicing a consigned sale raises a settlement", Boolean(settleDoc),
    settleDoc ? `${settleDoc.doc_no} ${n(settleDoc.gross_total).toLocaleString()}` : "none");

  if (settleDoc) {
    const owedToConsignor = async () => n((await one(sql`
      select coalesce(sum(outstanding), 0) as v from v_open_item
       where company_id = ${co.id} and partner_id = ${xyz.id}`)).v);

    check("the consignor is owed for what sold", (await owedToConsignor()) > 0,
      (await owedToConsignor()).toLocaleString());

    await P2.voidDocument({ documentId: settleDoc.id, reason: "raised in error" });

    check("voiding the settlement leaves nothing owed — not a negative",
      (await owedToConsignor()) === 0, String(await owedToConsignor()));

    const findable = await one(sql`
      select count(*)::int as n from consignment_lot_consumption c
       where c.settlement_document_id is not null
         and exists (select 1 from document sd
                      where sd.id = c.settlement_document_id and sd.status <> 'POSTED')`);
    check("  and the sale can be settled again", findable.n > 0, `${findable.n} rows released`);
  }

  // ---- the books still hold ----------------------------------------------

  const tb = await one(sql`select coalesce(sum(base_amount), 0) as v
     from journal_line where company_id = ${co.id}`);
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, String(n(tb.v)));
  const recon = await one(sql`select count(*)::int as n from v_check_inventory_reconciliation`);
  check("inventory reconciles to the stock ledger", recon.n === 0, String(recon.n));

  console.log(bad === 0
    ? "\n  the right consignor's goods left the building\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
