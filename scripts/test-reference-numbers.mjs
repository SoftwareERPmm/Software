// Reference numbers: Type + Date + a sequence that restarts daily.
//
//   npx tsx scripts/test-reference-numbers.mjs
//
// Numbering has broken this system before — the fiscal-year collision in
// 0025 stopped every posting — so the things worth asserting are not that a
// number looks right, but that it cannot repeat, cannot skip, and cannot
// depend on which day the test happens to run.
//
// Writes documents. Run against a scratch database.

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

const { sql } = await import("../lib/db.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  for (let i = 1; ; i++) {
    try { await sql`select 1`; break; }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const D = "2026-09-01";                       // the customer's own example date
  const next = async (type, dir = null) =>
    (await sql`select fn_next_document_no(${co.id}, ${type}, ${D}::date, ${dir}) as no`)[0].no;

  // ---- the customer's table, verbatim -------------------------------------
  console.log("  the scheme as specified\n");
  const spec = [
    ["CASH_VOUCHER",       "IN",  "R20260901001",   "Cash Received"],
    ["CUSTOMER_RECEIPT",   null,  "CR20260901001",  "Customer Received"],
    ["CASH_VOUCHER",       "OUT", "P20260901001",   "Cash Payment"],
    ["SUPPLIER_PAYMENT",   null,  "CP20260901001",  "Supplier Payment"],
    ["JOURNAL_VOUCHER",    null,  "J20260901001",   "Journal"],
    ["SALES_INVOICE",      null,  "DS20260901001",  "Direct Sales"],
    ["SALES_RETURN",       null,  "SR20260901001",  "Sales Return"],
    ["PURCHASE_INVOICE",   null,  "DP20260901001",  "Direct Purchase"],
    ["PURCHASE_RETURN",    null,  "PR20260901001",  "Purchase Return"],
    ["STOCK_TRANSFER",     null,  "ST20260901001",  "Stock Transfer"],
    ["GOODS_RECEIPT",      null,  "STR20260901001", "Stock Received"],
    ["DELIVERY",           null,  "SI20260901001",  "Stock Issued"],
    ["STOCK_ADJUSTMENT",   null,  "SAJ20260901001", "Stock Adjustment"],
  ];
  for (const [type, dir, want, label] of spec) {
    const got = await next(type, dir);
    check(`${label.padEnd(18)} ${want}`, got === want, got === want ? "" : `got ${got}`);
  }

  // ---- the six that were not in the table ---------------------------------
  console.log("\n  the rest, same shape\n");
  for (const [type, dir, want] of [
    ["PURCHASE_ORDER", null, "PO20260901001"],
    ["SALES_ORDER", null, "SO20260901001"],
    ["BANK_VOUCHER", "IN", "BR20260901001"],
    ["BANK_VOUCHER", "OUT", "BP20260901001"],
    ["CASH_TRANSFER", null, "CT20260901001"],
    ["OPENING_BALANCE", null, "OB20260901001"],
    ["CONSIGNMENT_RECEIPT", null, "CNR20260901001"],
  ]) {
    const got = await next(type, dir);
    check(`${type.padEnd(20)} ${want}`, got === want, got === want ? "" : `got ${got}`);
  }

  // ---- no two prefixes collide --------------------------------------------
  // A journal voucher and a journal entry would both have been "J" if the
  // mapping were taken literally, and would then hand out the same number.
  {
    const types = [...spec.map((r) => r[0]), "PURCHASE_ORDER", "SALES_ORDER",
                   "BANK_VOUCHER", "CASH_TRANSFER", "OPENING_BALANCE",
                   "CONSIGNMENT_RECEIPT", "JOURNAL"];
    const seen = new Map();
    let clash = null;
    for (const t of new Set(types)) {
      for (const d of ["IN", "OUT", null]) {
        const [{ p }] = await sql`select fn_document_prefix(${t}, ${d}) as p`;
        const key = `${p}|${d ?? ""}`;
        if (seen.has(key) && seen.get(key) !== t) clash = `${p} used by ${seen.get(key)} and ${t}`;
        seen.set(key, t);
      }
    }
    check("no two document types share a prefix", clash === null, clash ?? "");
  }

  // ---- the sequence -------------------------------------------------------
  console.log("\n  counting\n");
  const a = await next("SALES_INVOICE");
  const b = await next("SALES_INVOICE");
  check("the count runs on within a day", a.endsWith("002") && b.endsWith("003"), `${a}, ${b}`);

  const other = await next("SALES_INVOICE", null);
  const nextDay = (await sql`
    select fn_next_document_no(${co.id}, ${"SALES_INVOICE"}, ${"2026-09-02"}::date, null) as no`)[0].no;
  check("and restarts the next day", nextDay === "DS20260902001", nextDay);
  check("without disturbing the first day", other.endsWith("004"), other);

  // Cash in and cash out are one document type. If they shared a counter,
  // R and P would interleave and neither would read as a sequence.
  const r2 = await next("CASH_VOUCHER", "IN");
  const p2 = await next("CASH_VOUCHER", "OUT");
  check("money in and money out count separately",
    r2 === "R20260901002" && p2 === "P20260901002", `${r2}, ${p2}`);

  // ---- peek agrees with what posting will give ----------------------------
  const peek = (await sql`
    select fn_peek_document_no(${co.id}, ${"SALES_INVOICE"}, ${D}::date, null) as no`)[0].no;
  const actual = await next("SALES_INVOICE");
  check("peek shows the number the next document actually gets",
    peek === actual, `peeked ${peek}, got ${actual}`);

  // ---- posting for real ---------------------------------------------------
  console.log("\n  posting a real voucher\n");
  {
    const { postCashVoucher } = await import("../lib/posting.ts");
    const [cash] = await sql`
      select id from account where company_id = ${co.id} and is_cash_account and is_active limit 1`;
    const [income] = await sql`
      select id from account where company_id = ${co.id} and account_type = ${"REVENUE"}
        and is_postable and is_active limit 1`;
    const today = new Date().toISOString().slice(0, 10);

    const rec = await postCashVoucher({
      companyId: co.id, docDate: today,
      lines: [{ accountId: cash.id, amount: 150000 }, { accountId: income.id, amount: -150000 }],
    });
    check("a cash receipt is numbered R and recorded as money in",
      rec.docNo.startsWith("R" + today.replace(/-/g, "")), rec.docNo);
    const [recDoc] = await sql`select voucher_direction from document where id = ${rec.id}`;
    check("  and its direction is stored, not left to be re-derived",
      recDoc.voucher_direction === "IN", String(recDoc.voucher_direction));

    const pay = await postCashVoucher({
      companyId: co.id, docDate: today,
      lines: [{ accountId: cash.id, amount: -80000 }, { accountId: income.id, amount: 80000 }],
    });
    check("a cash payment is numbered P and recorded as money out",
      pay.docNo.startsWith("P" + today.replace(/-/g, "")), pay.docNo);
    const [payDoc] = await sql`select voucher_direction from document where id = ${pay.id}`;
    check("  and its direction too", payDoc.voucher_direction === "OUT", String(payDoc.voucher_direction));
  }

  // ---- nothing repeats ----------------------------------------------------
  const dupes = await sql`
    select doc_no, count(*)::int n from document
     where company_id = ${co.id} group by doc_no having count(*) > 1`;
  check("no document number is used twice", dupes.length === 0,
    dupes.map((d) => d.doc_no).join(", "));

  const entryDupes = await sql`
    select entry_no, count(*)::int n from journal_entry
     where company_id = ${co.id} group by entry_no having count(*) > 1`;
  check("no journal entry number is used twice", entryDupes.length === 0,
    entryDupes.map((d) => d.entry_no).join(", "));

  console.log(`\n  ${failures === 0 ? "all reference number tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
