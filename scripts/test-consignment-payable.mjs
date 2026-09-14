// Paying the consignor for what sold.
//
//   node scripts/test-consignment-payable.mjs
//
// Posts real documents. Run against a scratch database.
//
// Settlement already records the debt, as a real Purchase Invoice against the
// consignor (0029, reusing that doc_type rather than inventing a third one
// precisely so AP aging and the payment screens pick it up for free). What
// was never traced end to end is the half that matters to whoever has to pay
// it: that the settlement is visible and selectable on the Pay a supplier
// screen, that a part payment leaves the rest outstanding, and that the AP
// control account agrees with the payables subledger at every step.
//
// Nothing here posts a second liability. Every figure below is the one
// settlement being drawn down.

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

const { postConsignmentReceipt, postSaleWithDelivery, postSupplierPayment } =
  await import("../lib/posting.ts");

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
const head = (t) => console.log(`\n  ${t}\n`);

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
    values (${co.id}, 'CP', 'x', 'Consignment Payable Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;

  const stamp = Date.now().toString().slice(-6);
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, code)
    values (${co.id}, ${grp.id}, ${"cp" + stamp}, 'Consigned Shirt', ${uom.id}, ${"cp" + stamp})
    returning id, code`;

  const mkPartner = async (code, name, kind) => (await sql`
    insert into business_partner (company_id, code, name, ${sql(kind)})
    values (${co.id}, ${code + "-" + stamp}, ${name}, true) returning id, code, name`)[0];
  const consignor = await mkPartner("CONS", "Consignor Ltd", "is_supplier");
  const customer = await mkPartner("BUYER", "Retail Customer", "is_customer");

  const [till] = await sql`
    select id from account where company_id = ${co.id} and is_cash_account and is_active
     order by code limit 1`;

  const today = new Date().toISOString().slice(0, 10);
  const base = { companyId: co.id, locationId: loc.id, docDate: today };

  const [ag] = await sql`insert into consignment_agreement (company_id, partner_id)
    values (${co.id}, ${consignor.id}) returning id`;
  const [agLine] = await sql`insert into consignment_agreement_line
    (company_id, agreement_id, item_id, pricing_method, pricing_value)
    values (${co.id}, ${ag.id}, ${item.id}, 'PERCENTAGE', 80) returning id`;

  console.log(`\n  ${co.name}`);

  // The subledger and the control account, the way the invariant view reads
  // them. Kept as one function so every step below asks the same question.
  const apControl = async () => {
    const [r] = await sql`
      select coalesce(sum(jl.amount), 0) as v
        from journal_line jl
        join account a on a.id = jl.account_id
       where a.company_id = ${co.id}
         and a.id = fn_resolve_control_account(${co.id}, 'AP_CONTROL', null)`;
    return n(r?.v);
  };
  const apSubledger = async () => {
    const [r] = await sql`
      select coalesce(sum(outstanding), 0) as v from v_open_item
       where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE'`;
    return n(r?.v);
  };

  // What the Pay a supplier screen actually offers: getSettlementData("pay")
  // reads v_invoice_status, not v_open_item, and the supplier dropdown is
  // filtered to is_supplier. Both halves have to admit the settlement or it
  // is unreachable however correct the ledger is.
  const payableRows = async () => sql`
    select document_id, doc_no, partner_id, outstanding, payment_status
      from v_invoice_status
     where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE' and outstanding <> 0
     order by due_date nulls last, posting_date`;

  head("a consignment sale leaves the consignor owed 6,400");

  await postConsignmentReceipt({ ...base, partnerId: consignor.id,
    lines: [{ itemId: item.id, qty: 100, agreementLineId: agLine.id }] });

  // 20 sold at 400 = 8,000 to the customer; the consignor's 80% share is 6,400.
  const sale = await postSaleWithDelivery({ ...base, partnerId: customer.id, dueDate: null,
    lines: [{ itemId: item.id, qty: 20, unitPrice: 400, source: "CONSIGNMENT" }] });

  const [settlement] = await sql`
    select id, doc_no, gross_total, partner_id from document
     where source_document_id = ${sale.id} and doc_type = 'PURCHASE_INVOICE'`;
  check("the settlement exists and is billed to the consignor",
    !!settlement && settlement.partner_id === consignor.id, settlement?.doc_no);
  check("for 6,400", n(settlement?.gross_total) === 6400, `${n(settlement?.gross_total)}`);

  const settlementCount = async () => n((await sql`
    select count(*) as c from document
     where company_id = ${co.id} and doc_type = 'PURCHASE_INVOICE' and status = 'POSTED'`)[0]?.c);
  check("and it is the only purchase invoice — no second liability was raised",
    (await settlementCount()) === 1, `${await settlementCount()} purchase invoice(s)`);

  const outstandingOf = async () => n((await sql`
    select coalesce(outstanding, 0) as v from v_open_item where document_id = ${settlement.id}`)[0]?.v);

  check("outstanding settlement: 6,400", (await outstandingOf()) === 6400, `${await outstandingOf()}`);
  check("  AP control agrees with the payables subledger",
    Math.abs(await apControl()) === Math.abs(await apSubledger()),
    `control ${await apControl()} vs subledger ${await apSubledger()}`);

  head("it is visible and selectable on the Pay a supplier screen");

  const offered = await payableRows();
  check("the screen offers it", offered.some((r) => r.document_id === settlement.id),
    offered.map((r) => `${r.doc_no}:${n(r.outstanding)}`).join(" ") || "(nothing offered)");
  check("  at 6,400, marked OPEN",
    n(offered.find((r) => r.document_id === settlement.id)?.outstanding) === 6400 &&
    offered.find((r) => r.document_id === settlement.id)?.payment_status === "OPEN");
  const suppliers = await sql`
    select id from business_partner where company_id = ${co.id} and is_supplier and is_active`;
  check("  and the consignor is in the supplier list, so it can be reached",
    suppliers.some((s) => s.id === consignor.id));

  head("paying 2,000 leaves 4,400");

  const pay1 = await postSupplierPayment({ companyId: co.id, partnerId: consignor.id,
    docDate: today, cashAccountId: till.id,
    allocations: [{ invoiceId: settlement.id, amount: 2000 }] });
  check("the payment posted", !!pay1?.docNo, pay1?.docNo);
  check("outstanding settlement: 4,400", (await outstandingOf()) === 4400, `${await outstandingOf()}`);
  check("  the screen now shows it PARTIALLY_PAID",
    (await payableRows()).find((r) => r.document_id === settlement.id)?.payment_status
      === "PARTIALLY_PAID");
  check("  still one purchase invoice — paying did not raise another",
    (await settlementCount()) === 1);
  check("  AP control agrees with the payables subledger",
    Math.abs(await apControl()) === Math.abs(await apSubledger()),
    `control ${await apControl()} vs subledger ${await apSubledger()}`);

  head("paying the remaining 4,400 clears it");

  const pay2 = await postSupplierPayment({ companyId: co.id, partnerId: consignor.id,
    docDate: today, cashAccountId: till.id,
    allocations: [{ invoiceId: settlement.id, amount: 4400 }] });
  check("the payment posted", !!pay2?.docNo, pay2?.docNo);
  check("outstanding settlement: 0", (await outstandingOf()) === 0, `${await outstandingOf()}`);
  check("  it drops off the Pay a supplier screen",
    !(await payableRows()).some((r) => r.document_id === settlement.id));
  check("  the consignor owes nothing", (await apSubledger()) === 0, `${await apSubledger()}`);
  check("  AP control is flat too", (await apControl()) === 0, `${await apControl()}`);
  check("  and the settlement is still the only purchase invoice",
    (await settlementCount()) === 1);

  head("the books stand up on their own terms");

  const unbalanced = await sql`select * from v_check_unbalanced_entries`;
  check("no unbalanced journal entries", unbalanced.length === 0, `${unbalanced.length}`);
  const control = await sql`select * from v_check_control_reconciliation where abs(difference) > 0.005`;
  check("every control account reconciles", control.length === 0,
    control.map((r) => `${r.control}:${n(r.difference)}`).join(" "));
  const [tb] = await sql`select coalesce(sum(balance), 0) as total from v_trial_balance`;
  check("the trial balance is flat", Math.abs(n(tb?.total)) < 0.005, `${n(tb?.total)}`);

  console.log(`\n  ${failures === 0 ? "all checks passed" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
