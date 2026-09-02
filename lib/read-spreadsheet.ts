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

/** Column widths that make the template readable without fiddling. */
const TEMPLATE_WIDTHS = [5, 20, 28, 18, 16, 22, 10, 10, 12];

/**
 * A blank import workbook with the Barcode column already formatted as Text.
 *
 * Formatting it here is what stops the barcode problem happening at all. Left
 * to Excel's own judgement a 13-digit barcode becomes a number, loses any
 * leading zero and rounds past fifteen digits, and by the time the file is
 * uploaded the original is gone. A template that arrives correct is worth
 * more than an instruction the user has to remember.
 */
export async function buildImportTemplate(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP";
  const ws = wb.addWorksheet("Items");

  const header = ["No", "Barcode", "Stock Name", "Category", "Brand", "Location", "Qty", "Unit", "Unit Cost"];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  header.forEach((_, i) => { ws.getColumn(i + 1).width = TEMPLATE_WIDTHS[i]; });

  // '@' is Excel's text format. Applied to the whole column so it holds for
  // rows the user adds later, not only the examples below.
  ws.getColumn(2).numFmt = "@";

  const examples = [
    [1, "8851234567890", "Coca-Cola 300ml", "Beverages", "Coca-Cola", "Main Warehouse", 100, "Bottle", 600],
    [2, "8851234567891", "Sprite 300ml", "Beverages", "Sprite", "Main Warehouse", 80, "Bottle", 550],
    // The same barcode again at another warehouse: one product, two balances.
    [3, "8851234567890", "Coca-Cola 300ml", "Beverages", "Coca-Cola", "Yangon Warehouse", 50, "Bottle", 600],
  ];
  for (const e of examples) {
    const r = ws.addRow(e);
    r.getCell(2).numFmt = "@";
    r.font = { italic: true, color: { argb: "FF888888" } };
  }

  const note = ws.addRow([]);
  note.getCell(1).value =
    "Delete the three grey example rows before uploading. Category, Brand, Location and Unit must " +
    "already exist in the ERP — they are never created by an import. The same barcode in two " +
    "warehouses is one item with two stock balances, not two items.";
  ws.mergeCells(`A${note.number}:I${note.number}`);
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  note.height = 40;

  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}
