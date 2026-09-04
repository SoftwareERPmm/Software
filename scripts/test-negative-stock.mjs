// Selling goods the ERP has not been told about yet.
//
//   npx tsx scripts/test-negative-stock.mjs
//
// The stock is physically on the shelf; the paperwork is not. Refusing the
// sale means either inventing a receipt — a fabricated document with a
// made-up cost that nobody would later recognise as fabricated — or not
// invoicing goods the customer has already taken. So the issue is allowed,
// but only deliberately, and it leaves a record that says what is owed to
// the inventory account and why.
//
// What this suite is really protecting: that negative stock stays visible.
// A balance of -10 that nobody confirmed, with nothing explaining it, is the
// failure. Every check here is about the difference between that and a
// recorded, costed, reconcilable shortfall.
//
// Writes documents. Run against a scratch database.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const { sql } = await import("../lib/db.ts");
const { postDelivery, postGoodsReceipt, postSaleWithDelivery } = await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

try {
  for (let i = 1; ; i++) {
    try { await sql`select 1`; break; }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"NS" + stamp}, 'x', ${"Neg Stock " + stamp}) returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [cust] = await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${"NC-" + stamp}, ${"Neg Customer " + stamp}, true) returning id`;
  const [supp] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"NS-" + stamp}, ${"Neg Supplier " + stamp}, true) returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;

  let serial = 0;
  const newItem = async (name) => {
    serial++;
    const [it] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
      values (${co.id}, ${grp.id}, ${String(serial).padStart(3, "0")},
              ${`${name} ${stamp}`}, ${uom.id}, true) returning id`;
    return it.id;
  };
  const onHand = async (itemId) =>
    n((await sql`select fn_qty_on_hand(${co.id}, ${itemId}, ${wh.id}) as q`)[0].q);

  // ---- the guard still holds by default -----------------------------------
  console.log("  without confirmation, nothing changes\n");
  {
    const item = await newItem("Dress");
    let refused = null;
    try {
      await postDelivery({
        companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today,
        lines: [{ itemId: item, qty: 10 }],
      });
    } catch (e) { refused = e.message; }
    check("stock that is not there still cannot be delivered",
      refused !== null && /Not enough/.test(String(refused)),
      String(refused).slice(0, 50));
    check("and nothing moved", (await onHand(item)) === 0, String(await onHand(item)));
  }

  // ---- the scenario -------------------------------------------------------
  // Physical 10, recorded 0. Invoice 10. ERP goes to -10.
  console.log("\n  confirmed: physical stock the ERP has not recorded\n");
  const item = await newItem("Dress");

  // Give the item a known cost history so the provisional figure has
  // something honest to be: bought at 5,000 once, elsewhere.
  const [wh2] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
      and id <> ${wh.id} order by code limit 1`;
  if (wh2) {
    await postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: wh2.id, docDate: today,
      lines: [{ itemId: item, qty: 1, unitCost: 5000 }],
    });
  }

  const sale = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today, dueDate: null,
    allowNegativeStock: true,
    lines: [{ itemId: item, qty: 10, unitPrice: 9000 }],
  });
  console.log(`    sold 10 with none recorded: ${sale.docNo}\n`);

  check("ERP stock is now minus ten", (await onHand(item)) === -10, String(await onHand(item)));

  const [ns] = await sql`
    select * from v_negative_stock where company_id = ${co.id} and item_id = ${item}`;
  check("the shortfall is on the reconciliation worklist", Boolean(ns));
  check("  for the quantity that no layer covered", n(ns?.outstanding) === 10, String(n(ns?.outstanding)));
  check("  naming the document that caused it", Boolean(ns?.document_no), ns?.document_no);
  check("  costed at what the item was last bought for, not at nothing",
    n(ns?.provisional_unit_cost) === 5000, String(n(ns?.provisional_unit_cost)));

  // Charging it out at something is the point: a sale with no cost shows a
  // margin of 100% and nothing ever corrects it.
  const cogs = await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.account_type = 'COGS'`;
  check("cost of sales was charged, not left at zero", n(cogs[0].v) === 50000, String(n(cogs[0].v)));

  // ---- the reconciliation -------------------------------------------------
  // The goods are recorded later, at what they really cost — 5,200, not the
  // 5,000 assumed.
  console.log("\n  the receipt arrives, at a different cost\n");
  const gr = await postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item, qty: 10, unitCost: 5200 }],
  });
  console.log(`    ${gr.docNo} received 10 at 5,200\n`);

  check("ERP stock returns to zero", (await onHand(item)) === 0, String(await onHand(item)));

  const after = await sql`
    select * from v_negative_stock where company_id = ${co.id} and item_id = ${item}`;
  check("the shortfall leaves the worklist", after.length === 0, `${after.length} left`);

  const settled = await sql`
    select s.qty, s.actual_unit_cost from negative_stock_settlement s
      join negative_stock ns on ns.id = s.negative_stock_id
     where ns.item_id = ${item}`;
  check("settled against the receipt, at the receipt's cost",
    settled.length === 1 && n(settled[0].qty) === 10 && n(settled[0].actual_unit_cost) === 5200,
    settled.length ? `${n(settled[0].qty)} @ ${n(settled[0].actual_unit_cost)}` : "none");

  // Goods sold before they were recorded never sat on the shelf, so no layer
  // is left behind for them — otherwise the next sale would draw on stock
  // that had already gone out of the door.
  const lots = await sql`
    select coalesce(sum(sl.qty_received - coalesce(c.used, 0)), 0) as remaining
      from stock_lot sl
      left join (select lot_id, sum(qty) used from stock_lot_consumption group by lot_id) c
        on c.lot_id = sl.id
     where sl.company_id = ${co.id} and sl.item_id = ${item} and sl.location_id = ${wh.id}`;
  check("no phantom layer is left on the shelf", n(lots[0].remaining) === 0, String(n(lots[0].remaining)));

  // 10 x 200 understated.
  const variance = await sql`
    select coalesce(sum(jl.base_amount), 0) as v
      from journal_line jl join account a on a.id = jl.account_id
      join system_account sa on sa.account_id = a.id and sa.role = 'PURCHASE_PRICE_VARIANCE'
     where jl.company_id = ${co.id}`;
  check("the 200 a unit it was under-costed by reaches variance",
    Math.abs(n(variance[0].v) - 2000) < 0.0001, String(n(variance[0].v)));

  // ---- the confirmation is recorded ---------------------------------------
  // The confirmation belongs on the document that moved the stock. The
  // voucher posts an invoice and a delivery together, and it is the delivery
  // that took goods the ERP did not have.
  const [doc] = await sql`
    select d.doc_no, d.negative_stock_confirmed, d.negative_stock_confirmed_at,
           d.negative_stock_confirmed_by
      from document d
     where d.company_id = ${co.id} and d.doc_type = 'DELIVERY'
       and d.source_document_id = ${sale.id}
     union all
    select d.doc_no, d.negative_stock_confirmed, d.negative_stock_confirmed_at,
           d.negative_stock_confirmed_by
      from document d
      join document inv on inv.id = ${sale.id} and inv.source_document_id = d.id
     where d.doc_type = 'DELIVERY'
     limit 1`;
  check("the confirmation is stored on the delivery that moved the stock",
    doc?.negative_stock_confirmed === true, doc?.doc_no ?? "(delivery not found)");
  check("  with when it was given", Boolean(doc?.negative_stock_confirmed_at));
  check("  and no user, honestly, until there is a login",
    doc?.negative_stock_confirmed_by === null);

  // ---- reconciling by hand, when no receipt is coming ---------------------
  // The other half: the goods were found and counted, and nobody is going to
  // send an invoice for them. The price is not asked for — it is the one
  // these units were charged out at, or the correction and the cost of sale
  // would disagree.
  console.log("\n  reconciled by hand, at the price it went out at\n");
  {
    const { reconcileNegativeStock } = await import("../lib/posting.ts");
    const item2 = await newItem("Shirt");

    // Give it a purchase invoice history so the stock price has a source,
    // and prove the invoice is preferred over the receipt's own figure.
    const grA = await postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: wh.id, docDate: today,
      lines: [{ itemId: item2, qty: 1, unitCost: 44000 }],
    });
    await sql`select 1`;
    const { postPurchaseInvoice } = await import("../lib/posting.ts");
    await postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: wh.id, docDate: today,
      goodsReceiptId: grA.id,
      lines: [{ itemId: item2, qty: 1, unitPrice: 45000 }],
    });
    // Clear the one unit that receipt put on the shelf, so the next sale is
    // entirely uncovered.
    await postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today,
      lines: [{ itemId: item2, qty: 1 }],
    });

    await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today, dueDate: null,
      allowNegativeStock: true,
      lines: [{ itemId: item2, qty: 10, unitPrice: 90000 }],
    });

    const [pending] = await sql`
      select * from v_negative_stock where company_id = ${co.id} and item_id = ${item2}`;
    check("the stock price comes from the purchase invoice, not the receipt",
      n(pending?.provisional_unit_cost) === 45000, String(n(pending?.provisional_unit_cost)));
    check("  and says which invoice it came from",
      pending?.price_source === "PURCHASE_INVOICE" && Boolean(pending?.price_source_no),
      `${pending?.price_source} ${pending?.price_source_no}`);
    check("  with the adjustment value already worked out",
      n(pending?.outstanding_value) === 450000, String(n(pending?.outstanding_value)));

    const before = await onHand(item2);
    const done = await reconcileNegativeStock({
      companyId: co.id, negativeStockIds: [pending.id], docDate: today,
      memo: "found on the shelf",
    });
    console.log(`    reconciled ${done.units} units — ${done.documents.join(", ")}\n`);

    check("stock comes back to zero", (await onHand(item2)) === 0,
      `${before} -> ${await onHand(item2)}`);
    const left = await sql`
      select * from v_negative_stock where company_id = ${co.id} and item_id = ${item2}`;
    check("and the line leaves the worklist", left.length === 0, `${left.length} left`);

    // Valued at the price it went out at, so no variance arises here.
    const lot = await sql`
      select unit_cost, qty_received from stock_lot
       where company_id = ${co.id} and item_id = ${item2} and location_id = ${wh.id}
       order by created_at desc limit 1`;
    check("the layer it puts back is at that same price",
      n(lot[0]?.unit_cost) === 45000 && n(lot[0]?.qty_received) === 10,
      `${n(lot[0]?.qty_received)} @ ${n(lot[0]?.unit_cost)}`);

    // Reconciling the same line twice must not add stock twice.
    let twice = null;
    try {
      await reconcileNegativeStock({
        companyId: co.id, negativeStockIds: [pending.id], docDate: today,
      });
    } catch (e) { twice = e.message; }
    check("the same shortfall cannot be reconciled twice", twice !== null,
      String(twice).slice(0, 50));
    check("  and stock stayed where it was", (await onHand(item2)) === 0,
      String(await onHand(item2)));
  }

  // ---- invariants ---------------------------------------------------------
  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  const recon = await sql`
    select count(*)::int c from (
      select sm.item_id, sm.location_id, sum(sm.qty) moved,
             fn_qty_on_hand(${co.id}, sm.item_id, sm.location_id) on_hand
        from stock_movement sm where sm.company_id = ${co.id}
       group by sm.item_id, sm.location_id
    ) x where abs(moved - on_hand) > 0.0001`;
  check("inventory reconciles to the stock ledger", recon[0].c === 0);

  console.log(`\n  ${failures === 0 ? "all negative stock tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
