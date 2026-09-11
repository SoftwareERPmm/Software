// An edit is a new version of the same document.
//
//   npx tsx scripts/test-document-versions.mjs
//
// The tester's example, exactly: an invoice for 10,000 corrected to 12,000.
// Afterwards the invoice says 12,000 and calls itself v2; the 10,000 version
// is still there as v1, superseded and read-only; the accounts show the
// correction rather than both figures; and the number on the customer's copy
// still finds the invoice.
//
// The rules underneath it are the ones that make it safe rather than merely
// convenient:
//
//   one live version of a number, ever
//   an edit is reversal and replacement in one transaction, or neither
//   what the void rules refuse, an edit refuses — settled money and moved
//     stock are corrected by their own documents, not by editing history
//   an order cannot be corrected below what has already been fulfilled

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

  await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
    payment_allocation, stock_lot_consumption, stock_lot, stock_movement,
    document_line, document, journal_line, journal_entry restart identity cascade`);
  await sql`update number_series set next_value = 1`;

  const today = new Date().toISOString().slice(0, 10);

  const versions = async (docNo) => sql`
    select version, status, gross_total::float as total,
           (superseded_by_document_id is not null) as superseded,
           (supersedes_document_id is not null) as replaces
      from document where doc_no = ${docNo} order by version`;

  // ---- an invoice, 10,000 corrected to 12,000 -----------------------------

  console.log("  a sales invoice for 10,000, corrected to 12,000\n");

  await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, lines: [{ itemId: item.id, qty: 100, unitCost: 400 }] });

  const inv = await P.postSalesInvoice({
    companyId: co.id, partnerId: cust.id, locationId: loc.id,
    docDate: today, dueDate: null, toDeliver: true,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }],
  });
  const before = await versions(inv.docNo);
  check("it posts as v1", before.length === 1 && before[0].version === 1,
    `${inv.docNo} v${before[0]?.version} · ${n(before[0]?.total).toLocaleString()}`);

  const amended = await P.amendInvoice({
    companyId: co.id, documentId: inv.id,
    reason: "agreed price was 1,200, not 1,000",
    invoice: {
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null, toDeliver: true,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1200 }],
    },
  });

  const after = await versions(inv.docNo);
  check("the number is unchanged", amended.docNo === inv.docNo, amended.docNo);
  check("  and it is now v2", amended.version === 2,
    `${n(amended.totalBefore).toLocaleString()} → ${n(amended.totalAfter).toLocaleString()}`);
  check("  two versions exist under that number", after.length === 2,
    after.map((v) => `v${v.version} ${v.status} ${n(v.total).toLocaleString()}`).join(" · "));

  const v1 = after.find((v) => v.version === 1);
  const v2 = after.find((v) => v.version === 2);
  check("  v1 is kept, superseded, and no longer standing",
    v1.superseded && v1.status === "REVERSED" && n(v1.total) === 10000,
    `${v1.status} · ${n(v1.total).toLocaleString()}`);
  check("  v2 is the live one and says 12,000",
    v2.status === "POSTED" && !v2.superseded && v2.replaces && n(v2.total) === 12000,
    `${v2.status} · ${n(v2.total).toLocaleString()}`);

  // The accounts show the correction, not both figures.
  const [receivable] = await sql`
    select coalesce(sum(jl.base_amount), 0)::float as v
      from journal_line jl join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.is_control and a.subledger = 'CUSTOMER'`;
  check("the customer owes 12,000, not 22,000", n(receivable.v) === 12000,
    `${n(receivable.v).toLocaleString()}`);

  const [hist] = await sql`
    select action, reason, detail from document_history
     where action = 'AMEND' order by acted_at desc limit 1`;
  check("the edit is on the record with its reason", !!hist && !!hist.reason,
    `${hist?.reason} · ${JSON.stringify(hist?.detail)?.slice(0, 60)}`);

  // ---- one live version, always -------------------------------------------

  console.log("\n  what cannot happen\n");

  let twice = null;
  try {
    await P.amendInvoice({
      companyId: co.id, documentId: inv.id, reason: "again",
      invoice: {
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: null, toDeliver: true,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 1500 }],
      },
    });
  } catch (e) { twice = e.message; }
  check("a superseded version cannot be edited again", twice !== null,
    twice ? twice.slice(0, 60) : "EDITED — two replacements of one version");

  const [live] = await sql`
    select count(*)::int as n from document
     where doc_no = ${inv.docNo} and status = 'POSTED'`;
  check("  exactly one version of the number is live", live.n === 1, `${live.n}`);

  let noReason = null;
  try {
    await P.amendInvoice({
      companyId: co.id, documentId: amended.replacementId, reason: "   ",
      invoice: {
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: null, toDeliver: true,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 1300 }],
      },
    });
  } catch (e) { noReason = e.message; }
  check("editing without a reason is refused", noReason !== null,
    noReason ? noReason.slice(0, 52) : "EDITED with no reason given");

  // Settled money is not editable — the payment comes off first.
  const [bank] = await sql`select id from account
     where company_id = ${co.id} and is_bank_account and is_active order by code limit 1`;
  await P.postCustomerReceipt({
    companyId: co.id, partnerId: cust.id, docDate: today,
    cashAccountId: bank.id,
    allocations: [{ invoiceId: amended.replacementId, amount: 12000 }],
  });
  let settled = null;
  try {
    await P.amendInvoice({
      companyId: co.id, documentId: amended.replacementId, reason: "price wrong again",
      invoice: {
        companyId: co.id, partnerId: cust.id, locationId: loc.id,
        docDate: today, dueDate: null, toDeliver: true,
        lines: [{ itemId: item.id, qty: 10, unitPrice: 1400 }],
      },
    });
  } catch (e) { settled = e.message; }
  check("an invoice with money against it cannot be edited", settled !== null,
    settled ? settled.slice(0, 64) : "EDITED — a payment now points at a document that was reversed");

  // ---- an order, corrected ------------------------------------------------

  console.log("\n  an order, corrected\n");

  const po = await P.postPurchaseOrder({
    companyId: co.id, partnerId: supp.id, locationId: loc.id,
    docDate: today, dueDate: today,
    lines: [{ itemId: item.id, qty: 100, unitPrice: 400 }],
  });
  const [poLine] = await sql`select id from document_line where document_id = ${po.id}`;

  const poV2 = await P.amendOrder({
    companyId: co.id, documentId: po.id,
    reason: "supplier confirmed 120",
    order: {
      companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, dueDate: today,
      lines: [{ itemId: item.id, qty: 120, unitPrice: 400 }],
    },
  });
  const poVersions = await versions(po.docNo);
  check("an order keeps its number and becomes v2",
    poV2.docNo === po.docNo && poV2.version === 2,
    poVersions.map((v) => `v${v.version} ${v.status} ${n(v.total).toLocaleString()}`).join(" · "));
  check("  and posts no journal entry either way",
    n((await sql`select count(*)::int as n from journal_entry je
                   join document d on d.id = je.source_id
                  where d.doc_no = ${po.docNo}`)[0].n) === 0);

  // Receive against the corrected order, then try to correct it below that.
  const [v2Line] = await sql`
    select dl.id from document_line dl join document d on d.id = dl.document_id
     where d.id = ${poV2.replacementId}`;
  await P.postGoodsReceipt({
    companyId: co.id, partnerId: supp.id, locationId: loc.id, docDate: today,
    sourceDocumentId: poV2.replacementId,
    lines: [{ itemId: item.id, qty: 80, unitCost: 400, sourceLineId: v2Line.id }],
  });

  let tooLow = null;
  try {
    await P.amendOrder({
      companyId: co.id, documentId: poV2.replacementId,
      reason: "cutting it back",
      order: {
        companyId: co.id, partnerId: supp.id, locationId: loc.id,
        docDate: today, dueDate: today,
        lines: [{ itemId: item.id, qty: 50, unitPrice: 400 }],
      },
    });
  } catch (e) { tooLow = e.message; }
  check("an order cannot be cut below what has already arrived", tooLow !== null,
    tooLow ? tooLow.slice(0, 70) : "EDITED — 80 received against an order for 50");

  void poLine;

  // ---- a correction changes what it was asked to, and nothing else --------

  console.log("\n  what a correction must not quietly drop\n");
  {
    await sql.unsafe(`truncate table document_history, fulfilment_link, order_closure,
      payment_allocation, stock_lot_adjustment, stock_lot_consumption, stock_lot,
      stock_movement, document_line, document, journal_line, journal_entry
      restart identity cascade`);
    await sql`update number_series set next_value = 1`;

    await P.postGoodsReceipt({ companyId: co.id, partnerId: supp.id, locationId: loc.id,
      docDate: today, lines: [{ itemId: item.id, qty: 100, unitCost: 400 }] });

    // 10 at 1,000 with 10% off — the customer agreed 9,000, not 10,000.
    const disc = await P.postSalesInvoice({
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null, toDeliver: true,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1000, discountPct: 10 }],
    });
    const [v1] = await sql`select gross_total::float as t from document where id = ${disc.id}`;
    check("an invoice with 10% off bills 9,000", n(v1.t) === 9000, `${n(v1.t)}`);

    const [line] = await sql`select id from document_line where document_id = ${disc.id}`;

    // The preview and the posting must agree. Both are asked the same
    // question, through the same builder the screens use.
    const corrected = {
      companyId: co.id, partnerId: cust.id, locationId: loc.id,
      docDate: today, dueDate: null, toDeliver: true,
      lines: [{ itemId: item.id, qty: 10, unitPrice: 1200, discountPct: 10,
                focReasonId: null, sourceLineId: null }],
    };
    const plan = await P.planInvoiceAmendment({
      companyId: co.id, documentId: disc.id, invoice: corrected, reason: "preview",
    });
    check("correcting the price to 1,200 previews 10,800, not 12,000",
      n(plan.order.totalAfter) === 10800, `previewed ${n(plan.order.totalAfter)}`);

    const after = await P.amendInvoice({
      companyId: co.id, documentId: disc.id, reason: "agreed 1,200 before discount",
      invoice: corrected,
    });
    check("  and posts exactly what it previewed",
      n(after.totalAfter) === n(plan.order.totalAfter),
      `previewed ${n(plan.order.totalAfter)} · posted ${n(after.totalAfter)}`);
    check("  the discount survived the correction",
      n((await sql`select discount_pct::float as d from document_line
                    where document_id = ${after.replacementId}`)[0].d) === 10);
    check("  and the dry run left nothing behind",
      (await sql`select 1 from document where doc_no = ${disc.docNo} and version > 2`).length === 0);
    void line;
  }

  // ---- the books still hold ------------------------------------------------

  console.log("");
  const [tb] = await sql`select coalesce(sum(balance), 0) as v from v_trial_balance`;
  check("trial balance nets to zero", Math.abs(n(tb.v)) < 0.0001, `${n(tb.v)}`);
  check("no unbalanced entries",
    (await sql`select 1 from v_check_unbalanced_entries`).length === 0);
  check("inventory reconciles to the stock ledger",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  console.log(bad === 0
    ? "\n  the number stays, the history stays, and the accounts follow\n"
    : `\n  ${bad} FAILED\n`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error("\n  error:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
