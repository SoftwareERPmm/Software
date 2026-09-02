/**
 * Reading and checking an item spreadsheet.
 *
 * Everything here is pure: it takes text and existing master data and returns
 * a verdict. Nothing in this file writes. That is the point — the preview a
 * user confirms has to be produced by the same code that later performs the
 * import, and it cannot be if producing the preview has side effects.
 *
 * The rule throughout: the spreadsheet is input, the ERP is the source of
 * truth. The file may say "Beverages"; whether that is a category is the
 * database's answer, not the file's. Nothing here creates master data, and a
 * row naming a category, brand or unit that does not exist is an error rather
 * than an invitation to invent one — two spellings of the same category is
 * exactly the mess an importer is supposed to prevent.
 *
 * The Stock ID column is the item's own piece of its code. The database
 * composes the full code as the category's code followed by that piece — a
 * Beverages category coded 001 and a sheet saying Item001 make 001Item001 —
 * and maintains it by trigger, so `code` is never written directly here. Left
 * blank, the next number in that category is used instead.
 *
 * This sheet answers one question: **what items does this company deal in?**
 * It does not carry quantity, cost or warehouse, because none of those are
 * properties of an item. How many there are is the result of goods receipts,
 * deliveries, transfers and adjustments; what they cost is the FIFO layer a
 * receipt created. An item that has never been received is a perfectly good
 * item with no stock — so the two are imported separately, and opening stock
 * is entered as the stock document it actually is.
 */

export const IMPORT_COLUMNS = [
  "No", "Barcode", "Stock ID", "Stock Name", "Category", "Brand", "Unit",
] as const;

/**
 * Columns a row cannot do without. "No" is a convenience for the reader,
 * "Brand" is genuinely optional, and "Stock ID" is optional in both senses —
 * the column may be absent and a cell may be blank, in which case the next
 * number in that category is assigned, which is what the importer did before
 * the column existed.
 */
const REQUIRED_COLUMNS = ["Barcode", "Stock Name", "Category", "Unit"];

export type MasterData = {
  items: { id: string; code: string; serial: string; name: string; barcode: string | null;
           item_group_id: string; brand_id: string | null; base_uom_id: string }[];
  categories: { id: string; code: string; name: string }[];
  brands: { id: string; code: string; name: string }[];
  uoms: { id: string; code: string; name: string }[];
};

export type Issue = { row: number; column?: string; message: string };

/**
 * One item the file describes. There is exactly one row per item now — with
 * no warehouse column there is nothing to repeat a barcode for, so a second
 * appearance is a duplicate rather than a second balance.
 */
export type PlannedRow = {
  row: number;
  barcode: string;
  name: string;
  itemId: string | null;        // set when the barcode matches an existing item
  isNew: boolean;
  categoryId: string;
  brandId: string | null;
  uomId: string;
  /**
   * The item's own piece of the code — what the Stock ID column holds, or the
   * next number in the category when it was left blank. `code` is this
   * appended to the category's code, exactly as the database composes it, so
   * the preview shows the identifier the item will actually carry.
   */
  serial: string;
  code: string;
  serialAssigned: boolean;      // true when the sheet did not say
  // Carried for the preview, so the screen can show what the file means
  // without looking anything up a second time.
  unitName: string;
  categoryName: string;
  brandName: string | null;
};

export type ImportPlan = {
  rows: PlannedRow[];
  /**
   * Brand names the file uses that the brand master does not have, in the
   * order they first appear. Reported apart from the errors because this one
   * has an obvious remedy — register them — and a list of names is what that
   * remedy needs, where a list of failing row numbers is not.
   */
  missingBrands: string[];
  errors: Issue[];
  warnings: Issue[];
  summary: { rows: number; newItems: number; existingItems: number };
};

/* ------------------------------------------------------------------ CSV -- */

/**
 * A CSV reader that understands quoting, because a name like
 * "Coca-Cola 300ml, 6-pack" is ordinary and splitting on commas would tear it
 * in half and shift every later column by one — silently, into the wrong
 * field, which is worse than failing.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  const src = text.replace(/^﻿/, "");   // Excel writes a BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/* ----------------------------------------------------------- validation -- */

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Excel turns a long barcode into a float and shows it as 8.85123E+12. The
 * damage is done before the file reaches us: 8851234567890 and
 * 8851234567891 both render that way, so the digits that told them apart are
 * gone and no amount of parsing brings them back. Guessing would silently
 * merge two products into one, so this refuses instead and says what to fix.
 */
function scientificNotation(v: string): boolean {
  return /^\d+(\.\d+)?[eE][+-]?\d+$/.test(v.trim());
}

/** Edit distance, capped — only used to decide whether to offer a suggestion. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * The nearest existing name to what the sheet said, when there is an obvious
 * one. "Category Beverages not found" tells a user their file is wrong;
 * "did you mean Beverage?" tells them what to change, which is the difference
 * between an error they can act on and one they have to go hunting for.
 */
function suggest(typed: string, candidates: { name: string }[]): string | null {
  const t = norm(typed);
  if (!t) return null;
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = distance(t, norm(c.name));
    if (d <= 3 && (!best || d < best.d)) best = { name: c.name, d };
  }
  if (best) return best.name;

  // Nothing close by spelling. "Soft Drink" is several edits from "Soft
  // Drinks & Water" and no containment match either, but it is obviously the
  // same thing — so fall back to the first word. Requiring the FIRST word
  // rather than any word is what keeps this honest: "Nowhere Drinks" shares
  // "drinks" with every drinks category and must not be answered with
  // whichever one happens to sort first.
  const firstWord = t.split(/\s+/)[0];
  if (firstWord.length >= 3) {
    const sameStart = candidates.find((c) => norm(c.name).split(/\s+/)[0] === firstWord);
    if (sameStart) return sameStart.name;
  }

  const partial = candidates.find((c) => norm(c.name).includes(t) || t.includes(norm(c.name)));
  return partial ? partial.name : null;
}

const didYouMean = (typed: string, candidates: { name: string }[]) => {
  const s = suggest(typed, candidates);
  return s ? ` Did you mean "${s}"?` : "";
};

const empty = (errors: Issue[], warnings: Issue[] = []): ImportPlan => ({
  rows: [], missingBrands: [], errors, warnings,
  summary: { rows: 0, newItems: 0, existingItems: 0 },
});

export function planImport(rowsIn: string[][], master: MasterData): ImportPlan {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const rows: PlannedRow[] = [];

  if (rowsIn.length === 0) return empty([{ row: 0, message: "The file is empty." }]);

  // ---- header -------------------------------------------------------------
  const header = rowsIn[0].map((h) => h.trim());
  const indexOf = new Map<string, number>();
  header.forEach((h, i) => indexOf.set(norm(h), i));

  const missing = REQUIRED_COLUMNS.filter((c) => !indexOf.has(norm(c)));
  if (missing.length > 0) {
    return empty([{
      row: 1,
      message: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    }], warnings);
  }

  // A sheet still carrying the old stock columns is worth naming rather than
  // ignoring: whoever filled it in meant those numbers to land somewhere, and
  // silently dropping them would look like they had.
  for (const stale of ["Qty", "Unit Cost", "Location"]) {
    if (indexOf.has(norm(stale))) {
      warnings.push({
        row: 1, column: stale,
        message:
          `"${stale}" is ignored — this sheet sets up items only. Quantity, cost and ` +
          `warehouse come from stock documents (goods receipt, or a stock adjustment ` +
          `for opening balances), not from the item master.`,
      });
    }
  }

  const col = (name: string) => indexOf.get(norm(name))!;
  const cell = (r: string[], name: string) => (r[col(name)] ?? "").trim();
  const has = (name: string) => indexOf.has(norm(name));

  // ---- lookups, by both code and name so either spelling in the sheet works
  const byNameOrCode = <T extends { id: string; code: string; name: string }>(list: T[]) => {
    const m = new Map<string, T>();
    for (const x of list) { m.set(norm(x.name), x); m.set(norm(x.code), x); }
    return m;
  };
  const categories = byNameOrCode(master.categories);
  const brands = byNameOrCode(master.brands);
  const uoms = byNameOrCode(master.uoms);
  const itemByBarcode = new Map(
    master.items.filter((i) => i.barcode).map((i) => [i.barcode!.trim(), i])
  );
  const itemByCode = new Map(master.items.map((i) => [norm(i.code), i]));

  /**
   * The next free number in a category, for rows that name no Stock ID.
   *
   * Counted here rather than left to the database so the preview can show the
   * code the item will carry instead of a blank. Only all-digit serials are
   * considered, matching what the importer has always done — a serial of
   * "Item001" is not a number and must not push the counter past it.
   */
  const nextSerial = new Map<string, number>();
  const takeNextSerial = (categoryId: string, categoryCode: string): string => {
    let n = nextSerial.get(categoryId);
    if (n === undefined) {
      n = master.items
        .filter((i) => i.item_group_id === categoryId && /^[0-9]+$/.test(i.serial ?? ""))
        .reduce((max, i) => Math.max(max, Number(i.serial)), 0) + 1;
    }
    // Step over anything already spoken for, whether by an item in the
    // database or by a Stock ID typed further up this same file. A number
    // nobody asked for must not be the thing that fails the import.
    let serial = String(n).padStart(3, "0");
    while (itemByCode.has(norm(`${categoryCode}${serial}`)) ||
           seenCode.has(norm(`${categoryCode}${serial}`))) {
      n++;
      serial = String(n).padStart(3, "0");
    }
    nextSerial.set(categoryId, n + 1);
    return serial;
  };

  const missingBrands: string[] = [];
  const seenBarcode = new Map<string, number>();
  const seenCode = new Map<string, number>();

  for (let i = 1; i < rowsIn.length; i++) {
    const r = rowsIn[i];
    const rowNo = i + 1;                       // 1-based, counting the header
    // Counted rather than searched for. Asking "does this row have an error?"
    // by scanning every error found so far is quadratic, and a 5,000-row file
    // with a systematic mistake — one wrong column name, say — is precisely
    // the case where every row fails and the scan is longest.
    const errorsBefore = errors.length;
    const add = (message: string, column?: string) => errors.push({ row: rowNo, column, message });

    const barcode = cell(r, "Barcode");
    const stockId = has("Stock ID") ? cell(r, "Stock ID") : "";
    const name = cell(r, "Stock Name");
    const categoryText = cell(r, "Category");
    const brandText = has("Brand") ? cell(r, "Brand") : "";
    const unitText = cell(r, "Unit");

    // ---- barcode ----------------------------------------------------------
    if (!barcode) {
      add("Barcode is empty. Every row needs one — it is what tells this item apart "
        + "from every other, and what matches a row to an item already here.", "Barcode");
    }
    else if (scientificNotation(barcode)) {
      add(
        `Barcode reads "${barcode}" — Excel has stored it as a number and lost digits. ` +
        `Format the Barcode column as Text and re-enter it.`, "Barcode"
      );
    } else if (!/^[0-9A-Za-z._-]+$/.test(barcode)) {
      add(`Barcode "${barcode}" contains characters that are not allowed.`, "Barcode");
    }

    if (!name) add("Stock Name is empty.", "Stock Name");

    // ---- stock id ---------------------------------------------------------
    // Kept narrow deliberately. This becomes part of the item's code, which is
    // printed on documents, typed into search boxes and sorted on — a space or
    // a comma in it turns into a code nobody can type back.
    if (stockId && !/^[0-9A-Za-z._\/-]+$/.test(stockId)) {
      add(`Stock ID "${stockId}" contains characters that are not allowed. ` +
          `Letters, digits, dot, dash, underscore and slash only — it becomes part ` +
          `of the item's code, which has to stay typeable.`, "Stock ID");
    }

    // ---- master data ------------------------------------------------------
    const category = categories.get(norm(categoryText));
    if (!categoryText) {
      add("Category is empty. Every item belongs to one, and an import will not invent it.", "Category");
    }
    else if (!category) {
      add(`Category "${categoryText}" is not in the item categories.` +
          didYouMean(categoryText, master.categories) +
          ` Categories are never created by an import — add it under Master data first, or correct the sheet.`,
          "Category");
    }

    let brandId: string | null = null;
    let brandName: string | null = null;
    if (brandText) {
      const brand = brands.get(norm(brandText));
      if (!brand) {
        if (!missingBrands.some((b) => norm(b) === norm(brandText))) missingBrands.push(brandText);
        add(`Brand "${brandText}" is not in the brand list.` + didYouMean(brandText, master.brands) +
            ` Register it, or leave the cell blank if this product has no brand.`, "Brand");
      }
      else { brandId = brand.id; brandName = brand.name; }
    } else {
      warnings.push({ row: rowNo, column: "Brand", message: "Brand is blank." });
    }

    const uom = uoms.get(norm(unitText));
    if (!unitText) {
      add("Unit is empty. It is the unit every quantity of this item will be counted in, "
        + "so it has to be settled before the item exists.", "Unit");
    }
    else if (!uom) {
      add(`Unit "${unitText}" is not a unit of measure here.` + didYouMean(unitText, master.uoms) +
          ` Abbreviations are not guessed — "Btl" is not read as "Bottle", because guessing a unit ` +
          `changes what every quantity of this item means. Add it under Units first.`, "Unit");
    }

    // ---- the item this row refers to --------------------------------------
    const existing = barcode ? itemByBarcode.get(barcode) : undefined;
    if (existing) {
      if (norm(existing.name) !== norm(name) && name) {
        add(
          `Barcode ${barcode} already belongs to "${existing.name}". ` +
          `Correct the sheet, or rename the item first if it really has changed.`, "Stock Name"
        );
      } else {
        warnings.push({
          row: rowNo,
          message: `Barcode ${barcode} already exists — "${existing.name}" is left as it is.`,
        });
      }
    }

    // ---- the file disagreeing with itself ---------------------------------
    // One row per item, so a repeated barcode is a duplicate rather than a
    // second balance somewhere. Refused rather than merged: which of the two
    // rows was meant is not something to guess at.
    if (barcode) {
      const seen = seenBarcode.get(barcode);
      if (seen) {
        add(`Barcode ${barcode} is already on row ${seen}. An item belongs on one row — ` +
            `delete the duplicate.`, "Barcode");
      } else {
        seenBarcode.set(barcode, rowNo);
      }
    }

    // A Stock ID that disagrees with an item already carrying that barcode is
    // worth saying out loud. The item is left alone either way — an import
    // does not renumber a catalogue — but silently ignoring the column the
    // user just filled in would be its own kind of wrong.
    if (existing && stockId && norm(existing.serial ?? "") !== norm(stockId)) {
      warnings.push({
        row: rowNo, column: "Stock ID",
        message: `"${existing.name}" already has the Stock ID ${existing.serial} ` +
                 `(code ${existing.code}). The sheet says ${stockId}; the existing one is kept.`,
      });
    }

    if (errors.length > errorsBefore) continue;

    // ---- the code this row will carry -------------------------------------
    // Composed exactly as fn_set_item_code does it — the category's code
    // followed by the item's own piece — so what the preview shows is what the
    // database will store, not an approximation of it.
    const assigned = !stockId;
    const serial = existing
      ? (existing.serial ?? "")
      : (stockId || takeNextSerial(category!.id, category!.code));
    const code = existing ? existing.code : `${category!.code}${serial}`;

    // Two rows landing on one code, or a code an item already has. Both are
    // refused rather than resolved: the unique constraint would abort the
    // whole import at the very end, and a row number now is worth more than a
    // constraint violation after four hundred rows have been read.
    if (!existing) {
      const key = norm(code);
      const clash = seenCode.get(key);
      const taken = itemByCode.get(key);
      if (clash) {
        add(`Stock ID ${serial} in ${category!.name} makes the code ${code}, ` +
            `which row ${clash} already takes.`, "Stock ID");
      } else if (taken) {
        add(`Stock ID ${serial} in ${category!.name} makes the code ${code}, ` +
            `which already belongs to "${taken.name}". Give this item a different ` +
            `Stock ID, or match the existing item by its barcode.`, "Stock ID");
      } else {
        seenCode.set(key, rowNo);
      }
    }

    if (errors.length > errorsBefore) continue;

    rows.push({
      row: rowNo,
      barcode,
      name,
      itemId: existing?.id ?? null,
      isNew: !existing,
      categoryId: category!.id,
      brandId,
      uomId: uom!.id,
      serial,
      code,
      serialAssigned: assigned,
      unitName: uom!.name,
      categoryName: category!.name,
      brandName,
    });
  }

  return {
    rows,
    missingBrands,
    errors,
    warnings,
    summary: {
      rows: Math.max(0, rowsIn.length - 1),
      newItems: rows.filter((r) => r.isNew).length,
      existingItems: rows.filter((r) => !r.isNew).length,
    },
  };
}
