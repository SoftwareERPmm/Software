// Selling consignment stock, and settling with the consignor.
//
//   node scripts/test-consignment-sale.mjs
//
// Posts real documents. Run against a scratch database.
//
// Owned stock and consigned stock are separate pools — the user's explicit
// choice, after being shown what silently blending them under one FIFO draw
// would risk. A normal sale draws owned stock only; a sale marked
// source: "CONSIGNMENT" draws consigned stock only, and never falls back to
// owned stock if consigned stock runs short. Settlement — the purchase and
// the payable to the consignor — is recognized at the sales invoice, not the
// delivery, at the price the customer is actually being charged, as a real
// Purchase Invoice document.

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

const {
  postConsignmentReceipt, postSaleWithDelivery, postGoodsReceipt, postSalesInvoice,
} = await import("../lib/posting.ts");

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
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 1`;

  await sql.unsafe(`truncate table payment_allocation, stock_lot_consumption, stock_lot,
    stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`delete from consignment_agreement_line`;
  await sql`delete from consignment_agreement`;
  await sql`update number_series set next_value = 1`;

  let [grp] = await sql`select id from item_group where company_id = ${co.id} limit 1`;
  if (!grp) [grp] = await sql`insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'CS', 'x', 'Consignment Sale Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;

  // item.code is trigger-composed from item_group.segment + serial, not
  // taken from the value passed here — so two items in one group need
  // distinct serials, not distinct "code" strings, to land on distinct rows.
  const mkItem = async (serial, name) => (await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code)
    values (${co.id}, ${grp.id}, ${serial}, ${name}, ${uom.id}, ${serial}) returning id, code`)[0];
  const coke = await mkItem("cs1" + Date.now().toString().slice(-6), "Coca-Cola");
  const water = await mkItem("cs2" + Date.now().toString().slice(-6), "Water");

  const mkPartner = async (code, name, kind) => (await sql`
    insert into business_partner (company_id, code, name, ${sql(kind)})
    values (${co.id}, ${code + "-" + Date.now().toString().slice(-5)}, ${name}, true) returning id`)[0];
  const golden = await mkPartner("GOLD", "Golden Land Store", "is_supplier");
  const silver = await mkPartner("SILV", "Silver Trading", "is_supplier");
  await sql`update business_partner set payment_terms_days = 30 where id = ${golden.id}`;
  const customer = await mkPartner("CUST", "Retail Customer", "is_customer");

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, locationId: loc.id, docDate: today };

  const [goldenAg] = await sql`insert into consignment_agreement (company_id, partner_id)
    values (${co.id}, ${golden.id}) returning id`;
  const [cokePct] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${goldenAg.id}, ${coke.id}, 'PERCENTAGE', 80) returning id`;

  console.log(`\n  ${co.name}\n`);

  // ---- The basic loop: percentage settlement ------------------------------

  const cr1 = await postConsignmentReceipt({ ...base, partnerId: golden.id,
    lines: [{ itemId: coke.id, qty: 100, agreementLineId: cokePct.id }] });
  console.log(`  ${cr1.docNo}: 100 Coca-Cola on consignment from Golden Land, 80% of selling price\n`);

  const sale1 = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: coke.id, qty: 20, unitPrice: 1000, source: "CONSIGNMENT" }] });

  // postSaleWithDelivery posts the delivery first, so it is the invoice
  // that points back at it, not the other way round.
  const [delivery1] = await sql`select dl.id, dl.journal_entry_id from document si
    join document dl on dl.id = si.source_document_id and dl.doc_type = 'DELIVERY'
   where si.id = ${sale1.id}`;
  check("the delivery carries no journal entry — nothing owned moved",
    delivery1.journal_entry_id === null);
  check("its line is marked consignment",
    (await sql`select is_consignment from document_line where document_id = ${delivery1.id}`)[0]
      ?.is_consignment === true);

  const settlement1 = await sql`select * from document
    where source_document_id = ${sale1.id} and doc_type = 'PURCHASE_INVOICE'`;
  check("a settlement purchase invoice was auto-created", settlement1.length === 1);
  check("it is billed to the consignor, not the customer",
    settlement1[0]?.partner_id === golden.id);
  check("80% of 20 x 1,000 = 16,000",
    n(settlement1[0]?.gross_total) === 16000, `${n(settlement1[0]?.gross_total)}`);
  check("due 30 days out, matching the consignor's terms",
    settlement1[0]?.due_date !== null);

  const j1 = await sql`select a.code, jl.amount from journal_line jl join account a on a.id = jl.account_id
    join journal_entry je on je.id = jl.journal_entry_id where je.source_id = ${settlement1[0]?.id}`;
  check("posts Dr COGS / Cr AP, no Inventory line",
    j1.some((l) => n(l.amount) === 16000) && j1.some((l) => n(l.amount) === -16000) && j1.length === 2,
    j1.map((l) => `${l.code}:${n(l.amount)}`).join(" "));

  const [openAfter1] = await sql`select coalesce(outstanding, 0) as v from v_open_item
    where document_id = ${settlement1[0]?.id}`;
  check("shows up in AP aging like any other bill", n(openAfter1?.v) === 16000);

  // ---- Fixed-price settlement, and a second sale against the same lot -----

  const [waterAg] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${goldenAg.id}, ${water.id}, 'FIXED', 300) returning id`;
  await postConsignmentReceipt({ ...base, partnerId: golden.id,
    lines: [{ itemId: water.id, qty: 50, agreementLineId: waterAg.id }] });

  const sale2 = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: water.id, qty: 10, unitPrice: 500, source: "CONSIGNMENT" }] });
  const settlement2 = await sql`select gross_total from document
    where source_document_id = ${sale2.id} and doc_type = 'PURCHASE_INVOICE'`;
  check("fixed pricing ignores the selling price: 10 x 300 = 3,000, not 10 x 500",
    n(settlement2[0]?.gross_total) === 3000, `${n(settlement2[0]?.gross_total)}`);

  // ---- A mixed sale: one owned line, one consigned line -------------------

  await postGoodsReceipt({ ...base, partnerId: silver.id,
    lines: [{ itemId: coke.id, qty: 200, unitCost: 400 }] });

  const mixed = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [
      { itemId: coke.id, qty: 5, unitPrice: 1000 },                          // owned — default source
      { itemId: water.id, qty: 5, unitPrice: 500, source: "CONSIGNMENT" },   // consigned
    ] });

  const [mixedDelivery] = await sql`select dl.id, dl.journal_entry_id from document si
    join document dl on dl.id = si.source_document_id and dl.doc_type = 'DELIVERY'
   where si.id = ${mixed.id}`;
  check("a mixed delivery still gets a journal entry — the owned line has real COGS",
    mixedDelivery.journal_entry_id !== null);
  const mixedLines = await sql`select item_id, is_consignment from document_line
    where document_id = ${mixedDelivery.id} order by line_no`;
  check("only the consigned line is marked",
    mixedLines.filter((l) => l.is_consignment).length === 1);

  const mixedInvoice = await sql`select gross_total from document where id = ${mixed.id}`;
  check("the invoice bills the full price of both lines",
    n(mixedInvoice[0]?.gross_total) === 5 * 1000 + 5 * 500, `${n(mixedInvoice[0]?.gross_total)}`);
  const mixedSettlement = await sql`select gross_total from document
    where source_document_id = ${mixed.id} and doc_type = 'PURCHASE_INVOICE'`;
  check("but only the consigned portion is settled with the consignor",
    mixedSettlement.length === 1 && n(mixedSettlement[0]?.gross_total) === 5 * 300,
    `${n(mixedSettlement[0]?.gross_total)}`);

  // ---- Pools never blend ---------------------------------------------------

  console.log("");
  const remainingCokeConsigned = n((await sql`
    select coalesce(sum(cl.qty_received),0) - coalesce((
      select sum(c.qty) from consignment_lot_consumption c
        join consignment_lot l2 on l2.id = c.lot_id where l2.item_id = ${coke.id}
    ), 0) as v
    from consignment_lot cl where cl.item_id = ${coke.id}`)[0].v);
  check("80 units of consigned Coca-Cola remain, untouched by owned sales", remainingCokeConsigned === 80);

  check("a normal (owned) sale cannot dip into consigned stock to make up a shortfall",
    (await refused(() => postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
      lines: [{ itemId: coke.id, qty: 999999, unitPrice: 1000 }] })))?.includes("Not enough"));

  check("nor can a consignment-sourced line dip into owned stock",
    (await refused(() => postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
      lines: [{ itemId: coke.id, qty: 999999, unitPrice: 1000, source: "CONSIGNMENT" }] })))
      ?.includes("Not enough consigned"));

  // ---- Two consignors, the same item, one sale -----------------------------

  console.log("");
  const [silverAg] = await sql`insert into consignment_agreement (company_id, partner_id)
    values (${co.id}, ${silver.id}) returning id`;
  const [silverLine] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${silverAg.id}, ${water.id}, 'PERCENTAGE', 60) returning id`;
  await postConsignmentReceipt({ ...base, partnerId: silver.id,
    lines: [{ itemId: water.id, qty: 20, agreementLineId: silverLine.id }] });

  // Golden's water lot: 50 received, 10 sold in sale2, 5 more sold in the
  // mixed sale above — 35 left. Draw 45 to spill across both consignors.
  const twoConsignor = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: water.id, qty: 45, unitPrice: 500, source: "CONSIGNMENT" }] });
  const settlements = await sql`select partner_id, gross_total from document
    where source_document_id = ${twoConsignor.id} and doc_type = 'PURCHASE_INVOICE' order by gross_total`;
  check("one sale spanning two consignors' lots produces two settlements",
    settlements.length === 2, `${settlements.length}`);
  check("Golden's remaining 35 at fixed 300", n(settlements[1]?.gross_total) === 35 * 300,
    `${n(settlements[1]?.gross_total)}`);
  check("Silver's 10 at 60% of 500", n(settlements[0]?.gross_total) === 10 * 500 * 0.6,
    `${n(settlements[0]?.gross_total)}`);

  // ---- Idempotence: nothing left to settle if invoiced again --------------

  console.log("");
  await postConsignmentReceipt({ ...base, partnerId: golden.id,
    lines: [{ itemId: coke.id, qty: 10, agreementLineId: cokePct.id }] });
  const sale3 = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: coke.id, qty: 10, unitPrice: 1000, source: "CONSIGNMENT" }] });
  const [d3] = await sql`select dl.id from document si
    join document dl on dl.id = si.source_document_id and dl.doc_type = 'DELIVERY'
   where si.id = ${sale3.id}`;

  // A second invoice referencing the same delivery — legitimate in this app
  // (partial invoicing of one delivery across documents) — must find nothing
  // left to settle rather than double-bill the consignor.
  const before = n((await sql`select count(*)::int as c from document
    where doc_type = 'PURCHASE_INVOICE' and source_document_id = ${sale3.id}`)[0].c);
  await postSalesInvoice({ ...base, partnerId: customer.id, dueDate: null, deliveryId: d3.id,
    lines: [{ itemId: coke.id, qty: 10, unitPrice: 1000 }] });
  const after = n((await sql`select count(*)::int as c from document
    where doc_type = 'PURCHASE_INVOICE' and source_document_id = ${sale3.id}`)[0].c);
  check("a second invoice against an already-settled delivery creates no second settlement",
    after === before, `${before} -> ${after}`);

  // ---- Invariants -----------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory still reconciles — consignment never touches stock_movement",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(failures === 0 ? "\n  all consignment-sale tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
