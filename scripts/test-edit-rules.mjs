// The tester's editing rules, enforced where a browser cannot reach.
//
//   npx tsx scripts/test-edit-rules.mjs
//
// Every rule here is also a locked field on a screen. A locked field is a
// courtesy: it stops a mistake, not a request. These call the posting engine
// directly, which is what a crafted request reaches, and check that the rule
// holds there too.
//
//   an order-linked invoice is corrected at the order, never on itself
//   an agreed price is billed, not typed over
//   a correction changes what was charged, never how much moved

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

  const fresh = async () => {
    await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
      payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
      stock_movement, document_line, document, journal_line, journal_entry
      restart identity cascade`);
    await sql`update number_series set next_value = 1`;
  };
  const today = new Date().toISOString().slice(0, 10);

  const stock = () => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 200, unitCost: 400 }],
  });

  /** Order → delivery → invoice, the chain the rules are about. */
  const chain = async (price = 1000) => {
    const so = await P.postSalesOrder({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: item.id, qty: 10, unitPrice: price }],
    });
    const [soLine] = await sql`select id from document_line where document_id = ${so.id}`;
    const dl = await P.postDelivery({
      companyId: co.id, partnerId: cust.id, locationId: loc.id, docDate: today,
      sourceDocumentId: so.id,
      lines: [{ itemId: item.id, qty: 10, unitPrice: price, sourceLineId: soLine.id }],
    });
    const [dlLine] = await sql`select id from document_line where document_id = ${dl.id}`;
    return { so, soLine, dl, dlLine };
  };

  // ---- 1. an order-linked invoice is corrected at the order ---------------

  console.log("  an invoice that belongs to an order\n");
  {
    await fresh();
    await stock();
    const { dl, dlLine } = await chain(1000);
    const inv = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, sourceLineId: dlLine.id }],
    });

    let refused = null;
    try {
      await P.amendInvoice({
        companyId: co.id, documentId: inv.id, reason: "going round the screen",
        invoice: {
          companyId: co.id, partnerId: cust.id, locationId: loc.id,
          docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
          lines: [{ itemId: item.id, qty: 10, unitPrice: 1500, sourceLineId: dlLine.id }],
        },
      });
    } catch (e) { refused = e.message; }

    check("cannot be corrected directly, even calling the engine", refused !== null,
      refused ? refused.slice(0, 70) : "CORRECTED — the rule is only a hidden button");
    check("  and the invoice still says 10,000",
      n((await sql`select gross_total::float as t from document where id = ${inv.id}`)[0].t) === 10000);
  }

  // ---- 2. an agreed price is billed, not typed over -----------------------

  console.log("\n  a price the order already agreed\n");
  {
    await fresh();
    await stock();
    const { dl, dlLine } = await chain(1000);

    let refused = null;
    try {
      await P.postSalesInvoice({
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 1500, sourceLineId: dlLine.id }],
      });
    } catch (e) { refused = e.message; }
    check("billing more than was agreed is refused", refused !== null,
      refused ? refused.slice(0, 70) : "POSTED — the price list beat the agreement");

    let under = null;
    try {
      await P.postSalesInvoice({
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 800, sourceLineId: dlLine.id }],
      });
    } catch (e) { under = e.message; }
    check("  and so is billing less", under !== null,
      under ? under.slice(0, 56) : "POSTED — a discount nobody agreed");

    const ok = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: today, toDeliver: false, deliveryId: dl.id,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, sourceLineId: dlLine.id }],
    });
    check("  the agreed price posts normally",
      n((await sql`select gross_total::float as t from document where id = ${ok.id}`)[0].t) === 10000);
  }

  // ---- 3. a correction cannot change what moved ---------------------------

  console.log("\n  a quantity the goods already decided\n");
  {
    await fresh();
    await stock();
    // A purchase invoice billing a receipt: no order behind it, so it is
    // correctable — but only its price.
    const gr = await P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: 20, unitCost: 100 }],
    });
    const [grLine] = await sql`select id from document_line where document_id = ${gr.id}`;
    const bill = await P.postPurchaseInvoice({
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: null, goodsReceiptId: gr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: grLine.id }],
    });

    let qtyChanged = null;
    try {
      await P.amendInvoice({
        companyId: co.id, documentId: bill.id, reason: "sneaking the quantity down",
        invoice: {
          companyId: co.id, partnerId: supp.id, locationId: loc.id,
          docDate: today, dueDate: null, goodsReceiptId: gr.id,
          lines: [{ itemId: item.id, qty: 12, unitPrice: 100, sourceLineId: grLine.id }],
        },
      });
    } catch (e) { qtyChanged = e.message; }
    check("the quantity cannot be corrected", qtyChanged !== null,
      qtyChanged ? qtyChanged.slice(0, 70) : "CORRECTED — 20 boxes became 12 on paper");

    let added = null;
    try {
      const [other] = await sql`select id from item where company_id = ${co.id}
         and is_stocked and is_active and id <> ${item.id} order by code limit 1`;
      await P.amendInvoice({
        companyId: co.id, documentId: bill.id, reason: "adding a line",
        invoice: {
          companyId: co.id, partnerId: supp.id, locationId: loc.id,
          docDate: today, dueDate: null, goodsReceiptId: gr.id,
          lines: [
            { itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: grLine.id },
            { itemId: other.id, qty: 5, unitPrice: 50 },
          ],
        },
      });
    } catch (e) { added = e.message; }
    check("  nor can goods it never billed be added", added !== null,
      added ? added.slice(0, 60) : "CORRECTED — a line appeared from nowhere");

    const priced = await P.amendInvoice({
      companyId: co.id, documentId: bill.id, reason: "supplier confirmed 130",
      invoice: {
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: null, goodsReceiptId: gr.id,
        lines: [{ itemId: item.id, qty: 20, unitPrice: 130, sourceLineId: grLine.id }],
      },
    });
    check("  the price still corrects", n(priced.totalAfter) === 2600,
      `${n(priced.totalAfter)}`);
  }

  // ---- the books still hold ------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);

  console.log(bad === 0
    ? "\n  the rules hold where the screen cannot reach\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
