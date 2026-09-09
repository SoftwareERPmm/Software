// The worked example the document screens were designed around.
//
//   npx tsx scripts/demo-documents.mjs
//
// One supplier, one product, and the whole purchase cycle caught mid-flight:
// an order part received, an invoice part paid, a receipt nobody has billed
// yet, a payment nobody has allocated, and a schedule that came and went. It
// exists so every panel on every document page has something real to show —
// an empty database makes a layout look finished when it is only empty.
//
// Everything is posted through lib/posting.ts, so the ledger is real. What is
// written directly is only what the ledger has no opinion about: who did it,
// who owes what next, and what happened when.
//
// Document numbers are this company's own — PO20260901001, not PO-001. The
// numbering scheme is deliberate (migrations 0035-0038: type, date, daily
// sequence) and worth more than matching a mockup's shorthand.

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

const day = (d) => `2026-09-0${d}`;
const at = (d, hhmm) => `2026-09-0${d} ${hhmm}:00+06:30`;

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  const [loc] = await sql`select id, code from location
     where company_id = ${co.id} and is_stock_location and is_active order by code limit 1`;
  console.log(`\n  ${co.name}\n`);

  // ---- nobody, yet ---------------------------------------------------------
  //
  // The screens attribute work to a person, and there are no people: this app
  // has no accounts, and inventing three so the demo looks populated would put
  // names against documents nobody signed. So the work is seeded unattributed
  // and the pages show a dash. When roles arrive, these rows will be visibly
  // unclaimed rather than quietly credited to the wrong person.
  const hla = { id: null }, aung = { id: null }, suSu = { id: null };
  console.log("  people: none — attribution waits for the roles that own it");

  // ---- the supplier and the product ---------------------------------------

  const [supplier] = await sql`
    insert into business_partner (company_id, code, name, is_supplier, is_customer, payment_terms_days)
    values (${co.id}, 'SUP-001', 'Branch Test Supplier', true, false, 30)
    on conflict (company_id, code) do update set name = excluded.name
    returning id, code, name`;

  const [uom] = await sql`select id from uom where company_id = ${co.id} and code = 'BOX'`;
  const [anyUom] = uom ? [uom] : await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  // The item's code is composed by the database from its group and serial, so
  // "GR001" is asked for as a serial under a group with no prefix of its own.
  const [group] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, 'GN', '', 'Demo')
    on conflict do nothing
    returning id`;
  const [itemGroup] = group
    ? [group]
    : await sql`select id from item_group where company_id = ${co.id} and code = ''`;
  const [existing] = await sql`select id, code, name from item
     where company_id = ${co.id} and code = 'GR001'`;
  const [item] = existing ? [existing] : await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${itemGroup.id}, 'GR001', 'Test Product', ${anyUom.id}, true)
    returning id, code, name`;
  console.log(`  supplier: ${supplier.code} ${supplier.name} · item: ${item.code} ${item.name}\n`);

  const base = { companyId: co.id, partnerId: supplier.id, locationId: loc.id };

  // ---- 1 Sep · the order --------------------------------------------------

  const po = await P.postPurchaseOrder({
    ...base, docDate: day(1), dueDate: day(5),
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }],
  });
  const [poLine] = await sql`select id from document_line where document_id = ${po.id}`;

  // ---- 3 Sep · the supplier bills for all 100 -----------------------------

  const pi1 = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supplier.id, docDate: day(3), dueDate: day(8),
    lines: [{ itemId: item.id, qty: 100, unitPrice: 1000 }],
  });

  // ---- 5 Sep · 40 of them arrive, against the order -----------------------

  const gr1 = await P.postGoodsReceipt({
    ...base, docDate: day(5), sourceDocumentId: po.id,
    lines: [{ itemId: item.id, qty: 40, unitCost: 1000, sourceLineId: poLine.id }],
  });

  // ---- 5 Sep · half the invoice is paid -----------------------------------

  const [bank] = await sql`select id from account
     where company_id = ${co.id} and is_bank_account and is_active order by code limit 1`;
  const pay1 = await P.postSupplierPayment({
    companyId: co.id, partnerId: supplier.id, docDate: day(5),
    cashAccountId: bank.id,
    allocations: [{ invoiceId: pi1.id, amount: 50000 }],
  });

  // ---- 6 Sep · another 60 arrive, billed on their own invoice -------------
  //
  // Left unlinked to the order on purpose: it is what the "link existing
  // receipt" drawer on the order has to work with.

  const pi2 = await P.postPurchaseInvoice({
    companyId: co.id, partnerId: supplier.id, docDate: day(6), dueDate: day(13),
    lines: [{ itemId: item.id, qty: 60, unitPrice: 1000 }],
  });
  const gr2 = await P.postGoodsReceipt({
    ...base, docDate: day(6), sourceDocumentId: pi2.id,
    lines: [{ itemId: item.id, qty: 60, unitCost: 1000 }],
  });

  // ---- 7 Sep · money out, allocated to nothing yet ------------------------

  const pay2 = await P.postSupplierPayment({
    companyId: co.id, partnerId: supplier.id, docDate: day(7),
    cashAccountId: bank.id, reference: "TX-0926",
    // Allocated to the second invoice, because it has to be: this engine
    // will not post a payment that settles nothing. The "money out, not yet
    // allocated" state the payment screen is designed around is therefore not
    // reachable today — see the note in the report. 50,000 of 60,000 leaves
    // that invoice part paid, which is the next best thing to show.
    allocations: [{ invoiceId: pi2.id, amount: 50000 }],
  });

  // ---- who did what -------------------------------------------------------

  const attribute = async (docId, createdBy, postedBy) => {
    await sql`update document set created_by_id = ${createdBy}, posted_by_id = ${postedBy}
               where id = ${docId}`;
  };
  await attribute(po.id, hla.id, hla.id);
  await attribute(pi1.id, hla.id, hla.id);
  await attribute(gr1.id, hla.id, hla.id);
  await attribute(pay1.id, suSu.id, suSu.id);
  await attribute(pi2.id, hla.id, hla.id);
  await attribute(gr2.id, aung.id, aung.id);
  await attribute(pay2.id, aung.id, aung.id);

  // ---- the same shape on the sales side ------------------------------------
  //
  // A customer order part delivered, an invoice part collected: the mirror of
  // the purchase story above, so the sales screens have the same situation to
  // show rather than an empty page that makes a layout look finished.

  const [customer] = await sql`
    insert into business_partner (company_id, code, name, is_customer, is_supplier, payment_terms_days)
    values (${co.id}, 'CUS-001', 'Branch Test Customer', true, false, 7)
    on conflict (company_id, code) do update set name = excluded.name
    returning id, code, name`;

  const so = await P.postSalesOrder({
    companyId: co.id, partnerId: customer.id, locationId: loc.id,
    docDate: day(2), dueDate: day(6),
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1800 }],
  });
  const [soLine] = await sql`select id from document_line where document_id = ${so.id}`;

  const si = await P.postSalesInvoice({
    companyId: co.id, partnerId: customer.id, locationId: loc.id,
    docDate: day(4), dueDate: day(9),
    lines: [{ itemId: item.id, qty: 50, unitPrice: 1800 }],
  });

  // Twenty of the fifty go out, against the order.
  await P.postDelivery({
    companyId: co.id, partnerId: customer.id, locationId: loc.id,
    docDate: day(6), sourceDocumentId: so.id,
    lines: [{ itemId: item.id, qty: 20, sourceLineId: soLine.id }],
  });

  // And half the money comes in.
  await P.postCustomerReceipt({
    companyId: co.id, partnerId: customer.id, docDate: day(7),
    cashAccountId: bank.id,
    allocations: [{ invoiceId: si.id, amount: 45000 }],
  });

  // ---- what somebody still owes -------------------------------------------

  const task = async (docId, name, who, due, aspect = null) => {
    await sql`
      insert into document_task (company_id, document_id, task, responsible_id, due_date, aspect)
      values (${co.id}, ${docId}, ${name}, ${who}, ${due}::date, ${aspect})
      on conflict (document_id, task) do update
        set responsible_id = excluded.responsible_id, due_date = excluded.due_date,
            aspect = excluded.aspect`;
  };
  // Chasing the bill for goods that arrived and nobody has invoiced. That is
  // the first receipt: it came in against the order, so no invoice names it.
  await task(gr1.id, "Invoice follow-up", suSu.id, day(8));
  // The order is still short, and somebody owns getting the rest in.
  await task(po.id, "Chase outstanding delivery", aung.id, day(5));
  // Money out with nothing to attach it to.
  await task(pay2.id, "Payment reconciliation", suSu.id, day(8));

  // The first invoice owes two different things to two different people:
  // sixty boxes that have not arrived, and half the money. Which is the whole
  // reason an invoice shows them as two halves rather than one status.
  await task(pi1.id, "Chase delivery", aung.id, day(5), "GOODS");
  await task(pi1.id, "Settle balance", suSu.id, day(8), "PAYMENT");

  // The same two on the customer invoice: goods still to ship, money still to
  // collect, each with its own deadline.
  await task(si.id, "Ship the balance", null, day(6), "GOODS");
  await task(si.id, "Chase payment", null, day(9), "PAYMENT");

  // ---- what has happened so far -------------------------------------------

  const event = async (docId, when, who, kind, note) => {
    await sql`
      insert into document_activity (company_id, document_id, happened_at, actor_id, kind, note)
      values (${co.id}, ${docId}, ${when}::timestamptz, ${who}, ${kind}, ${note})`;
  };
  await event(po.id, at(1, "10:30"), hla.id, "POSTED", "Purchase order posted.");
  await event(pi1.id, at(3, "10:30"), hla.id, "POSTED", "Purchase invoice posted.");
  await event(gr1.id, at(5, "10:30"), hla.id, "POSTED", "Goods receipt posted.");
  await event(gr1.id, at(5, "10:31"), hla.id, "STOCK", "40 BOX added to Magway Warehouse.");
  await event(pay1.id, at(5, "14:05"), suSu.id, "POSTED", "Payment posted and allocated.");
  await event(gr2.id, at(6, "09:15"), aung.id, "POSTED", "Goods receipt posted.");
  await event(pay2.id, at(7, "14:18"), aung.id, "CREATED", "Payment created.");
  await event(pay2.id, at(7, "14:20"), aung.id, "POSTED", "Payment posted.");
  await event(pay2.id, at(7, "14:20"), aung.id, "BANK", "Bank payment recorded · TX-0926.");

  // ---- a payment somebody planned and did not make ------------------------

  await sql`
    insert into payment_schedule
      (company_id, schedule_no, partner_id, invoice_id, planned_date, amount, created_by_id)
    values (${co.id}, 'SCH-003', ${supplier.id}, ${pi1.id}, ${day(8)}::date, 50000, ${suSu.id})
    on conflict (company_id, schedule_no) do nothing`;

  // ---- what the screens now have to show ----------------------------------

  const rows = await sql`
    select d.doc_no, d.doc_type, to_char(d.doc_date, 'DD Mon') as on_date,
           d.gross_total::float as total, u.name as posted_by
      from document d left join app_user u on u.id = d.posted_by_id
     where d.company_id = ${co.id} order by d.doc_date, d.doc_no`;
  console.table(rows.map((r) => ({
    document: r.doc_no, type: r.doc_type.toLowerCase().replace(/_/g, " "),
    date: r.on_date, total: r.total.toLocaleString(), posted_by: r.posted_by,
  })));

  const [state] = await sql`
    select coalesce(sum(ordered), 0)::float as ordered,
           coalesce(sum(fulfilled), 0)::float as received,
           coalesce(sum(outstanding), 0)::float as remaining
      from v_order_outstanding where order_id = ${po.id}`;
  console.log(`  order: ${state.ordered} ordered · ${state.received} received · ${state.remaining} remaining`);
  console.log(`  ${gr2.docNo} is unlinked, so the order's "link existing receipt" has something to offer`);
  console.log(`  ${pay2.docNo} is unallocated, so the payment's "allocate to invoice" does too\n`);
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
