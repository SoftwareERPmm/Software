import { NextRequest } from "next/server";
import {
  getCompany, getSupplierSpend, getSupplierCommitmentData, getSupplierFulfilment,
  getSupplierLeadTimeObservations, getSupplierPriceObservations,
  getSupplierDeliveryCompleteness, getSupplierMatchingVariance,
} from "@/lib/queries";
import { requireFeature } from "@/lib/plans";
import { METRICS, CALC_VERSION, type MetricId } from "@/lib/supplier-metrics";
import { buildPerformance } from "@/lib/supplier-performance";

/**
 * The same figures, as a file.
 *
 * Built by calling the same queries and the same buildPerformance the page
 * calls, so the file cannot disagree with the screen it was downloaded
 * from. A supplier review runs off a spreadsheet, and a spreadsheet that
 * says something different from the dashboard is worse than no spreadsheet.
 *
 * One row per supplier per metric rather than a wide grid: a metric has a
 * measurement, a score, a sample size and a reason for being absent, and
 * flattening four facts into one cell loses the three that explain the
 * first. Long format also survives a new metric being added without every
 * saved pivot breaking.
 */

const asDate = (v: string | null) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(Number(v.toFixed(4)));
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) =>
  rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export async function GET(req: NextRequest) {
  const company = await getCompany();
  if (!company) return new Response("No company", { status: 404 });

  // Server-side, so the file cannot be fetched by a Starter company that
  // guessed the URL after the navigation link was hidden from them. Still
  // not security — there is nobody to authenticate — but the gate is at
  // least in the same place as the data rather than only in the markup.
  if (!requireFeature(company.plan, "supplier_performance")) {
    return new Response("Not available on this plan", { status: 404 });
  }

  const q = req.nextUrl.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const asked = asDate(q.get("to"));
  const to = asked === null || asked > today ? today : asked;
  const from = asDate(q.get("from"))
    ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  const [spend, commitments, fulfilment, leadTimes, prices, completeness, variance] =
    await Promise.all([
      getSupplierSpend(company.id, from, to),
      getSupplierCommitmentData(company.id, from, to),
      getSupplierFulfilment(company.id, from, to),
      getSupplierLeadTimeObservations(company.id, from, to),
      getSupplierPriceObservations(company.id, from, to),
      getSupplierDeliveryCompleteness(company.id, from, to),
      getSupplierMatchingVariance(company.id, from, to),
    ]);

  const rows = buildPerformance({
    suppliers: spend, commitments, fulfilment, leadTimes, prices,
    completeness, variance, cutoff: to,
  });

  const out: unknown[][] = [[
    "Supplier code", "Supplier", "Metric", "Measured", "Unit", "Score",
    "Target", "Sample", "Availability", "From", "To", "Calc version",
  ]];

  for (const r of rows) {
    for (const id of Object.keys(METRICS) as MetricId[]) {
      const m = r.metrics[id];
      const def = METRICS[id];
      out.push([
        r.code, r.name, def.name,
        // Blank, not zero: an unmeasured metric totalled as nought would
        // make a spreadsheet average it into everyone else's score.
        m.raw === null ? "" : m.raw,
        def.unit === "" ? "ratio" : def.unit.trim(),
        m.score === null ? "" : Math.round(m.score),
        m.target ?? "",
        m.n || "",
        m.unavailable ?? "measured",
        from, to, CALC_VERSION,
      ]);
    }
  }

  const filename = `supplier-performance_${from}_to_${to}.csv`;
  return new Response("﻿" + csv(out), {
    headers: {
      // Excel on Windows reads a BOM-less UTF-8 CSV as the local codepage,
      // which mangles Burmese supplier names.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
