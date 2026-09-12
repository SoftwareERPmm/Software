// GR/IR clearing, matched line by line, from both directions.
//
//   node scripts/test-grir.mjs
//
// Posts real documents. Run against a scratch database.
//
// A goods receipt and a purchase invoice settle against each other, and
// either can arrive first. Whichever posts second must work out how much of
// the first it actually covers, and at what rate. Two ways that went wrong:
//
//   Per document instead of per line — half a shipment released an entire
//   invoice and dumped the rest into price variance.
//   Per item instead of per line — two lines of one item at different costs
//   were averaged, settling at a rate nothing was received at.
//
// Both are proven here in the shapes that exposed them.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { postGoodsReceipt, postPurchaseInvoice, postPurchaseOrder } =
  await import("../lib/posting.ts");
const { getGrirCollisions, getOpenPurchaseOrders } = await import("../lib/queries.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.0001;

// Signed: positive is a debit. GR/IR carries a credit balance while goods are
// received and unbilled, so an outstanding liability reads as a positive
// "owed" figure here.
const balance = async (code) =>
  n((await sql`select coalesce(sum(jl.amount), 0) as v from journal_line jl
                join account a on a.id = jl.account_id where a.code = ${code}`)[0].v);

const wipe = async () => {
  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await wipe();

  let [supp] = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier order by code limit 1`;
  if (!supp) {
    [supp] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, 'GI-S', 'GR/IR Test Supplier', true) returning id`;
  }

  let [item] = await sql`
    select id, code from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) {
      [grp] = await sql`
        insert into item_group (company_id, segment, code, name)
        values (${co.id}, 'GI', 'x', 'GR/IR Test') returning id`;
    }
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`
      insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'GR/IR Test Item', ${uom.id}) returning id, code`;
  }

  // The codes this chart uses for the two accounts this suite is about,
  // asked of the chart rather than assumed. On any chart but the demo seed,
  // "1310" and "5200" are somebody else's accounts or nobody's.
  const { accountsFor } = await import("./accounts.mjs");
  const acct = accountsFor(sql, co.id);
  const GRIR = await acct.role("GRIR_CLEARING");
  const PPV = await acct.role("PURCHASE_PRICE_VARIANCE");
  // Inventory is resolved per item, so ask for this item's own account.
  const INV = await acct.forItem("INVENTORY", item.id);

  // A second item, so "a bill for something else" can be told apart from
  // "a bill for these goods" — found by name, since a trigger builds the code.
  let [item2] = await sql`
    select id, code from item where company_id = ${co.id} and name = 'GR/IR Second Item'`;
  if (!item2) {
    const [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item2] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id)
      values (${co.id}, ${grp.id}, 'G02', 'GR/IR Second Item', ${uom.id}) returning id, code`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  console.log(`\n  ${co.name}  ·  item ${item.code}  ·  ${loc.code}`);

  // ---- Goods first, one receipt holding two different costs --------------

  console.log("\n  goods first — 50 @ 1,000 and 50 @ 2,000 on one receipt\n");

  const gr = await postGoodsReceipt({ ...base, lines: [
    { itemId: item.id, qty: 50, unitCost: 1000 },
    { itemId: item.id, qty: 50, unitCost: 2000 },
  ]});
  const grLines = await sql`
    select id from document_line where document_id = ${gr.id} order by line_no`;

  check("the receipt holds the full 150,000 in GR/IR", (await balance(GRIR)) === -150000,
    `${-(await balance(GRIR))}`);

  const pi1 = await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1000, sourceLineId: grLines[0].id }] });

  check("billing the cheap line settles 50,000, not an averaged 75,000",
    (await balance(GRIR)) === -100000, `${-(await balance(GRIR))} still owed`);
  check("and books no variance, because it matched exactly",
    (await balance(PPV)) === 0, `${await balance(PPV)}`);

  const pi2 = await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 2000, sourceLineId: grLines[1].id }] });

  check("billing the dear line clears the rest", (await balance(GRIR)) === 0);
  check("still no variance across the pair", (await balance(PPV)) === 0);
  check("both invoices recorded which receipt line they billed",
    (await sql`select count(*)::int as c from document_line dl join document d on d.id = dl.document_id
                where d.doc_type = 'PURCHASE_INVOICE' and dl.source_line_id is not null`)[0].c === 2);

  // ---- Same shape, but the invoice names no line -------------------------

  await wipe();
  console.log("\n  same receipt, invoice names no line — oldest cost layer first\n");

  const gr2 = await postGoodsReceipt({ ...base, lines: [
    { itemId: item.id, qty: 50, unitCost: 1000 },
    { itemId: item.id, qty: 50, unitCost: 2000 },
  ]});
  await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1000 }] });

  check("an unnamed line settles the oldest layer, at 1,000",
    (await balance(GRIR)) === -100000, `${-(await balance(GRIR))} still owed`);
  check("no variance invented", (await balance(PPV)) === 0);

  const stockValue = async () => Number((await sql`
    select coalesce(sum(total_cost), 0)::float as v
      from stock_movement where company_id = ${co.id}`)[0].v);

  const beforeOvercharge = await stockValue();
  await postPurchaseInvoice({ ...base, dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 2200 }] });

  // 0057: an overcharge on goods that are still here is a cost that was
  // wrong, not an expense. It goes onto those goods — which is why variance
  // stays empty and the stock is worth 10,000 more than it was.
  check("a genuine overcharge lands on the goods, not in variance",
    Math.round(await stockValue() - beforeOvercharge) === 10000,
    `stock +${Math.round(await stockValue() - beforeOvercharge)} on 50 × 200`);
  check("  and variance stays empty", (await balance(PPV)) === 0,
    `${await balance(PPV)}`);

  // ---- Bill first, goods in two shipments --------------------------------

  await wipe();
  console.log("\n  bill first — 100 @ 1,000 invoiced, goods arrive in halves\n");

  const pi3 = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  check("the invoice alone holds 100,000 in GR/IR", (await balance(GRIR)) === 100000);

  await postGoodsReceipt({ ...base, sourceDocumentId: pi3.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  check("half the goods release half the invoice, not all of it",
    (await balance(GRIR)) === 50000, `${await balance(GRIR)} still awaited`);
  check("and book no variance", (await balance(PPV)) === 0, `${await balance(PPV)}`);

  await postGoodsReceipt({ ...base, sourceDocumentId: pi3.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1000 }] });
  check("the second half clears it exactly", (await balance(GRIR)) === 0);
  check("with no variance across the pair", (await balance(PPV)) === 0);

  // ---- The receipt disagrees with the bill it is matched to --------------
  //
  // It does not get to. The bill is what these goods cost; a price typed on
  // the receipt is an opinion about a cost that is already known. Valuing
  // them at 1,100 against a bill of 1,000 used to credit 5,000 to variance —
  // a profit booked on buying something — and carry the stock 5,000 above
  // what was owed for it.

  await wipe();
  console.log("\n  the receipt says 1,100, the bill says 1,000\n");

  const pi4 = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  const gr4 = await postGoodsReceipt({ ...base, sourceDocumentId: pi4.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 1100 }] });

  check("only the invoiced half is released", (await balance(GRIR)) === 50000);
  check("the goods are valued at the bill, not the receipt",
    (await balance(INV)) === 50000, `${await balance(INV)} in inventory`);
  check("so nothing reaches variance", (await balance(PPV)) === 0,
    `${await balance(PPV)}`);
  check("  and the stock ledger agrees with the accounts",
    n((await sql`select coalesce(sum(value_on_hand), 0) as v
                   from v_stock_on_hand where item_id = ${item.id}`)[0].v) === 50000,
    `${n((await sql`select coalesce(sum(value_on_hand), 0) as v
                      from v_stock_on_hand where item_id = ${item.id}`)[0].v)} on the shelf`);

  // Receiving more than was billed is a real event, and the excess is not a
  // variance either: it is goods held and not yet invoiced.
  await postGoodsReceipt({ ...base, sourceDocumentId: pi4.id,
    lines: [{ itemId: item.id, qty: 80, unitCost: 1100 }] });

  check("over-receiving leaves goods awaiting a bill, not a variance",
    (await balance(GRIR)) === -30000, `${await balance(GRIR)}`);
  check("  still no variance", (await balance(PPV)) === 0, `${await balance(PPV)}`);
  check("  and all 130 units are carried at the billed price",
    (await balance(INV)) === 130000, `${await balance(INV)}`);

  // ---- halves of one purchase that never found each other ----------------
  //
  // The failure this catches, in the order it happens:
  //
  //   an order is placed                      nothing unusual
  //   the bill arrives before the goods       it can name no order, so it
  //                                           waits for goods of its own
  //   the goods arrive against the order      the order is satisfied, and the
  //                                           "order still owed goods" warning
  //                                           on the receive form goes quiet
  //   the bill's goods are received too       200 units for a 100 order,
  //                                           two payables, GR/IR clean
  //
  // After the last step nothing looks wrong — both halves cleared and every
  // document is individually correct. The third step is the only moment this
  // is visible, and what makes it visible is the clearing account: goods with
  // no bill credit it, a bill with no goods debits it, and a pair that found
  // each other nets to zero and disappears.

  console.log("\n  a bill and an order that never met\n");

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const collisions = async () => getGrirCollisions(co.id);
  const sideOf = (rows, side) => rows.filter((r) => r.side === side);

  const order = await postPurchaseOrder({ companyId: co.id, partnerId: supp.id,
    locationId: loc.id, docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  check("an order on its own is not a double", (await collisions()).length === 0);

  const bill = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }] });
  check("a bill waiting on goods is not one either — nothing has arrived yet",
    (await collisions()).length === 0);

  const [orderLine] = await sql`select id from document_line where document_id = ${order.id}`;
  const arrived = await postGoodsReceipt({ ...base, sourceDocumentId: order.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 1000, sourceLineId: orderLine.id }] });

  // The old warning has nothing left to say at this point: the order it was
  // watching is satisfied. That is precisely when the new one has to speak.
  check("the order is no longer owed goods, so the receive form's old warning stops",
    (await getOpenPurchaseOrders(co.id)).length === 0);

  let coll = await collisions();
  check("now it is a double waiting to happen", coll.length === 2, `${coll.length} rows`);
  check("  the goods already here are named",
    sideOf(coll, "GOODS").some((r) => r.doc_no === arrived.docNo && near(r.qty, 100)));
  check("  and so is the bill still waiting for them",
    sideOf(coll, "BILL").some((r) => r.doc_no === bill.docNo && near(r.qty, 100)));

  // A bill for one thing and unbilled goods of another is ordinary trade.
  const other = await postPurchaseInvoice({ ...base, dueDate: null,
    lines: [{ itemId: item2.id, qty: 5, unitPrice: 100 }] });
  check("a bill for a different item is not paired with these goods",
    (await collisions()).every((r) => r.doc_no !== other.docNo));

  // And receiving the bill's goods anyway is the mistake. Afterwards there is
  // nothing to detect, which is the reason the warning has to come first.
  await postGoodsReceipt({ ...base, sourceDocumentId: bill.id,
    lines: [{ itemId: item.id, qty: 100, unitCost: 1000 }] });
  check("once it has happened, the clearing account is clean again",
    (await collisions()).length === 0);
  check("  and the only trace is twice the goods",
    n((await sql`select coalesce(sum(qty), 0) as q from stock_movement
                  where item_id = ${item.id}`)[0].q) === 200,
    `${n((await sql`select coalesce(sum(qty), 0) as q from stock_movement
                     where item_id = ${item.id}`)[0].q)} units for a 100 order`);

  // ---- Invariants --------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all GR/IR tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
