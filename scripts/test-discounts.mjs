// Item discount, volume discount, FOC — three things, kept apart.
//
//   npx tsx scripts/test-discounts.mjs
//
// The point of the feature is not the arithmetic, it is that an invoice can
// say which part of a reduction the seller gave and which part the order
// earned. So most of these check attribution rather than totals: the right
// number reached by the wrong route would still leave the invoice unable to
// explain itself.
//
// Pure arithmetic plus a posted sale. Run against a scratch database.

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

const { priceLines, bandFor } = await import("../lib/discount.ts");

let failures = 0;
const n = (v) => Number(v ?? 0);
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const band = (o) => ({
  id: o.id ?? o.code, code: o.code, name: o.name ?? o.code,
  basis: o.basis, item_id: o.item_id ?? null, item_group_id: o.item_group_id ?? null,
  min_value: o.min, max_value: o.max ?? null, discount_pct: o.pct,
});

const TIERS = [
  band({ code: "VOL-0",  basis: "QUANTITY", min: 1,   max: 49,  pct: 0 }),
  band({ code: "VOL-3",  basis: "QUANTITY", min: 50,  max: 99,  pct: 3 }),
  band({ code: "VOL-5",  basis: "QUANTITY", min: 100,           pct: 5 }),
  band({ code: "INV-3",  basis: "INVOICE_TOTAL", min: 10000000, pct: 3 }),
];

console.log("\n  the examples as specified\n");

// 10 x 50,000 less 10% item discount = 450,000
{
  const r = priceLines([{ itemId: "a", qty: 10, unitPrice: 50000, discountPct: 10 }], []);
  check("item discount: 10 x 50,000 less 10% is 450,000",
    r.total === 450000, String(r.total));
  check("  and it is attributed to the line, not to a volume band",
    r.lines[0].itemDiscountAmount === 50000 && r.lines[0].volumeDiscountAmount === 0);
}

// 100 x 50,000 less 5% volume = 4,750,000
{
  const r = priceLines([{ itemId: "a", qty: 100, unitPrice: 50000, discountPct: 0 }],
                       TIERS.filter((b) => b.basis === "QUANTITY"));
  check("volume discount: 100 x 50,000 at 5% is 4,750,000",
    r.total === 4750000, String(r.total));
  check("  and it names the band that gave it",
    r.lines[0].volumeDiscountPct === 5 && r.lines[0].volumeDiscountId === "VOL-5",
    r.lines[0].volumeDiscountId ?? "none");
}

// The bands themselves
{
  const q = (n) => bandFor(TIERS, "QUANTITY", n, "a", null)?.discount_pct ?? 0;
  check("1-49 earns nothing", q(1) === 0 && q(49) === 0);
  check("50-99 earns 3%", q(50) === 3 && q(99) === 3);
  check("100 and above earns 5%", q(100) === 5 && q(1000) === 5);
}

console.log("\n  both bases at once\n");

// 100 units -> 5%, and the invoice passes 10,000,000 -> another 3%.
{
  const r = priceLines(
    [{ itemId: "a", qty: 100, unitPrice: 50000, discountPct: 0 },
     { itemId: "b", qty: 200, unitPrice: 40000, discountPct: 0 }],
    TIERS
  );
  // 5,000,000 - 5% = 4,750,000 ; 8,000,000 - 5% = 7,600,000 ; subtotal 12,350,000
  check("each line earns its own quantity band first",
    r.lines[0].volumeDiscountAmount === 250000 && r.lines[1].volumeDiscountAmount === 400000,
    `${r.lines[0].volumeDiscountAmount} / ${r.lines[1].volumeDiscountAmount}`);
  check("the invoice band is judged on the subtotal after those",
    r.subtotal === 12350000 && r.invoiceBand?.code === "INV-3", String(r.subtotal));
  check("both apply — the second on what the first left, not added to it",
    r.total === Math.round(12350000 * 0.97 * 10000) / 10000, String(r.total));
  check("and the invoice discount is spread across the lines, not held on the header",
    r.lines.every((l) => l.invoiceDiscountAmount > 0) &&
    Math.abs(r.lines.reduce((s, l) => s + l.invoiceDiscountAmount, 0) - 370500) < 0.01,
    String(r.lines.reduce((s, l) => s + l.invoiceDiscountAmount, 0)));
  check("every line can name all three separately",
    r.lines.every((l) =>
      typeof l.itemDiscountAmount === "number" &&
      l.volumeDiscountId !== null && l.invoiceDiscountId !== null));
}

// Sequential, not additive: 10% then 5% is 14.5% off, not 15%.
{
  const r = priceLines([{ itemId: "a", qty: 100, unitPrice: 50000, discountPct: 10 }],
                       TIERS.filter((b) => b.basis === "QUANTITY"));
  check("a line discount and a volume band compound rather than sum",
    r.total === 4275000, `${r.total} (15% flat would be 4,250,000)`);
}

console.log("\n  which band wins\n");
{
  const mixed = [
    band({ code: "ALL",  basis: "QUANTITY", min: 100, pct: 5 }),
    band({ code: "CAT",  basis: "QUANTITY", min: 100, pct: 4, item_group_id: "g1" }),
    band({ code: "ITEM", basis: "QUANTITY", min: 100, pct: 2, item_id: "a" }),
  ];
  check("a rule naming the item beats one naming its category",
    bandFor(mixed, "QUANTITY", 100, "a", "g1")?.code === "ITEM");
  check("a rule naming the category beats the company-wide one",
    bandFor(mixed, "QUANTITY", 100, "b", "g1")?.code === "CAT");
  check("and the company-wide one still covers everything else",
    bandFor(mixed, "QUANTITY", 100, "z", "g9")?.code === "ALL");

  const tie = [
    band({ code: "LOW",  basis: "QUANTITY", min: 100, pct: 3 }),
    band({ code: "HIGH", basis: "QUANTITY", min: 100, pct: 6 }),
  ];
  check("between two equally specific bands the customer gets the better one",
    bandFor(tie, "QUANTITY", 100, "a", null)?.code === "HIGH");
}

console.log("\n  nothing configured\n");
{
  const r = priceLines([{ itemId: "a", qty: 500, unitPrice: 1000, discountPct: 0 }], []);
  check("with no bands at all, nothing is discounted",
    r.total === 500000 && r.lines[0].volumeDiscountId === null, String(r.total));
  const below = priceLines([{ itemId: "a", qty: 10, unitPrice: 1000, discountPct: 0 }], TIERS);
  check("a quantity below every band earns nothing",
    below.lines[0].volumeDiscountPct === 0, String(below.lines[0].volumeDiscountPct));
}

// ---- posted for real -----------------------------------------------------
// The arithmetic above is only worth anything if the invoice keeps the split.
console.log("\n  posted, and the invoice remembers why\n");
{
  const { sql } = await import("../lib/db.ts");
  const { postSaleWithDelivery, postGoodsReceipt } = await import("../lib/posting.ts");
  const [co] = await sql`select id from company order by created_at limit 1`;
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"VD" + stamp}, 'x', ${"Vol Disc " + stamp}) returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, '001', ${"Dress " + stamp}, ${uom.id}, true) returning id`;
  const [cust] = await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${"VC-" + stamp}, ${"Vol Customer " + stamp}, true) returning id`;
  const [supp] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"VS-" + stamp}, ${"Vol Supplier " + stamp}, true) returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;

  // Scoped to this test's own item. An unscoped quantity band is company-wide
  // master data that outlives the run, and it silently repriced every later
  // suite's sales — a test that changes what other tests mean.
  await sql`
    insert into volume_discount (company_id, code, name, basis, item_id, min_value, max_value,
                                 discount_pct, valid_from)
    values (${co.id}, ${"Q5-" + stamp}, '100 or more', 'QUANTITY', ${item.id}, 100, null, 5, ${today}::date)`;
  await sql`
    insert into volume_discount (company_id, code, name, basis, min_value,
                                 discount_pct, valid_from)
    values (${co.id}, ${"I3-" + stamp}, 'Bill over 10M', 'INVOICE_TOTAL', 10000000, 3, ${today}::date)`;

  await postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 300, unitCost: 20000 }],
  });

  // 100 x 50,000 = 5,000,000 -> 5% = 4,750,000. Under 10M, so no invoice band.
  const small = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 50000 }],
  });
  const [sl] = await sql`
    select unit_price, discount_pct, volume_discount_pct, volume_discount_amount,
           volume_discount_id, invoice_discount_pct, net_amount
      from document_line where document_id = ${small.id}`;
  check("the line keeps the list price, not a pre-netted one",
    n(sl.unit_price) === 50000, String(n(sl.unit_price)));
  check("the volume discount is recorded as its own figure",
    n(sl.volume_discount_pct) === 5 && n(sl.volume_discount_amount) === 250000,
    `${n(sl.volume_discount_pct)}% / ${n(sl.volume_discount_amount)}`);
  check("  naming the band that gave it", Boolean(sl.volume_discount_id));
  check("no invoice band applies below its threshold",
    n(sl.invoice_discount_pct) === 0, String(n(sl.invoice_discount_pct)));
  check("and the net is what the customer is charged",
    n(sl.net_amount) === 4750000, String(n(sl.net_amount)));

  // 200 x 60,000 = 12,000,000 -> 5% = 11,400,000, over 10M -> another 3%.
  const big = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 200, unitPrice: 60000 }],
  });
  const [bl] = await sql`
    select volume_discount_amount, invoice_discount_pct, invoice_discount_amount,
           invoice_discount_id, net_amount
      from document_line where document_id = ${big.id}`;
  check("both bands apply to the same line",
    n(bl.volume_discount_amount) === 600000 && n(bl.invoice_discount_pct) === 3,
    `${n(bl.volume_discount_amount)} then ${n(bl.invoice_discount_pct)}%`);
  check("  each recorded separately, with its own rule named",
    Boolean(bl.invoice_discount_id) && n(bl.invoice_discount_amount) === 342000,
    String(n(bl.invoice_discount_amount)));
  check("  and the second came off what the first left",
    n(bl.net_amount) === 11058000, String(n(bl.net_amount)));

  const [rev] = await sql`
    select coalesce(sum(-jl.base_amount), 0) v
      from journal_line jl join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
     where je.source_id = ${big.id} and a.account_type = 'REVENUE'`;
  check("revenue posted is the discounted figure, not the list price",
    Math.abs(n(rev.v) - 11058000) < 0.01, String(n(rev.v)));

  // Retire the bands this run created. The invoice-total band cannot be
  // scoped to an item by design, so leaving it active would discount every
  // large invoice posted in this database afterwards — which is exactly what
  // it was doing to the suites that run after this one.
  await sql`
    update volume_discount set is_active = false
     where company_id = ${co.id} and code like ${"%-" + stamp}`;

  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));
}

// ---- FOC: not a discount ------------------------------------------------
// A free unit is charged at nothing and still leaves the warehouse. The
// distinction that matters: the discount reduces revenue, FOC gives goods
// away — so its cost must land in the expense its reason names, not in COGS,
// and the stock must still go out.
console.log("\n  free of charge, which is not a discount\n");
{
  const { sql } = await import("../lib/db.ts");
  const { postSaleWithDelivery, postGoodsReceipt } = await import("../lib/posting.ts");
  const [co] = await sql`select id from company order by created_at limit 1`;
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"FC" + stamp}, 'x', ${"Foc " + stamp}) returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, '001', ${"Product A " + stamp}, ${uom.id}, true) returning id`;
  const [cust] = await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${"FC-" + stamp}, ${"Foc Customer " + stamp}, true) returning id`;
  const [supp] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"FS-" + stamp}, ${"Foc Supplier " + stamp}, true) returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;
  const [sample] = await sql`
    select id from foc_reason where company_id = ${co.id} and code = 'SAMPLE'`;

  await postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 50, unitCost: 30000 }],
  });
  const before = n((await sql`
    select fn_qty_on_hand(${co.id}, ${item.id}, ${wh.id}) as q`)[0].q);

  // Buys 10 at 50,000, is given 2 free as a sample.
  const sale = await postSaleWithDelivery({
    companyId: co.id, partnerId: cust.id, locationId: wh.id, docDate: today, dueDate: null,
    lines: [
      { itemId: item.id, qty: 10, unitPrice: 50000 },
      { itemId: item.id, qty: 2, unitPrice: 0, focReasonId: sample.id },
    ],
  });

  const [inv] = await sql`select gross_total from document where id = ${sale.id}`;
  check("revenue is the billable quantity only",
    n(inv.gross_total) === 500000, String(n(inv.gross_total)));

  const after = n((await sql`
    select fn_qty_on_hand(${co.id}, ${item.id}, ${wh.id}) as q`)[0].q);
  check("but twelve units leave the warehouse, not ten",
    before - after === 12, `${before} -> ${after}`);

  const focLine = await sql`
    select dl.base_qty, dl.unit_price, dl.net_amount, f.code as reason
      from document_line dl
      join document d on d.id = dl.document_id
      join foc_reason f on f.id = dl.foc_reason_id
     where d.source_document_id = ${sale.id} or d.id = ${sale.id}`;
  check("the free units are their own line, priced at zero, with a reason",
    focLine.length > 0 && n(focLine[0].unit_price) === 0 && focLine[0].reason === "SAMPLE",
    focLine.length ? `${n(focLine[0].base_qty)} @ ${n(focLine[0].unit_price)} ${focLine[0].reason}` : "none");

  // The whole point of the reason: cost goes to the expense it names rather
  // than to cost of sales, so giving stock away does not look like selling it.
  const cogs = await sql`
    select coalesce(sum(jl.base_amount), 0) v
      from journal_line jl join account a on a.id = jl.account_id
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.journal_entry_id = je.id
     where a.account_type = 'COGS'
       and (d.id = ${sale.id}
            or d.source_document_id = ${sale.id}
            -- A counter sale posts the delivery first and points the invoice
            -- at it, so the delivery carrying the cost is the invoice's
            -- parent, not its child. Looking only downwards found nothing.
            or d.id = (select source_document_id from document where id = ${sale.id}))`;
  check("cost of sales carries only the ten that were sold",
    Math.abs(n(cogs[0].v) - 300000) < 0.01, String(n(cogs[0].v)));

  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  await sql.end();
}

console.log(`\n  ${failures === 0 ? "all discount tests pass" : failures + " FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
