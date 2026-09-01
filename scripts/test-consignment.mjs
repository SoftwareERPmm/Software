// Consignment receipts: custody without ownership.
//
//   node scripts/test-consignment.mjs
//
// Posts real documents and attacks the immutability of a document type that
// deliberately never gets a journal entry. Run against a scratch database.
//
// A consignment receipt is unusual in one specific way: journal_entry_id
// stays null forever, by design, because custody changed and value did not.
// Every other document type's immutability trigger reads a null
// journal_entry_id as "posting is still assembling this row" — true for
// them, since they all get one moments later, and permanently false for
// this one. Migration 0028 amended fn_document_immutable and
// fn_document_line_immutable to know the difference; this suite is what
// proves the amendment actually closes the gap rather than only looking like
// it does.

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

const { postConsignmentReceipt } = await import("../lib/posting.ts");

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

  let [item] = await sql`
    select id, code from item where company_id = ${co.id} and is_stocked order by code limit 1`;
  if (!item) {
    let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
    if (!grp) [grp] = await sql`insert into item_group (company_id, segment, code, name)
      values (${co.id}, 'CN', 'x', 'Consignment Test') returning id`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
    [item] = await sql`insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '001', 'x', 'Consignment Test Item', ${uom.id}) returning id, code`;
  }
  let [otherItem] = await sql`
    select id from item where company_id = ${co.id} and is_stocked and id <> ${item.id} limit 1`;
  if (!otherItem) {
    const [grp] = await sql`select id from item_group where company_id = ${co.id} limit 1`;
    const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
    [otherItem] = await sql`insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
      values (${co.id}, ${grp.id}, '002', 'y', 'Not On Agreement', ${uom.id}) returning id`;
  }

  const [consignor] = await sql`insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${'CN-' + Date.now().toString().slice(-6)}, 'Test Consignor', true) returning id`;
  const [customerOnly] = await sql`insert into business_partner (company_id, code, name, is_customer)
    values (${co.id}, ${'CO-' + Date.now().toString().slice(-6)}, 'Customer Only', true) returning id`;

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, locationId: loc.id, docDate: today };

  console.log(`\n  ${co.name}  ·  item ${item.code}\n`);

  // ---- Guards before an agreement exists ----------------------------------

  check("a receipt against a partner with no agreement is refused",
    (await refused(() => postConsignmentReceipt({ ...base, partnerId: consignor.id,
      lines: [{ itemId: item.id, qty: 10, agreementLineId: "00000000-0000-0000-0000-000000000000" }] }))) !== null);

  check("an agreement cannot be made with a non-supplier",
    (await refused(() => sql`insert into consignment_agreement (company_id, partner_id)
      values (${co.id}, ${customerOnly.id})`)) !== null);

  const [agreement] = await sql`insert into consignment_agreement (company_id, partner_id, memo)
    values (${co.id}, ${consignor.id}, 'Test terms') returning id`;
  const [line] = await sql`insert into consignment_agreement_line
      (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${agreement.id}, ${item.id}, 'PERCENTAGE', 80) returning id`;

  check("a percentage over 100 is refused",
    (await refused(() => sql`insert into consignment_agreement_line
      (company_id, agreement_id, item_id, pricing_method, pricing_value)
      values (${co.id}, ${agreement.id}, ${otherItem.id}, 'PERCENTAGE', 150)`)) !== null);

  // ---- The receipt itself --------------------------------------------------

  console.log("");
  check("receiving an item not on the agreement is refused",
    (await refused(() => postConsignmentReceipt({ ...base, partnerId: consignor.id,
      lines: [{ itemId: otherItem.id, qty: 5, agreementLineId: line.id }] }))) !== null);

  const cr = await postConsignmentReceipt({ ...base, partnerId: consignor.id,
    lines: [{ itemId: item.id, qty: 100, agreementLineId: line.id }] });
  console.log(`  posted ${cr.docNo}`);

  check("the receipt carries no journal entry", (await sql`
    select journal_entry_id from document where id = ${cr.id}`)[0].journal_entry_id === null);
  check("the ledger is completely unaffected",
    n((await sql`select coalesce(sum(balance),0) as v from v_trial_balance`)[0].v) === 0);
  const lot = await sql`select qty_received, pricing_method, pricing_value
    from consignment_lot where receipt_document_id = ${cr.id}`;
  check("a consignment lot was created for the received quantity",
    lot.length === 1 && n(lot[0].qty_received) === 100, `${lot.length} lot(s)`);
  check("it carries the agreement line's rate, frozen at receipt",
    lot[0]?.pricing_method === "PERCENTAGE" && n(lot[0].pricing_value) === 80);

  // ---- The gap this suite exists to catch ----------------------------------

  console.log("\n  attacking the immutability gap a null journal_entry_id used to leave open\n");
  check("the receipt's total cannot be edited after posting",
    (await refused(() => sql`update document set gross_total = 999 where id = ${cr.id}`))?.includes("posted"));
  check("the posted receipt cannot be deleted",
    (await refused(() => sql`delete from document where id = ${cr.id}`))?.includes("POSTED"));
  check("its line cannot be edited",
    (await refused(() => sql`update document_line set base_qty = 1 where document_id = ${cr.id}`))?.includes("posted"));
  check("its line cannot be deleted",
    (await refused(() => sql`delete from document_line where document_id = ${cr.id}`))?.includes("posted"));
  check("the consignment lot cannot be edited",
    (await refused(() => sql`update consignment_lot set qty_received = 1
      where receipt_document_id = ${cr.id}`))?.includes("append-only"));
  check("the consignment lot cannot be deleted",
    (await refused(() => sql`delete from consignment_lot where receipt_document_id = ${cr.id}`))?.includes("append-only"));

  // ---- Closed period --------------------------------------------------------

  console.log("");
  const [period] = await sql`select id, status from fiscal_period
    where company_id = ${co.id} and ${today}::date between start_date and end_date`;
  if (period) {
    await sql`update fiscal_period set status = 'CLOSED' where id = ${period.id}`;
    check("a receipt cannot post into a closed period, even with no journal entry to guard it",
      (await refused(() => postConsignmentReceipt({ ...base, partnerId: consignor.id,
        lines: [{ itemId: item.id, qty: 5, agreementLineId: line.id }] })))?.includes("CLOSED"));
    await sql`update fiscal_period set status = ${period.status} where id = ${period.id}`;
    check("and posts again once reopened",
      (await refused(() => postConsignmentReceipt({ ...base, partnerId: consignor.id,
        lines: [{ itemId: item.id, qty: 5, agreementLineId: line.id }] }))) === null);
  } else {
    check("a fiscal period covers today", false, "none found — cannot test the lock");
  }

  // ---- Invariants -----------------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("trial balance still nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);

  console.log(failures === 0 ? "\n  all consignment tests pass\n" : `\n  ${failures} failed\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  failures++;
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
