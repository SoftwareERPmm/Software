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
  "No", "Barcode", "Stock ID", "Stock Name", "Category", "Sub Category", "Brand", "Unit",
  "Selling price",
] as const;

/**
 * Columns a row cannot do without. "No" is a convenience for the reader,
 * "Brand" and "Selling price" are genuinely optional.
 *
 * Neither identifier is here. A barcode belongs to the goods and plenty of
 * goods have none — loose rice, own-packed sacks, anything sold by weight,
 * and every service — so requiring one made those items unimportable. A Stock
 * ID is ours and can always be assigned. What a row cannot do without is
 * *one of the two*, which is a rule about rows rather than about columns and
 * is enforced as such below.
 */
const REQUIRED_COLUMNS = ["Stock Name", "Category", "Unit"];

/** At least one of these must be a column, or no row can carry an identifier. */
const IDENTIFIER_COLUMNS = ["Barcode", "Stock ID"];

/**
 * What other systems call our columns.
 *
 * A customer arriving from an incumbent system has a spreadsheet already, and
 * its headings are whatever that system called them. Rejecting the file until
 * they are renamed is a chore that teaches nothing — the file is right, the
 * words differ. These are the names those columns actually carry in the wild:
 * "UOM" for Unit, "Item Group" for Category, "Product Name" for Stock Name.
 *
 * An alias is only consulted when the real column is absent, and taking one
 * is always said out loud in the warnings. Reading somebody's "Description"
 * column as the item's name without telling them is how an import quietly
 * does the wrong thing to four hundred rows.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  "Stock ID": ["item code", "stock code", "product code", "sku", "item no", "item number", "code"],
  "Stock Name": ["item name", "product name", "name", "item", "product", "description"],
  "Barcode": ["bar code", "ean", "upc", "gtin", "barcode no"],
  "Category": ["item group", "product group", "item category", "group"],
  "Sub Category": ["sub group", "subcategory", "sub-category", "item sub group", "sub item group"],
  "Brand": ["make", "manufacturer"],
  "Unit": ["uom", "unit of measure", "base unit", "stock uom", "base uom"],
  "Selling price": ["price", "sale price", "sales price", "unit price", "rate",
                    "standard rate", "mrp", "retail price"],
};

export type MasterData = {
  items: { id: string; code: string; serial: string; name: string; barcode: string | null;
           item_group_id: string; brand_id: string | null; base_uom_id: string }[];
  categories: { id: string; code: string; name: string; parent_id: string | null }[];
  brands: { id: string; code: string; name: string }[];
  uoms: { id: string; code: string; name: string }[];
};

/**
 * A name the sheet uses that the master data does not have yet, and which the
 * user can register from the preview rather than by leaving to go and type it
 * somewhere else.
 *
 * `similarTo` is the point of interest. A name close to one already
 * registered is usually the same thing spelled differently — "Coca Cola"
 * where "Coca-Cola" exists — and registering it makes two of them, each with
 * a share of the sales. The importer cannot tell which was meant, so it
 * refuses to decide and says what it noticed instead.
 */
export type Registrable = {
  kind: "brand" | "category" | "subcategory";
  name: string;
  /** For a sub category: the category it will be created under. */
  parent?: string;
  /** An existing name close enough that this one may be a duplicate of it. */
  similarTo?: string;
  /** Sheet rows asking for it, so the user can go and look. */
  rows: number[];
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
  /**
   * What this item sells for, if the sheet said. Written to the first price
   * level exactly as the new-item form writes it, so an imported catalogue
   * arrives priced instead of arriving as eight hundred blanks nobody can
   * fill in from any screen.
   *
   * Null where the column is absent or the cell is empty — an item with no
   * price is legitimate, and is what every imported item was until now.
   */
  salePrice: number | null;
  // Carried for the preview, so the screen can show what the file means
  // without looking anything up a second time.
  unitName: string;
  categoryName: string;
  subCategoryName: string | null;
  brandName: string | null;
};

export type ImportPlan = {
  rows: PlannedRow[];
  /**
   * Categories, sub categories and brands the file names that do not exist
   * here, in the order they first appear. Reported apart from the errors
   * because these have an obvious remedy — register them — and a list of
   * names is what that remedy needs, where a list of failing row numbers is
   * not. Categories come before the sub categories that hang off them, so
   * registering the list in order always has a parent to attach to.
   */
  missing: Registrable[];
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
  rows: [], missing: [], errors, warnings,
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

  // ---- headings this sheet calls something else ---------------------------
  const canonical = new Set(IMPORT_COLUMNS.map((c) => norm(c)));
  const aliasOf = new Map<string, string>();
  for (const [name, list] of Object.entries(HEADER_ALIASES)) {
    for (const a of list) aliasOf.set(norm(a), name);
  }

  // Headings that are not one of ours, in the order they appear.
  const unknownHeadings = header.filter((h) => h && !canonical.has(norm(h)));

  // Which unknown headings lay claim to which of our columns. Collected before
  // any is accepted, because two headings claiming one column is a question
  // rather than a race.
  const claims = new Map<string, string[]>();
  for (const h of unknownHeadings) {
    const target = aliasOf.get(norm(h));
    if (!target) continue;
    if (indexOf.has(norm(target))) continue;   // the real column is here; the alias is not needed
    claims.set(target, [...(claims.get(target) ?? []), h]);
  }

  for (const [target, headings] of claims) {
    if (headings.length > 1) {
      return empty([{
        row: 1,
        message:
          `"${headings.join('" and "')}" both look like the ${target} column, and only one of `
          + `them can be it. Rename or remove the one that is not.`,
      }], warnings);
    }
    indexOf.set(norm(target), header.indexOf(headings[0]));
    warnings.push({
      row: 1,
      column: headings[0],
      message: `"${headings[0]}" is being read as ${target}.`,
    });
  }

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !indexOf.has(norm(c)));
  if (missingColumns.length > 0) {
    const spare = unknownHeadings.filter((h) => !aliasOf.has(norm(h)));
    const hint = missingColumns
      .map((c) => {
        const near = suggest(c, spare.map((h) => ({ name: h })));
        return near ? `"${near}" may be your ${c} column` : null;
      })
      .filter(Boolean);
    return empty([{
      row: 1,
      message:
        `Missing column${missingColumns.length === 1 ? "" : "s"}: ${missingColumns.join(", ")}.`
        + (hint.length > 0
            ? ` ${hint.join("; ")} — rename the heading and upload again.`
            : ""),
    }], warnings);
  }

  if (IDENTIFIER_COLUMNS.every((c) => !indexOf.has(norm(c)))) {
    return empty([{
      row: 1,
      message:
        "The sheet needs a Barcode column or a Stock ID column — without one there is "
        + "nothing to tell an item apart from another, or to match a row against an item "
        + "already here. Either will do, and a row may use whichever it has.",
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
  // Categories nest exactly two deep (Category -> Sub category, enforced in
  // createCategory), so the two levels are indexed separately. A flat "any
  // group by name" map cannot tell a category from a sub category, and two
  // sub categories called "Soft Drinks" under different parents are different
  // things that such a map would collapse into one.
  const rootCategories = byNameOrCode(master.categories.filter((c) => !c.parent_id));
  const childrenOf = (parentId: string) =>
    byNameOrCode(master.categories.filter((c) => c.parent_id === parentId));
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

  /**
   * One entry per distinct missing name, carrying every row that asked for
   * it. Collected rather than pushed straight into errors so the same name on
   * two hundred rows is one thing to register, not two hundred failures.
   */
  const missing: Registrable[] = [];
  const noteMissing = (
    kind: Registrable["kind"], name: string, row: number,
    candidates: { name: string }[], parent?: string
  ) => {
    const found = missing.find(
      (m) => m.kind === kind && norm(m.name) === norm(name) && norm(m.parent ?? "") === norm(parent ?? "")
    );
    if (found) { found.rows.push(row); return; }
    missing.push({
      kind, name, parent,
      similarTo: suggest(name, candidates) ?? undefined,
      rows: [row],
    });
  };

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
    const subText = has("Sub Category") ? cell(r, "Sub Category") : "";
    const brandText = has("Brand") ? cell(r, "Brand") : "";
    const unitText = cell(r, "Unit");
    const priceText = has("Selling price") ? cell(r, "Selling price") : "";

    // ---- the identifier ---------------------------------------------------
    // One of the two, not both. Which one is the company's business: a tin of
    // milk has a barcode from the factory and probably no code of its own; a
    // sack of rice packed here has a code and no barcode at all.
    if (!barcode && !stockId) {
      add("This row has neither a Barcode nor a Stock ID. One of them is needed — it is "
        + "what tells this item apart from every other, and what matches a row against an "
        + "item already here.", "Stock ID");
    }

    // ---- barcode ----------------------------------------------------------
    if (barcode && scientificNotation(barcode)) {
      add(
        `Barcode reads "${barcode}" — Excel has stored it as a number and lost digits. ` +
        `Format the Barcode column as Text and re-enter it.`, "Barcode"
      );
    } else if (barcode && !/^[0-9A-Za-z._-]+$/.test(barcode)) {
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

    // ---- category and sub category ----------------------------------------
    // Neither is invented silently. A name that is not registered is an error
    // AND an offer: the preview lists it so it can be created deliberately,
    // which is the difference between adding a category and acquiring three
    // spellings of one.
    const roots = master.categories.filter((c) => !c.parent_id);
    const category = rootCategories.get(norm(categoryText));
    if (!categoryText) {
      add("Category is empty. Every item belongs to one.", "Category");
    } else if (!category) {
      noteMissing("category", categoryText, rowNo, roots);
      add(`Category "${categoryText}" is not registered yet.` + didYouMean(categoryText, roots) +
          ` Register it below, or correct the sheet.`, "Category");
    }

    let sub: { id: string; code: string; name: string } | undefined;
    if (subText) {
      if (category) {
        const siblings = master.categories.filter((c) => c.parent_id === category.id);
        sub = childrenOf(category.id).get(norm(subText));
        if (!sub) {
          noteMissing("subcategory", subText, rowNo, siblings, category.name);
          add(`Sub category "${subText}" is not registered under "${category.name}".` +
              didYouMean(subText, siblings) + ` Register it below, or correct the sheet.`,
              "Sub Category");
        }
      } else if (categoryText) {
        // The parent is missing too. Record the sub against the category the
        // sheet names, so registering both in order still attaches correctly.
        noteMissing("subcategory", subText, rowNo, [], categoryText);
      }
    }

    // The item is filed against the leaf: the sub category when there is one,
    // the category otherwise. That is also the group whose code goes in front
    // of the Stock ID, because fn_set_item_code reads the group the item
    // actually points at.
    const group = sub ?? category;

    let brandId: string | null = null;
    let brandName: string | null = null;
    if (brandText) {
      const brand = brands.get(norm(brandText));
      if (!brand) {
        noteMissing("brand", brandText, rowNo, master.brands);
        add(`Brand "${brandText}" is not registered yet.` + didYouMean(brandText, master.brands) +
            ` Register it below, or leave the cell blank if this product has no brand.`, "Brand");
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

    // ---- selling price ----------------------------------------------------
    // Commas stripped because a spreadsheet writes 1,200 and means one number.
    // Refused rather than rounded or ignored: a price is the one field here
    // that turns into money on an invoice.
    let salePrice: number | null = null;
    if (priceText) {
      const n = Number(priceText.replace(/,/g, ""));
      if (!Number.isFinite(n)) {
        add(`Selling price "${priceText}" is not a number.`, "Selling price");
      } else if (n < 0) {
        add(`Selling price "${priceText}" is below zero.`, "Selling price");
      } else if (n > 0) {
        salePrice = n;
      }
    }

    // ---- the item this row refers to --------------------------------------
    // Barcode first, because it is the identifier the trade already agrees on
    // and cannot be two items at once. Falling back to the code the Stock ID
    // composes is what lets a barcode-less catalogue be re-imported without
    // making a second copy of everything: both are unique per company, so
    // either is a sound key, and a row carrying only one still matches.
    const byCodeKey = !barcode && stockId && group ? norm(`${group.code}${stockId}`) : null;
    const existing = (barcode ? itemByBarcode.get(barcode) : undefined)
      ?? (byCodeKey ? itemByCode.get(byCodeKey) : undefined);

    if (existing) {
      const named = barcode ? `Barcode ${barcode}` : `Stock ID ${stockId} in ${group!.name}`;
      if (norm(existing.name) !== norm(name) && name) {
        add(
          `${named} already belongs to "${existing.name}". ` +
          `Correct the sheet, or rename the item first if it really has changed.`, "Stock Name"
        );
      } else {
        warnings.push({
          row: rowNo,
          message: `${named} already exists — "${existing.name}" is left as it is.`,
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
    // The same check for the other identifier. A sheet with no barcodes would
    // otherwise be free to list one item twice, and the two rows would only
    // collide later on the code they compose.

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
      : (stockId || takeNextSerial(group!.id, group!.code));
    const code = existing ? existing.code : `${group!.code}${serial}`;

    // Two rows landing on one code, or a code an item already has. Both are
    // refused rather than resolved: the unique constraint would abort the
    // whole import at the very end, and a row number now is worth more than a
    // constraint violation after four hundred rows have been read.
    if (!existing) {
      const key = norm(code);
      const clash = seenCode.get(key);
      const taken = itemByCode.get(key);
      if (clash) {
        add(`Stock ID ${serial} in ${group!.name} makes the code ${code}, ` +
            `which row ${clash} already takes.`, "Stock ID");
      } else if (taken) {
        add(`Stock ID ${serial} in ${group!.name} makes the code ${code}, ` +
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
      categoryId: group!.id,
      brandId,
      uomId: uom!.id,
      serial,
      code,
      serialAssigned: assigned,
      salePrice,
      unitName: uom!.name,
      categoryName: category ? category.name : group!.name,
      subCategoryName: sub ? sub.name : null,
      brandName,
    });
  }

  // Categories before the sub categories that hang off them, so registering
  // the list top to bottom always has a parent to attach to.
  const order = { category: 0, subcategory: 1, brand: 2 } as const;
  missing.sort((a, b) => order[a.kind] - order[b.kind]);

  return {
    rows,
    missing,
    errors,
    warnings,
    summary: {
      rows: Math.max(0, rowsIn.length - 1),
      newItems: rows.filter((r) => r.isNew).length,
      existingItems: rows.filter((r) => !r.isNew).length,
    },
  };
}
