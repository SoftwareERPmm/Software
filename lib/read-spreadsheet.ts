import ExcelJS from "exceljs";

/**
 * Turning an uploaded file into rows of text.
 *
 * Server-side only. exceljs is a Node library and must not reach a browser
 * bundle; this module is imported solely from lib/actions.ts, which is
 * "use server", so it never does. Deliberately not marked with the
 * `server-only` package: that throws on import outside a Next.js request,
 * which would make this module impossible to test from a script, and the
 * bundling is verified against the build output instead.
 *
 * Reading .xlsx directly rather than asking for a CSV is not a convenience.
 * A 13-digit barcode is stored in the workbook as an exact number and only
 * *displayed* as 8.85123E+12; it is the save-as-CSV step that can write the
 * display out and lose the digits for good. Opening the workbook gets the
 * stored value, so the round trip that damages barcodes never happens.
 *
 * What it cannot rescue: a barcode typed into a numeric cell loses any
 * leading zeros before the file is ever saved, and anything past fifteen
 * significant digits is already rounded. Both are Excel deciding the value is
 * a quantity rather than a label, and the only cure is formatting the column
 * as Text. Hence the instruction on the upload screen either way.
 */
export type UploadFormat = "csv" | "xlsx";

/** How a cell reads once it is text. Dates and formulas are flattened to what
 *  a person would see, since every column here is a name, a code or a number. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const v = value as Record<string, unknown>;
  // A formula cell carries both the formula and its last computed result.
  if ("result" in v) return cellText(v.result);
  // Rich text arrives as runs that have to be joined back together.
  if ("richText" in v && Array.isArray(v.richText)) {
    return (v.richText as { text?: string }[]).map((r) => r.text ?? "").join("").trim();
  }
  if ("text" in v) return cellText(v.text);
  if ("hyperlink" in v && "text" in v) return cellText(v.text);
  return String(value).trim();
}

export async function xlsxToRows(base64: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, "base64") as unknown as ArrayBuffer);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error("That workbook has no sheets in it.");

  const rows: string[][] = [];
  let width = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // includeEmpty keeps blank cells in place; without it a row with a gap
    // would shift every later value one column to the left, silently into
    // the wrong field.
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell.value)));
    width = Math.max(width, cells.length);
    rows.push(cells);
  });

  // Pad short rows so the header's column positions hold for every row.
  for (const r of rows) while (r.length < width) r.push("");

  return rows.filter((r) => r.some((c) => c !== ""));
}
