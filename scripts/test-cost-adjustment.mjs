// A bill that disagrees with its receipt corrects the cost of the goods.
//
//   npx tsx scripts/test-cost-adjustment.mjs
//
// Twenty boxes received at 100 and billed at 130. The 600 does not become an
// expense by default any more: it goes back onto the goods, and only the part
// belonging to goods already sold reaches the profit and loss.
//
//     20 still held        →  600 onto the stock, nothing expensed
//     8 issued, 12 held    →  360 onto the stock, 240 to cost of sales
//     20 issued            →  nothing to add to, 600 to cost of sales
//
// The quantity never moves. Nothing is received twice, the receipt keeps its
// history, and the next issue relieves inventory at the corrected figure
// rather than at the estimate the receipt was posted with.

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

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.01;

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

  const today = new Date().toISOString().slice(0, 10);

  const balance = async (code) => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0)::float as v
        from journal_line jl join account a on a.id = jl.account_id
       where jl.company_id = ${co.id} and a.code = ${code}`;
    return n(r.v);
  };
  const inventoryBalance = async () => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0)::float as v
        from journal_line jl
       where jl.company_id = ${co.id}
         and jl.account_id in (select account_id from account_determination
                                where company_id = ${co.id} and role = 'INVENTORY')`;
    return n(r.v);
  };
  const stockValue = async () => {
    const [r] = await sql`select coalesce(sum(total_cost), 0)::float as v
                            from stock_movement where company_id = ${co.id}`;
    return n(r.v);
  };
  const onHand = async () => {
    const [r] = await sql`select coalesce(sum(qty), 0)::float as v
                            from stock_movement where company_id = ${co.id}
                             and item_id = ${item.id}`;
    return n(r.v);
  };

  const fresh = async () => {
    await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
      payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
      stock_movement, document_line, document, journal_line, journal_entry
      restart identity cascade`);
    await sql`update number_series set next_value = 1`;
  };

  // Receive 20 at 100, sell `issued` of them, then bill the lot at 130.
  const scenario = async (issued) => {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;

    if (issued > 0) {
      await P.postDelivery({
        companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
        lines: [{ itemId: item.id, qty: issued, unitPrice: 500 }],
      });
    }

    const cogsBefore = await balance("5000");
    const invBefore = await inventoryBalance();

    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });

    return {
      gr, bill,
      toInventory: round(await inventoryBalance() - invBefore),
      toCogs: round(await balance("5000") - cogsBefore),
      ppv: round(await balance("5050")),
    };
  };
  const round = (v) => Math.round(n(v) * 100) / 100;

  // ---- the three splits ---------------------------------------------------

  console.log("  twenty boxes received at 100, billed at 130\n");

  {
    const r = await scenario(0);
    check("all 20 still held: 600 onto the stock",
      near(r.toInventory, 600), `inventory +${r.toInventory}`);
    check("  and nothing expensed", near(r.toCogs, 0), `cost of sales +${r.toCogs}`);
    check("  variance stays out of it", near(r.ppv, 0), `PPV ${r.ppv}`);
    check("  the boxes are worth 130 each",
      near(await stockValue(), 2600), `stock ${await stockValue()}`);
    check("  and there are still only 20", near(await onHand(), 20), `${await onHand()} on hand`);
  }

  {
    const r = await scenario(8);
    check("8 issued, 12 held: 360 onto the stock",
      near(r.toInventory, 360), `inventory +${r.toInventory}`);
    check("  and 240 to cost of sales", near(r.toCogs, 240), `cost of sales +${r.toCogs}`);
    check("  variance stays out of it", near(r.ppv, 0), `PPV ${r.ppv}`);
    check("  12 boxes left, worth 130 each",
      near(await onHand(), 12) && near(await stockValue(), 1560),
      `${await onHand()} on hand worth ${await stockValue()}`);
  }

  {
    const r = await scenario(20);
    check("all 20 issued: nothing to add to",
      near(r.toInventory, 0), `inventory +${r.toInventory}`);
    check("  and 600 to cost of sales", near(r.toCogs, 600), `cost of sales +${r.toCogs}`);
    check("  variance stays out of it", near(r.ppv, 0), `PPV ${r.ppv}`);
  }

  // ---- what the corrected cost does next ----------------------------------

  console.log("\n  the corrected cost carries forward\n");
  {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });

    const cogsBefore = await balance("5000");
    await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 5, unitPrice: 500 }],
    });
    const relieved = round(await balance("5000") - cogsBefore);
    check("goods issued after the correction cost 130, not 100",
      near(relieved, 650), `cost of sale ${relieved}`);
    check("  and the 15 left are worth 1,950",
      near(await stockValue(), 1950), `stock ${await stockValue()}`);
  }

  // ---- billing more than arrived ------------------------------------------

  console.log("\n  a difference with no goods behind it\n");
  {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
    // There is no longer a way in: a bill for more than arrived is refused
    // before it can become anything, which is a better answer than putting it
    // in variance and calling it explained.
    let refused = null;
    try {
      await P.postPurchaseInvoice({
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: null, goodsReceiptId: gr.id,
        lines: [{ itemId: item.id, qty: 25, unitPrice: 100, sourceLineId: grLine.id }],
      });
    } catch (e) { refused = e.message; }
    check("billing 25 against 20 received is refused outright",
      refused !== null, refused ? refused.slice(0, 64) : "POSTED — 5 boxes billed that never arrived");
    check("  and the 20 boxes are untouched at 100",
      near(await stockValue(), 2000), `stock ${await stockValue()}`);
  }

  // ---- correcting the bill again ------------------------------------------

  console.log("\n  correcting a bill that already revalued the goods\n");
  {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });
    check("the bill revalued the stock to 2,600",
      near(await stockValue(), 2600), `stock ${await stockValue()}`);

    const v2 = await P.amendInvoice({
      companyId: co.id, documentId: bill.id,
      reason: "supplier confirmed 140, not 130",
      invoice: {
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: null, goodsReceiptId: gr.id,
        lines: [{ itemId: item.id, qty: 20, unitPrice: 140, sourceLineId: grLine.id }],
      },
    });
    check("correcting it to 140 revalues again, not on top",
      near(await stockValue(), 2800), `stock ${await stockValue()}`);
    check("  the bill is v2 under the same number",
      v2.version === 2 && v2.docNo === bill.docNo, `${v2.docNo} v${v2.version}`);
    check("  and there are still only 20 boxes",
      near(await onHand(), 20), `${await onHand()} on hand`);
  }

  // ---- goods moved between warehouses are still goods ---------------------

  console.log("\n  goods transferred, not sold\n");
  {
    await fresh();
    const [other] = await sql`select id from location
       where company_id = ${co.id} and is_stock_location and is_active
         and id <> ${loc.id} order by code limit 1`;

    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;

    // Eight boxes move to another warehouse. They have not been sold; they are
    // on a different shelf.
    await P.postStockTransfer({
      companyId: co.id, fromLocationId: loc.id, toLocationId: other.id,
      docDate: today, lines: [{ itemId: item.id, qty: 8 }],
    });

    const cogsBefore = await balance("5000");
    const invBefore = await inventoryBalance();

    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });

    const toInv = round(await inventoryBalance() - invBefore);
    const toCogs = round(await balance("5000") - cogsBefore);

    check("all 600 goes to inventory — none of it was sold",
      near(toInv, 600), `inventory +${toInv}`);
    check("  and nothing reaches cost of sales", near(toCogs, 0),
      `cost of sales +${toCogs}`);
    check("  the twenty boxes are worth 2,600 across both warehouses",
      near(await stockValue(), 2600), `stock ${await stockValue()}`);
    check("  and are still twenty", near(await onHand(), 20), `${await onHand()} on hand`);

    // The eight that moved carry the corrected cost too, or selling them from
    // the second warehouse would relieve inventory at the old figure.
    const cogsBefore2 = await balance("5000");
    await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: other.id, docDate: today,
      lines: [{ itemId: item.id, qty: 8, unitPrice: 500 }],
    });
    const relieved = round(await balance("5000") - cogsBefore2);
    check("  selling them from the other warehouse costs 130 each",
      near(relieved, 1040), `cost of sale ${relieved}`);
  }

  // ---- a revaluation whose goods have gone cannot be undone ----------------

  console.log("\n  what cannot be undone\n");
  {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });
    await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 5, unitPrice: 500 }],
    });
    let blocked = null;
    try {
      await P.voidDocument({ companyId: co.id, documentId: bill.id, reason: "changed my mind" });
    } catch (e) { blocked = e.message; }
    check("goods sold at the corrected cost block undoing the correction",
      blocked !== null, blocked ? blocked.slice(0, 72) : "VOIDED — stock now states a value the ledger does not");
  }

  // ---- the correction goes back where the cost went -----------------------

  console.log("\n  the account the cost actually went to\n");
  {
    await fresh();
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;

    await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 8, unitPrice: 500 }],
    });

    // The delivery recorded which account it charged the cost to.
    const [rec] = await sql`
      select a.code from stock_lot_consumption c
        join account a on a.id = c.expense_account_id limit 1`;
    check("a delivery records the account it charged the cost to",
      !!rec, rec ? rec.code : "nothing recorded");

    // Re-map the item's cost of sales to a different account, the way a
    // re-chart would. The correction must still land where the sale did.
    const [other] = await sql`
      select id, code from account where company_id = ${co.id}
         and code = ${"5030"} limit 1`;
    const [grp] = await sql`select item_group_id from item where id = ${item.id}`;
    const before5000 = await balance("5000");
    if (other && grp?.item_group_id) {
      await sql`
        insert into account_determination (company_id, role, account_id, item_group_id)
        values (${co.id}, 'COGS', ${other.id}, ${grp.item_group_id})
        on conflict do nothing`;
    }

    await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
    });

    const moved = round(await balance("5000") - before5000);
    check("  the correction adjusts that account, not today's mapping",
      near(moved, 240), `5000 moved by ${moved}`);
    check("  and nothing landed in the re-mapped account",
      near(await balance("5030"), 0), `5030 ${await balance("5030")}`);

    // Put the chart back so later runs are unaffected.
    if (other && grp?.item_group_id) {
      await sql`delete from account_determination
                 where company_id = ${co.id} and role = 'COGS'
                   and account_id = ${other.id} and item_group_id = ${grp.item_group_id}`;
    }
  }

  // ---- the books still hold ------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0
    ? "\n  the price that was wrong goes back onto the goods it was wrong about\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
