// One submission, one posting.
//
//   ./node_modules/.bin/tsx scripts/test-idempotency.mjs
//
// A double-clicked button, a browser resending a request it could not
// confirm, a platform retry — each arrives as a second identical request, and
// every posting path here was free to turn it into a second document with its
// own stock movements and its own journal entry.
//
// Not to be confused with the same goods genuinely arriving twice, which is a
// fact and must stay postable. That is a deliberate second transaction and
// carries a key of its own; these tests check both halves.

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
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 4 });

const P = await import("../lib/posting.ts");
const { postOnce } = await import("../lib/idempotency.ts");

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
  const [item] = await sql`select id from item
     where company_id = ${co.id} and is_stocked and is_active order by code limit 1`;
  const [supp] = await sql`select id from business_partner
     where company_id = ${co.id} and is_supplier order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  await sql.unsafe(`truncate table posting_attempt, document_history, fulfilment_link,
    order_closure, payment_allocation, stock_lot_adjustment, stock_lot_consumption,
    stock_lot, stock_movement, document_line, document, journal_line, journal_entry
    restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);
  const receive = (key) => postOnce(co.id, key, () => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 10, unitCost: 100 }],
  }));

  const counts = async () => {
    const [d] = await sql`select count(*)::int n from document
       where company_id = ${co.id} and doc_type = 'GOODS_RECEIPT'`;
    const [s] = await sql`select coalesce(sum(qty), 0)::float q from stock_movement
       where company_id = ${co.id} and item_id = ${item.id}`;
    const [j] = await sql`select count(*)::int n from journal_entry
       where company_id = ${co.id}`;
    return { docs: d.n, stock: n(s.q), entries: j.n };
  };

  // ---- the same submission, sent twice -----------------------------------

  console.log("  the same submission, sent twice\n");

  const first = await receive("attempt-A");
  const one = await counts();
  const again = await receive("attempt-A");
  const two = await counts();

  check("the retry is handed the document the first one posted",
    again.id === first.id, `${again.docNo} vs ${first.docNo}`);
  check("  and says it was a repeat", again.repeated === true);
  check("  no second document", two.docs === one.docs, `${one.docs} → ${two.docs}`);
  check("  no second stock movement", two.stock === one.stock, `${one.stock} → ${two.stock}`);
  check("  no second journal entry", two.entries === one.entries,
    `${one.entries} → ${two.entries}`);

  // ---- a deliberate second transaction -----------------------------------

  console.log("\n  a deliberate second transaction\n");

  const other = await receive("attempt-B");
  const three = await counts();
  check("a new key posts a new document", other.id !== first.id, other.docNo);
  check("  and the goods really arrive", three.stock === one.stock + 10,
    `${one.stock} → ${three.stock}`);
  check("  with a journal entry of its own", three.entries === one.entries + 1);

  // ---- two requests at once ----------------------------------------------
  // The double-click that lands twice before the first has finished. Settled
  // by the database, not by hoping they do not overlap.

  console.log("\n  two requests at once\n");

  const before = await counts();
  const [a, b] = await Promise.all([receive("attempt-C"), receive("attempt-C")]);
  const after = await counts();

  check("both requests get the same document", a.id === b.id, `${a.docNo} / ${b.docNo}`);
  check("  exactly one was posted", after.docs === before.docs + 1,
    `${before.docs} → ${after.docs}`);
  check("  and the stock moved once", after.stock === before.stock + 10,
    `${before.stock} → ${after.stock}`);
  check("  one of them knows it was the repeat",
    (a.repeated === true) !== (b.repeated === true));

  // ---- a posting that was refused ----------------------------------------
  // A claim is not a posted document. If the posting fails, the key must be
  // free for the correction that follows.

  console.log("\n  a refusal does not burn the key\n");

  let refused = null;
  try {
    await postOnce(co.id, "attempt-D", () => P.postGoodsReceipt({
      companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
      lines: [{ itemId: item.id, qty: -5, unitCost: 100 }],
    }));
  } catch (e) { refused = e.message; }
  check("the refusal is passed through", !!refused, refused?.slice(0, 50));

  const retried = await postOnce(co.id, "attempt-D", () => P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    lines: [{ itemId: item.id, qty: 5, unitCost: 100 }],
  }));
  check("  and the same key may be used again once it is corrected", !!retried.id,
    retried.docNo);

  // ---- no key at all ------------------------------------------------------
  // Scripts, imports and the suites post directly. A missing key must never
  // become a silent refusal to post.

  console.log("\n  no key at all\n");

  const p1 = await receive(null);
  const p2 = await receive(undefined);
  check("two keyless postings are two documents", p1.id !== p2.id);

  console.log(bad === 0 ? "\n  one submission, one posting\n" : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
