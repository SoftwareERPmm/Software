// Two postings taking the same items in opposite order must not deadlock.
//
//   ALLOW_DESTRUCTIVE_TESTS=1 npx tsx scripts/test-stock-lock-order.mjs
//
// A delivery of X then Y, a transfer of Y then X and an adjustment of Y then
// X, all at once. Each queues on a different number series, so nothing
// serialises them before they reach the stock. Locking items as each line
// came up let one hold X while waiting for Y and another hold Y while
// waiting for X — Postgres cancels one, and somebody's posting fails.
// lockStockInOrder takes every item up front in one global order, so the
// three run one after another on the stock and all of them post.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
import { resetTransactions } from "./test-reset.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const { sql } = await import("../lib/db.ts");
await takeTestLock(sql, "test-stock-lock-order.mjs");
const P = await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const [co] = await sql`select id from company order by created_at limit 1`;
  await resetTransactions(sql);
  const locs = await sql`
    select id from location where company_id = ${co.id} and is_stock_location order by code limit 2`;
  if (locs.length < 2) throw new Error("Needs two stock locations");
  const [A, B] = locs.map((l) => l.id);
  const [grp] = await sql`select id from item_group where company_id = ${co.id} limit 1`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const stamp = Date.now().toString().slice(-6);
  const item = async (tag) => (await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code, is_stocked)
    values (${co.id}, ${grp.id}, ${tag + stamp}, ${"Lock probe " + tag}, ${uom.id}, ${tag + stamp}, true)
    returning id`)[0].id;
  const X = await item("lx"), Y = await item("ly");
  const party = async (code, flag) => (await sql`
    insert into business_partner (company_id, code, name, ${sql(flag)})
    values (${co.id}, ${code + stamp}, ${code}, true) returning id`)[0].id;
  const supp = await party("LKS", "is_supplier");
  const cust = await party("LKC", "is_customer");
  const DAY = (await sql`select to_char(current_date,'YYYY-MM-DD') as d`)[0].d;

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp, locationId: A, docDate: DAY,
    lines: [{ itemId: X, qty: 100, unitCost: 10 }, { itemId: Y, qty: 100, unitCost: 20 }] });

  console.log("\n  three postings at once, items in opposite orders\n");
  const ROUNDS = 6;
  const errors = [];
  for (let r = 0; r < ROUNDS; r++) {
    const results = await Promise.allSettled([
      P.postDelivery({ companyId: co.id, partnerId: cust, locationId: A, docDate: DAY,
        lines: [{ itemId: X, qty: 1, unitPrice: 50 }, { itemId: Y, qty: 1, unitPrice: 50 }] }),
      P.postStockTransfer({ companyId: co.id, fromLocationId: A, toLocationId: B, docDate: DAY,
        lines: [{ itemId: Y, qty: 1 }, { itemId: X, qty: 1 }] }),
      P.postStockAdjustment({ companyId: co.id, locationId: A, docDate: DAY,
        lines: [{ itemId: Y, qty: -1 }, { itemId: X, qty: -1 }] }),
    ]);
    for (const x of results) if (x.status === "rejected") errors.push(x.reason);
  }
  const deadlocks = errors.filter((e) => e?.code === "40P01" || /deadlock/i.test(String(e?.message)));
  check("no posting was cancelled as a deadlock", deadlocks.length === 0,
    `${deadlocks.length} of ${ROUNDS * 3}`);
  check("and none failed for any other reason", errors.length === deadlocks.length,
    errors.filter((e) => !deadlocks.includes(e)).map((e) => String(e?.message).slice(0, 80)).join(" | "));

  const onHand = async (itemId, loc) => Number((await sql`
    select fn_qty_on_hand(${co.id}, ${itemId}, ${loc}) as q`)[0].q);
  const expectA = 100 - 3 * (ROUNDS - errors.length / 3);
  check(`each item at the source is down by every posting that succeeded`,
    (await onHand(X, A)) === expectA && (await onHand(Y, A)) === expectA,
    `X ${await onHand(X, A)} Y ${await onHand(Y, A)} expected ${expectA}`);
  check("and the transfers arrived", (await onHand(X, B)) === ROUNDS && (await onHand(Y, B)) === ROUNDS,
    `X ${await onHand(X, B)} Y ${await onHand(Y, B)}`);

  const [tb] = await sql`select coalesce(sum(base_amount),0)::float v from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(tb.v) < 0.005, `${tb.v}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
