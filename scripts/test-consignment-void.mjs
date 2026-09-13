// What the screen offers, the engine does.
//
//   ./node_modules/.bin/tsx scripts/test-consignment-void.mjs
//
// Consigned goods belong to the consignor until they sell. A delivery drawing
// on them writes no stock movement and no journal line, and nothing releases
// what it drew from consignment_lot_consumption — so voiding one is not
// supported, and this suite does not make it supported.
//
// What it does check is that the refusal is honest and early. The engine
// always refused, at the last moment, with "has no entry to reverse" — a
// sentence about bookkeeping for a reason that is about ownership. The plan
// the confirmation screen reads knew none of it and said the document could
// go, so the button was offered and then failed when pressed.
//
// A refusal must also leave everything exactly as it was: status, stock, the
// consignor's drawn-down quantity, and the journal.

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
const V = await import("../lib/void.ts");

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
  const items = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 2`;
  const [owned, consignedItem] = items;
  const [consignor] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  const [customer] = await sql`select id from business_partner
     where company_id = ${co.id} and is_customer order by code limit 1`;
  if (!consignedItem) throw new Error("needs two stocked items");
  console.log(`\n  ${co.name}\n`);

  // This suite truncates. It may only do that to the database .env names —
  // the development one — never to a URL passed in on the command line, which
  // is how the pilot tester's books or the real ones would be reached.
  const envUrl = existsSync(join(root, ".env"))
    ? (readFileSync(join(root, ".env"), "utf8").split("\n")
        .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/)).find(Boolean)?.[1]
        ?? "").replace(/^["']|["']$/g, "")
    : "";
  if (!envUrl || new URL(url).host !== new URL(envUrl).host) {
    throw new Error(
      `This suite wipes the database it runs against, and will only do that to `
      + `the one .env names. Target ${new URL(url).host}, .env ${envUrl ? new URL(envUrl).host : "(none)"}.`
    );
  }

  await sql.unsafe(`truncate table posting_attempt, consignment_lot_consumption,
    consignment_lot, document_history, fulfilment_link, order_closure, payment_allocation,
    stock_lot_adjustment, stock_lot_consumption, stock_lot, stock_movement,
    document_line, document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, locationId: loc.id, docDate: today };

  let [ag] = await sql`select id from consignment_agreement
     where company_id = ${co.id} and partner_id = ${consignor.id}`;
  if (!ag) {
    [ag] = await sql`insert into consignment_agreement (company_id, partner_id, memo)
      values (${co.id}, ${consignor.id}, 'void suite') returning id`;
  }
  let [agl] = await sql`select id from consignment_agreement_line
     where agreement_id = ${ag.id} and item_id = ${consignedItem.id}`;
  if (!agl) {
    [agl] = await sql`insert into consignment_agreement_line
      (company_id, agreement_id, item_id, pricing_method, pricing_value, is_active)
      values (${co.id}, ${ag.id}, ${consignedItem.id}, 'PERCENTAGE', 80, true) returning id`;
  }

  /** Everything a refusal must leave untouched. */
  const snapshot = async (docId) => {
    const [d] = await sql`select status from document where id = ${docId}`;
    const [s] = await sql`select coalesce(sum(qty), 0)::float q from stock_movement`;
    const [c] = await sql`select coalesce(sum(qty), 0)::float q from consignment_lot_consumption`;
    const [j] = await sql`select count(*)::int n from journal_entry`;
    const [jl] = await sql`select count(*)::int n from journal_line`;
    return { status: d?.status, stock: n(s.q), drawn: n(c.q), entries: j.n, lines: jl.n };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** The plan and the act, asked the same question. */
  const bothRefuse = async (docId, label) => {
    const before = await snapshot(docId);
    const plan = await V.planVoid(docId);
    let threw = null;
    try {
      await P.voidDocument({ documentId: docId, reason: "checking the refusal" });
    } catch (e) { threw = e.message; }
    const after = await snapshot(docId);

    check(`${label}: the plan refuses it`, plan?.canVoid === false,
      plan?.blockers?.[0]?.reason?.slice(0, 62) ?? "canVoid true");
    check(`  and so does the engine`, !!threw, threw?.slice(0, 62) ?? "it went through");
    check(`  saying the same thing`,
      !!threw && !!plan?.blockers?.some((b) => threw.includes(b.reason.slice(0, 40))),
      threw?.slice(0, 50));
    check(`  and nothing moved`, same(before, after),
      same(before, after) ? "" : `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    return plan;
  };

  // ---- a consignment receipt ----------------------------------------------

  console.log("  goods held, not bought\n");

  const cr = await P.postConsignmentReceipt({ ...base, partnerId: consignor.id,
    lines: [{ itemId: consignedItem.id, qty: 50, agreementLineId: agl.id }] });
  const receiptPlan = await bothRefuse(cr.id, "a consignment receipt");
  check("  for the reason that is actually true",
    !!receiptPlan?.blockers?.some((b) => /consignor/i.test(b.reason)));

  // ---- a delivery of consigned goods only ---------------------------------

  console.log("\n  a delivery of the consignor's goods\n");

  await P.postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: consignedItem.id, qty: 10, unitPrice: 800, source: "CONSIGNMENT" }] });
  const [consignedDelivery] = await sql`select id, doc_no from document
     where doc_type = 'DELIVERY' order by created_at desc limit 1`;

  // Clear what sits on top so the delivery itself is the question.
  for (let pass = 0; pass < 4; pass++) {
    for (const d of await sql`select id from document
         where status = 'POSTED' and doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
         order by created_at desc`) {
      const p = await V.planVoid(d.id);
      if (p?.canVoid) {
        try { await P.voidDocument({ documentId: d.id, reason: "clearing the way" }); } catch { /* */ }
      }
    }
  }

  await bothRefuse(consignedDelivery.id, "a consigned delivery");

  // ---- a delivery carrying both ------------------------------------------
  // This one has a journal entry, so "nothing to reverse" never fires. It is
  // refused for issuing stock — and now also for whose goods it moved.

  console.log("\n  a delivery carrying both our goods and the consignor's\n");

  await P.postGoodsReceipt({ ...base, partnerId: consignor.id,
    lines: [{ itemId: owned.id, qty: 50, unitCost: 100 }] });
  await P.postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: owned.id, qty: 10, unitPrice: 500, source: "OWNED" },
            { itemId: consignedItem.id, qty: 10, unitPrice: 800, source: "CONSIGNMENT" }] });
  const [mixed] = await sql`select id, doc_no, journal_entry_id from document
     where doc_type = 'DELIVERY' order by created_at desc limit 1`;

  check("the mixed delivery does post to the ledger",
    !!mixed.journal_entry_id, "so 'nothing to reverse' cannot be what saves it");

  for (let pass = 0; pass < 4; pass++) {
    for (const d of await sql`select id from document
         where status = 'POSTED' and doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
         order by created_at desc`) {
      const p = await V.planVoid(d.id);
      if (p?.canVoid) {
        try { await P.voidDocument({ documentId: d.id, reason: "clearing the way" }); } catch { /* */ }
      }
    }
  }

  const mixedPlan = await bothRefuse(mixed.id, "a mixed delivery");
  check("  and the consignor's goods are named among the reasons",
    !!mixedPlan?.blockers?.some((b) => /consigned goods/i.test(b.reason)),
    mixedPlan?.blockers?.map((b) => b.reason.slice(0, 28)).join(" | "));

  // ---- orders, which post nothing either -----------------------------------
  //
  // The "nothing to reverse" blocker applies to any document with no ledger
  // entry, and an order is one. Its own flows must be untouched: an amendment
  // never asks the void plan anything, and closing or reopening an order is
  // not a void at all. What changes is that the plan now refuses an order's
  // void in words, where it used to offer one the engine then refused.

  console.log("\n  orders post nothing, and are not voids\n");

  for (const [kind, post, partner] of [
    ["purchase", P.postPurchaseOrder, consignor],
    ["sales", P.postSalesOrder, customer],
  ]) {
    const ord = await post({ ...base, partnerId: partner.id, dueDate: today,
      lines: [{ itemId: owned.id, qty: 5, unitPrice: 100 }] });

    await P.closeOrderRemaining({ companyId: co.id, documentId: ord.id, reason: "not coming" });
    const owedAfterClose = n((await sql`select coalesce(sum(outstanding), 0)::float o
       from v_order_outstanding where order_id = ${ord.id}`)[0].o);
    check(`a ${kind} order still closes as no longer expected`, owedAfterClose === 0,
      `${owedAfterClose} outstanding`);

    await P.reopenOrder({ companyId: co.id, documentId: ord.id, reason: "back on" });
    const owedAfterReopen = n((await sql`select coalesce(sum(outstanding), 0)::float o
       from v_order_outstanding where order_id = ${ord.id}`)[0].o);
    check(`  and reopens`, owedAfterReopen === 5, `${owedAfterReopen} outstanding`);

    const before = await snapshot(ord.id);
    const plan = await V.planVoid(ord.id);
    let threw = null;
    try { await P.voidDocument({ documentId: ord.id, reason: "probe" }); }
    catch (e) { threw = e.message; }
    const after = await snapshot(ord.id);
    check(`  voiding it is refused by both, as it always was by one`,
      plan?.canVoid === false && !!threw,
      `plan ${plan?.canVoid} · engine ${threw ? "refused" : "allowed"}`);
    check(`  and the order is untouched`, same(before, after) && after.status === "POSTED",
      after.status);
  }

  // ---- and the consignor's stock is exactly where it was -----------------

  const [drawn] = await sql`select coalesce(sum(qty), 0)::float q from consignment_lot_consumption`;
  check("through all of it, the consignor's goods stay drawn down by what sold",
    n(drawn.q) === 20, `${n(drawn.q)}`);

  // Left as it was found. A consigned sale settles to the consignor with a
  // purchase invoice that credits payables and is no open item of its own, so
  // leaving them behind puts the payables control account out of step with
  // the purchase-invoice subledger for whatever suite runs next — which is
  // how this suite first appeared to break test-void.
  await sql.unsafe(`truncate table posting_attempt, consignment_lot_consumption,
    consignment_lot, document_history, fulfilment_link, order_closure, payment_allocation,
    stock_lot_adjustment, stock_lot_consumption, stock_lot, stock_movement,
    document_line, document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;
  await sql`delete from consignment_agreement_line where agreement_id in
    (select id from consignment_agreement where memo = 'void suite')`;
  await sql`delete from consignment_agreement where memo = 'void suite'`;

  console.log(bad === 0
    ? "\n  what the screen offers, the engine does\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
