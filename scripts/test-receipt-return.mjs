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
  if (!/—\s*DEV\b|\bDEV\b/i.test(String(co.name)) && process.env.ALLOW_DESTRUCTIVE_TESTS !== "1") {
    throw new Error(
      `This suite empties the transaction tables, and "${co.name}" does not look like a `
      + `disposable development database. Set ALLOW_DESTRUCTIVE_TESTS=1 to say you mean it.`);
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
  await sql.end();
}
