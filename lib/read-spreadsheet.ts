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
const TEMPLATE_WIDTHS = [5, 20, 14, 34, 20, 20, 18, 14];

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

  const header = ["No", "Barcode", "Stock ID", "Stock Name", "Category", "Sub Category", "Brand", "Unit"];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  header.forEach((_, i) => { ws.getColumn(i + 1).width = TEMPLATE_WIDTHS[i]; });

  // '@' is Excel's text format. Applied to the whole column so it holds for
  // rows the user adds later, not only the examples below. Stock ID gets it
  // for the same reason as Barcode: a Stock ID of "0012" is not the number
  // twelve, and losing the leading zeros changes the item's code.
  ws.getColumn(2).numFmt = "@";
  ws.getColumn(3).numFmt = "@";

  const examples = [
    [1, "8851234567890", "Item001", "Coca-Cola 300ml", "Beverages", "Soft Drinks", "Coca-Cola", "Bottle"],
    [2, "8851234567891", "Item002", "Sprite 300ml", "Beverages", "Soft Drinks", "Sprite", "Bottle"],
    // Stock ID and Sub Category both left blank: the item is filed under the
    // category itself, and given the next number in it.
    [3, "10001", "", "T-Shirt Black L", "Clothing", "", "", "Piece"],
  ];
  for (const e of examples) {
    const r = ws.addRow(e);
    r.getCell(2).numFmt = "@";
    r.getCell(3).numFmt = "@";
    r.font = { italic: true, color: { argb: "FF888888" } };
  }

  const note = ws.addRow([]);
  note.getCell(1).value =
    "Delete the three grey example rows before uploading. Category, Brand and Unit must already " +
    "exist in the ERP, but any the sheet names can be registered from the preview before " +
    "importing. Sub Category and Brand may be left blank; an item with no sub category is filed " +
    "under its category. " +
    "Stock ID is the item's own piece of its code: the category's code goes in front of it, so a " +
    "category coded 001 and a Stock ID of Item001 make 001Item001. Leave it blank to be given the " +
    "next number in that category. One row per item: this sheet sets up what the items ARE, and " +
    "carries no quantity, cost or warehouse — stock arrives on a goods receipt, or on a stock " +
    "adjustment for opening balances.";
  ws.mergeCells(`A${note.number}:H${note.number}`);
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  note.height = 66;

  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

/**
 * A blank receipt workbook whose columns are the fields the receipt screen
 * asks for, in the order it asks for them. Someone who has entered one
 * receipt by hand should recognise the sheet without being taught it.
 */
export async function buildVoucherTemplate(columns: string[], kind: "cash" | "bank"): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP";
  const ws = wb.addWorksheet(kind === "cash" ? "Cash receipts" : "Bank receipts");

  ws.addRow(columns);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  [5, 14, 24, 26, 14, 18, 20, 34].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Dates as text, so Excel cannot reformat one into a shape the sheet did
  // not intend — and the importer refuses an ambiguous 03/04/2026 anyway.
  ws.getColumn(2).numFmt = "@";

  const money = kind === "cash" ? "Cash on Hand" : "Cash at Bank";
  const examples = [
    [1, "2026-09-02", money, "Other Income", 150000, "Yangon Branch", "RCP-001", "Scrap sale"],
    [2, "2026-09-02", money, "Other Income", 42000, "Mandalay Branch", "RCP-002", "Rent recovered"],
  ];
  for (const e of examples) {
    const r = ws.addRow(e);
    r.getCell(2).numFmt = "@";
    r.font = { italic: true, color: { argb: "FF888888" } };
  }

  const note = ws.addRow([]);
  note.getCell(1).value =
    "Delete the two grey example rows before uploading. One row is one receipt. Dates as YYYY-MM-DD. " +
    "Received From must be an account in the chart that can be posted to — not a heading, and not " +
    "Accounts Receivable, which is maintained by the sales ledger: record money from a customer " +
    "against their invoice instead. Branch may be left blank, but then the receipt appears in no " +
    "branch's figures.";
  ws.mergeCells(`A${note.number}:H${note.number}`);
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  note.height = 56;

  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}
