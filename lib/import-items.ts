/**
 * Reading and checking an item/opening-stock spreadsheet.
 *
 * Everything here is pure: it takes text and existing master data and returns
 * a verdict. Nothing in this file writes. That is the point — the preview a
 * user confirms has to be produced by the same code that later performs the
 * import, and it cannot be if producing the preview has side effects.
 *
 * The rule throughout: the spreadsheet is input, the ERP is the source of
 * truth. The file may say "Beverages"; whether that is a category is the
 * database's answer, not the file's. Nothing here creates master data, and a
 * row naming a category, brand, unit or warehouse that does not exist is an
 * error rather than an invitation to invent one — two spellings of the same
 * category is exactly the mess an importer is supposed to prevent.
 */

export const IMPORT_COLUMNS = [
  "No", "Barcode", "Stock Name", "Category", "Brand", "Location", "Qty", "Unit", "Unit Cost",
] as const;

/** Columns a row cannot do without. "No" is a convenience for the reader and
 *  "Brand" is genuinely optional, so neither is required here. */
const REQUIRED_COLUMNS = ["Barcode", "Stock Name", "Category", "Location", "Qty", "Unit", "Unit Cost"];

export type MasterData = {
  items: { id: string; code: string; name: string; barcode: string | null;
           item_group_id: string; brand_id: string | null; base_uom_id: string }[];
  categories: { id: string; code: string; name: string }[];
  brands: { id: string; code: string; name: string }[];
  uoms: { id: string; code: string; name: string }[];
  locations: { id: string; code: string; name: string; parent_id: string | null;
               is_stock_location: boolean; is_active: boolean }[];
  /** item_id + location_id pairs that already hold stock. */
  existingStock: { item_id: string; location_id: string }[];
};

export type Issue = { row: number; column?: string; message: string };

export type PlannedRow = {
  row: number;
  barcode: string;
  name: string;
  itemId: string | null;        // set when the barcode matches an existing item
  categoryId: string;
  brandId: string | null;
  uomId: string;
  locationId: string;
  qty: number;
  unitCost: number;
  // Carried for the preview, so the screen can show what the file means
  // without looking anything up a second time.
  locationName: string;
  unitName: string;
  categoryName: string;
};

/** One product the file describes, however many warehouses it appears in. */
export type PlannedItem = {
  barcode: string;
  name: string;
  categoryName: string;
  isNew: boolean;
  locations: number;
  totalQty: number;
};

export type ImportPlan = {
  rows: PlannedRow[];
  /** The item master this file implies — one entry per barcode, not per row. */
  items: PlannedItem[];
  /**
   * Brand names the file uses that the brand master does not have, in the
   * order they first appear. Reported apart from the errors because this one
   * has an obvious remedy — register them — and a list of names is what that
   * remedy needs, where a list of failing row numbers is not.
   */
  missingBrands: string[];
  errors: Issue[];
  warnings: Issue[];
  summary: {
    rows: number; newItems: number; existingItems: number;
    stockRows: number; totalUnits: number;
  };
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

  // Nothing close by spelling. "Mandalay WH" is seven edits from "Mandalay
  // Warehouse" and no containment match either, but it is obviously the same
  // place — so fall back to the first word. Requiring the FIRST word rather
  // than any word is what keeps this honest: "Nowhere Warehouse" shares
  // "warehouse" with every warehouse in the company and must not be answered
  // with whichever one happens to sort first.
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

export function planImport(rowsIn: string[][], master: MasterData): ImportPlan {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const rows: PlannedRow[] = [];

  if (rowsIn.length === 0) {
    return { rows, items: [], missingBrands: [],
             errors: [{ row: 0, message: "The file is empty." }], warnings,
             summary: { rows: 0, newItems: 0, existingItems: 0, stockRows: 0, totalUnits: 0 } };
  }

  // ---- header -------------------------------------------------------------
  const header = rowsIn[0].map((h) => h.trim());
  const indexOf = new Map<string, number>();
  header.forEach((h, i) => indexOf.set(norm(h), i));

  const missing = REQUIRED_COLUMNS.filter((c) => !indexOf.has(norm(c)));
  if (missing.length > 0) {
    errors.push({ row: 1, message: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` });
    return { rows, items: [], missingBrands: [], errors, warnings,
             summary: { rows: 0, newItems: 0, existingItems: 0, stockRows: 0, totalUnits: 0 } };
  }
  const col = (name: string) => indexOf.get(norm(name))!;
  const cell = (r: string[], name: string) => (r[col(name)] ?? "").trim();

  // ---- lookups, by both code and name so either spelling in the sheet works
  const byNameOrCode = <T extends { id: string; code: string; name: string }>(list: T[]) => {
    const m = new Map<string, T>();
    for (const x of list) { m.set(norm(x.name), x); m.set(norm(x.code), x); }
    return m;
  };
  const categories = byNameOrCode(master.categories);
  const brands = byNameOrCode(master.brands);
  const uoms = byNameOrCode(master.uoms);
  const locations = byNameOrCode(master.locations);
  const itemByBarcode = new Map(
    master.items.filter((i) => i.barcode).map((i) => [i.barcode!.trim(), i])
  );
  const stockPairs = new Set(master.existingStock.map((s) => `${s.item_id}|${s.location_id}`));

  // Same barcode twice in the file must agree about what the item is, and the
  // same item may not be stocked into the same warehouse twice.
  const missingBrands: string[] = [];
  const seenBarcodeName = new Map<string, { name: string; row: number }>();
  const seenPairs = new Map<string, number>();

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
    const name = cell(r, "Stock Name");
    const categoryText = cell(r, "Category");
    const brandText = cell(r, "Brand");
    const locationText = cell(r, "Location");
    const qtyText = cell(r, "Qty");
    const unitText = cell(r, "Unit");
    const costText = cell(r, "Unit Cost");

    // ---- barcode ----------------------------------------------------------
    if (!barcode) {
      add("Barcode is empty. Every row needs one — it is what matches a row to an item, "
        + "and what keeps the same product in two warehouses from becoming two products.", "Barcode");
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
    if (brandText) {
      const brand = brands.get(norm(brandText));
      if (!brand) {
        if (!missingBrands.some((b) => norm(b) === norm(brandText))) missingBrands.push(brandText);
        add(`Brand "${brandText}" is not in the brand list.` + didYouMean(brandText, master.brands) +
            ` Register it, or leave the cell blank if this product has no brand.`, "Brand");
      }
      else brandId = brand.id;
    } else {
      warnings.push({ row: rowNo, column: "Brand", message: "Brand is blank." });
    }

    const uom = uoms.get(norm(unitText));
    if (!unitText) add("Unit is empty — without it the quantity has no meaning.", "Unit");
    else if (!uom) {
      add(`Unit "${unitText}" is not a unit of measure here.` + didYouMean(unitText, master.uoms) +
          ` Abbreviations are not guessed — "Btl" is not read as "Bottle", because guessing a unit ` +
          `changes what the quantity means.`, "Unit");
    }

    const location = locations.get(norm(locationText));
    if (!locationText) {
      add("Location is empty. Stock has to be somewhere — name the warehouse holding it.", "Location");
    }
    else if (!location) {
      add(`Warehouse "${locationText}" does not exist.` +
          didYouMean(locationText, master.locations.filter((l) => l.is_stock_location)) +
          ` Warehouses are never created by an import — add it under Branches & warehouses first.`,
          "Location");
    } else if (!location.is_active) {
      add(`Warehouse "${locationText}" is inactive, so stock cannot be placed in it. ` +
          `Reactivate it under Branches & warehouses, or name a different warehouse.`, "Location");
    } else if (!location.is_stock_location) {
      // The case worth explaining rather than just rejecting: a branch is an
      // organisational unit and holds nothing. Its warehouses do, and naming
      // them is more use than telling someone they were wrong.
      const inside = master.locations
        .filter((l) => l.parent_id === location.id && l.is_stock_location && l.is_active)
        .map((l) => `"${l.name}"`);
      add(
        `"${locationText}" is a branch, not a warehouse. A branch is an organisational unit ` +
        `and holds no stock; the warehouses inside it do. ` +
        (inside.length
          ? `Use ${inside.join(" or ")} instead.`
          : `This branch has no active warehouse yet — create one under Branches & warehouses.`),
        "Location"
      );
    }

    // ---- quantity and cost ------------------------------------------------
    const qty = Number(qtyText);
    if (!qtyText) add("Qty is empty. Use 0 if this item is stocked here but currently empty.", "Qty");
    else if (!/^-?\d+(\.\d+)?$/.test(qtyText)) add(`Qty "${qtyText}" is not a number.`, "Qty");
    else if (qty < 0) add("Opening stock cannot be negative.", "Qty");
    else if (qty === 0) warnings.push({ row: rowNo, column: "Qty", message: "Qty is zero — nothing will be stocked." });

    const unitCost = Number(costText);
    if (!costText) {
      add("Unit Cost is required — stock imported without a cost is valued at nothing.", "Unit Cost");
    } else if (!/^\d+(\.\d+)?$/.test(costText)) {
      add(`Unit Cost "${costText}" is not a number.`, "Unit Cost");
    } else if (unitCost <= 0 && qty > 0) {
      add("Unit Cost must be greater than zero.", "Unit Cost");
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
        warnings.push({ row: rowNo, message: `Barcode ${barcode} already exists — the existing item will be used.` });
      }
    }

    // ---- the file disagreeing with itself ---------------------------------
    if (barcode && name) {
      const seen = seenBarcodeName.get(barcode);
      if (seen && norm(seen.name) !== norm(name)) {
        add(`Barcode ${barcode} is used for "${seen.name}" on row ${seen.row} and "${name}" here.`, "Barcode");
      } else if (!seen) {
        seenBarcodeName.set(barcode, { name, row: rowNo });
      }
    }

    if (barcode && location) {
      const key = `${barcode}|${location.id}`;
      const seen = seenPairs.get(key);
      if (seen) {
        add(
          `${barcode} is already stocked into "${locationText}" on row ${seen}. ` +
          `Combine them into one row rather than importing both.`, "Location"
        );
      } else {
        seenPairs.set(key, rowNo);
      }
    }

    // ---- stock that is already there --------------------------------------
    // Blocked rather than added to. The user almost certainly means "the
    // opening balance is 100", and quietly making it 200 is the kind of
    // error nobody finds until a stock count disagrees months later.
    if (existing && location && stockPairs.has(`${existing.id}|${location.id}`)) {
      add(
        `"${existing.name}" already holds stock in "${locationText}". ` +
        `Importing would add to it. Use a stock adjustment instead.`, "Qty"
      );
    }

    if (errors.length > errorsBefore) continue;

    rows.push({
      row: rowNo,
      barcode,
      name,
      itemId: existing?.id ?? null,
      categoryId: category!.id,
      brandId,
      uomId: uom!.id,
      locationId: location!.id,
      qty,
      unitCost,
      locationName: location!.name,
      unitName: uom!.name,
      categoryName: category!.name,
    });
  }

  // What the file means, as the ERP reads it. One item per barcode however
  // many warehouses it appears in — that an item repeated across locations is
  // one product with several balances, not several products, is the single
  // thing most worth showing back to whoever is about to press Confirm.
  const items: PlannedItem[] = [];
  const byBarcode = new Map<string, PlannedItem>();
  for (const r of rows) {
    let entry = byBarcode.get(r.barcode);
    if (!entry) {
      entry = {
        barcode: r.barcode, name: r.name, categoryName: r.categoryName,
        isNew: !r.itemId, locations: 0, totalQty: 0,
      };
      byBarcode.set(r.barcode, entry);
      items.push(entry);
    }
    entry.locations++;
    entry.totalQty = Math.round((entry.totalQty + r.qty) * 10000) / 10000;
  }

  return {
    rows,
    items,
    missingBrands,
    errors,
    warnings,
    summary: {
      rows: Math.max(0, rowsIn.length - 1),
      newItems: items.filter((i) => i.isNew).length,
      existingItems: items.filter((i) => !i.isNew).length,
      stockRows: rows.filter((r) => r.qty > 0).length,
      totalUnits: Math.round(rows.reduce((s, r) => s + r.qty, 0) * 10000) / 10000,
    },
  };
}
