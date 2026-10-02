import { NextRequest } from "next/server";
import {
  getCompany, getMatchedProfitability, getVariantProfitability, getInventoryAging,
} from "@/lib/queries";

/**
 * The same figures, as a file.
 *
 * A spreadsheet is where a manager actually argues with a number — sorts it
 * differently, puts last quarter beside it, shows somebody else. Refusing
 * to export is refusing the thing the report is for.
 *
 * CSV rather than xlsx: it opens in Excel, it is a format nothing can
 * silently reinterpret, and it needs no library. Numbers go out unformatted
 * and undelimited so a spreadsheet reads them as numbers — a thousands
 * separator here becomes text there.
 *
 * Built by calling the same queries the page calls, so the file cannot
 * disagree with the screen it was downloaded from.
 */

const asDate = (v: string | null) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/**
 * RFC 4180: quote anything containing a comma, quote or newline.
 *
 * Numerics are trimmed first. Postgres returns a division as thirty
 * decimal places, and 6000.0000000000000000000000000000 in a spreadsheet
 * column is unreadable — four is past anything money or quantity here
 * needs, and trailing zeros go.
 */
const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" && /^-?\d+\.\d+$/.test(v)) {
    return String(Number(Number(v).toFixed(4)));
  }
  if (typeof v === "number") return String(Number(v.toFixed(4)));
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) =>
  rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

/** What each variant is, flattened for a column. */
const variantOf = (v: unknown) =>
  Array.isArray(v)
    ? v.map((x: any) => `${x?.a}: ${x?.o}`).join(" / ")
    : "";

export async function GET(req: NextRequest) {
  const company = await getCompany();
  if (!company) return new Response("No company", { status: 404 });

  const q = req.nextUrl.searchParams;
  const tab = q.get("tab") ?? "matched";
  const locationId = q.get("location") || null;

  const today = new Date().toISOString().slice(0, 10);
  const askedTo = asDate(q.get("to"));
  // Clamped the same way the page clamps it, or the file would cover a
  // different window than the screen it came from.
  const shown = askedTo === null || askedTo > today ? today : askedTo;
  const to = new Date(new Date(shown).getTime() + 86400000).toISOString().slice(0, 10);
  const from = asDate(q.get("from"))
    ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  let name: string;
  let rows: unknown[][];

  if (tab === "aging") {
    const data = (await getInventoryAging(company.id, locationId)) as unknown as any[];
    name = "inventory-aging";
    rows = [
      ["Code", "Item", "Variant", "Unit", "On hand", "Value",
       "Average age (days)", "Oldest (days)", "Oldest received",
       "0-30", "31-60", "61-90", "91-180", "180+"],
      ...data.map((r) => [
        r.code, r.name, variantOf(r.variant), r.uom_code,
        r.qty, r.value, r.avg_age, r.oldest_days, r.oldest,
        r.v0 ?? 0, r.v30 ?? 0, r.v60 ?? 0, r.v90 ?? 0, r.v180 ?? 0,
      ]),
    ];
  } else if (tab === "period") {
    const data = (await getVariantProfitability(
      company.id, from, to, locationId)) as unknown as any[];
    name = "revenue-vs-cogs";
    rows = [
      ["Code", "Item", "Variant", "Unit", "Invoiced qty", "Revenue",
       "Shipped qty", "Cost", "Margin"],
      ...data.map((r) => [
        r.code, r.name, variantOf(r.variant), r.uom_code,
        r.qty_sold, r.revenue, r.qty_shipped, r.cogs, r.margin,
      ]),
    ];
  } else {
    const data = (await getMatchedProfitability(
      company.id, from, to, locationId)) as unknown as any[];
    name = "matched-profitability";
    rows = [
      ["Code", "Item", "Variant", "Unit", "Sold", "Revenue",
       "Matched revenue", "Cost", "Margin",
       "Lines exact", "Lines by item", "Lines unmatched",
       "Lines part shipped", "Return lines"],
      // A blank cost and a blank margin are deliberate: an unmatched line
      // has no cost, and writing nought there would make a spreadsheet
      // total it as free profit — the same mistake the page avoids.
      ...data.map((r) => [
        r.code, r.name, variantOf(r.variant), r.uom_code,
        r.qty, r.revenue, r.revenue_matched ?? "", r.cost ?? "", r.margin ?? "",
        r.n_exact, r.n_by_item, r.n_unmatched, r.n_part_shipped, r.n_returned,
      ]),
    ];
  }

  const filename = `${name}_${from}_to_${shown}.csv`;
  // The BOM itself, not just the promise of one.
  return new Response("\uFEFF" + csv(rows), {
    headers: {
      // Excel on Windows reads a BOM-less UTF-8 CSV as the local codepage,
      // which mangles Burmese item names. The BOM is three bytes that fix it.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
