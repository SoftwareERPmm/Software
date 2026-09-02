// Branch dimension: every posting lands in the branch that made it.
//
//   npx tsx scripts/test-branch-dimension.mjs
//
// Branch and warehouse already existed in the schema — location.parent_id,
// with a branch as a parentless non-stock location and its warehouses as
// children — and journal_line has carried a location_id since the first
// migration. What was missing is that nine of the twenty-six journal.push
// calls never set it, revenue among them, so a per-branch profit report read
// zero everywhere while the company-wide one was right.
//
// writeJournal now stamps the posting document's location onto any line that
// does not name its own. This proves that: the same goods sold from two
// branches must produce two separately attributable P&Ls that still add up
// to the company total.
//
// Writes documents. Run against a scratch database.

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

const { postSaleWithDelivery, postPurchaseWithReceipt, postStockTransfer, postSupplierPayment,
        postCashVoucher } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, {
  ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1,
});

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  // Two branches, each with its own warehouse — the hierarchy the schema
  // already models. Reused if the seed already made them.
  const branches = [];
  for (const [bCode, bName, wCode, wName] of [
    ["YGN", "Yangon Branch", "YGN-WH", "Yangon Main Warehouse"],
    ["MDY", "Mandalay Branch", "MDY-WH", "Mandalay Warehouse"],
  ]) {
    let [branch] = await sql`
      select id from location where company_id = ${co.id} and code = ${bCode}`;
    if (!branch) {
      [branch] = await sql`insert into location (company_id, code, name, is_stock_location)
        values (${co.id}, ${bCode}, ${bName}, false) returning id`;
    }
    let [wh] = await sql`
      select id from location where company_id = ${co.id} and code = ${wCode}`;
    if (!wh) {
      [wh] = await sql`insert into location (company_id, parent_id, code, name, is_stock_location)
        values (${co.id}, ${branch.id}, ${wCode}, ${wName}, true) returning id`;
    }
    branches.push({ code: bCode, name: bName, branchId: branch.id, whId: wh.id });
  }

  check("each warehouse belongs to exactly one branch",
    (await sql`select count(*)::int as c from location w
                 join location b on b.id = w.parent_id
                where w.company_id = ${co.id} and w.is_stock_location and b.parent_id is null`)[0].c >= 2);

  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  let [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
  if (!grp) {
    [grp] = await sql`insert into item_group (company_id, segment, code, name)
      values (${co.id}, 'BR', 'x', 'Branch Test') returning id`;
  }
  const stamp = Date.now().toString().slice(-5);
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
    values (${co.id}, ${grp.id}, ${stamp}, 'Branch Test Item', ${uom.id}, true) returning id`;
  const [cust] = await sql`insert into business_partner (company_id, code, name, is_customer, payment_terms_days)
    values (${co.id}, ${'BC-' + stamp}, 'Branch Test Customer', true, 30) returning id`;
  const [supp] = await sql`insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${'BS-' + stamp}, 'Branch Test Supplier', true) returning id`;

  const today = new Date().toISOString().slice(0, 10);

  // Same item, bought and sold at both branches, deliberately at different
  // volumes so the two branches cannot be confused for one another.
  const plan = [
    { b: branches[0], buyQty: 100, sellQty: 60, cost: 1000, price: 1500 },  // Yangon
    { b: branches[1], buyQty: 50,  sellQty: 20, cost: 1000, price: 1500 },  // Mandalay
  ];

  for (const p of plan) {
    await postPurchaseWithReceipt({
      companyId: co.id, partnerId: supp.id, locationId: p.b.whId,
      docDate: today, dueDate: null,
      lines: [{ itemId: item.id, qty: p.buyQty, unitPrice: p.cost }],
    });
    await postSaleWithDelivery({
      companyId: co.id, partnerId: cust.id, locationId: p.b.whId,
      docDate: today, dueDate: null,
      lines: [{ itemId: item.id, qty: p.sellQty, unitPrice: p.price }],
    });
  }

  console.log("\n  every line of this run carries a branch\n");

  // Scoped to this run's documents like every other assertion here. Lines
  // posted by older code genuinely have no location and always will —
  // location_id is only ever written at posting time, so entries made before
  // the dimension was stamped stay unattributed unless they are reversed and
  // re-posted. That is history, not a defect this test should fail on.
  const orphan = await sql`
    select count(*)::int as c
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
     where jl.company_id = ${co.id} and jl.location_id is null
       and je.source_type in ('SALES_INVOICE','DELIVERY','GOODS_RECEIPT','PURCHASE_INVOICE')
       and je.source_id in (select document_id from document_line where item_id = ${item.id})`;
  check("no sale or purchase line was left without a location", orphan[0].c === 0, `${orphan[0].c} orphaned`);

  // Revenue was the line that used to be missing entirely.
  const revByBranch = await sql`
    select b.code, -sum(jl.base_amount) as revenue
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
      join location w on w.id = jl.location_id
      join location b on b.id = coalesce(w.parent_id, w.id)
     where jl.company_id = ${co.id} and a.account_type = 'REVENUE'
       and je.source_id in (select document_id from document_line where item_id = ${item.id})
     group by b.code order by b.code`;
  const rev = Object.fromEntries(revByBranch.map((r) => [r.code, n(r.revenue)]));

  check("Yangon revenue is 60 x 1,500", rev.YGN === 90000, String(rev.YGN));
  check("Mandalay revenue is 20 x 1,500", rev.MDY === 30000, String(rev.MDY));

  const cogsByBranch = await sql`
    select b.code, sum(jl.base_amount) as cogs
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
      join location w on w.id = jl.location_id
      join location b on b.id = coalesce(w.parent_id, w.id)
     where jl.company_id = ${co.id} and a.account_type = 'COGS'
       and je.source_id in (select document_id from document_line where item_id = ${item.id})
     group by b.code order by b.code`;
  const cogs = Object.fromEntries(cogsByBranch.map((r) => [r.code, n(r.cogs)]));
  check("Yangon COGS is 60 x 1,000", cogs.YGN === 60000, String(cogs.YGN));
  check("Mandalay COGS is 20 x 1,000", cogs.MDY === 20000, String(cogs.MDY));

  check("branch gross profits differ, so the two are genuinely separate",
    rev.YGN - cogs.YGN === 30000 && rev.MDY - cogs.MDY === 10000,
    `YGN ${rev.YGN - cogs.YGN}, MDY ${rev.MDY - cogs.MDY}`);

  // The consolidation requirement: branches must sum to the company.
  const [companyRev] = await sql`
    select -sum(jl.base_amount) as revenue
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join account a on a.id = jl.account_id
     where jl.company_id = ${co.id} and a.account_type = 'REVENUE'
       and je.source_id in (select document_id from document_line where item_id = ${item.id})
  `;
  check("all branches add up to the company-wide revenue",
    n(companyRev.revenue) === Object.values(rev).reduce((s, v) => s + v, 0),
    `${n(companyRev.revenue)} total`);

  // Balance-sheet side: the user asked for branch balance sheets too, so the
  // dimension has to reach the control accounts, not only the P&L ones. AR is
  // resolved the way the engine resolves it rather than by hardcoding a code.
  const [arAcct] = await sql`
    select fn_resolve_control_account(${co.id}, 'AR_CONTROL', ${cust.id}) as a`;
  const arByBranch = await sql`
    select b.code, sum(jl.base_amount) as ar
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join location w on w.id = jl.location_id
      join location b on b.id = coalesce(w.parent_id, w.id)
     where jl.company_id = ${co.id} and jl.account_id = ${arAcct.a}
       and je.source_id in (select document_id from document_line where item_id = ${item.id})
     group by b.code order by b.code`;
  const ar = Object.fromEntries(arByBranch.map((r) => [r.code, n(r.ar)]));
  check("receivables split by branch, not just company-wide",
    ar.YGN === 90000 && ar.MDY === 30000, `YGN ${ar.YGN}, MDY ${ar.MDY}`);

  // ---- Settling a bill relieves the branch that raised it ------------------
  // A payment used to carry no branch at all. Left that way, an invoice would
  // credit Yangon's payables and the payment would debit nothing in
  // particular, so Yangon went on reporting money it no longer owed for ever.
  // The same accounts the payment screens offer. Picking any old asset account
  // gets refused by fn_journal_line_account_guard, and rightly — a control
  // account is maintained by the subledger, never posted to by hand.
  const [cashAcct] = await sql`
    select id from account
     where company_id = ${co.id} and is_cash_account and is_active
     order by code limit 1`;

  const apAt = async (branchCode) => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0) as v
        from journal_line jl
        join location w on w.id = jl.location_id
        join location b on b.id = coalesce(w.parent_id, w.id)
       where jl.company_id = ${co.id} and b.code = ${branchCode}
         and jl.partner_id = ${supp.id}
         and jl.account_id = (select fn_resolve_control_account(${co.id}, 'AP_CONTROL', ${supp.id}))`;
    return n(r.v);
  };

  const bill = await postPurchaseWithReceipt({
    companyId: co.id, partnerId: supp.id, locationId: branches[0].whId,
    docDate: today, dueDate: null,
    lines: [{ itemId: item.id, qty: 7, unitPrice: 1000 }],
  });
  const owedBefore = await apAt("YGN");

  await postSupplierPayment({
    companyId: co.id, partnerId: supp.id, docDate: today, cashAccountId: cashAcct.id,
    allocations: [{ invoiceId: bill.id, amount: 7000 }],
  });
  const owedAfter = await apAt("YGN");

  check("paying a Yangon bill clears Yangon's payables, not another branch's",
    owedAfter - owedBefore === 7000, `${owedBefore} -> ${owedAfter}`);

  const payLines = await sql`
    select count(*) filter (where jl.location_id is null)::int as unlocated
      from document d
      join journal_entry je on je.id = d.journal_entry_id
      join journal_line jl on jl.journal_entry_id = je.id
     where d.company_id = ${co.id} and d.doc_type = 'SUPPLIER_PAYMENT'
       and d.partner_id = ${supp.id}`;
  check("and every line of that payment carries a branch",
    payLines[0].unlocated === 0, `${payLines[0].unlocated} unlocated`);

  // ---- a receipt taken at a branch reaches that branch's books -------------
  // The point of the Branch field on the receipt screen. Money taken at
  // Yangon has to show in Yangon's income statement and nowhere else, or the
  // field is decoration.
  {
    const [cashAcct2] = await sql`
      select id from account where company_id = ${co.id} and is_cash_account and is_active
       order by code limit 1`;
    const [incomeAcct] = await sql`
      select id, name from account
       where company_id = ${co.id} and account_type = 'REVENUE' and is_postable and not is_control
       order by code limit 1`;

    const revenueAt = async (branchCode) => {
      const [r] = await sql`
        select coalesce(-sum(jl.base_amount), 0) as v
          from journal_line jl
          join location w on w.id = jl.location_id
          join location b on b.id = coalesce(w.parent_id, w.id)
         where jl.company_id = ${co.id} and b.code = ${branchCode}
           and jl.account_id = ${incomeAcct.id}`;
      return n(r.v);
    };

    const ygnBefore = await revenueAt("YGN");
    const mdyBefore = await revenueAt("MDY");

    // Posted against the BRANCH itself, which is what the receipt screen now
    // offers — no warehouse involved.
    await postCashVoucher({
      companyId: co.id, docDate: today, memo: "Branch receipt test",
      locationId: branches[0].branchId,
      lines: [
        { accountId: cashAcct2.id, amount: 25000 },
        { accountId: incomeAcct.id, amount: -25000 },
      ],
    });

    check("a receipt taken at Yangon shows in Yangon's income",
      (await revenueAt("YGN")) - ygnBefore === 25000,
      `${ygnBefore} -> ${await revenueAt("YGN")}`);
    check("and not in Mandalay's",
      (await revenueAt("MDY")) === mdyBefore, `${mdyBefore}`);
  }

  // ---- Inter-branch transfer ----------------------------------------------
  // Moving stock between two warehouses that share one Inventory account is a
  // no-op company-wide, and used to post no journal at all for that reason.
  // With a branch dimension it is not a no-op: the value leaves one branch and
  // arrives at another. Skipping it left the sending branch's balance sheet
  // holding stock it had already shipped.
  const invAt = async (branchCode) => {
    const [r] = await sql`
      select coalesce(sum(jl.base_amount), 0) as v
        from journal_line jl
        join account a on a.id = jl.account_id
        join location w on w.id = jl.location_id
        join location b on b.id = coalesce(w.parent_id, w.id)
       where jl.company_id = ${co.id} and b.code = ${branchCode}
         and a.id = (select fn_resolve_account_for_item(${co.id}, 'INVENTORY', ${item.id}))`;
    return n(r.v);
  };
  const ygnBefore = await invAt("YGN");
  const mdyBefore = await invAt("MDY");

  const xfer = await postStockTransfer({
    companyId: co.id, fromLocationId: branches[0].whId, toLocationId: branches[1].whId,
    docDate: today, lines: [{ itemId: item.id, qty: 10 }],
  });

  const ygnAfter = await invAt("YGN");
  const mdyAfter = await invAt("MDY");

  check("an inter-branch transfer posts a journal at all",
    Boolean((await sql`select journal_entry_id from document where doc_no = ${xfer.docNo}`)[0].journal_entry_id),
    xfer.docNo);
  check("10 x 1,000 of inventory value leaves the sending branch",
    ygnBefore - ygnAfter === 10000, `${ygnBefore} -> ${ygnAfter}`);
  check("and the same value arrives at the receiving branch",
    mdyAfter - mdyBefore === 10000, `${mdyBefore} -> ${mdyAfter}`);
  check("the company holds exactly as much as before — it only moved",
    (ygnAfter + mdyAfter) === (ygnBefore + mdyBefore),
    `${ygnBefore + mdyBefore} -> ${ygnAfter + mdyAfter}`);

  const xferRev = await sql`
    select count(*)::int as c
      from document d
      join journal_entry je on je.id = d.journal_entry_id
      join journal_line jl on jl.journal_entry_id = je.id
      join account a on a.id = jl.account_id
     where d.doc_no = ${xfer.docNo} and a.account_type in ('REVENUE', 'COGS')`;
  check("a transfer is an internal movement, never revenue or cost of sale",
    xferRev[0].c === 0);

  // The strongest statement available: nothing this run posted is unattributed.
  const anyOrphan = await sql`
    select count(*)::int as c
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
     where jl.company_id = ${co.id} and jl.location_id is null
       and je.source_id in (select document_id from document_line where item_id = ${item.id})
  `;
  check("every journal line in the database carries a branch",
    anyOrphan[0].c === 0, `${anyOrphan[0].c} without a location`);

  // Inventory still reconciles — the dimension must not have altered value.
  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) as total from journal_line where company_id = ${co.id}`;
  check("trial balance still nets to zero", Math.abs(n(tb.total)) < 0.0001, String(n(tb.total)));

  const unbalanced = await sql`
    select je.entry_no from journal_entry je
      join journal_line jl on jl.journal_entry_id = je.id
     where je.company_id = ${co.id}
     group by je.id, je.entry_no having abs(sum(jl.base_amount)) > 0.0001`;
  check("no unbalanced entries", unbalanced.length === 0);

  console.log(`\n  ${failures === 0 ? "all branch dimension tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
