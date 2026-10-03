// Enough trade to read the sales report by.
//
//   npx tsx scripts/demo-sales-report.mjs
//
// Posts real documents against the database in .env. Re-running adds
// nothing: every sale is checked for first, so this is safe to run after a
// test suite has emptied the tables, which is the usual reason to want it.
//
// The report has five tabs and each asks a different question, so the data
// has to be able to answer all of them: several categories and brands so the
// donut has slices worth comparing, several customers so "by customer" is not
// one row, discounts on some lines and not others, a giveaway, a return, and
// two months of trade so the overview has a previous period to compare with
// rather than reporting everything as new.
//
// It also has to make the two reporting bases disagree, or the switch between
// them looks broken. A counter sale matches on both, so the seed ends with
// the two cases that do not: goods out in the earlier month and billed in the
// later one, and a bill with nothing shipped against it at all.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

const { sql } = await import("../lib/db.ts");
const { postGoodsReceipt, postSaleWithDelivery, postDelivery, postSalesReturn,
        postSalesInvoice } = await import("../lib/posting.ts");

const [co] = await sql`select id, name from company order by created_at limit 1`;
const [loc] = await sql`
  select id, code from location where company_id = ${co.id} and is_stock_location order by code limit 1`;
if (!co || !loc) { console.error("This needs a company with a stock location."); process.exit(1); }
console.log(`\n  ${co.name}  ·  ${loc.code}\n`);

/* Categories and brands, so the two charts have something to divide by. A
   catalogue filed entirely under one heading draws a donut with one slice. */
const CATEGORIES = [
  ["APP", "Apparel"], ["ACC", "Accessories"], ["FTW", "Footwear"],
  ["HOM", "Homeware"], ["STA", "Stationery"], ["TLS", "Tools"],
];
const BRANDS = ["Lotus", "Shwe", "Delta", "Pinlon"];

const groups = [];
for (const [code, name] of CATEGORIES) {
  const [found] = await sql`
    select id from item_group where company_id = ${co.id} and code = ${code}`;
  groups.push(found ?? (await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${code}, ${code}, ${name}) returning id`)[0]);
}
const brands = [];
for (const name of BRANDS) {
  const [found] = await sql`
    select id from brand where company_id = ${co.id} and name = ${name}`;
  brands.push(found ?? (await sql`
    insert into brand (company_id, code, name)
    values (${co.id}, ${name.slice(0, 3).toUpperCase()}, ${name}) returning id`)[0]);
}
console.log(`  ${groups.length} categories, ${brands.length} brands`);

/* An item or two per category, created rather than borrowed.
   Re-filing the existing catalogue was the first attempt and it is not
   possible: item.code is generated from the category's segment and the
   item's serial, so moving an item to another category regenerates its
   code — and two items carrying the same serial under one new category
   collide on the first move. Items of its own also keep this seeder from
   renaming things somebody is using. */
const [uom] = await sql`
  select id from uom where company_id = ${co.id} and code = 'PCS' limit 1`;
if (!uom) { console.error("This needs a PCS unit."); process.exit(1); }

const PRODUCTS = [
  ["Cotton shirt", "Linen trousers"], ["Leather belt", "Canvas bag"],
  ["Running shoe", "Sandal"], ["Ceramic mug", "Cotton towel"],
  ["Notebook A5", "Ink pen"], ["Hand saw", "Screwdriver set"],
];

const items = [];
for (const [gi, names] of PRODUCTS.entries()) {
  for (const [ni, name] of names.entries()) {
    const [found] = await sql`
      select id, name from item where company_id = ${co.id} and name = ${name}`;
    if (found) { items.push(found); continue; }
    const [made] = await sql`
      insert into item (company_id, item_group_id, brand_id, serial, name,
                        base_uom_id, is_stocked)
      values (${co.id}, ${groups[gi].id}, ${brands[(gi + ni) % brands.length].id},
              ${String(100 + gi * 10 + ni)}, ${name}, ${uom.id}, true)
      returning id, name`;
    items.push(made);
  }
}
console.log(`  ${items.length} items across them`);

const party = async (code, name, cols) => {
  const [found] = await sql`
    select id, code from business_partner where company_id = ${co.id} and code = ${code}`;
  if (found) return found;
  return (await sql`
    insert into business_partner ${sql({ company_id: co.id, code, name, ...cols })}
    returning id, code`)[0];
};
const supplier = await party("DS-SUP", "Demo Supplier", { is_supplier: true });
const customers = [
  await party("DS-YGN", "Yangon Retail", { is_customer: true, payment_terms_days: 30 }),
  await party("DS-MDY", "Mandalay Trading", { is_customer: true, payment_terms_days: 30 }),
  await party("DS-EXP", "Export Partner", { is_customer: true, payment_terms_days: 45 }),
];
const [promo] = await sql`
  select id from foc_reason where company_id = ${co.id} and code = 'PROMOTION'`;

/* Two months, so the overview has a previous period. Which months depends on
   the fiscal calendar that exists, because posting outside it is refused —
   so the days are taken from the open periods rather than assumed. */
const months = await sql`
  select to_char(start_date, 'YYYY-MM') as m, start_date
    from fiscal_period
   where company_id = ${co.id} and start_date <= current_date
   order by start_date desc limit 2`;
if (months.length < 2) { console.error("This needs at least two open fiscal periods."); process.exit(1); }
// Mid-month, but never later than today: goods cannot move on a day that
// has not happened, and the current period's fifteenth often has not.
const today = new Date().toISOString().slice(0, 10);
const days = months.map((p) => {
  const d = new Date(p.start_date);
  d.setDate(15);
  const mid = d.toISOString().slice(0, 10);
  return mid > today ? today : mid;
}).reverse();
console.log(`  trading on ${days.join(" and ")}\n`);

let sales = 0, received = 0;
for (const [di, day] of days.entries()) {
  for (const [i, it] of items.entries()) {
    const cost = 400 + i * 150 + di * 60;
    await postGoodsReceipt({
      companyId: co.id, partnerId: supplier.id, locationId: loc.id, docDate: day,
      lines: [{ itemId: it.id, qty: 200, unitCost: cost }],
    });
    received += 1;

    const cust = customers[(i + di) % customers.length];
    const already = await sql`
      select d.id from document d
       where d.company_id = ${co.id} and d.doc_type = 'SALES_INVOICE'
         and d.partner_id = ${cust.id} and d.posting_date = ${day}::date
         and exists (select 1 from document_line dl
                      where dl.document_id = d.id and dl.item_id = ${it.id})`;
    if (already.length > 0) continue;

    // A discount on some lines and not others, so the column has a spread
    // worth sorting rather than one figure repeated.
    const disc = i % 3 === 0 ? 10 : i % 3 === 1 ? 5 : 0;
    await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: day, dueDate: day, paymentType: "CREDIT",
      lines: [{
        itemId: it.id,
        qty: 12 + (items.length - i) * 4 + di * 6,
        unitPrice: cost * (2 + (i % 3) * 0.4),
        discountPct: disc,
      }],
    });
    sales += 1;
  }

  // One giveaway and one return a month, so the columns that exist for them
  // are not permanently dashes.
  if (promo) {
    await postDelivery({
      companyId: co.id, partnerId: customers[0].id, locationId: loc.id, docDate: day,
      lines: [{ itemId: items[0].id, qty: 3, focReasonId: promo.id }],
    });
  }
  try {
    await postSalesReturn({
      companyId: co.id, partnerId: customers[1].id, locationId: loc.id, docDate: day,
      lines: [{ itemId: items[1 % items.length].id, qty: 2, unitPrice: 1800 }],
    });
  } catch (e) {
    console.log(`    return on ${day} skipped — ${String(e.message).slice(0, 60)}`);
  }
}

/* The two shapes that make the reporting bases differ. Without them every
   sale is a counter sale, the two bases agree to the kyat, and a reader
   flipping the switch concludes it does nothing. */
const straddler = items[0];
const lateCust = customers[customers.length - 1];
const already = await sql`
  select d.id from document d
   where d.company_id = ${co.id} and d.doc_type = 'DELIVERY'
     and d.partner_id = ${lateCust.id} and d.posting_date = ${days[0]}::date
     and d.reference = 'billed next month'`;
if (already.length === 0 && days.length > 1) {
  const sent = await postDelivery({
    companyId: co.id, partnerId: lateCust.id, locationId: loc.id, docDate: days[0],
    reference: "billed next month",
    lines: [{ itemId: straddler.id, qty: 30, unitPrice: 2400 }],
  });
  await postSalesInvoice({
    companyId: co.id, partnerId: lateCust.id, locationId: loc.id,
    docDate: days[1], dueDate: days[1], paymentType: "CREDIT", deliveryId: sent.id,
    lines: [{ itemId: straddler.id, qty: 30, unitPrice: 2400 }],
  });
  console.log(`  goods out ${days[0]}, billed ${days[1]}`);
}

const waiting = await sql`
  select d.id from document d
   where d.company_id = ${co.id} and d.doc_type = 'SALES_INVOICE'
     and d.reference = 'goods to follow'`;
if (waiting.length === 0) {
  try {
    await postSalesInvoice({
      companyId: co.id, partnerId: customers[1].id, locationId: loc.id,
      docDate: days[days.length - 1], dueDate: days[days.length - 1],
      paymentType: "CREDIT", toDeliver: true, reference: "goods to follow",
      lines: [{ itemId: items[1 % items.length].id, qty: 18, unitPrice: 2900 }],
    });
    console.log("  one bill still waiting on its goods");
  } catch (e) {
    console.log(`    deliver-later bill skipped — ${String(e.message).slice(0, 60)}`);
  }
}

console.log(`  ${received} receipts, ${sales} sales, a giveaway and a return each month`);
console.log("  Sales -> Sales report\n");
await sql.end();
