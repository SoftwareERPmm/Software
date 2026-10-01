// Enough purchasing history for the supplier screens to have something to say.
//
//   npx tsx scripts/demo-supplier-performance.mjs
//
// Supplier performance abstains rather than guesses: every metric needs a
// handful of comparable observations before it will report, so a database
// with one order per supplier draws a bare radar and looks broken. This
// builds a catalogue and six months of purchasing against it — five
// suppliers who are each bad at something different, so the radar has a
// shape worth reading and the comparison table has something to sort.
//
// What it makes, and why each piece is there:
//
//   a t-shirt in three colours and three sizes, photographed by colour, so
//     the variant grid, the stock matrix and the thumbnails have real rows;
//   four plain items bought by everybody, so price competitiveness has
//     something to compare against — an item one supplier alone sells is
//     excluded from that metric by design;
//   six orders per supplier across April to September, so lead-time
//     consistency (4 observations) and price stability (4) clear their bars;
//   confirmations of all three kinds, including a supplier who moves their
//     own date and a buyer who moves it for them, because the difference
//     between those two is the whole point of the on-time metric.
//
// Writes real documents through lib/posting.ts. Run against dev.
//
// Re-running adds another six months rather than replacing what is there.
// To start over: node scripts/clear.mjs --confirm, then run this again.

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
const { postPurchaseOrder, postGoodsReceipt, postPurchaseInvoice,
        postSaleWithDelivery } = await import("../lib/posting.ts");

const [co] = await sql`select id, name, plan from company limit 1`;
const [loc] = await sql`select id, code from location
                         where is_stock_location order by code limit 1`;
const [uom] = await sql`select id from uom where company_id = ${co.id}
                         and code = 'PCS' limit 1`;

if (!co || !loc || !uom) {
  console.error("This needs a company with a stock location and a PCS unit.");
  process.exit(1);
}

// A category of its own rather than whichever one happened to be first.
// clear.mjs --all takes the categories with everything else, and that is
// the state this script is most often run from — a seeder that only works
// on a database somebody else prepared is not much of a seeder.
async function category(code, name) {
  const [found] = await sql`
    select id from item_group where company_id = ${co.id} and code = ${code}`;
  if (found) return found;
  const [made] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${code}, ${code}, ${name}) returning id`;
  return made;
}
const grp = await category("DEMO", "Demo purchasing");

// The feature is Business and above, and the navigation hides it otherwise.
// Seeding the data without opening the door would look like the seed failed.
if (co.plan === "STARTER") {
  await sql`update company set plan = 'BUSINESS' where id = ${co.id}`;
  console.log("  plan: STARTER -> BUSINESS, so the screens are reachable");
}

// Dates are fixed to the fiscal year rather than counted back from today:
// the calendar starts on 1 April and posting refuses a date outside it, so
// "200 days ago" quietly becomes an error every spring.
const FY = { from: "2026-04-01", to: "2027-03-31" };

/* --------------------------------------------------------------- catalogue */

// No photographs. An earlier version of this script drew its own — a
// polygon rasterised to PNG, because the item photo column takes only
// webp, png or jpeg — and invented product imagery is worse than none: it
// looks like real data until somebody tries to use it. The variants are
// created unphotographed, and the thumbnail column stays collapsed until
// real pictures are uploaded, which is the honest empty state.

const COLOURS = [{ name: "Red" }, { name: "Black" }, { name: "Navy" }];
const SIZES = ["S", "M", "L"];

/* ------------------------------------------------------- master data helpers */

async function partner(code, name, leadDays) {
  const [found] = await sql`
    select id from business_partner where company_id = ${co.id} and code = ${code}`;
  if (found) return found;
  const [made] = await sql`
    insert into business_partner (company_id, code, name, is_supplier, lead_time_days)
    values (${co.id}, ${code}, ${name}, true, ${leadDays}) returning id`;
  return made;
}

async function plainItem(serial, name) {
  const [found] = await sql`
    select id from item where company_id = ${co.id} and name = ${name}`;
  if (found) return found;
  const [made] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id)
    values (${co.id}, ${grp.id}, ${serial}, ${name}, ${uom.id}) returning id`;
  return made;
}

/** The attribute, its options, and the parent's ordering of it. */
async function attribute(parentId, name, options, sortOrder) {
  let [attr] = await sql`
    select id from variant_attribute where company_id = ${co.id} and name = ${name}`;
  if (!attr) {
    [attr] = await sql`
      insert into variant_attribute (company_id, code, name, sort_order)
      values (${co.id}, ${name.toUpperCase()}, ${name}, ${sortOrder})
      returning id`;
  }
  await sql`
    insert into item_variant_attribute (item_id, attribute_id, sort_order)
    values (${parentId}, ${attr.id}, ${sortOrder})
    on conflict do nothing`;

  const made = [];
  for (const [i, opt] of options.entries()) {
    let [o] = await sql`
      select id from variant_option where attribute_id = ${attr.id} and name = ${opt}`;
    if (!o) {
      [o] = await sql`
        insert into variant_option (company_id, attribute_id, code, name, sort_order)
        values (${co.id}, ${attr.id}, ${opt.toUpperCase()}, ${opt}, ${i})
        returning id`;
    }
    made.push({ ...o, name: opt });
  }
  return { attr, options: made };
}

/* ----------------------------------------------------------------- catalogue */

console.log(`\n  ${co.name}  ·  ${loc.code}\n`);
console.log("  catalogue");

const shirtParent = await plainItem("TSHIRT", "Cotton T-Shirt");
const colour = await attribute(shirtParent.id, "Colour", COLOURS.map((c) => c.name), 0);
const size = await attribute(shirtParent.id, "Size", SIZES, 1);

const variants = [];
for (const c of COLOURS) {
  for (const sz of SIZES) {
    const name = `Cotton T-Shirt ${c.name} / ${sz}`;
    let [v] = await sql`select id from item where company_id = ${co.id} and name = ${name}`;
    if (!v) {
      [v] = await sql`
        insert into item (company_id, item_group_id, serial, name, base_uom_id,
                          parent_item_id)
        values (${co.id}, ${grp.id}, ${`TS-${c.name.slice(0,2).toUpperCase()}${sz}`},
                ${name}, ${uom.id}, ${shirtParent.id})
        returning id`;
      const co_ = colour.options.find((o) => o.name === c.name);
      const sz_ = size.options.find((o) => o.name === sz);
      await sql`insert into item_variant_option (item_id, option_id)
                values (${v.id}, ${co_.id}), (${v.id}, ${sz_.id})
                on conflict do nothing`;
    }
    variants.push({ ...v, colour: c.name, size: sz });
  }
}

console.log(`    ${variants.length} shirt variants`);
console.log("    no photos: upload real ones and the thumbnails appear by colour");

const shared = [
  await plainItem("FAB", "Cotton fabric roll"),
  await plainItem("BTN", "Button pack"),
  await plainItem("ZIP", "Zipper 20cm"),
  await plainItem("CTN", "Packing carton"),
];
console.log(`    ${shared.length} items everybody buys`);

/* ----------------------------------------------------------------- suppliers */

// Each is bad at something different, so the radar is worth comparing. The
// numbers below drive that: lateDays is how far past their own confirmed
// date they deliver, splits is how often an order arrives in two shipments,
// priceIndex multiplies the going rate, and drift is how much their own
// price wanders between orders.
const SUPPLIERS = [
  { code: "SUP-REL", name: "Reliable Trading", lead: 10,
    lateDays: 0, splitEvery: 0, priceIndex: 1.00, drift: 0.01 },
  { code: "SUP-SLP", name: "Slipping Imports", lead: 12,
    lateDays: 6, splitEvery: 2, priceIndex: 1.08, drift: 0.09 },
  { code: "SUP-BUD", name: "Budget Textiles", lead: 21,
    lateDays: 3, splitEvery: 3, priceIndex: 0.86, drift: 0.04 },
  { code: "SUP-PRM", name: "Premium Mills", lead: 7,
    lateDays: 0, splitEvery: 0, priceIndex: 1.22, drift: 0.00 },
  { code: "SUP-AGR", name: "Agreed Supply Co", lead: 14,
    lateDays: 5, splitEvery: 0, priceIndex: 1.03, drift: 0.02, buyerMoves: true },
];

const BASE_PRICE = { FAB: 1000, BTN: 50, ZIP: 120, CTN: 300, TSHIRT: 2500 };

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Six order dates per supplier, one a month, staggered so they interleave. */
const orderDates = (offset) =>
  ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
    .map((m, i) => `${m}-${String(3 + offset + i).padStart(2, "0")}`);

// Goods cannot move on a day that has not happened (migration 0102), and a
// long lead time on a recent order lands past it. Such an order is left
// outstanding rather than skipped — an overdue delivery nobody has made is
// real purchasing, and the on-time metric is supposed to count it against
// the supplier.
const TODAY = new Date().toISOString().slice(0, 10);

const lineOf = async (docId) =>
  (await sql`select id from document_line where document_id = ${docId} order by line_no`)[0];

let posted = 0;

for (const [si, s] of SUPPLIERS.entries()) {
  const sup = await partner(s.code, s.name, s.lead);
  const dates = orderDates(si);
  console.log(`\n  ${s.name}`);

  for (const [oi, orderDate] of dates.entries()) {
    // Rotate through the shared items so every supplier buys several of
    // them, which is what gives price competitiveness something to compare.
    const item = oi === 5
      ? variants[(si * 2 + oi) % variants.length]      // a shirt, now and then
      : shared[(si + oi) % shared.length];
    const base = item.colour
      ? BASE_PRICE.TSHIRT
      : BASE_PRICE[["FAB", "BTN", "ZIP", "CTN"][(si + oi) % shared.length]];

    // Their own price level, wandering a little from order to order.
    const wander = 1 + s.drift * Math.sin(oi * 1.7);
    const price = Math.round(base * s.priceIndex * wander);
    const qty = item.colour ? 40 + oi * 5 : 60 + oi * 10;

    // Re-running completes what an earlier run left off rather than
    // doubling it: one order per supplier per day is the shape this seeder
    // makes, so finding one means this order is already here.
    const [already] = await sql`
      select d.id from document d
       where d.company_id = ${co.id} and d.partner_id = ${sup.id}
         and d.doc_type = 'PURCHASE_ORDER' and d.doc_date = ${orderDate}::date`;
    if (already) { process.stdout.write(`    ${orderDate}  already here\n`); continue; }

    const po = await postPurchaseOrder({
      companyId: co.id, partnerId: sup.id, locationId: loc.id,
      docDate: orderDate, lines: [{ itemId: item.id, qty, unitPrice: price }],
    });
    const line = await lineOf(po.id);

    const promised = addDays(orderDate, s.lead);
    await sql`
      insert into purchase_confirmation
        (company_id, order_line_id, qty, confirmed_date, kind, recorded_at, source)
      values (${co.id}, ${line.id}, ${qty}, ${promised}::date, 'INITIAL',
              ${addDays(orderDate, 1)}::timestamptz, 'order acknowledgement')`;

    const arrives = addDays(promised, s.lateDays);

    // A supplier who moves their own date is measured against the first one.
    // A change we agreed to moves the baseline with it — same slip, opposite
    // meaning, and the two must not look alike in the data.
    if (s.lateDays > 0) {
      await sql`
        insert into purchase_confirmation
          (company_id, order_line_id, qty, confirmed_date, kind, recorded_at, source)
        values (${co.id}, ${line.id}, ${qty}, ${arrives}::date,
                ${s.buyerMoves ? "BUYER_AGREED" : "SUPPLIER_REVISION"},
                ${addDays(promised, -2)}::timestamptz,
                ${s.buyerMoves ? "we asked them to hold it" : "they rang to say"})`;
    }

    const splits = s.splitEvery > 0 && oi % s.splitEvery === 0;
    const parts = splits
      ? [[arrives, Math.round(qty * 0.6)], [addDays(arrives, 4), qty - Math.round(qty * 0.6)]]
      : [[arrives, qty]];

    const landed = parts.filter(([day]) => day <= TODAY);
    if (landed.length < parts.length) {
      process.stdout.write(`    ${orderDate}  ${String(qty).padStart(3)} @ ${price}`
        + `  still outstanding, due ${arrives}\n`);
    }

    for (const [day, q] of landed) {
      const gr = await postGoodsReceipt({
        companyId: co.id, partnerId: sup.id, locationId: loc.id, docDate: day,
        sourceDocumentId: po.id,
        lines: [{ itemId: item.id, qty: q, unitCost: price, sourceLineId: line.id }],
      });
      const billed = addDays(day, 1) > TODAY ? TODAY : addDays(day, 1);
      await postPurchaseInvoice({
        companyId: co.id, partnerId: sup.id, locationId: loc.id,
        docDate: billed, dueDate: addDays(billed, 30), goodsReceiptId: gr.id,
        lines: [{ itemId: item.id, qty: q, unitPrice: price }],
      });
      posted += 2;
    }
    posted += 1;
    if (landed.length === 0) continue;
    process.stdout.write(`    ${orderDate}  ${String(qty).padStart(3)} @ ${price}`
      + `${splits ? "  (two shipments)" : ""}`
      + `${s.lateDays ? `  ${s.lateDays}d ${s.buyerMoves ? "agreed" : "late"}` : ""}\n`);
  }
}

/* --------------------------------------------------------------- selling */

// Buying alone leaves the profitability screens empty, and an empty report
// reads as a broken one. These sell part of what was bought, at a margin,
// so matched profitability has revenue to set against the FIFO layers the
// purchases created and Revenue vs COGS has both halves.
//
// Sold out of stock on the day, which posts the delivery and the invoice
// together — the common case, and the one that gives every line a cost.
console.log("\n  selling some of it on");

const CUSTOMERS = [
  { code: "CUS-YGN", name: "Yangon Retail" },
  { code: "CUS-MDY", name: "Mandalay Trading" },
  { code: "CUS-EXP", name: "Export Partner" },
];

let sales = 0;
for (const [ci, c] of CUSTOMERS.entries()) {
  const [found] = await sql`
    select id from business_partner where company_id = ${co.id} and code = ${c.code}`;
  const cust = found ?? (await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${c.code}, ${c.name}, true) returning id`)[0];

  for (const [mi, month] of ["2026-06", "2026-07", "2026-08", "2026-09"].entries()) {
    const docDate = `${month}-${String(18 + ci).padStart(2, "0")}`;
    // Only a standing sale counts as "already here". A reversed one is a
    // decision somebody undid, and the reversal posted against it carries
    // no lines at all — so "is there an invoice on this date" answers yes
    // to a day whose sale was taken back. Ask for the lines instead.
    const [already] = await sql`
      select d.id from document d
       where d.company_id = ${co.id} and d.partner_id = ${cust.id}
         and d.doc_type = 'SALES_INVOICE' and d.doc_date = ${docDate}::date
         and d.status = 'POSTED'
         and exists (select 1 from document_line dl where dl.document_id = d.id)`;
    if (already) continue;

    // Only what is actually on the shelf, and never all of it: a report
    // that empties the warehouse leaves inventory aging nothing to age.
    const onHand = await sql`
      select item_id, sum(qty_on_hand) q from v_stock_on_hand
       where company_id = ${co.id} group by item_id having sum(qty_on_hand) > 8
       order by sum(qty_on_hand) desc limit 3`;
    if (onHand.length === 0) break;

    const pick = onHand[(ci + mi) % onHand.length];
    const qty = Math.max(1, Math.floor(Number(pick.q) * 0.18));
    const [cost] = await sql`
      select avg(unit_cost)::float8 c from stock_lot
       where item_id = ${pick.item_id} and company_id = ${co.id}`;
    // A margin that varies by item, so the profitability table has a spread
    // worth sorting rather than one number repeated.
    const price = Math.max(1, Math.round((cost?.c ?? 100) * (1.25 + 0.1 * ((ci + mi) % 4))));

    // postSaleWithDelivery, not postSalesInvoice: the latter posts revenue
    // and no goods, which is a real case (invoiced before shipping) but
    // leaves every line unmatched and the profitability report empty. This
    // is the counter sale — the delivery and the invoice in one
    // transaction, so each line has a FIFO cost to set against it.
    await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate, dueDate: addDays(docDate, 30), paymentType: "CREDIT",
      lines: [{ itemId: pick.item_id, qty, unitPrice: price }],
    });
    sales += 1;
    process.stdout.write(`    ${docDate}  ${c.name.padEnd(18)} ${String(qty).padStart(3)} @ ${price}\n`);
  }
}

console.log(`\n  ${posted} purchase documents across ${SUPPLIERS.length} suppliers`);
console.log(`  ${sales} sales invoices across ${CUSTOMERS.length} customers`);
console.log("  Purchases -> Supplier performance");
console.log("  Inventory -> Intelligence\n");

await sql.end();
