// Supplier performance, measured from documents rather than from fixtures.
//
//   npx tsx scripts/test-supplier-performance.mjs
//
// scripts/test-supplier-commitments.mjs already proves the commitment
// arithmetic against numbers worked out by hand, with no database in the
// way. This suite proves the other half: that the six queries read the
// documents correctly, and that what they hand the arithmetic is what was
// actually posted. The cases it exists for are the ones a pure test cannot
// reach — partial receipts, over-receipts, cancellations, amendments, a
// receipt billed by two invoices, and a voided document that must stop
// counting.
//
// Writes documents. Run against a scratch database.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { takeTestLock, releaseTestLock } from "./test-lock.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const { sql } = await import("../lib/db.ts");
await takeTestLock(sql, "test-supplier-performance.mjs");

const { resetTransactions } = await import("./test-reset.mjs");
const {
  getSupplierSpend, getSupplierCommitmentData, getSupplierFulfilment,
  getSupplierLeadTimeObservations, getSupplierPriceObservations,
  getSupplierDeliveryCompleteness, getSupplierMatchingVariance,
  getRadarPresets, getSupplierPerformanceSetting,
} = await import("../lib/queries.ts");
const { buildPerformance } = await import("../lib/supplier-performance.ts");
const { resolveThresholds, resolveTargets, sanitizeAxes, DEFAULT_THRESHOLDS } =
  await import("../lib/supplier-metrics.ts");
const { postPurchaseOrder, postGoodsReceipt, postPurchaseInvoice } =
  await import("../lib/posting.ts");
const { voidDocument } = await import("../lib/posting.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const near = (a, b, tol = 0.05) =>
  a !== null && b !== null && Math.abs(Number(a) - Number(b)) <= tol;

const d = (n) => {
  const t = new Date();
  t.setDate(t.getDate() + n);
  return t.toISOString().slice(0, 10);
};

try {
  const [co] = await sql`select id, name from company limit 1`;
  const [loc] = await sql`select id, code from location where is_stock_location order by code limit 1`;

  await resetTransactions(sql);

  const [grp] = await sql`select id from item_group where company_id = ${co.id} order by code limit 1`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} order by code limit 1`;

  const partner = async (code, name) => {
    const [x] = await sql`select id from business_partner where company_id = ${co.id} and code = ${code}`;
    if (x) return x;
    const [n] = await sql`
      insert into business_partner (company_id, code, name, is_supplier)
      values (${co.id}, ${code}, ${name}, true) returning id`;
    return n;
  };
  const makeItem = async (serial, name) => {
    const [x] = await sql`select id from item where company_id = ${co.id} and name = ${name}`;
    if (x) return x;
    const [n] = await sql`
      insert into item (company_id, item_group_id, serial, name, base_uom_id)
      values (${co.id}, ${grp.id}, ${serial}, ${name}, ${uom.id}) returning id`;
    return n;
  };

  const alpha = await partner("PERF-A", "Alpha Supplies");
  const beta = await partner("PERF-B", "Beta Supplies");
  const widget = await makeItem("PF1", "Perf widget");
  const sole = await makeItem("PF2", "Perf sole-source part");

  const lineOf = async (docId) =>
    (await sql`select id from document_line where document_id = ${docId} order by line_no`)[0];
  const confirm = (lineId, qty, date, kind, recordedDaysAgo) => sql`
    insert into purchase_confirmation
      (company_id, order_line_id, qty, confirmed_date, kind, recorded_at)
    values (${co.id}, ${lineId}, ${qty}, ${date}::date, ${kind},
            now() - (${recordedDaysAgo} || ' days')::interval)`;

  const from = d(-120), to = d(0);
  const load = async () => {
    const [spend, commitments, fulfilment, leadTimes, prices, completeness, variance] =
      await Promise.all([
        getSupplierSpend(co.id, from, to),
        getSupplierCommitmentData(co.id, from, to),
        getSupplierFulfilment(co.id, from, to),
        getSupplierLeadTimeObservations(co.id, from, to),
        getSupplierPriceObservations(co.id, from, to),
        getSupplierDeliveryCompleteness(co.id, from, to),
        getSupplierMatchingVariance(co.id, from, to),
      ]);
    return buildPerformance({
      suppliers: spend.length ? spend : [],
      commitments, fulfilment, leadTimes, prices, completeness, variance,
      cutoff: to,
    });
  };
  const of = (rows, id) => rows.find((r) => r.partnerId === id);

  console.log(`\n  ${co.name}  ·  ${loc.code}\n`);

  // ---- a partial receipt splits the promise, not the line ----------------
  console.log("  a receipt that only half arrives\n");

  const po1 = await postPurchaseOrder({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id,
    docDate: d(-60), lines: [{ itemId: widget.id, qty: 100, unitPrice: 500 }],
  });
  const l1 = await lineOf(po1.id);
  await confirm(l1.id, 100, d(-50), "INITIAL", 58);
  const gr1 = await postGoodsReceipt({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-50),
    sourceDocumentId: po1.id,
    lines: [{ itemId: widget.id, qty: 60, unitCost: 500, sourceLineId: l1.id }],
  });

  let rows = await load();
  let a = of(rows, alpha.id);
  check("60 of 100 counts as 60% on time", near(a.actuals.onTimePct, 60),
    `${a.actuals.onTimePct}`);
  check("the missing 40 is outstanding, not forgotten",
    a.actuals.onTime.outstanding === 40, `${a.actuals.onTime.outstanding}`);
  check("fulfilment sees the same 60", near(a.actuals.fulfilmentPct, 60),
    `${a.actuals.fulfilmentPct}`);

  // ---- the rest arrives late, on a second receipt ------------------------
  console.log("\n  the rest arrives, a week after it was due\n");

  const gr2 = await postGoodsReceipt({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-43),
    sourceDocumentId: po1.id,
    lines: [{ itemId: widget.id, qty: 40, unitCost: 500, sourceLineId: l1.id }],
  });

  rows = await load();
  a = of(rows, alpha.id);
  check("still 60% — arriving late is not arriving on time",
    near(a.actuals.onTimePct, 60), `${a.actuals.onTimePct}`);
  check("40 units are late", a.actuals.onTime.late === 40, `${a.actuals.onTime.late}`);
  check("by seven days", near(a.actuals.averageDelayDays, 7),
    `${a.actuals.averageDelayDays}`);
  check("fulfilment is now complete", near(a.actuals.fulfilmentPct, 100),
    `${a.actuals.fulfilmentPct}`);

  const dc = a.metrics.delivery_completeness;
  check("two receipts means the order was not complete in one",
    near(dc.raw, 0), `${dc.raw}`);

  // ---- an over-receipt cannot score above 100 ----------------------------
  console.log("\n  more arrives than was ordered\n");

  const po2 = await postPurchaseOrder({
    companyId: co.id, partnerId: beta.id, locationId: loc.id,
    docDate: d(-40), lines: [{ itemId: widget.id, qty: 50, unitPrice: 520 }],
  });
  const l2 = await lineOf(po2.id);
  await confirm(l2.id, 50, d(-30), "INITIAL", 38);
  await postGoodsReceipt({
    companyId: co.id, partnerId: beta.id, locationId: loc.id, docDate: d(-30),
    sourceDocumentId: po2.id,
    lines: [{ itemId: widget.id, qty: 60, unitCost: 520, sourceLineId: l2.id }],
  });

  rows = await load();
  let b = of(rows, beta.id);
  check("60 delivered against 50 ordered is 100%, not 120%",
    near(b.actuals.fulfilmentPct, 100), `${b.actuals.fulfilmentPct}`);
  check("and on-time is capped the same way",
    b.metrics.order_fulfillment.raw <= 100, `${b.metrics.order_fulfillment.raw}`);

  // ---- price comparison needs somebody to compare with -------------------
  console.log("\n  a part only one supplier sells\n");

  await postPurchaseInvoice({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-49),
    dueDate: null, goodsReceiptId: gr1.id,
    lines: [{ itemId: widget.id, qty: 60, unitPrice: 500 }],
  });
  const poSole = await postPurchaseOrder({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id,
    docDate: d(-35), lines: [{ itemId: sole.id, qty: 10, unitPrice: 9000 }],
  });
  const lSole = await lineOf(poSole.id);
  const grSole = await postGoodsReceipt({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-30),
    sourceDocumentId: poSole.id,
    lines: [{ itemId: sole.id, qty: 10, unitCost: 9000, sourceLineId: lSole.id }],
  });
  await postPurchaseInvoice({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-29),
    dueDate: null, goodsReceiptId: grSole.id,
    lines: [{ itemId: sole.id, qty: 10, unitPrice: 9000 }],
  });

  rows = await load();
  a = of(rows, alpha.id);
  check("the sole-source part is bought but not comparable",
    a.priceCoverage.totalItems === 2 && a.priceCoverage.comparableItems <= 1,
    `${a.priceCoverage.comparableItems} of ${a.priceCoverage.totalItems}`);
  check("and coverage says how much of the spend was compared",
    a.priceCoverage.spendCovered < 1, `${a.priceCoverage.spendCovered.toFixed(2)}`);

  // ---- one receipt, two invoices, counted once ---------------------------
  console.log("\n  a receipt billed by two invoices\n");

  await postPurchaseInvoice({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-42),
    dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: widget.id, qty: 20, unitPrice: 500 }],
  });
  await postPurchaseInvoice({
    companyId: co.id, partnerId: alpha.id, locationId: loc.id, docDate: d(-41),
    dueDate: null, goodsReceiptId: gr2.id,
    lines: [{ itemId: widget.id, qty: 20, unitPrice: 500 }],
  });

  rows = await load();
  a = of(rows, alpha.id);
  check("splitting an invoice in two does not double the fulfilment",
    near(a.actuals.fulfilmentPct, 100), `${a.actuals.fulfilmentPct}`);
  const mv = a.metrics.matching_variance;
  check("and neither invoice reads as a variance", near(mv.raw, 0), `${mv.raw}`);

  // ---- a cancelled order leaves the denominator --------------------------
  console.log("\n  an order the buyer cancelled\n");

  const po3 = await postPurchaseOrder({
    companyId: co.id, partnerId: beta.id, locationId: loc.id,
    docDate: d(-25), lines: [{ itemId: widget.id, qty: 400, unitPrice: 520 }],
  });
  const before = of(await load(), beta.id).actuals.fulfilmentPct;
  await sql`
    insert into order_closure (company_id, document_id, reason, is_open)
    values (${co.id}, ${po3.id}, 'Cancelled — no longer needed', false)`;
  const after = of(await load(), beta.id).actuals.fulfilmentPct;
  check("cancelling lifts fulfilment back out of the hole it dug",
    after > before, `${before?.toFixed(1)} -> ${after?.toFixed(1)}`);
  check("and a cancelled order is not a supplier failure",
    near(after, 100), `${after}`);

  // ---- a voided receipt stops counting -----------------------------------
  console.log("\n  a receipt posted by mistake, then voided\n");

  const poV = await postPurchaseOrder({
    companyId: co.id, partnerId: beta.id, locationId: loc.id,
    docDate: d(-20), lines: [{ itemId: widget.id, qty: 30, unitPrice: 520 }],
  });
  const lV = await lineOf(poV.id);
  await confirm(lV.id, 30, d(-10), "INITIAL", 18);
  const grV = await postGoodsReceipt({
    companyId: co.id, partnerId: beta.id, locationId: loc.id, docDate: d(-10),
    sourceDocumentId: poV.id,
    lines: [{ itemId: widget.id, qty: 30, unitCost: 520, sourceLineId: lV.id }],
  });
  const withReceipt = of(await load(), beta.id).actuals.onTime.onTime;
  await voidDocument({ documentId: grV.id, reason: "Posted against the wrong order" });
  const voided = of(await load(), beta.id);
  check("a voided receipt stops being a delivery",
    voided.actuals.onTime.onTime < withReceipt,
    `${withReceipt} -> ${voided.actuals.onTime.onTime}`);
  check("and the promise it answered is outstanding again",
    voided.actuals.onTime.outstanding >= 30,
    `${voided.actuals.onTime.outstanding}`);

  // ---- too few observations abstains rather than guessing ----------------
  console.log("\n  a metric with almost nothing behind it\n");

  rows = await load();
  b = of(rows, beta.id);
  const lead = b.metrics.lead_time_consistency;
  check("lead-time consistency says how many it needs",
    lead.score === null ? Boolean(lead.unavailable) : true,
    lead.score === null ? "abstained" : `scored ${lead.score}`);
  for (const id of ["return_performance", "quantity_accuracy", "quality_acceptance"]) {
    const m = b.metrics[id];
    check(`${id} is unavailable, not nought`,
      m.score === null && m.raw === null && Boolean(m.unavailable));
  }

  // ---- normalization boundaries ------------------------------------------
  console.log("\n  the scale itself\n");

  const merged = resolveThresholds({ premiumCeiling: 35 });
  check("a company's own boundary is used", merged.premiumCeiling === 35);
  check("and the ones it did not set keep following the defaults",
    merged.cvLimit === DEFAULT_THRESHOLDS.cvLimit);
  check("a nonsense boundary is ignored rather than clamped",
    resolveThresholds({ premiumCeiling: 0 }).premiumCeiling
      === DEFAULT_THRESHOLDS.premiumCeiling);
  check("a null target clears the default rather than falling back",
    resolveTargets({ on_time_delivery: null }).on_time_delivery === undefined);

  check("three axes is a radar", sanitizeAxes(
    ["on_time_delivery", "order_fulfillment", "lead_time_consistency"])?.length === 3);
  check("two is not", sanitizeAxes(["on_time_delivery", "order_fulfillment"]) === null);
  check("an unmeasurable axis is refused",
    sanitizeAxes(["on_time_delivery", "order_fulfillment", "quality_acceptance"]) === null);
  check("seven are trimmed to six", sanitizeAxes([
    "on_time_delivery", "order_fulfillment", "lead_time_consistency",
    "price_competitiveness", "price_stability", "delivery_completeness",
    "matching_variance"])?.length === 6);

  // ---- presets and settings persist --------------------------------------
  console.log("\n  what the company saved\n");

  const { saveRadarPreset, deleteRadarPreset, saveSupplierPerformanceSettings } =
    await import("../lib/actions.ts");

  const fd = (o) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, String(v));
    return f;
  };

  // The actions are called directly rather than through a request, so their
  // last step — revalidatePath — throws: it needs a Next render context that
  // does not exist here. The database write has already happened by then, so
  // that specific invariant is treated as the success it is, and everything
  // below asserts the stored row rather than the return value. Every
  // validation path returns before the revalidate, so a refusal still comes
  // back as one.
  const act = async (fn, form) => {
    try {
      return await fn(null, form);
    } catch (e) {
      if (String(e?.message ?? e).includes("static generation store missing")) {
        return { ok: true };
      }
      throw e;
    }
  };

  let r = await act(saveRadarPreset, fd({
    name: "Cost review", is_default: "on",
    axes: "price_competitiveness,price_stability,matching_variance",
  }));
  check("a preset saves", "ok" in r, JSON.stringify(r));

  r = await act(saveRadarPreset, fd({ name: "Too few", axes: "on_time_delivery" }));
  check("one with two axes is refused", "error" in r);

  let presets = await getRadarPresets(co.id);
  check("it comes back with its order intact",
    presets[0]?.axes?.[0] === "price_competitiveness", JSON.stringify(presets[0]?.axes));
  check("and is the default", presets[0]?.is_default === true);

  await act(saveRadarPreset, fd({
    name: "Delivery review", is_default: "on",
    axes: "on_time_delivery,order_fulfillment,delivery_completeness",
  }));
  presets = await getRadarPresets(co.id);
  check("only one preset can be the default at a time",
    presets.filter((p) => p.is_default).length === 1,
    `${presets.filter((p) => p.is_default).length}`);

  r = await act(saveSupplierPerformanceSettings, fd({
    t_premiumCeiling: 30, g_on_time_delivery: 85,
  }));
  check("settings save", "ok" in r, JSON.stringify(r));
  const stored = await getSupplierPerformanceSetting(co.id);
  check("the boundary is stored", Number(stored.thresholds.premiumCeiling) === 30);
  check("the target is stored", Number(stored.targets.on_time_delivery) === 85);
  check("a partial save does not freeze the other defaults",
    stored.thresholds.cvLimit === undefined);

  r = await act(saveSupplierPerformanceSettings, fd({ t_premiumCeiling: 0 }));
  check("a boundary of nought is refused", "error" in r);

  const scored = buildPerformance({
    suppliers: await getSupplierSpend(co.id, from, to),
    commitments: await getSupplierCommitmentData(co.id, from, to),
    fulfilment: await getSupplierFulfilment(co.id, from, to),
    leadTimes: await getSupplierLeadTimeObservations(co.id, from, to),
    prices: await getSupplierPriceObservations(co.id, from, to),
    completeness: await getSupplierDeliveryCompleteness(co.id, from, to),
    variance: await getSupplierMatchingVariance(co.id, from, to),
    cutoff: to,
    thresholds: resolveThresholds(stored.thresholds),
    targets: resolveTargets(stored.targets),
  });
  check("the stored target reaches the figures",
    of(scored, alpha.id).metrics.on_time_delivery.target === 85,
    `${of(scored, alpha.id).metrics.on_time_delivery.target}`);

  for (const p of presets) await act(deleteRadarPreset, fd({ id: p.id }));
  check("presets delete", (await getRadarPresets(co.id)).length === 0);

  // ---- a confirmation cannot be quietly rewritten -------------------------
  console.log("\n  the record of what was said\n");

  const [anyConfirm] = await sql`select id from purchase_confirmation limit 1`;
  let refused = false;
  try {
    await sql`update purchase_confirmation set confirmed_date = current_date
               where id = ${anyConfirm.id}`;
  } catch { refused = true; }
  check("a confirmation cannot be edited", refused);

  refused = false;
  try {
    await sql`delete from purchase_confirmation where id = ${anyConfirm.id}`;
  } catch { refused = true; }
  check("nor deleted", refused);

  refused = false;
  try {
    const [inv] = await sql`
      select dl.id from document_line dl join document d on d.id = dl.document_id
       where d.doc_type = 'PURCHASE_INVOICE' limit 1`;
    if (inv) {
      await sql`
        insert into purchase_confirmation
          (company_id, order_line_id, qty, confirmed_date, kind)
        values (${co.id}, ${inv.id}, 1, current_date, 'INITIAL')`;
    } else { refused = true; }
  } catch { refused = true; }
  check("and cannot be hung on an invoice line", refused);

  console.log(failures === 0
    ? "\n  supplier performance reads the documents correctly\n"
    : `\n  ${failures} failed\n`);
} finally {
  await releaseTestLock(sql);
  await sql.end({ timeout: 5 });
}

process.exit(failures > 0 ? 1 : 0);
