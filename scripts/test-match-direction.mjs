// Which way a goods receipt and its purchase invoice see each other.
//
//   npx tsx scripts/test-match-direction.mjs
//
// The chain is built one way: a receipt is posted, and the invoice that bills
// it names the receipt as its source. Nothing ever points back the other way.
// So a screen that looks for its counterpart only by "documents whose source
// is me" can answer correctly from one end and wrongly from the other — and
// the wrong end is the invoice, which then reports goods it was raised from
// as never having arrived.
//
// Writes documents. Run against a scratch database.

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

const { sql } = await import("../lib/db.ts");
const { getMatchStatus } = await import("../lib/queries.ts");
const { postGoodsReceipt, postPurchaseInvoice } = await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);
  const stamp = Date.now().toString().slice(-6);

  // ---- fixtures -----------------------------------------------------------
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"MD" + stamp}, 'x', ${"Match Dir " + stamp})
    returning id, name`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, '001', ${"Match Item " + stamp}, ${uom.id}, true)
    returning id, code`;
  const [supplier] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"MS-" + stamp}, ${"Match Supplier " + stamp}, true)
    returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;
  const today = new Date().toISOString().slice(0, 10);

  // ---- the ordinary chain: receive, then bill it --------------------------
  const gr = await postGoodsReceipt({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitCost: 45000 }],
  });
  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    goodsReceiptId: gr.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 45000 }],
  });
  console.log(`  ${gr.docNo} received 10, billed by ${pi.docNo}\n`);

  const [piRow] = await sql`select source_document_id from document where id = ${pi.id}`;
  check("the invoice names the receipt as its source",
    piRow.source_document_id === gr.id);
  const [grRow] = await sql`select source_document_id from document where id = ${gr.id}`;
  check("and the receipt does NOT point back at the invoice — nothing ever does",
    grRow.source_document_id !== pi.id);

  // ---- what each end reports ----------------------------------------------
  const fromGr = await getMatchStatus(gr.id);
  check("from the receipt: fully invoiced",
    fromGr?.state === "FULL" && fromGr.lines[0].remaining === 0,
    `${fromGr?.state}, remaining ${fromGr?.lines[0]?.remaining}`);
  check("and it names the invoice that billed it",
    fromGr?.lines[0].matchedBy.some((m) => m.docId === pi.id),
    fromGr?.lines[0]?.matchedBy.map((m) => m.docNo).join(", ") || "none");

  // The half that was wrong: the same ten units, seen from the invoice.
  const fromPi = await getMatchStatus(pi.id);
  check("from the invoice: fully received",
    fromPi?.state === "FULL" && fromPi.lines[0].remaining === 0,
    `${fromPi?.state}, remaining ${fromPi?.lines[0]?.remaining}`);
  check("and it names the receipt the goods came in on",
    fromPi?.lines[0].matchedBy.some((m) => m.docId === gr.id),
    fromPi?.lines[0]?.matchedBy.map((m) => m.docNo).join(", ") || "none");
  check("so nothing is left to receive, and no receipt is offered",
    (fromPi?.lines ?? []).every((l) => l.remaining === 0));

  // ---- an invoice genuinely not received yet still says so ----------------
  const piAlone = await postPurchaseInvoice({
    companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 4, unitPrice: 45000 }],
  });
  const alone = await getMatchStatus(piAlone.id);
  check("an invoice raised with no receipt still reports nothing received",
    alone?.state === "NONE" && alone.lines[0].remaining === 4,
    `${alone?.state}, remaining ${alone?.lines[0]?.remaining}`);

  // ---- the sales mirror ---------------------------------------------------
  // Same shape, different vocabulary: a delivery moves the goods and a sales
  // invoice bills them. The invoice names the delivery, nothing points back,
  // so the identical asymmetry would apply — and the identical fix has to
  // reach it, or the sales side keeps the bug the purchase side just lost.
  const { postDelivery, postSalesInvoice } = await import("../lib/posting.ts");
  const [customer] = await sql`
    insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${"MC-" + stamp}, ${"Match Customer " + stamp}, true)
    returning id`;

  // Stock to sell: the receipt above brought in 10.
  const del = await postDelivery({
    companyId: co.id, partnerId: customer.id, locationId: wh.id, docDate: today,
    lines: [{ itemId: item.id, qty: 6 }],
  });
  const si = await postSalesInvoice({
    companyId: co.id, partnerId: customer.id, locationId: wh.id, docDate: today,
    deliveryId: del.id,
    lines: [{ itemId: item.id, qty: 6, unitPrice: 90000 }],
  });
  console.log(`\n  ${del.docNo} delivered 6, billed by ${si.docNo}\n`);

  const fromDel = await getMatchStatus(del.id);
  check("from the delivery: fully invoiced",
    fromDel?.state === "FULL" && fromDel.lines[0].remaining === 0,
    `${fromDel?.state}, remaining ${fromDel?.lines[0]?.remaining}`);
  check("and it names the invoice that billed it",
    fromDel?.lines[0].matchedBy.some((m) => m.docId === si.id),
    fromDel?.lines[0]?.matchedBy.map((m) => m.docNo).join(", ") || "none");

  const fromSi = await getMatchStatus(si.id);
  check("from the invoice: fully delivered",
    fromSi?.state === "FULL" && fromSi.lines[0].remaining === 0,
    `${fromSi?.state}, remaining ${fromSi?.lines[0]?.remaining}`);
  check("and it names the delivery the goods went out on",
    fromSi?.lines[0].matchedBy.some((m) => m.docId === del.id),
    fromSi?.lines[0]?.matchedBy.map((m) => m.docNo).join(", ") || "none");

  console.log(`\n  ${failures === 0 ? "match direction is symmetric on both sides" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
