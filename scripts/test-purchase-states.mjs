// The four dimensions of a purchase, and every combination of the first three.
//
//   npx tsx scripts/test-purchase-states.mjs
//
// A purchase carries four independent facts, and collapsing them into one
// status is what makes a purchasing screen unreadable:
//
//   PO       what was committed to      ordered
//   GR       what physically arrived    received
//   PI       what the supplier billed   invoiced
//   PAYMENT  what was settled           money, not quantity
//
// They move independently. Goods can arrive before the bill or after it; an
// invoice can cover more than has arrived; a payment says nothing about
// whether anything was received. This suite walks the 3x3 of received
// against invoiced — the nine states A to I — plus the cases that break the
// "one PO, one GR, one PI" assumption, and checks each dimension reports
// itself without borrowing from the others.
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
const { getMatchStatus, getOrderProgress } = await import("../lib/queries.ts");
const { postPurchaseOrder, postGoodsReceipt, postPurchaseInvoice, postSupplierPayment } =
  await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

// Neon scales an idle branch to zero, and lib/db allows ten seconds to
// connect — right for a web request, occasionally short for the first query
// after a quiet spell. Retrying the first one costs nothing and stops a cold
// start being reported as a failing suite.
async function warm() {
  for (let i = 1; ; i++) {
    try { return await sql`select 1 as ok`; }
    catch (e) {
      if (i >= 5) throw e;
      console.log(`  (waking the database, attempt ${i})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

try {
  await warm();
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, ${"PS" + stamp}, 'x', ${"Purchase States " + stamp})
    returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;
  const [supplier] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, ${"PS-" + stamp}, ${"States Supplier " + stamp}, true)
    returning id`;
  const [wh] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location and is_active
     order by code limit 1`;
  const [cash] = await sql`
    select id from account where company_id = ${co.id} and is_cash_account and is_active limit 1`;

  let serial = 0;
  const newItem = async () => {
    serial++;
    const [it] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id, is_stocked)
      values (${co.id}, ${grp.id}, ${String(serial).padStart(3, "0")},
              ${`States Item ${stamp}-${serial}`}, ${uom.id}, true)
      returning id`;
    return it.id;
  };

  const PRICE = 45000;

  /** Builds one scenario on its own PO and its own item, and reports the
   *  three quantity dimensions plus what each screen would say. */
  const scenario = async (name, { ordered, receipts = [], invoices = [] }) => {
    const itemId = await newItem();
    const po = await postPurchaseOrder({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      lines: [{ itemId, qty: ordered, unitPrice: PRICE }],
    });

    const grs = [];
    for (const qty of receipts) {
      grs.push(await postGoodsReceipt({
        companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
        sourceDocumentId: po.id,
        lines: [{ itemId, qty, unitCost: PRICE }],
      }));
    }

    const pis = [];
    for (const [i, qty] of invoices.entries()) {
      pis.push(await postPurchaseInvoice({
        companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
        // Bill against a receipt where one exists; otherwise the invoice
        // arrives ahead of the goods, which is a legitimate state of its own.
        goodsReceiptId: grs[i]?.id ?? null,
        lines: [{ itemId, qty, unitPrice: PRICE }],
      }));
    }

    const progress = await getOrderProgress(po.id, "PURCHASE_ORDER");
    const line = progress.lines?.[0] ?? progress[0];
    const received = n(line?.fulfilled ?? line?.received);
    return { name, po, grs, pis, itemId, ordered, received, progress };
  };

  const poState = (ordered, received) =>
    received === 0 ? "Open" : received < ordered ? "Partially Fulfilled" : "Fulfilled";

  // ---- the 3x3: received against invoiced ---------------------------------
  console.log("  received x invoiced — PO of 20\n");
  const cases = [
    ["A  nothing at all",                { ordered: 20, receipts: [],       invoices: []       }, 0,  "Open"],
    ["B  received 10, not invoiced",     { ordered: 20, receipts: [10],     invoices: []       }, 10, "Partially Fulfilled"],
    ["C  received 20, not invoiced",     { ordered: 20, receipts: [20],     invoices: []       }, 20, "Fulfilled"],
    ["D  invoiced 10 before any goods",  { ordered: 20, receipts: [],       invoices: [10]     }, 0,  "Open"],
    ["E  invoiced 20 before any goods",  { ordered: 20, receipts: [],       invoices: [20]     }, 0,  "Open"],
    ["F  received 10, invoiced 10",      { ordered: 20, receipts: [10],     invoices: [10]     }, 10, "Partially Fulfilled"],
    ["G  received 20, invoiced 20",      { ordered: 20, receipts: [20],     invoices: [20]     }, 20, "Fulfilled"],
    ["I  received 20, invoiced 10",      { ordered: 20, receipts: [20],     invoices: [10]     }, 20, "Fulfilled"],
  ];

  for (const [label, spec, expectReceived, expectPo] of cases) {
    const r = await scenario(label, spec);
    check(`${label} — PO reports ${expectPo.toLowerCase()}`,
      r.received === expectReceived && poState(r.ordered, r.received) === expectPo,
      `received ${r.received}/${r.ordered} -> ${poState(r.ordered, r.received)}`);
  }

  // H is the one that cannot be built by billing a receipt: the invoice is
  // for more than arrived, so it is raised on its own.
  {
    const itemId = await newItem();
    const po = await postPurchaseOrder({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      lines: [{ itemId, qty: 20, unitPrice: PRICE }],
    });
    await postGoodsReceipt({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      sourceDocumentId: po.id, lines: [{ itemId, qty: 10, unitCost: PRICE }],
    });
    const pi = await postPurchaseInvoice({
      companyId: co.id, partnerId: supplier.id, locationId: wh.id, docDate: today,
      lines: [{ itemId, qty: 20, unitPrice: PRICE }],
    });
    const m = await getMatchStatus(pi.id);
    check("H  received 10 but invoiced 20 — the invoice still shows 20 to account for",
      m !== null && n(m.lines[0].qty) === 20,
      `invoice line ${n(m?.lines?.[0]?.qty)}`);
  }

  // ---- one PO, many receipts, many invoices -------------------------------
  console.log("\n  many receipts and many invoices against one order\n");
  {
    const r = await scenario("split", { ordered: 20, receipts: [5, 10, 5], invoices: [5, 10, 5] });
    check("three receipts of 5, 10 and 5 fulfil the order exactly",
      r.received === 20 && poState(20, r.received) === "Fulfilled",
      `received ${r.received}/20`);
    check("the order is not fulfilled three times over",
      r.received === 20, String(r.received));

    // Each receipt is billed by its own invoice, and each pair must agree
    // without borrowing quantity from the others.
    for (const [i, gr] of r.grs.entries()) {
      const m = await getMatchStatus(gr.id);
      check(`  receipt ${i + 1} of ${[5, 10, 5][i]} reads fully invoiced`,
        m?.state === "FULL" && n(m.lines[0].remaining) === 0,
        `${m?.state}, remaining ${n(m?.lines?.[0]?.remaining)}`);
    }
    for (const [i, pi] of r.pis.entries()) {
      const m = await getMatchStatus(pi.id);
      check(`  invoice ${i + 1} of ${[5, 10, 5][i]} reads fully received`,
        m?.state === "FULL" && n(m.lines[0].remaining) === 0,
        `${m?.state}, remaining ${n(m?.lines?.[0]?.remaining)}`);
    }
  }

  // ---- payment is a fourth dimension, in money ----------------------------
  console.log("\n  payment — money, and independent of the three above\n");
  {
    const r = await scenario("paying", { ordered: 20, receipts: [10], invoices: [10] });
    const pi = r.pis[0];
    const total = 10 * PRICE;

    const outstanding = async () => {
      const [row] = await sql`
        select coalesce(outstanding, 0) as o from v_open_item where document_id = ${pi.id}`;
      return n(row?.o);
    };
    check("unpaid: the whole invoice is outstanding", (await outstanding()) === total,
      `${await outstanding()} of ${total}`);

    await postSupplierPayment({
      companyId: co.id, partnerId: supplier.id, docDate: today, cashAccountId: cash.id,
      allocations: [{ invoiceId: pi.id, amount: 200000 }],
    });
    check("part paid: the balance falls but nothing else moves",
      (await outstanding()) === total - 200000, `${await outstanding()} left`);

    const stillReceived = await getMatchStatus(pi.id);
    check("  paying does not change what was received",
      stillReceived?.state === "FULL", String(stillReceived?.state));
    const prog = await getOrderProgress(r.po.id, "PURCHASE_ORDER");
    const pl = prog.lines?.[0] ?? prog[0];
    check("  nor what the order still awaits",
      n(pl?.fulfilled ?? pl?.received) === 10, String(n(pl?.fulfilled ?? pl?.received)));

    await postSupplierPayment({
      companyId: co.id, partnerId: supplier.id, docDate: today, cashAccountId: cash.id,
      allocations: [{ invoiceId: pi.id, amount: total - 200000 }],
    });
    check("paid: nothing outstanding", (await outstanding()) === 0, String(await outstanding()));

    // The state the user described as valid and worth supporting:
    // PO partially fulfilled, GR fully invoiced, PI fully received and paid.
    const finalOrder = poState(20, 10);
    const finalMatch = await getMatchStatus(r.grs[0].id);
    check("PO partly fulfilled while its receipt is fully invoiced and its invoice paid",
      finalOrder === "Partially Fulfilled" && finalMatch?.state === "FULL" &&
      (await outstanding()) === 0,
      `${finalOrder} / ${finalMatch?.state} / paid`);
  }

  // ---- the invariants still hold ------------------------------------------
  const [tb] = await sql`
    select coalesce(sum(base_amount), 0) as t from journal_line where company_id = ${co.id}`;
  check("trial balance nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  const recon = await sql`
    select count(*)::int as c from (
      select sm.item_id, sm.location_id, sum(sm.qty) as moved,
             fn_qty_on_hand(${co.id}, sm.item_id, sm.location_id) as on_hand
        from stock_movement sm where sm.company_id = ${co.id}
       group by sm.item_id, sm.location_id
    ) x where abs(moved - on_hand) > 0.0001`;
  check("inventory reconciles to the stock ledger", recon[0].c === 0);

  console.log(`\n  ${failures === 0 ? "all purchase state tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}
process.exit(failures === 0 ? 0 : 1);
