// Goods that arrived and went back.
//
//   ./node_modules/.bin/tsx scripts/test-receipt-return.mjs
//
// A supplier delivers goods meant for somebody else. They are booked in, seen
// to be wrong, and sent back the same day. No order, no bill, no payment —
// just a receipt and a return.
//
// That produced three wrong things at once. The return debited payables, so a
// supplier who had never invoiced anything appeared to owe us the value of the
// goods. The accrual the receipt raised stayed where it was, for stock we no
// longer had. And the receipt went on offering the returned units to be
// billed — on the screen, and in the engine, which would post the invoice.
//
// What a return gives back depends on what it is returned against: a bill
// means the supplier owes a credit; a receipt they never billed means the
// accrual comes off instead.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
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


// One suite at a time: these share a database and empty it, so a second
// runner is refused rather than left to collide. See scripts/test-lock.mjs.
await takeTestLock(sql, "test-receipt-return.mjs");
const P = await import("../lib/posting.ts");
const Q = await import("../lib/queries.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.01;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  /**
   * Two conditions, both required — not either one.
   *
   * The database has to look disposable: the company name carries a DEV
   * marker on the development branch and does not on the tester's or the
   * real books, which is the same thing CLAUDE.md tells a human to check
   * before trusting a screen. AND the person running it has to have said so
   * out loud, with ALLOW_DESTRUCTIVE_TESTS=1.
   *
   * Either alone is weaker than it looks. A name check alone empties
   * whatever a stale .env happens to point at. An override alone lets one
   * exported variable, set hours earlier for a different suite, turn a run
   * against the wrong branch into a truncate. Requiring both means an
   * accident has to happen twice, deliberately, to do any damage.
   */
  const disposable = /—\s*DEV\b|\bDEV\b/i.test(String(co.name));
  const optedIn = process.env.ALLOW_DESTRUCTIVE_TESTS === "1";
  if (!disposable || !optedIn) {
    throw new Error(
      `This suite empties the transaction tables of whatever it runs against. `
      + (!disposable
        ? `"${co.name}" does not look like a disposable development database — `
          + `point .env at one. `
        : `"${co.name}" looks disposable. `)
      + (!optedIn ? `Set ALLOW_DESTRUCTIVE_TESTS=1 to say you mean it.` : ``)
    );
  }
  const [loc] = await sql`select id from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  const [item] = await sql`select id, code from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  const wipe = () => sql.unsafe(`truncate table posting_attempt, document_history,
    fulfilment_link, order_closure, payment_allocation, stock_lot_adjustment,
    stock_lot_consumption, stock_lot, stock_movement, document_line, document,
    journal_line, journal_entry restart identity cascade`);
  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today };

  const role = async (r) => n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
     from journal_line jl join system_account s on s.account_id = jl.account_id and s.role = ${r}
     where jl.company_id = ${co.id}`)[0].v);
  const payables = async () => n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
     from journal_line jl join account a on a.id = jl.account_id
     where a.is_control and a.account_type = 'LIABILITY' and jl.company_id = ${co.id}`)[0].v);
  const inventory = async () => n((await sql`select coalesce(sum(jl.base_amount), 0)::float v
     from journal_line jl join account a on a.id = jl.account_id
     where a.code = '1040' and jl.company_id = ${co.id}`)[0].v);
  const onHand = async () => n((await sql`select coalesce(sum(qty), 0)::float q
     from stock_movement where company_id = ${co.id} and item_id = ${item.id}`)[0].q);
  const billable = async () => (await Q.getOpenGoodsReceipts(co.id))
    .reduce((s, r) => s + r.lines.reduce((x, l) => x + l.qty, 0), 0);

  const receiveAndReturn = async (qty) => {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const gr = await P.postGoodsReceipt({ ...base,
      lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
    const [gl] = await sql`select id from document_line where document_id = ${gr.id}`;
    const ret = await P.postPurchaseReturn({ ...base,
      sourceDocumentId: gr.id, memo: "Delivered to us by mistake",
      lines: [{ itemId: item.id, qty, unitPrice: 500, sourceLineId: gl.id }] });
    return { gr, gl, ret };
  };

  // ---- everything goes back -----------------------------------------------

  console.log("  100 arrived by mistake, all 100 went back\n");

  const all = await receiveAndReturn(100);
  check("no stock remains from that receipt", (await onHand()) === 0, `${await onHand()}`);
  check("  no inventory value either", near(await inventory(), 0), `${await inventory()}`);
  check("  the accrual it raised comes off with the goods",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);
  check("  and payables are untouched — nobody ever billed us",
    near(await payables(), 0), `${await payables()}`);
  check("  nothing is left to bill", (await billable()) === 0, `${await billable()}`);

  const [kept] = await sql`select status from document where id = ${all.gr.id}`;
  check("  the receipt is kept as it was", kept.status === "POSTED", kept.status);

  // The screen offering nothing is not enforcement.
  let billedAnyway = null;
  try {
    await P.postPurchaseInvoice({ ...base, dueDate: today, goodsReceiptId: all.gr.id,
      lines: [{ itemId: item.id, qty: 100, unitPrice: 500, sourceLineId: all.gl.id }] });
    billedAnyway = "posted";
  } catch (e) { billedAnyway = e.message; }
  check("  and the engine refuses to bill what went back",
    billedAnyway !== "posted" && /0 of .* left to bill/.test(billedAnyway),
    billedAnyway.slice(0, 64));

  // ---- part of it goes back -----------------------------------------------

  console.log("\n  40 of the 100 went back\n");

  const part = await receiveAndReturn(40);
  check("60 remain on the shelf", (await onHand()) === 60, `${await onHand()}`);
  check("  worth what 60 cost", near(await inventory(), 30000), `${await inventory()}`);
  check("  the accrual is for 60", near(await role("GRIR_CLEARING"), -30000),
    `${await role("GRIR_CLEARING")}`);
  check("  payables still untouched", near(await payables(), 0), `${await payables()}`);
  check("  and 60 are billable", (await billable()) === 60, `${await billable()}`);

  const billedPart = await P.postPurchaseInvoice({ ...base, dueDate: today,
    goodsReceiptId: part.gr.id,
    lines: [{ itemId: item.id, qty: 60, unitPrice: 500, sourceLineId: part.gl.id }] });
  check("  billing the remaining 60 is allowed", !!billedPart.docNo, billedPart.docNo);
  check("  which clears the rest of the accrual",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);
  check("  and now the supplier really is owed", near(await payables(), -30000),
    `${await payables()}`);


  // ---- billing and returning at the same moment ---------------------------
  //
  // Both read what the receipt still has before either has committed, so the
  // question is not which is refused but whether both can succeed. They
  // cannot: each takes the receipt's row before deciding, so the second waits
  // for the first and then sees what it did. Written as a forced interleaving
  // rather than a hopeful Promise.all, which proves nothing when one happens
  // to finish first.

  console.log("\n  billing and returning at the same moment\n");

  for (const [first, second] of [["bill", "return"], ["return", "bill"]]) {
    await wipe();
    await sql`update number_series set next_value = 1`;
    const rec = await P.postGoodsReceipt({ ...base,
      lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
    const [rl] = await sql`select id from document_line where document_id = ${rec.id}`;

    const run = {
      bill: (tx) => P.postPurchaseInvoice({ ...base, dueDate: today, goodsReceiptId: rec.id,
        lines: [{ itemId: item.id, qty: 100, unitPrice: 500, sourceLineId: rl.id }] }, tx),
      return: (tx) => P.postPurchaseReturn({ ...base, sourceDocumentId: rec.id,
        lines: [{ itemId: item.id, qty: 100, unitPrice: 500, sourceLineId: rl.id }] }, tx),
    };

    let latecomer = null;
    await sql.begin(async (tx) => {
      await run[first](tx);                    // held open, not yet committed
      latecomer = run[second](undefined);      // its own connection — must wait
      await new Promise((r) => setTimeout(r, 400));
    });

    let refused = null;
    try { await latecomer; } catch (e) { refused = e.message; }

    const [docs] = await sql`select count(*)::int n from document
       where company_id = ${co.id} and doc_type in ('PURCHASE_INVOICE', 'PURCHASE_RETURN')`;
    check(`${first} first: the ${second} arriving mid-flight is refused`, !!refused,
      refused?.slice(0, 58) ?? "it posted too");
    check(`  and only one of them exists`, docs.n === 1, `${docs.n}`);
  }

  // ---- a receipt that has already been billed ------------------------------

  console.log("\n  a receipt the supplier has already billed\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const billedGr = await P.postGoodsReceipt({ ...base,
    lines: [{ itemId: item.id, qty: 20, unitCost: 100 }] });
  const [bgl] = await sql`select id from document_line where document_id = ${billedGr.id}`;
  const bill = await P.postPurchaseInvoice({ ...base, dueDate: today, goodsReceiptId: billedGr.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: bgl.id }] });

  let refused = null;
  try {
    await P.postPurchaseReturn({ ...base, sourceDocumentId: billedGr.id,
      lines: [{ itemId: item.id, qty: 20, unitPrice: 100, sourceLineId: bgl.id }] });
  } catch (e) { refused = e.message; }

  check("returning against the receipt is refused once it has been billed", !!refused,
    refused?.slice(0, 70));
  check("  and the refusal names the bill to return against",
    !!refused && refused.includes(bill.docNo), bill.docNo);

  // Against the bill itself, it is an ordinary credit: payables come down.
  const payablesBefore = await payables();
  await P.postPurchaseReturn({ ...base, sourceDocumentId: bill.id,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 100 }] });
  check("  returning against the bill credits the supplier instead",
    near((await payables()) - payablesBefore, 2000),
    `payables moved ${(await payables()) - payablesBefore}`);

  // ---- the price on the form cannot leave the accrual behind --------------
  //
  // The form offered an editable price seeded from the item's next_cost, and
  // the engine debited GR/IR by what was typed. Return a hundred units that
  // arrived at 500 while 600 is sitting in the box and GR/IR came off by
  // 60,000 against an accrual of 50,000 — a 10,000 debit left standing for
  // goods that had gone back, with no quantity remaining to explain it and no
  // invoice that would ever clear it.

  console.log("\n  the price is the receipt's, not the typist's\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const pricedGr = await P.postGoodsReceipt({ ...base,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  const [pgl] = await sql`select id from document_line where document_id = ${pricedGr.id}`;
  check("the receipt accrued 100 x 500", near(await role("GRIR_CLEARING"), -50000),
    `${await role("GRIR_CLEARING")}`);

  const overpriced = await P.postPurchaseReturn({ ...base, sourceDocumentId: pricedGr.id,
    memo: "all of it back, priced wrong on the form",
    lines: [{ itemId: item.id, qty: 100, unitPrice: 600, sourceLineId: pgl.id }] });

  check("returning all 100 at a typed 600 still clears the accrual to nothing",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);
  check("  the return is valued at what arrived, not what was typed",
    near((await sql`select gross_total from document where id = ${overpriced.id}`)[0].gross_total,
      50000),
    `${n((await sql`select gross_total from document where id = ${overpriced.id}`)[0].gross_total)}`);
  check("  and its line carries the receipt's rate",
    near((await sql`select unit_price from document_line
      where document_id = ${overpriced.id}`)[0].unit_price, 500));
  check("  payables are untouched — nobody billed us", near(await payables(), 0),
    `${await payables()}`);
  check("  no stock left", (await onHand()) === 0, `${await onHand()}`);
  check("  and no inventory value", near(await inventory(), 0), `${await inventory()}`);

  // Half of it, at a wrong price, leaves exactly half the accrual.
  await wipe();
  await sql`update number_series set next_value = 1`;
  const halfGr = await P.postGoodsReceipt({ ...base,
    lines: [{ itemId: item.id, qty: 100, unitCost: 500 }] });
  const [hgl] = await sql`select id from document_line where document_id = ${halfGr.id}`;
  await P.postPurchaseReturn({ ...base, sourceDocumentId: halfGr.id,
    lines: [{ itemId: item.id, qty: 40, unitPrice: 1, sourceLineId: hgl.id }] });
  check("40 back at a typed 1 leaves the accrual for the 60 still here",
    near(await role("GRIR_CLEARING"), -30000), `${await role("GRIR_CLEARING")}`);

  // ---- one item, two costs ------------------------------------------------
  //
  // Ten in at 100 and ten more at 200 average 150, and an average is right
  // only for the whole receipt. Return the first ten and an average takes
  // 1,500 off an accrual that held 1,000 for them — while the billable-
  // quantity matcher, which draws in line order, goes on believing the 100s
  // left and the 200s are still here. The price and the matcher have to be
  // the same rule, not two rules that happen to agree on round numbers.

  console.log("\n  one item, received twice at different costs\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const twoCost = await P.postGoodsReceipt({ ...base,
    lines: [
      { itemId: item.id, qty: 10, unitCost: 100 },
      { itemId: item.id, qty: 10, unitCost: 200 },
    ] });
  check("the receipt accrued 1,000 + 2,000", near(await role("GRIR_CLEARING"), -3000),
    `${await role("GRIR_CLEARING")}`);

  const firstTen = await P.postPurchaseReturn({ ...base, sourceDocumentId: twoCost.id,
    memo: "the first ten back",
    lines: [{ itemId: item.id, qty: 10, unitPrice: 999 }] });

  check("returning the first 10 takes the first line's 1,000, not an averaged 1,500",
    near((await sql`select gross_total from document where id = ${firstTen.id}`)[0].gross_total,
      1000),
    `${n((await sql`select gross_total from document where id = ${firstTen.id}`)[0].gross_total)}`);
  check("  so 2,000 of accrual remains — the ten that cost 200",
    near(await role("GRIR_CLEARING"), -2000), `${await role("GRIR_CLEARING")}`);
  check("  and 10 are still billable", (await billable()) === 10, `${await billable()}`);

  // And the bill for what is left must agree: 10 at 200, not 10 at 150.
  const restBill = await P.postPurchaseInvoice({ ...base, dueDate: today,
    goodsReceiptId: twoCost.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 200 }] });
  check("  billing the remaining 10 at 200 clears the accrual exactly",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);
  check("  and the supplier is owed 2,000 for them", near(await payables(), -2000),
    `${await payables()}`);
  check("  the bill exists", !!restBill.docNo, restBill.docNo);

  // The second return picks up where the first left off.
  await wipe();
  await sql`update number_series set next_value = 1`;
  const twoCost2 = await P.postGoodsReceipt({ ...base,
    lines: [
      { itemId: item.id, qty: 10, unitCost: 100 },
      { itemId: item.id, qty: 10, unitCost: 200 },
    ] });
  await P.postPurchaseReturn({ ...base, sourceDocumentId: twoCost2.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 0 }] });
  const secondTen = await P.postPurchaseReturn({ ...base, sourceDocumentId: twoCost2.id,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 0 }] });
  check("a second return of 10 draws the 200s, not the 100s again",
    near((await sql`select gross_total from document where id = ${secondTen.id}`)[0].gross_total,
      2000),
    `${n((await sql`select gross_total from document where id = ${secondTen.id}`)[0].gross_total)}`);
  check("  and between them they clear the whole accrual",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);
  check("  with nothing left to bill", (await billable()) === 0, `${await billable()}`);

  // Spanning both lines: 15 back is 10 at 100 plus 5 at 200.
  await wipe();
  await sql`update number_series set next_value = 1`;
  const twoCost3 = await P.postGoodsReceipt({ ...base,
    lines: [
      { itemId: item.id, qty: 10, unitCost: 100 },
      { itemId: item.id, qty: 10, unitCost: 200 },
    ] });
  const spanning = await P.postPurchaseReturn({ ...base, sourceDocumentId: twoCost3.id,
    lines: [{ itemId: item.id, qty: 15, unitPrice: 0 }] });
  check("15 back spans both lines: 10 x 100 + 5 x 200 = 2,000",
    near((await sql`select gross_total from document where id = ${spanning.id}`)[0].gross_total,
      2000),
    `${n((await sql`select gross_total from document where id = ${spanning.id}`)[0].gross_total)}`);
  check("  leaving 1,000 for the five that cost 200",
    near(await role("GRIR_CLEARING"), -1000), `${await role("GRIR_CLEARING")}`);

  // ---- the bill can arrive before the goods -------------------------------
  //
  // A receipt and its invoice are paired by source_document_id, and which one
  // points at the other depends on which came first. The already-billed guard
  // asked only the receipt-first question, so goods received against a bill
  // that already existed went down the receipt-only path: the accrual came
  // off, and the payable the supplier had actually raised stayed standing in
  // full.

  console.log("\n  the bill arrived before the goods\n");

  await wipe();
  await sql`update number_series set next_value = 1`;
  const firstBill = await P.postPurchaseInvoice({ ...base, dueDate: today,
    lines: [{ itemId: item.id, qty: 50, unitPrice: 200 }] });
  const lateGoods = await P.postGoodsReceipt({ ...base, sourceDocumentId: firstBill.id,
    lines: [{ itemId: item.id, qty: 50, unitCost: 200 }] });
  check("the receipt names the invoice it answers",
    (await sql`select source_document_id from document where id = ${lateGoods.id}`)[0]
      .source_document_id === firstBill.id);
  const owedBefore = await payables();
  check("  and the supplier is owed for it", near(owedBefore, -10000), `${owedBefore}`);

  let billFirst = null;
  try {
    await P.postPurchaseReturn({ ...base, sourceDocumentId: lateGoods.id,
      lines: [{ itemId: item.id, qty: 50, unitPrice: 200 }] });
  } catch (e) { billFirst = e.message; }

  check("returning against those goods is refused too — they were billed first",
    !!billFirst, billFirst?.slice(0, 70));
  check("  and the refusal names the bill", !!billFirst && billFirst.includes(firstBill.docNo),
    firstBill.docNo);
  check("  nothing moved: the payable still stands in full",
    near(await payables(), owedBefore), `${await payables()}`);
  check("  and the accrual is still square",
    near(await role("GRIR_CLEARING"), 0), `${await role("GRIR_CLEARING")}`);

  await wipe();
  await sql`update number_series set next_value = 1`;

  console.log(bad === 0
    ? "\n  what goes back, goes back where it came from\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
