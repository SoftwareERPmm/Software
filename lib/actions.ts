"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "./db";
import { parseCsv, planImport, type MasterData } from "./import-items";
import { xlsxToRows, type UploadFormat } from "./read-spreadsheet";
import { planVoucherImport, voucherColumns, type VoucherMasterData, type VoucherKind }
  from "./import-vouchers";
import { getImportMasterData, getVoucherImportMasterData } from "./queries";
import { scaffoldCompany } from "./setup";
import {
  postSalesInvoice, postPurchaseInvoice, postSaleWithDelivery, postPurchaseWithReceipt,
  postSalesOrder, postPurchaseOrder, postDelivery, postGoodsReceipt,
  postSupplierPayment, postCustomerReceipt,
  postCashVoucher, postBankVoucher, postJournalVoucher,
  postCashTransfer, postAccountOpening, postStockAdjustment, postStockTransfer,
  importItems, importVouchers, voidDocument, reconcileNegativeStock,
  postSalesReturn, postPurchaseReturn, postConsignmentReceipt,
  type InvoiceLine, type OrderLine, type FulfillmentLine, type Allocation, type VoucherLine,
  type AdjustmentLine, type ReturnLine, type TransferLine, type ConsignmentReceiptLine,
} from "./posting";

export type ActionResult = { error: string } | { ok: true };

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function num(fd: FormData, key: string): number {
  const v = Number(fd.get(key));
  return Number.isFinite(v) ? v : 0;
}

/** Combines a date field with an optional time-of-day field into one ISO
 *  timestamp — blank time falls back to midnight, same as before either
 *  existed. Used for stock-in events, where FIFO ordering wants to know
 *  when stock actually arrived, not just what date it's dated. */
function dateTime(fd: FormData, dateKey: string, timeKey: string): string {
  const date = str(fd, dateKey);
  const time = str(fd, timeKey);
  return time ? `${date}T${time}` : date;
}

async function companyId(): Promise<string> {
  const [c] = await sql`select id from company order by created_at limit 1`;
  if (!c) throw new Error("No company is set up");
  return c.id;
}

/** Redirects with a one-shot confirmation the destination page pops as a toast. */
function redirectWithToast(path: string, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}toast=${encodeURIComponent(message)}`);
}

// ------------------------------------------------------------ first run --

export async function setupCompany(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Company set up";

  try {
    const name = str(fd, "name");
    const code = str(fd, "code").toUpperCase();
    const month = num(fd, "fiscal_year_start_month");
    const start = str(fd, "fiscal_year_start");

    if (!name) return { error: "Company name is required" };
    if (!code) return { error: "A short code is required" };
    if (!start) return { error: "Choose when the financial year starts" };
    if (month < 1 || month > 12) return { error: "Financial year start month must be 1 to 12" };

    await scaffoldCompany({
      code,
      name,
      nameMy: str(fd, "name_my") || null,
      baseCurrency: str(fd, "base_currency") || "MMK",
      fiscalYearStartMonth: month,
      fiscalYearStart: start,
      officeName: str(fd, "office_name") || "Head Office",
      warehouseName: str(fd, "warehouse_name") || "Main Warehouse",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/", "layout");
  redirectWithToast("/items/categories", toastMsg);
}

export async function companyExists(): Promise<boolean> {
  const rows = await sql`select 1 from company limit 1`;
  return rows.length > 0;
}

// --------------------------------------------------------------- partners --

export async function createPartner(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Partner added";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();

    const name = str(fd, "name");
    const isCustomer = fd.get("is_customer") === "on";
    const isSupplier = fd.get("is_supplier") === "on";

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (!isCustomer && !isSupplier) return { error: "Choose customer, supplier, or both" };

    const dup = await sql`
      select 1 from business_partner where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      insert into business_partner
        (company_id, code, name, name_my, company_name, is_customer, is_supplier,
         township, address, phone, payment_terms_days, credit_limit)
      values
        (${co}, ${code}, ${name}, ${str(fd, "name_my") || null},
         ${str(fd, "company_name") || null}, ${isCustomer}, ${isSupplier},
         ${str(fd, "township") || null}, ${str(fd, "address") || null},
         ${str(fd, "phone") || null}, ${num(fd, "payment_terms_days")},
         ${fd.get("credit_limit") ? num(fd, "credit_limit") : null})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/partners");
  redirectWithToast("/partners", toastMsg);
}

export async function updatePartner(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Partner updated";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();
    const id = str(fd, "id");
    const name = str(fd, "name");
    const isCustomer = fd.get("is_customer") === "on";
    const isSupplier = fd.get("is_supplier") === "on";

    if (!id) return { error: "Choose a partner" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (!isCustomer && !isSupplier) return { error: "Choose customer, supplier, or both" };

    const dup = await sql`
      select 1 from business_partner where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      update business_partner set
        code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
        company_name = ${str(fd, "company_name") || null},
        is_customer = ${isCustomer}, is_supplier = ${isSupplier},
        township = ${str(fd, "township") || null}, address = ${str(fd, "address") || null},
        phone = ${str(fd, "phone") || null}, payment_terms_days = ${num(fd, "payment_terms_days")},
        credit_limit = ${fd.get("credit_limit") ? num(fd, "credit_limit") : null},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/partners");
  redirectWithToast("/partners", toastMsg);
}

/** Deactivates a partner without touching any document already against them. */
export async function deactivatePartner(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a partner" };

    await sql`update business_partner set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/partners");
  redirectWithToast("/partners", "Partner deactivated");
}

/** Puts back what deactivatePartner retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activatePartner(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose partner" };

    await sql`update business_partner set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/partners");
  redirectWithToast("/partners", "Partner reactivated");
}

/** Hard delete only succeeds for a partner with no documents against them. Deactivating is the way to retire one. */
export async function deletePartner(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a partner" };

    await sql`delete from business_partner where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This partner has documents against them — deactivate instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/partners");
  redirectWithToast("/partners", "Partner deleted");
}

// ------------------------------------------------------ categories & items --

export async function createCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let returnTo: string | null = null;
  let composedCode: string | null = null;
  const toastMsg = "Category added";

  try {
    const co = await companyId();

    const segment = str(fd, "segment").toUpperCase();
    const name = str(fd, "name");
    const parentId = str(fd, "parent_id") || null;
    returnTo = str(fd, "return_to") || null;

    if (!segment) return { error: "Code segment is required" };
    if (!name) return { error: "Name is required" };

    if (parentId) {
      const [parent] = await sql`
        select parent_id from item_group where id = ${parentId} and company_id = ${co}`;
      if (!parent) return { error: "That category no longer exists" };
      if (parent.parent_id) {
        return { error: "Categories only nest two levels deep: Category → Sub category" };
      }
    }

    // The full code is the parent chain plus this segment, composed by
    // trigger. Two siblings sharing a segment would compose to the same
    // code, so check the composed value rather than the segment alone.
    const [composed] = await sql`
      select fn_compose_group_code(${parentId}::uuid, ${segment}) as code`;
    composedCode = composed.code;

    const dup = await sql`
      select name from item_group where company_id = ${co} and code = ${composed.code}`;
    if (dup.length) {
      return { error: `Code ${composed.code} is already used by ${dup[0].name}` };
    }

    await sql`
      insert into item_group (company_id, parent_id, segment, code, name, name_my)
      values (${co}, ${parentId}, ${segment}, ${composed.code}, ${name},
              ${str(fd, "name_my") || null})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${composedCode} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath("/items/new");
  redirectWithToast(returnTo || "/items/categories", toastMsg);
}

/**
 * Name only — not segment, parent, or code. Segment drives this category's
 * own composed code and every descendant's, and parent is a tree move; both
 * already have dedicated flows (createCategory's segment at creation time,
 * moveCategory/insertCategoryAbove for restructuring). This is the quick
 * "fix a typo" / "retire it" edit, not a restructure.
 */
export async function updateCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Category updated";
  const returnTo = str(fd, "return_to") || "/items/categories";
  const id = str(fd, "id");

  try {
    const co = await companyId();
    const name = str(fd, "name");

    if (!id) return { error: "Choose a category" };
    if (!name) return { error: "Name is required" };

    await sql`
      update item_group set
        name = ${name}, name_my = ${str(fd, "name_my") || null},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath(`/items/categories/${id}`);
  redirectWithToast(returnTo, toastMsg);
}

/** Deactivates a category without touching any item or sub category already filed under it. */
export async function deactivateCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const returnTo = str(fd, "return_to") || "/items/categories";
  const id = str(fd, "id");

  try {
    const co = await companyId();
    if (!id) return { error: "Choose a category" };

    await sql`update item_group set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath(`/items/categories/${id}`);
  redirectWithToast(returnTo, "Category deactivated");
}

/** Puts back what deactivateCategory retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const returnTo = str(fd, "return_to") || "/items/categories";

  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a category" };

    await sql`update item_group set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath("/items/subcategories");
  redirectWithToast(returnTo, "Category reactivated");
}

/**
 * Hard delete only succeeds for a category with nothing filed under it —
 * no items, no sub categories. Deactivating is the way to retire one that
 * has history.
 */
export async function deleteCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const returnTo = str(fd, "return_to") || "/items/categories";

  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a category" };

    await sql`delete from item_group where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This category has items or sub categories under it — deactivate it instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  redirectWithToast(returnTo, "Category deleted");
}

/**
 * Inserts a new category directly above an existing one: the new category
 * takes the target's place in the tree, and the target moves underneath it.
 * The whole branch below the target comes along, since it hangs off the
 * target rather than off its parent.
 */
export async function insertCategoryAbove(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Category inserted";

  try {
    const co = await companyId();

    const targetId = str(fd, "target_id");
    const segment = str(fd, "segment").toUpperCase();
    const name = str(fd, "name");

    if (!targetId) return { error: "Choose which category to lift" };
    if (!segment) return { error: "Code segment is required" };
    if (!name) return { error: "Name is required" };

    await sql.begin(async (tx) => {
      const [target] = await tx`
        select id, parent_id from item_group
         where id = ${targetId} and company_id = ${co}`;
      if (!target) throw new Error("That category no longer exists");
      if (target.parent_id) {
        throw new Error("This is already a sub category — inserting above it would nest three levels deep");
      }

      const [kid] = await tx`
        select 1 from item_group where parent_id = ${target.id} limit 1`;
      if (kid) {
        throw new Error("This category already has sub categories inside it — they'd end up nested too deep");
      }

      const [composed] = await tx`
        select fn_compose_group_code(${target.parent_id}::uuid, ${segment}) as code`;

      const [created] = await tx`
        insert into item_group (company_id, parent_id, segment, code, name, name_my)
        values (${co}, ${target.parent_id}, ${segment}, ${composed.code}, ${name},
                ${str(fd, "name_my") || null})
        returning id`;

      await tx`
        update item_group set parent_id = ${created.id} where id = ${target.id}`;
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath("/items/new");
  redirectWithToast("/items/categories", toastMsg);
}

/** Re-parents a category. Refuses moves that would make the tree cyclic. */
export async function moveCategory(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();

    const id = str(fd, "id");
    const newParent = str(fd, "new_parent_id") || null;

    if (!id) return { error: "Choose a category to move" };
    if (id === newParent) return { error: "A category cannot sit under itself" };

    if (newParent) {
      // Moving a category under one of its own descendants would detach the
      // branch from the tree entirely and loop forever when walking it.
      const cycle = await sql`
        with recursive descendants as (
          select id from item_group where id = ${id} and company_id = ${co}
          union all
          select g.id from item_group g join descendants d on g.parent_id = d.id
        )
        select 1 from descendants where id = ${newParent}`;
      if (cycle.length) {
        return { error: "That would put the category inside its own branch" };
      }

      // Categories only nest two levels deep, so the new parent must itself
      // be a top-level category, and a branch with sub categories of its own
      // can only move to the top level (its children would land too deep).
      const [np] = await sql`
        select parent_id from item_group where id = ${newParent} and company_id = ${co}`;
      if (!np) return { error: "That category no longer exists" };
      if (np.parent_id) {
        return { error: "Categories only nest two levels deep: Category → Sub category" };
      }

      const [kid] = await sql`
        select 1 from item_group where parent_id = ${id} and company_id = ${co} limit 1`;
      if (kid) {
        return { error: "This category has sub categories of its own — move it to the top level instead" };
      }
    }

    await sql`
      update item_group set parent_id = ${newParent}
       where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/categories");
  revalidatePath("/items/new");
  redirectWithToast("/items/categories", "Category moved");
}

export async function createItem(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let returnTo: string | null = null;
  let fullCode: string | null = null;
  const toastMsg = "Item added";

  try {
    const co = await companyId();
    returnTo = str(fd, "return_to") || null;

    const serial = str(fd, "serial").toUpperCase();
    const name = str(fd, "name");
    const groupId = str(fd, "item_group_id");
    const uomId = str(fd, "base_uom_id");
    const brandId = str(fd, "brand_id") || null;
    const salePrice = num(fd, "sale_price");

    if (!serial) return { error: "Serial is required" };
    if (!name) return { error: "Name is required" };
    if (!groupId) return { error: "Choose a category" };
    if (!uomId) return { error: "Choose a unit" };

    const [grp] = await sql`
      select code from item_group where id = ${groupId} and company_id = ${co}`;
    if (!grp) return { error: "That category no longer exists" };

    fullCode = `${grp.code}${serial}`;
    const dup = await sql`
      select name from item where company_id = ${co} and code = ${fullCode}`;
    if (dup.length) {
      return { error: `Code ${fullCode} is already used by ${dup[0].name}` };
    }


    await sql.begin(async (tx) => {
      const [item] = await tx`
        insert into item
          (company_id, item_group_id, brand_id, serial, code, name, name_my, base_uom_id, is_stocked)
        values
          (${co}, ${groupId}, ${brandId}, ${serial}, ${fullCode}, ${name}, ${str(fd, "name_my") || null},
           ${uomId}, ${fd.get("is_stocked") !== null})
        returning id`;

      if (salePrice > 0) {
        const [level] = await tx`
          select id from price_level where company_id = ${co} order by sort_order limit 1`;
        if (level) {
          await tx`
            insert into item_price
              (company_id, item_id, price_level_id, uom_id, currency, price)
            values (${co}, ${item.id}, ${level.id}, ${uomId}, 'MMK', ${salePrice})`;
        }
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${fullCode} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  revalidatePath("/items/categories");
  revalidatePath("/items/stock");
  redirectWithToast(returnTo || "/items", toastMsg);
}

/**
 * Name, brand, unit, stocked/active — not code or category. The code is the
 * item's identity (composed from the category's own code plus a serial at
 * creation time); reclassifying it into a different category is a bigger,
 * rarer operation than this quick edit is for.
 */
export async function updateItem(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Item updated";

  try {
    const co = await companyId();
    const id = str(fd, "id");
    const name = str(fd, "name");
    const uomId = str(fd, "base_uom_id");

    if (!id) return { error: "Choose an item" };
    if (!name) return { error: "Name is required" };
    if (!uomId) return { error: "Choose a unit" };

    await sql`
      update item set
        name = ${name}, name_my = ${str(fd, "name_my") || null},
        brand_id = ${str(fd, "brand_id") || null}, base_uom_id = ${uomId},
        is_stocked = ${fd.get("is_stocked") !== null},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  revalidatePath("/items/categories");
  revalidatePath("/items/stock");
  redirectWithToast("/items", toastMsg);
}

/** Deactivates an item without touching any document or stock history against it. */
export async function deactivateItem(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an item" };

    await sql`update item set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast("/items", "Item deactivated");
}

/** Puts back what deactivateItem retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateItem(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an item" };

    await sql`update item set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast("/items", "Item reactivated");
}

/** Hard delete only succeeds for an item nothing has ever touched. Deactivating is the way to retire one. */
export async function deleteItem(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an item" };

    await sql`delete from item where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This item has documents or stock history against it — deactivate it instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast("/items", "Item deleted");
}

// ------------------------------------------------------------- brands --

export async function createBrand(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Brand added";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();

    const name = str(fd, "name");

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`select 1 from brand where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      insert into brand (company_id, code, name, name_my)
      values (${co}, ${code}, ${name}, ${str(fd, "name_my") || null})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/brands");
  revalidatePath("/items/new");
  redirectWithToast("/items/brands", toastMsg);
}

export async function updateBrand(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Brand updated";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();
    const id = str(fd, "id");
    const name = str(fd, "name");

    if (!id) return { error: "Choose a brand" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`
      select 1 from brand where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      update brand set
        code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/brands");
  redirectWithToast("/items/brands", toastMsg);
}

/** Deactivates a brand without touching any item that already uses it. */
export async function deactivateBrand(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a brand" };

    await sql`update brand set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/brands");
  redirectWithToast("/items/brands", "Brand deactivated");
}

/** Puts back what deactivateBrand retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateBrand(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a brand" };

    await sql`update brand set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/brands");
  redirectWithToast("/items/brands", "Brand reactivated");
}

/** Hard delete only succeeds for a brand no item has ever used. Deactivating is the way to retire one. */
export async function deleteBrand(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a brand" };

    await sql`delete from brand where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This brand is used by one or more items — deactivate it instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/brands");
  redirectWithToast("/items/brands", "Brand deleted");
}

export type NewBrandInput = { name: string; nameMy?: string };
export type PickerBrand = { id: string; code: string; name: string };

/** Quick-add from inside the item form, same shape as createItemInline. */
export async function createBrandInline(
  input: NewBrandInput
): Promise<{ ok: true; brand: PickerBrand } | { ok: false; error: string }> {
  try {
    const co = await companyId();

    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };

    // Auto-code from the name — BRAKE PADS -> BRAKEPADS, deduped with a
    // numeric suffix if that code is already taken.
    const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "BRAND";
    let code = base;
    let n = 1;
    while ((await sql`select 1 from brand where company_id = ${co} and code = ${code}`).length) {
      code = `${base}${++n}`;
    }

    const [brand] = await sql`
      insert into brand (company_id, code, name, name_my)
      values (${co}, ${code}, ${name}, ${input.nameMy?.trim() || null})
      returning id, code, name`;

    revalidatePath("/items/brands");
    return { ok: true, brand: { id: brand.id, code: brand.code, name: brand.name } };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "That brand code was just taken — try again" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --------------------------------------------------------------- units --

/**
 * Units of measure — Piece, Box, Carton, Kilogram.
 *
 * Small, but not cosmetic: a unit is what every quantity of an item is
 * counted in, so changing one after stock exists changes what the numbers
 * mean without changing the numbers. That is why an item's base unit is set
 * once when the item is created and the sheet importer refuses to guess
 * "Btl" into "Bottle" — and why a unit in use is retired rather than deleted.
 */
export async function createUnit(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();
    const name = str(fd, "name");

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`select 1 from uom where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      insert into uom (company_id, code, name, name_my)
      values (${co}, ${code}, ${name}, ${str(fd, "name_my") || null})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/units");
  revalidatePath("/items/new");
  redirectWithToast("/items/units", "Unit added");
}

export async function updateUnit(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();
    const id = str(fd, "id");
    const name = str(fd, "name");

    if (!id) return { error: "Choose a unit" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`
      select 1 from uom where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      update uom set
        code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/units");
  redirectWithToast("/items/units", "Unit updated");
}

/**
 * Retires a unit without touching a single item that already counts in it.
 *
 * Deactivating takes it off the pickers and out of what an import will
 * accept; everything historic keeps reading exactly as it did, which is the
 * whole reason this is not a delete.
 */
export async function deactivateUnit(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a unit" };

    await sql`update uom set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/units");
  redirectWithToast("/items/units", "Unit deactivated");
}

/** Puts back what deactivateUnit retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateUnit(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a unit" };

    await sql`update uom set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/units");
  redirectWithToast("/items/units", "Unit reactivated");
}

/** Hard delete only succeeds for a unit nothing has ever been counted in.
 *  Deactivating is the way to retire one that has. */
export async function deleteUnit(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a unit" };

    await sql`delete from uom where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return {
        error: "This unit is in use by an item, a price or a document line — " +
               "deactivate it instead of deleting",
      };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/units");
  redirectWithToast("/items/units", "Unit deleted");
}

// ------------------------------------------------- inline item creation --

export type NewItemInput = {
  name: string;
  nameMy?: string;
  groupId: string;
  serial?: string;
  uomId: string;
  price?: number;
  isStocked: boolean;
};

export type PickerItem = {
  id: string; code: string; name: string; is_stocked: boolean;
  item_group_id: string; on_hand: string; sale_price: string; next_cost: string;
  uom_code: string;
};

/**
 * Creates an item from inside a voucher and hands it straight back, so the
 * line it was needed for can select it without leaving the page. Returns a
 * result rather than redirecting — the caller is mid-entry.
 */
export async function createItemInline(
  input: NewItemInput
): Promise<{ ok: true; item: PickerItem } | { ok: false; error: string }> {
  let fullCode: string | null = null;

  try {
    const co = await companyId();

    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };
    if (!input.groupId) return { ok: false, error: "Choose a category" };
    if (!input.uomId) return { ok: false, error: "Choose a unit" };
    // Read here rather than returned from the insert, because the picker
    // quotes quantities in it and only has the code to show.
    const [uomRow] = await sql`select code from uom where id = ${input.uomId}`;
    const uomCode: string | null = uomRow?.code ?? null;

    const [grp] = await sql`
      select code from item_group where id = ${input.groupId} and company_id = ${co}`;
    if (!grp) return { ok: false, error: "That category no longer exists" };

    // Auto-number within the category unless the user typed a serial. Only
    // numeric serials count toward the next value; a hand-typed "A1" is left
    // alone rather than breaking the sequence.
    let serial = (input.serial ?? "").trim().toUpperCase();
    if (!serial) {
      const [next] = await sql`
        select coalesce(max(serial::int), 0) + 1 as n
          from item
         where company_id = ${co} and item_group_id = ${input.groupId}
           and serial ~ '^[0-9]+$'`;
      serial = String(next.n).padStart(3, "0");
    }

    fullCode = `${grp.code}${serial}`;
    const dup = await sql`
      select name from item where company_id = ${co} and code = ${fullCode}`;
    if (dup.length) {
      return { ok: false, error: `Code ${fullCode} is already used by ${dup[0].name}` };
    }

    const created = await sql.begin(async (tx) => {
      const [item] = await tx`
        insert into item
          (company_id, item_group_id, serial, code, name, name_my, base_uom_id, is_stocked)
        values
          (${co}, ${input.groupId}, ${serial}, ${fullCode}, ${name},
           ${input.nameMy?.trim() || null}, ${input.uomId}, ${input.isStocked})
        returning id, code, name, is_stocked, item_group_id, base_uom_id`;

      if (input.price && input.price > 0) {
        const [level] = await tx`
          select id from price_level where company_id = ${co} order by sort_order limit 1`;
        if (level) {
          await tx`
            insert into item_price
              (company_id, item_id, price_level_id, uom_id, currency, price)
            values (${co}, ${item.id}, ${level.id}, ${input.uomId}, 'MMK', ${input.price})`;
        }
      }
      return item;
    });

    // The row is already committed. Cache revalidation is a hint, and letting
    // it throw here would report failure for an item that exists — the user
    // would retry and hit "code already used" for their own creation.
    try {
      revalidatePath("/items");
      revalidatePath("/items/categories");
    } catch {
      // Outside a request context (scripts, tests). Nothing to revalidate.
    }

    return {
      ok: true,
      item: {
        id: created.id,
        code: created.code,
        name: created.name,
        is_stocked: created.is_stocked,
        item_group_id: created.item_group_id,
        on_hand: "0",
        sale_price: String(input.price ?? 0),
        next_cost: "0",
        // The unit it was just created in — the picker needs it to quote a
        // quantity back, and this item is not in the list that was loaded
        // with the page.
        uom_code: uomCode ?? "",
      },
    };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: `Code ${fullCode} is already used` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --------------------------------------------------------------- invoices --

function parseLines(fd: FormData): InvoiceLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the invoice lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the invoice lines");

  const lines = parsed
    .map((l: any) => ({
      itemId: String(l.itemId ?? ""),
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      discountPct: Number(l.discountPct) || 0,
      focReasonId: l.focReasonId || null,
      sourceLineId: l.sourceLineId || null,
    }))
    .filter((l) => l.itemId && l.qty > 0);

  // Blank rows are dropped above; a negative price is a mistake, not a
  // blank, so it is named rather than passed down to the posting engine.
  const bad = lines.findIndex((l) => l.unitPrice !== undefined && Number(l.unitPrice) < 0);
  if (bad >= 0) throw new Error(`Line ${bad + 1}: price cannot be negative`);
  return lines;
}

export async function createSalesInvoice(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Sales invoice posted";

  try {
    const co = await companyId();
    const lines = parseLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a customer" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const paymentType: "CASH" | "CREDIT" = str(fd, "payment_type") === "CASH" ? "CASH" : "CREDIT";
    const dueDate = str(fd, "due_date") || null;
    const cashIn = num(fd, "cash_in");
    const toDeliver = fd.get("to_deliver") !== null;
    const deliveryId = str(fd, "delivery_id") || null;
    const deliveryFee = num(fd, "delivery_fee");
    // Counted toward what the customer owes, so an invoice that is only a
    // carriage charge still gets the due date it needs to age.
    const roughTotal = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) + deliveryFee;

    // An invoice left with no due date can never be flagged overdue no
    // matter how large or how old its balance gets — v_open_item buckets a
    // null due_date as permanently CURRENT. Going on the actual remaining
    // balance rather than the payment-type label, since "Cash" doesn't
    // guarantee cash_in covers the total — the field stays freely editable.
    if (cashIn < roughTotal && !dueDate) return { error: "This invoice leaves a balance owing — add a due date" };

    const input = {
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      dueDate,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      salesmanId: str(fd, "salesman_id") || null,
      paymentType,
      toDeliver,
      cashIn,
      cashAccountId: str(fd, "cash_account_id") || null,
      deliveryFee,
      // Present only when the confirmation dialog was answered. The engine
      // refuses to issue stock it has no record of without it, so a form
      // that never asked cannot post negative stock by omission.
      allowNegativeStock: fd.get("allow_negative_stock") !== null,
      lines,
    };

    // Three ways this can go, mirroring purchases: matched to a delivery
    // that already moved the stock (nothing should move it again); deferred
    // (revenue only, a real delivery fulfils it later); or "take now"
    // (delivery and invoice post together). Matching and deferring are
    // mutually exclusive — the form only shows one at a time.
    const result = deliveryId
      ? await postSalesInvoice({
          ...input, deliveryId,
          // Blank means "whatever the delivery charged" — the field is only
          // shown when composing a new delivery, so leaving it empty here
          // must not wipe a fee entered when the goods went out.
          deliveryFee: fd.get("delivery_fee") === null ? undefined : deliveryFee,
        })
      : toDeliver
        ? await postSalesInvoice(input)
        : await postSaleWithDelivery(input);

    docId = result.id;
    toastMsg = `Invoice ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/documents");
  revalidatePath("/receivables");
  revalidatePath("/ledger");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createPurchaseInvoice(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Purchase invoice posted";

  try {
    const co = await companyId();
    const lines = parseLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a supplier" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const goodsReceiptId = str(fd, "goods_receipt_id") || null;
    const cashOut = num(fd, "cash_out");
    const dueDate = str(fd, "due_date") || null;
    const roughTotal = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

    // Same reasoning as createSalesInvoice: a null due_date reads as
    // permanently CURRENT in v_partner_balance/v_open_item, so an invoice
    // left with a balance owing and no due date could never surface as
    // overdue on the Payables page no matter how old it got.
    if (cashOut < roughTotal && !dueDate) return { error: "This invoice leaves a balance owing — add a due date" };

    const input = {
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      dueDate,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      cashOut,
      cashAccountId: str(fd, "cash_account_id") || null,
      lines,
    };

    // Three ways this can go: matched to a receipt that already exists (the
    // goods are already in the warehouse, so nothing should create a second
    // one); received now (composes a fresh receipt in the same breath); or
    // deferred (only the GR/IR-clearing side posts, a receipt clears it
    // later). "Received now" and "match an existing receipt" are mutually
    // exclusive — the form only shows one at a time.
    const receivedNow = !goodsReceiptId && fd.get("received_now") !== null;
    const result = goodsReceiptId
      ? await postPurchaseInvoice({ ...input, goodsReceiptId })
      : receivedNow
        ? await postPurchaseWithReceipt(input)
        : await postPurchaseInvoice(input);

    docId = result.id;
    toastMsg = `Invoice ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/documents");
  revalidatePath("/payables");
  revalidatePath("/ledger");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// -------------------------------------------------------------- returns --

export async function createSalesReturn(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Sales return posted";

  try {
    const co = await companyId();
    const lines = parseLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a customer" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postSalesReturn({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      receivedAt: dateTime(fd, "doc_date", "received_time"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      sourceDocumentId: str(fd, "source_document_id") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Return ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/documents");
  revalidatePath("/receivables");
  revalidatePath("/ledger");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createPurchaseReturn(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Purchase return posted";

  try {
    const co = await companyId();
    const lines = parseLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a supplier" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postPurchaseReturn({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      sourceDocumentId: str(fd, "source_document_id") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Return ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/documents");
  revalidatePath("/payables");
  revalidatePath("/ledger");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// -------------------------------------------------- orders & fulfilment --

function parseOrderLines(fd: FormData): OrderLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the order lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the order lines");

  const lines = parsed
    .map((l: any) => ({
      itemId: String(l.itemId ?? ""),
      qty: Number(l.qty),
      unitPrice: l.unitPrice ? Number(l.unitPrice) : undefined,
    }))
    .filter((l) => l.itemId && l.qty > 0);

  // Blank rows are dropped above; a negative price is a mistake, not a
  // blank, so it is named rather than passed down to the posting engine.
  const bad = lines.findIndex((l) => l.unitPrice !== undefined && Number(l.unitPrice) < 0);
  if (bad >= 0) throw new Error(`Line ${bad + 1}: price cannot be negative`);
  return lines;
}

function parseFulfillmentLines(fd: FormData): FulfillmentLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the lines");

  const lines = parsed
    .map((l: any) => ({
      itemId: String(l.itemId ?? ""),
      qty: Number(l.qty),
      unitCost: l.unitCost ? Number(l.unitCost) : undefined,
      // The engine has always accepted this; the parser dropped it, so a
      // delivery raised anywhere but the sales voucher could not mark units
      // free and their cost went to cost of sales instead of the expense the
      // reason names.
      focReasonId: l.focReasonId || null,
      sourceLineId: l.sourceLineId || null,
    }))
    .filter((l) => l.itemId && l.qty > 0);

  // Blank rows are dropped above; a negative cost is a mistake, not a
  // blank, so it is named rather than passed down to the posting engine.
  const bad = lines.findIndex((l) => l.unitCost !== undefined && Number(l.unitCost) < 0);
  if (bad >= 0) throw new Error(`Line ${bad + 1}: cost cannot be negative`);
  return lines;
}

export async function createSalesOrder(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Sales order saved";

  try {
    const co = await companyId();
    const lines = parseOrderLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a customer" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postSalesOrder({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      dueDate: str(fd, "due_date") || null,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Order ${result.docNo} saved`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/sales/orders");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createPurchaseOrder(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Purchase order saved";

  try {
    const co = await companyId();
    const lines = parseOrderLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a supplier" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postPurchaseOrder({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      dueDate: str(fd, "due_date") || null,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Order ${result.docNo} saved`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/purchases/orders");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createDelivery(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Delivery posted";

  try {
    const co = await companyId();
    const lines = parseFulfillmentLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a customer" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const delivery = await postDelivery({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      sourceDocumentId: str(fd, "source_document_id") || null,
      // Recorded here, billed by the invoice that follows this delivery.
      deliveryFee: num(fd, "delivery_fee"),
      // Present only when the confirmation dialog was answered — the same
      // rule the sales voucher follows, so the two routes to moving stock
      // cannot disagree about whether someone had to be asked.
      allowNegativeStock: fd.get("allow_negative_stock") !== null,
      lines,
    });

    docId = delivery.id;
    toastMsg = `Delivery ${delivery.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

/**
 * One click from the "pending deliveries" list: delivers exactly what a
 * to_deliver invoice already billed, no re-keying. Service lines on that
 * invoice have nothing to deliver and are skipped.
 */
export async function deliverPendingInvoice(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Delivery posted";

  try {
    const co = await companyId();
    const invoiceId = str(fd, "invoice_id");
    if (!invoiceId) return { error: "Choose an invoice" };

    const [invoice] = await sql`
      select id, partner_id, location_id, doc_date
        from document
       where id = ${invoiceId} and company_id = ${co} and doc_type = 'SALES_INVOICE'`;
    if (!invoice) return { error: "That invoice no longer exists" };

    const lines = await sql`
      select dl.item_id, dl.base_qty, dl.foc_reason_id
        from document_line dl
        join item i on i.id = dl.item_id
       where dl.document_id = ${invoiceId} and i.is_stocked`;

    if (lines.length === 0) return { error: "Nothing on this invoice needs delivering" };

    const result = await postDelivery({
      companyId: co,
      partnerId: invoice.partner_id,
      locationId: invoice.location_id,
      docDate: new Date().toISOString().slice(0, 10),
      reference: `Against invoice`,
      sourceDocumentId: invoice.id,
      lines: lines.map((l: any) => ({
        itemId: l.item_id, qty: Number(l.base_qty), focReasonId: l.foc_reason_id,
      })),
    });

    docId = result.id;
    toastMsg = `Delivery ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/sales/deliver");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createGoodsReceipt(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Goods receipt posted";

  try {
    const co = await companyId();
    const lines = parseFulfillmentLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a supplier" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postGoodsReceipt({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      receivedAt: dateTime(fd, "doc_date", "received_time"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      sourceDocumentId: str(fd, "source_document_id") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Goods receipt ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// ------------------------------------------------------------- settlement --

function parseAllocations(fd: FormData): Allocation[] {
  const raw = String(fd.get("allocations") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the allocations");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the allocations");

  return parsed
    .map((a: any) => ({ invoiceId: String(a.invoiceId ?? ""), amount: Number(a.amount) }))
    .filter((a) => a.invoiceId && a.amount > 0);
}

async function settle(
  fd: FormData,
  kind: "pay" | "receive"
): Promise<{ error: string } | { id: string; docNo: string }> {
  const co = await companyId();
  const allocations = parseAllocations(fd);

  if (allocations.length === 0) {
    return { error: "Enter an amount against at least one invoice" };
  }
  if (!str(fd, "partner_id")) {
    return { error: kind === "pay" ? "Choose a supplier" : "Choose a customer" };
  }
  if (!str(fd, "cash_account_id")) {
    return { error: "Choose which cash or bank account to use" };
  }

  const input = {
    companyId: co,
    partnerId: str(fd, "partner_id"),
    docDate: str(fd, "doc_date"),
    cashAccountId: str(fd, "cash_account_id"),
    reference: str(fd, "reference") || null,
    memo: str(fd, "memo") || null,
    // Blank means "follow the invoices being settled", which postSettlement
    // resolves. Only worth setting when a payment spans branches, or when the
    // cash leaves a different branch from the one that raised the bill.
    locationId: str(fd, "location_id") || null,
    allocations,
  };

  const result = kind === "pay"
    ? await postSupplierPayment(input)
    : await postCustomerReceipt(input);

  return { id: result.id, docNo: result.docNo };
}

export async function createSupplierPayment(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Payment posted";
  try {
    const r = await settle(fd, "pay");
    if ("error" in r) return { error: r.error };
    docId = r.id;
    toastMsg = `Payment ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/payables");
  revalidatePath("/documents");
  revalidatePath("/ledger");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

export async function createCustomerReceipt(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Receipt posted";
  try {
    const r = await settle(fd, "receive");
    if ("error" in r) return { error: r.error };
    docId = r.id;
    toastMsg = `Receipt ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/");
  revalidatePath("/receivables");
  revalidatePath("/documents");
  revalidatePath("/ledger");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

/** Open invoices for one partner, for the settlement screens. */
export async function getSettlementData(kind: "pay" | "receive") {
  const co = await companyId();
  const docType = kind === "pay" ? "PURCHASE_INVOICE" : "SALES_INVOICE";
  const role = kind === "pay" ? "is_supplier" : "is_customer";

  const [partners, invoices, cashAccounts] = await Promise.all([
    kind === "pay"
      ? sql`select id, code, name from business_partner
             where company_id = ${co} and is_supplier and is_active order by code`
      : sql`select id, code, name from business_partner
             where company_id = ${co} and is_customer and is_active order by code`,
    sql`select document_id, doc_no, partner_id, posting_date, due_date,
                gross_total, paid, outstanding, payment_status, days_overdue
           from v_invoice_status
          where company_id = ${co} and doc_type = ${docType} and outstanding <> 0
          order by due_date nulls last, posting_date`,
    sql`select id, code, name from account
         where company_id = ${co} and is_cash_account and is_active order by code`,
  ]);

  return { partners, invoices, cashAccounts, role };
}

// ------------------------------------------------------ finance vouchers --

function parseVoucherLines(fd: FormData): VoucherLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the voucher lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the voucher lines");

  return parsed
    .map((l: any) => ({
      accountId: String(l.accountId ?? ""),
      amount: Number(l.amount),
      memo: l.memo ? String(l.memo) : null,
    }))
    .filter((l) => l.accountId && Number.isFinite(l.amount) && l.amount !== 0);
}

async function postVoucherFrom(
  fd: FormData,
  kind: "cash" | "bank" | "journal"
): Promise<{ error: string } | { id: string; docNo: string }> {
  const co = await companyId();
  const lines = parseVoucherLines(fd);

  if (lines.length < 2) {
    return { error: "A voucher needs at least two lines that balance" };
  }

  const input = {
    companyId: co,
    docDate: str(fd, "doc_date"),
    memo: str(fd, "memo") || null,
    reference: str(fd, "reference") || null,
    locationId: str(fd, "location_id") || null,
    lines,
  };

  const r =
    kind === "cash" ? await postCashVoucher(input)
      : kind === "bank" ? await postBankVoucher(input)
      : await postJournalVoucher(input);

  return { id: r.id, docNo: r.docNo };
}

function financeRevalidate() {
  revalidatePath("/");
  revalidatePath("/documents");
  revalidatePath("/ledger");
  revalidatePath("/finance/cash-detail");
  revalidatePath("/finance/bank-detail");
}

export async function createCashVoucher(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let id: string;
  let toastMsg = "Cash voucher posted";
  try {
    const r = await postVoucherFrom(fd, "cash");
    if ("error" in r) return { error: r.error };
    id = r.id;
    toastMsg = `Voucher ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  financeRevalidate();
  redirectWithToast(`/documents/${id}`, toastMsg);
}

export async function createBankVoucher(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let id: string;
  let toastMsg = "Bank voucher posted";
  try {
    const r = await postVoucherFrom(fd, "bank");
    if ("error" in r) return { error: r.error };
    id = r.id;
    toastMsg = `Voucher ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  financeRevalidate();
  redirectWithToast(`/documents/${id}`, toastMsg);
}

export async function createJournalVoucher(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let id: string;
  let toastMsg = "Journal voucher posted";
  try {
    const r = await postVoucherFrom(fd, "journal");
    if ("error" in r) return { error: r.error };
    id = r.id;
    toastMsg = `Voucher ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  financeRevalidate();
  redirectWithToast(`/documents/${id}`, toastMsg);
}

export async function createCashTransfer(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let id: string;
  let toastMsg = "Transfer posted";
  try {
    const co = await companyId();
    const from = str(fd, "from_account_id");
    const to = str(fd, "to_account_id");
    const amount = num(fd, "amount");

    if (!from || !to) return { error: "Choose both accounts" };
    if (from === to) return { error: "Choose two different accounts" };
    if (!(amount > 0)) return { error: "Enter an amount" };

    const r = await postCashTransfer({
      companyId: co,
      docDate: str(fd, "doc_date"),
      fromAccountId: from,
      toAccountId: to,
      fromLocationId: str(fd, "from_location_id") || null,
      toLocationId: str(fd, "to_location_id") || null,
      amount,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
    });
    id = r.id;
    toastMsg = `Transfer ${r.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  financeRevalidate();
  redirectWithToast(`/documents/${id}`, toastMsg);
}

export async function createAccountOpening(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let id: string;
  let toastMsg = "Opening balances posted";
  try {
    const co = await companyId();
    const lines = parseVoucherLines(fd);
    if (lines.length === 0) return { error: "Enter at least one opening balance" };

    const r = await postAccountOpening({
      companyId: co,
      docDate: str(fd, "doc_date"),
      memo: str(fd, "memo") || null,
      lines: lines.map((l) => ({ accountId: l.accountId, amount: l.amount })),
    });
    id = r.id;
    toastMsg = "Opening balances posted";
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  financeRevalidate();
  redirectWithToast(`/documents/${id}`, toastMsg);
}

/** Accounts and locations for the finance voucher screens. */
/**
 * The number the next voucher of this kind will carry, asked of the database
 * rather than spelled out on the page.
 *
 * The five voucher screens each printed a literal prefix — "CV-", "BV-",
 * "JV-" — which stopped being true when numbering moved to type + date +
 * daily sequence in migration 0035. They showed "No. CV-" with no number at
 * all, next to a form that posts P20260905001.
 *
 * Read-only on purpose: fn_peek_document_no takes no lock and consumes
 * nothing, so opening a screen never burns a number.
 */
export async function peekVoucherNo(
  type: "CASH_VOUCHER" | "BANK_VOUCHER" | "JOURNAL_VOUCHER",
  direction?: "IN" | "OUT",
): Promise<string> {
  const co = await companyId();
  const [row] = await sql`
    select fn_peek_document_no(${co}, ${type}, current_date, ${direction ?? null}) as no`;
  return (row?.no as string) ?? "";
}

export async function getFinanceData() {
  const co = await companyId();

  const [accounts, accountTree, cashAccounts, bankAccounts, branches, costCenters] = await Promise.all([
    sql`select id, code, name, parent_id, account_type, is_control, is_cash_account, is_bank_account
          from account
         where company_id = ${co} and is_postable and is_active
         order by code`,
    // Every account including the non-postable section headings, which the
    // list above deliberately excludes. Grouping a picker the way the chart
    // groups itself means walking up to the section an account sits under —
    // that is where the finer distinctions live, since the stored
    // account_type has six members and the chart draws eight (a tax payable
    // is a LIABILITY underneath and reads as Tax on screen).
    sql`select id, code, name, parent_id, is_postable from account where company_id = ${co}`,
    sql`select id, code, name from account
         where company_id = ${co} and is_cash_account and not is_bank_account and is_active
         order by code`,
    sql`select id, code, name from account
         where company_id = ${co} and is_bank_account and is_active order by code`,
    // Branches only, not every location. A voucher happens at a branch — a
    // receipt is taken at an office, money is transferred between them — and
    // a warehouse is where stock sits, which is a different question. Listing
    // warehouses under a control labelled "Branch" invited someone to file a
    // cash receipt into a shed.
    sql`select id, code, name from location
         where company_id = ${co} and parent_id is null and is_active order by code`,
    sql`select id, code, name from cost_center
         where company_id = ${co} and is_active order by code`,
  ]);

  return { accounts, accountTree, cashAccounts, bankAccounts, branches, costCenters };
}

/** Movements on one account with its running balance. */
export async function getAccountLedger(accountId: string, from?: string, to?: string) {
  const co = await companyId();
  return sql`
    select entry_no, entry_date, memo, source_type, doc_no, doc_type,
           partner_name, location_code, debit, credit, running_balance
      from v_account_ledger
     where company_id = ${co} and account_id = ${accountId}
       ${from ? sql`and entry_date >= ${from}::date` : sql``}
       ${to ? sql`and entry_date <= ${to}::date` : sql``}
     order by entry_date, entry_no`;
}

// ------------------------------------------------------------- form lookups --

export async function getFormData() {
  const co = await companyId();

  const [
    customers, suppliers, items, locations, volumeDiscounts, groups, uoms,
    salesmen, promotions, cashAccounts, focReasons, itemPrices, priceLevels,
    openInvoices, nextNo, stockByLocation,
  ] = await Promise.all([
    sql`select id, code, name, payment_terms_days, price_level_id from business_partner
         where company_id = ${co} and is_customer and is_active order by code`,
    sql`select id, code, name, payment_terms_days from business_partner
         where company_id = ${co} and is_supplier and is_active order by code`,
    sql`select i.id, i.code, i.name, i.is_stocked, i.item_group_id,
                -- The unit every quantity of this item is counted in, so a
                -- figure quoted back to the user can carry it rather than
                -- being a bare number.
                u.code as uom_code,
                coalesce(s.qty, 0) as on_hand,
                coalesce((
                  select unit_cost from v_stock_lot_open
                   where company_id = ${co} and item_id = i.id
                   order by received_date, created_at limit 1
                ), 0) as next_cost,
                0 as sale_price
           from item i
           join uom u on u.id = i.base_uom_id
           left join (select item_id, sum(qty_on_hand) as qty
                        from v_stock_on_hand group by item_id) s on s.item_id = i.id
          where i.company_id = ${co} and i.is_active
          order by i.code`,
    sql`select id, code, name from location
         where company_id = ${co} and is_stock_location and is_active order by code`,
    // Volume bands in force today, so the voucher previews the same discounts
    // the engine will apply.
    sql`select id, code, name, basis, item_id, item_group_id,
               min_value, max_value, discount_pct
          from volume_discount
         where company_id = ${co} and is_active
           and valid_from <= current_date
           and (valid_to is null or valid_to >= current_date)
         order by basis, min_value`,
    sql`select g.id, g.code, g.name, g.name_my, g.parent_id, p.name as parent_name
           from item_group g
           left join item_group p on p.id = g.parent_id
          where g.company_id = ${co} order by g.code`,
    sql`select id, code, name from uom where company_id = ${co} and is_active order by code`,

    sql`select id, code, name, name_my, commission_pct from salesman
         where company_id = ${co} and is_active order by code`,

    sql`select p.id, p.code, p.name, p.discount_pct, p.buy_qty, p.free_qty,
                p.valid_from, p.valid_to, p.item_id, p.item_group_id,
                i.code as item_code, g.name as group_name
           from promotion p
           left join item i on i.id = p.item_id
           left join item_group g on g.id = p.item_group_id
          where p.company_id = ${co} and p.is_active
            and p.valid_from <= current_date
            and (p.valid_to is null or p.valid_to >= current_date)
          order by p.code`,

    sql`select id, code, name from account
         where company_id = ${co} and is_cash_account and is_active order by code`,

    sql`select id, code, name from foc_reason where company_id = ${co} order by code`,

    // Every price at every level. The voucher picks the one matching the
    // customer, so a wholesale buyer is not quoted the retail price.
    sql`select ip.item_id, ip.price_level_id, ip.price
           from item_price ip
          where ip.company_id = ${co}`,

    sql`select id, code, name, sort_order from price_level
         where company_id = ${co} order by sort_order`,

    sql`select document_id, doc_no, partner_id, posting_date, due_date,
                gross_total, outstanding, aging_bucket
           from v_open_item
          where company_id = ${co} and doc_type = 'SALES_INVOICE'
          order by posting_date desc`,

    // Shown on the voucher before posting. The real number is taken under a
    // row lock at posting time, so this is a preview and may move if someone
    // else posts first.
    //
    // Asked of the database rather than assembled here: the number carries
    // the date and a daily sequence, and a second hand-written copy of that
    // format is how the two drift apart.
    sql`select fn_peek_document_no(${co}, 'SALES_INVOICE', current_date) as no`,

    // Per item, per location — what the company-wide on_hand above can't
    // show: whether the specific warehouse making this sale actually has it.
    sql`select item_id, location_id, qty_on_hand from v_stock_on_hand where company_id = ${co}`,
  ]);

  return {
    customers, suppliers, items, locations, volumeDiscounts, groups, uoms,
    salesmen, promotions, cashAccounts, focReasons, itemPrices, priceLevels, openInvoices,
    // Null until the first invoice of the year exists, since the format
    // depends on a series that has not been created yet.
    nextInvoiceNo: (nextNo[0]?.no as string | null) ?? null,
    stockByLocation,
  };
}

// ---------------------------------------------------------- warehouses --

/** True (23503) when a delete failed because something still references the row. */
function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23503";
}

/**
 * True (23505) when a create raced another request for the same code. Every
 * master-data create already pre-checks for a duplicate before inserting, so
 * this only ever fires on an actual race — but without it, that rare case
 * would surface Postgres's raw constraint-violation text instead of a
 * message someone entering data can actually act on.
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export async function createLocation(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Warehouse added";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();

    const name = str(fd, "name");
    const parentId = str(fd, "parent_id") || null;

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`select 1 from location where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      insert into location (company_id, parent_id, code, name, name_my, is_stock_location)
      values (${co}, ${parentId}, ${code}, ${name}, ${str(fd, "name_my") || null},
              ${fd.get("is_stock_location") === "on"})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/warehouses");
  redirectWithToast("/warehouses", toastMsg);
}

export async function updateLocation(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Warehouse updated";

  try {
    const co = await companyId();

    const id = str(fd, "id");
    const code = str(fd, "code").toUpperCase();
    const name = str(fd, "name");
    const parentId = str(fd, "parent_id") || null;

    if (!id) return { error: "Choose a warehouse" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (parentId === id) return { error: "A warehouse cannot sit under itself" };

    if (parentId) {
      const cycle = await sql`
        with recursive descendants as (
          select id from location where id = ${id} and company_id = ${co}
          union all
          select l.id from location l join descendants d on l.parent_id = d.id
        )
        select 1 from descendants where id = ${parentId}`;
      if (cycle.length) return { error: "That would put it inside its own branch" };
    }

    const dup = await sql`
      select 1 from location where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      update location set
        code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
        parent_id = ${parentId}, is_stock_location = ${fd.get("is_stock_location") === "on"},
        is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/warehouses");
  redirectWithToast("/warehouses", toastMsg);
}

/** Deactivates a warehouse without touching any history that points at it. */
export async function deactivateLocation(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a warehouse" };

    await sql`update location set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/warehouses");
  redirectWithToast("/warehouses", "Warehouse deactivated");
}

/** Puts back what deactivateLocation retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateLocation(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a warehouse" };

    await sql`update location set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/warehouses");
  redirectWithToast("/warehouses", "Warehouse reactivated");
}

/**
 * Hard delete only succeeds for a warehouse nothing has ever touched —
 * transactions are append-only, so a warehouse with history stays as a
 * foreign key everywhere it was used. Deactivating is the way to retire one.
 */
export async function deleteLocation(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a warehouse" };

    await sql`delete from location where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This warehouse has documents or stock history against it — deactivate it instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/warehouses");
  redirectWithToast("/warehouses", "Warehouse deleted");
}

// ------------------------------------------------------- salespersons --

export async function createSalesman(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Salesperson added";
  const code = str(fd, "code").toUpperCase();

  try {
    const co = await companyId();

    const name = str(fd, "name");

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`select 1 from salesman where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      insert into salesman (company_id, code, name, name_my, phone, location_id, commission_pct)
      values (${co}, ${code}, ${name}, ${str(fd, "name_my") || null}, ${str(fd, "phone") || null},
              ${str(fd, "location_id") || null}, ${num(fd, "commission_pct")})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/salespersons");
  redirectWithToast("/salespersons", toastMsg);
}

export async function updateSalesman(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Salesperson updated";

  try {
    const co = await companyId();

    const id = str(fd, "id");
    const code = str(fd, "code").toUpperCase();
    const name = str(fd, "name");

    if (!id) return { error: "Choose a salesperson" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };

    const dup = await sql`
      select 1 from salesman where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    await sql`
      update salesman set
        code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
        phone = ${str(fd, "phone") || null}, location_id = ${str(fd, "location_id") || null},
        commission_pct = ${num(fd, "commission_pct")}, is_active = ${fd.get("is_active") === "on"}
      where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/salespersons");
  redirectWithToast("/salespersons", toastMsg);
}

export async function deactivateSalesman(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a salesperson" };

    await sql`update salesman set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/salespersons");
  redirectWithToast("/salespersons", "Salesperson deactivated");
}

/** Puts back what deactivateSalesman retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateSalesman(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a salesperson" };

    await sql`update salesman set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/salespersons");
  redirectWithToast("/salespersons", "Salesperson reactivated");
}

export async function deleteSalesman(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a salesperson" };

    await sql`delete from salesman where id = ${id} and company_id = ${co}`;
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This salesperson has documents against them — deactivate instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/salespersons");
  redirectWithToast("/salespersons", "Salesperson deleted");
}

// ------------------------------------------------------ stock adjustments --

function parseAdjustmentLines(fd: FormData): AdjustmentLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the lines");

  return parsed
    .map((l: any) => ({
      itemId: String(l.itemId ?? ""),
      qty: Number(l.qty),
      unitCost: l.unitCost !== "" && l.unitCost != null ? Number(l.unitCost) : undefined,
    }))
    .filter((l) => l.itemId && l.qty !== 0);
}

export async function createStockAdjustment(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Stock adjustment posted";

  try {
    const co = await companyId();
    const lines = parseAdjustmentLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postStockAdjustment({
      companyId: co,
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      receivedAt: dateTime(fd, "doc_date", "received_time"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Adjustment ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  revalidatePath("/inventory/movements");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// -------------------------------------------------------- stock transfers --

function parseTransferLines(fd: FormData): TransferLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the lines");

  return parsed
    .map((l: any) => ({ itemId: String(l.itemId ?? ""), qty: Number(l.qty) }))
    .filter((l) => l.itemId && l.qty > 0);
}

export async function createStockTransfer(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Transfer posted";

  try {
    const co = await companyId();
    const lines = parseTransferLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    const fromLocationId = str(fd, "from_location_id");
    const toLocationId = str(fd, "to_location_id");
    if (!fromLocationId) return { error: "Choose a source warehouse" };
    if (!toLocationId) return { error: "Choose a destination warehouse" };
    if (fromLocationId === toLocationId) return { error: "Choose two different warehouses" };

    const result = await postStockTransfer({
      companyId: co,
      fromLocationId,
      toLocationId,
      docDate: str(fd, "doc_date"),
      receivedAt: dateTime(fd, "doc_date", "received_time"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      // Same rule as a delivery: present only when the dialog was answered.
      allowNegativeStock: fd.get("allow_negative_stock") !== null,
      lines,
    });

    docId = result.id;
    toastMsg = `Transfer ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/items");
  revalidatePath("/items/stock");
  revalidatePath("/inventory/movements");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// ------------------------------------------------------------ reorder points --

export async function createReorderPoint(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const itemId = str(fd, "item_id");
    const locationId = str(fd, "location_id");
    const minQty = num(fd, "min_qty");

    if (!itemId) return { error: "Choose an item" };
    if (!locationId) return { error: "Choose a location" };
    if (minQty <= 0) return { error: "Reorder point must be greater than zero" };

    const dup = await sql`
      select 1 from item_reorder where company_id = ${co} and item_id = ${itemId} and location_id = ${locationId}`;
    if (dup.length) return { error: "This item and location already has a reorder point — edit it instead" };

    await sql`
      insert into item_reorder (company_id, item_id, location_id, min_qty)
      values (${co}, ${itemId}, ${locationId}, ${minQty})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: "This item and location already has a reorder point — edit it instead" };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/stock");
  redirectWithToast("/items/stock", "Reorder point added");
}

export async function updateReorderPoint(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    const minQty = num(fd, "min_qty");

    if (!id) return { error: "Choose a reorder point" };
    if (minQty <= 0) return { error: "Reorder point must be greater than zero" };

    await sql`update item_reorder set min_qty = ${minQty} where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/stock");
  redirectWithToast("/items/stock", "Reorder point updated");
}

export async function deleteReorderPoint(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a reorder point" };

    await sql`delete from item_reorder where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items/stock");
  redirectWithToast("/items/stock", "Reorder point removed");
}

// --------------------------------------------------- chart of accounts --

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COGS", "EXPENSE"];

/**
 * Why an account must not be retired. The posting engine resolves some
 * accounts by role and the ledger refuses postings to an inactive account,
 * so deactivating one of these turns a routine sale into a runtime error.
 * Better to refuse here, naming the role, than to break posting later.
 */
async function accountLock(co: string, id: string): Promise<string | null> {
  const sys = await sql`
    select role from system_account where company_id = ${co} and account_id = ${id} order by role`;
  if (sys.length) {
    const roles = sys.map((r: any) => r.role.replace(/_/g, " ").toLowerCase()).join(", ");
    return `The posting engine uses this account for ${roles}. Point that role at another account before retiring this one.`;
  }

  const rules = await sql`
    select distinct role from account_determination
     where company_id = ${co} and account_id = ${id} order by role`;
  if (rules.length) {
    const roles = rules.map((r: any) => r.role.replace(/_/g, " ").toLowerCase()).join(", ");
    return `Posting rules send ${roles} to this account. Change those rules before retiring it.`;
  }

  return null;
}

/** Bank accounts are a subset of cash accounts — see migration 0014. */
function moneyFlags(kind: string): { cash: boolean; bank: boolean } {
  if (kind === "bank") return { cash: true, bank: true };
  if (kind === "cash") return { cash: true, bank: false };
  return { cash: false, bank: false };
}

export async function createAccount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Account added";
  const code = str(fd, "code");

  try {
    const co = await companyId();

    const name = str(fd, "name");
    const type = str(fd, "account_type");
    const parentId = str(fd, "parent_id") || null;

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (!ACCOUNT_TYPES.includes(type)) return { error: "Choose an account type" };

    const dup = await sql`select 1 from account where company_id = ${co} and code = ${code}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    if (parentId) {
      const [p] = await sql`
        select code, name, account_type from account where id = ${parentId} and company_id = ${co}`;
      if (!p) return { error: "That parent account no longer exists" };
      if (p.account_type !== type) {
        return {
          error: `${p.code} ${p.name} is ${String(p.account_type).toLowerCase()}, so anything filed under it has to be too`,
        };
      }

      // An account that has been posted to cannot become a heading: the
      // ledger refuses postings to headings, so its own history would sit on
      // an account nothing is allowed to post to any more.
      const [posted] = await sql`
        select count(*)::int as n from journal_line
         where company_id = ${co} and account_id = ${parentId}`;
      if (posted.n > 0) {
        return {
          error: `${p.code} ${p.name} already has ${posted.n} posting${posted.n === 1 ? "" : "s"} against it and cannot become a heading. File this account alongside it instead.`,
        };
      }
    }

    const money = moneyFlags(str(fd, "money_kind"));

    await sql.begin(async (tx) => {
      await tx`
        insert into account
          (company_id, parent_id, code, name, name_my, account_type,
           currency, is_cash_account, is_bank_account)
        values
          (${co}, ${parentId}, ${code}, ${name}, ${str(fd, "name_my") || null}, ${type},
           ${str(fd, "currency") || null}, ${money.cash}, ${money.bank})`;

      // Gaining a child makes the parent a heading, and headings are not postable.
      if (parentId) {
        await tx`
          update account set is_postable = false
           where id = ${parentId} and company_id = ${co}`;
      }
    });

  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/settings/accounts");
  redirectWithToast("/settings/accounts", toastMsg);
}

export async function updateAccount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const toastMsg = "Account updated";

  try {
    const co = await companyId();

    const id = str(fd, "id");
    const code = str(fd, "code");
    const name = str(fd, "name");
    const type = str(fd, "account_type");
    const parentId = str(fd, "parent_id") || null;
    const isActive = fd.get("is_active") !== null;

    if (!id) return { error: "Choose an account" };
    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (!ACCOUNT_TYPES.includes(type)) return { error: "Choose an account type" };
    if (parentId === id) return { error: "An account cannot sit under itself" };

    const [current] = await sql`
      select account_type, is_active, parent_id from account
       where id = ${id} and company_id = ${co}`;
    if (!current) return { error: "That account no longer exists" };

    const dup = await sql`
      select 1 from account where company_id = ${co} and code = ${code} and id <> ${id}`;
    if (dup.length) return { error: `Code ${code} is already used` };

    const [posted] = await sql`
      select count(*)::int as n from journal_line
       where company_id = ${co} and account_id = ${id}`;

    // Retyping a posted account silently moves its history between the
    // balance sheet and the income statement.
    if (type !== current.account_type && posted.n > 0) {
      return {
        error: `This account has ${posted.n} posting${posted.n === 1 ? "" : "s"} against it, so its type can no longer change — that would move settled history between the balance sheet and the income statement.`,
      };
    }

    if (!isActive && current.is_active) {
      const lock = await accountLock(co, id);
      if (lock) return { error: lock };
    }

    if (parentId) {
      const cycle = await sql`
        with recursive descendants as (
          select id from account where id = ${id} and company_id = ${co}
          union all
          select a.id from account a join descendants d on a.parent_id = d.id
        )
        select 1 from descendants where id = ${parentId}`;
      if (cycle.length) return { error: "That would put the account inside its own branch" };

      const [p] = await sql`
        select code, name, account_type from account where id = ${parentId} and company_id = ${co}`;
      if (!p) return { error: "That parent account no longer exists" };
      if (p.account_type !== type) {
        return {
          error: `${p.code} ${p.name} is ${String(p.account_type).toLowerCase()}, so anything filed under it has to be too`,
        };
      }
    }

    const money = moneyFlags(str(fd, "money_kind"));

    await sql.begin(async (tx) => {
      await tx`
        update account set
          code = ${code}, name = ${name}, name_my = ${str(fd, "name_my") || null},
          account_type = ${type}, parent_id = ${parentId},
          currency = ${str(fd, "currency") || null},
          is_cash_account = ${money.cash}, is_bank_account = ${money.bank},
          is_active = ${isActive}
        where id = ${id} and company_id = ${co}`;

      if (parentId) {
        await tx`update account set is_postable = false where id = ${parentId} and company_id = ${co}`;
      }

      // Moving out of a branch can leave the old parent childless. A heading
      // with nothing under it and nothing allowed to post to it is dead, so
      // hand it back its postability.
      if (current.parent_id && current.parent_id !== parentId) {
        const [left] = await tx`
          select 1 from account where parent_id = ${current.parent_id} limit 1`;
        if (!left) {
          await tx`update account set is_postable = true where id = ${current.parent_id}`;
        }
      }
    });

  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/settings/accounts");
  redirectWithToast("/settings/accounts", toastMsg);
}

export async function deactivateAccount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an account" };

    const lock = await accountLock(co, id);
    if (lock) return { error: lock };

    await sql`update account set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/settings/accounts");
  redirectWithToast("/settings/accounts", "Account deactivated");
}

/** Puts back what deactivateAccount retired. Reactivating is always safe, so
 *  unlike deactivation it carries no guard. */
export async function activateAccount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an account" };

    await sql`update account set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/settings/accounts");
  redirectWithToast("/settings/accounts", "Account reactivated");
}

/**
 * Only ever succeeds for an account nothing has touched. Anything with
 * postings, rules, or a partner override behind it is held by a foreign key,
 * which is the answer we want — history stays intact and the account gets
 * deactivated instead.
 */
export async function deleteAccount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose an account" };

    const lock = await accountLock(co, id);
    if (lock) return { error: lock };

    const [kid] = await sql`
      select 1 from account where parent_id = ${id} and company_id = ${co} limit 1`;
    if (kid) return { error: "This account has accounts filed under it. Move or remove those first." };

    const [target] = await sql`
      select parent_id from account where id = ${id} and company_id = ${co}`;

    await sql.begin(async (tx) => {
      await tx`delete from account where id = ${id} and company_id = ${co}`;

      // A heading that just lost its last child is postable again — otherwise
      // it is left as an account nothing can post to and nothing sits under.
      if (target?.parent_id) {
        const [left] = await tx`
          select 1 from account where parent_id = ${target.parent_id} limit 1`;
        if (!left) {
          await tx`update account set is_postable = true where id = ${target.parent_id}`;
        }
      }
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { error: "This account has postings or rules against it — deactivate it instead of deleting" };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/settings/accounts");
  redirectWithToast("/settings/accounts", "Account deleted");
}

// ---------------------------------------------------------- consignment --

export async function createConsignmentAgreement(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const partnerId = str(fd, "partner_id");
    if (!partnerId) return { error: "Choose a consignor" };

    const [existing] = await sql`
      select id from consignment_agreement where company_id = ${co} and partner_id = ${partnerId}`;
    if (existing) return { error: "This supplier already has a consignment agreement" };

    await sql`insert into consignment_agreement (company_id, partner_id, memo)
      values (${co}, ${partnerId}, ${str(fd, "memo") || null})`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/inventory/consignment");
  redirectWithToast("/inventory/consignment", "Consignment agreement created");
}

export async function addConsignmentAgreementLine(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const agreementId = str(fd, "agreement_id");
    const itemId = str(fd, "item_id");
    const method = str(fd, "pricing_method");
    const value = Number(fd.get("pricing_value"));

    if (!agreementId || !itemId) return { error: "Choose an item" };
    if (method !== "PERCENTAGE" && method !== "FIXED") return { error: "Choose a settlement method" };
    if (!Number.isFinite(value) || value <= 0) return { error: "Enter a settlement value" };
    if (method === "PERCENTAGE" && value > 100) return { error: "A percentage cannot exceed 100" };

    await sql`
      insert into consignment_agreement_line (company_id, agreement_id, item_id, pricing_method, pricing_value)
      values (${co}, ${agreementId}, ${itemId}, ${method}, ${value})`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/inventory/consignment");
  redirectWithToast("/inventory/consignment", "Item added to the agreement");
}

function parseConsignmentReceiptLines(fd: FormData): ConsignmentReceiptLine[] {
  const raw = String(fd.get("lines") ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the receipt lines");
  }
  if (!Array.isArray(parsed)) throw new Error("Could not read the receipt lines");

  return parsed
    .map((l: any) => ({
      itemId: String(l.itemId ?? ""),
      qty: Number(l.qty),
      agreementLineId: String(l.agreementLineId ?? ""),
    }))
    .filter((l) => l.itemId && l.qty > 0 && l.agreementLineId);
}

export async function createConsignmentReceipt(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Consignment receipt posted";

  try {
    const co = await companyId();
    const lines = parseConsignmentReceiptLines(fd);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a consignor" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const result = await postConsignmentReceipt({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate: str(fd, "doc_date"),
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Consignment receipt ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/inventory/consignment");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

/**
 * A consignment sale is a normal sale whose lines are all forced to draw
 * consigned stock — a dedicated form rather than a checkbox buried in the
 * general sales voucher, because the settlement math (consignor, rate,
 * amount owed, margin) is the entire point of this screen and deserves to
 * be shown plainly rather than tucked away.
 */
export async function createConsignmentSale(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let docId: string;
  let toastMsg = "Consignment sale posted";

  try {
    const co = await companyId();
    const raw = String(fd.get("lines") ?? "[]");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: "Could not read the sale lines" };
    }
    if (!Array.isArray(parsed)) return { error: "Could not read the sale lines" };

    const lines: InvoiceLine[] = parsed
      .map((l: any) => ({
        itemId: String(l.itemId ?? ""),
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        source: "CONSIGNMENT" as const,
      }))
      .filter((l) => l.itemId && l.qty > 0);

    if (lines.length === 0) return { error: "Add at least one line with a quantity" };
    if (!str(fd, "partner_id")) return { error: "Choose a customer" };
    if (!str(fd, "location_id")) return { error: "Choose a warehouse" };

    const dueDays = Number(fd.get("due_days") ?? 0);
    const docDate = str(fd, "doc_date");
    const dueDate = dueDays > 0
      ? new Date(new Date(docDate).getTime() + dueDays * 86400000).toISOString().slice(0, 10)
      : null;

    const result = await postSaleWithDelivery({
      companyId: co,
      partnerId: str(fd, "partner_id"),
      locationId: str(fd, "location_id"),
      docDate,
      dueDate,
      memo: str(fd, "memo") || null,
      reference: str(fd, "reference") || null,
      lines,
    });

    docId = result.id;
    toastMsg = `Consignment sale ${result.docNo} posted`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath("/inventory/consignment");
  revalidatePath("/purchases/invoices");
  redirectWithToast(`/documents/${docId}`, toastMsg);
}

// -------------------------------------------------------- volume discount --

/**
 * A discount band: a quantity range, or an invoice-total range, and the
 * percentage it earns.
 *
 * Bands are not validated against each other for overlap. Two that both cover
 * 100 units is a legitimate configuration — a general rule and an exception
 * for one product — and the pricing resolves it by taking the narrowest
 * scope, then the larger discount. Refusing overlaps here would forbid the
 * ordinary case in order to prevent a confusion that does not arise.
 */
export async function createVolumeDiscount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  const code = str(fd, "code").toUpperCase();
  try {
    const co = await companyId();
    const basis = str(fd, "basis") === "INVOICE_TOTAL" ? "INVOICE_TOTAL" : "QUANTITY";
    const name = str(fd, "name");
    const minValue = num(fd, "min_value");
    const maxRaw = str(fd, "max_value");
    const maxValue = maxRaw === "" ? null : Number(maxRaw);
    const pct = num(fd, "discount_pct");

    if (!code) return { error: "Code is required" };
    if (!name) return { error: "Name is required" };
    if (pct <= 0 || pct > 100) return { error: "Discount must be between 0 and 100 percent" };
    if (maxValue !== null && maxValue < minValue) {
      return { error: "The upper bound cannot be below the lower one" };
    }

    // An invoice-total band applies to the whole bill, so scoping it to an
    // item would describe a rule that could never be evaluated. The database
    // refuses it too; this says so in words first.
    const itemId = basis === "QUANTITY" ? str(fd, "item_id") || null : null;
    const groupId = basis === "QUANTITY" ? str(fd, "item_group_id") || null : null;
    if (itemId && groupId) {
      return { error: "Scope a band to an item or a category, not both" };
    }

    await sql`
      insert into volume_discount
        (company_id, code, name, basis, item_id, item_group_id,
         min_value, max_value, discount_pct, valid_from, valid_to)
      values (${co}, ${code}, ${name}, ${basis}, ${itemId}, ${groupId},
              ${minValue}, ${maxValue}, ${pct},
              ${str(fd, "valid_from") || new Date().toISOString().slice(0, 10)},
              ${str(fd, "valid_to") || null})`;
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Code ${code} is already used` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/sales/discounts");
  redirectWithToast("/sales/discounts", "Discount band added");
}

export async function deactivateVolumeDiscount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a band" };
    // Retired rather than deleted: invoices point at the band that priced
    // them, and an invoice unable to say which rule gave its discount is the
    // thing this feature exists to prevent.
    await sql`update volume_discount set is_active = false where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/sales/discounts");
  redirectWithToast("/sales/discounts", "Band retired");
}

export async function activateVolumeDiscount(_prev: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const co = await companyId();
    const id = str(fd, "id");
    if (!id) return { error: "Choose a band" };
    await sql`update volume_discount set is_active = true where id = ${id} and company_id = ${co}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/sales/discounts");
  redirectWithToast("/sales/discounts", "Band reinstated");
}

// ------------------------------------------------ negative stock --

/**
 * Brings recorded stock back up to what is physically on the shelf.
 *
 * Takes only which shortfalls to clear — no price. The figure was decided
 * when the goods left and is stored with the shortfall; asking for it again
 * here would let the correction and the cost of sale disagree.
 */
export async function reconcileNegativeStockAction(
  _prev: unknown, fd: FormData
): Promise<ActionResult> {
  let msg: string;
  try {
    const co = await companyId();
    const ids = fd.getAll("negative_stock_id").map(String).filter(Boolean);
    if (ids.length === 0) return { error: "Choose at least one line to reconcile" };

    const done = await reconcileNegativeStock({
      companyId: co,
      negativeStockIds: ids,
      docDate: str(fd, "doc_date") || new Date().toISOString().slice(0, 10),
      memo: str(fd, "memo") || null,
    });
    msg = `${done.units} unit${done.units === 1 ? "" : "s"} reconciled — ${done.documents.join(", ")}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/inventory/negative-stock");
  revalidatePath("/items/stock");
  revalidatePath("/documents");
  financeRevalidate();
  redirectWithToast("/inventory/negative-stock", msg);
}

// ------------------------------------------------------------------ void --

/**
 * Voids a posted document.
 *
 * The confirmation screen has already shown what this would do, but the
 * engine re-checks against the database as it is now: something can be built
 * on top of a document between looking at it and pressing the button, and a
 * half-undone chain is worse than a refusal.
 */
export async function voidDocumentAction(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let msg: string;
  let docId: string;
  try {
    const co = await companyId();
    docId = str(fd, "id");
    if (!docId) return { error: "Choose a document" };

    const [owned] = await sql`
      select id from document where id = ${docId} and company_id = ${co}`;
    if (!owned) return { error: "That document no longer exists" };

    const done = await voidDocument({
      documentId: docId,
      reason: str(fd, "reason") || null,
    });
    msg = `${done.docNo} voided — reversed by ${done.reversalNo}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/documents");
  revalidatePath(`/documents/${docId}`);
  revalidatePath("/documents/history");
  revalidatePath("/");
  financeRevalidate();
  redirectWithToast(`/documents/${docId}`, msg);
}

// --------------------------------------------------- item/stock import --

/**
 * Reads a spreadsheet and reports what it would do, changing nothing.
 *
 * Deliberately a separate call from the import itself, and deliberately the
 * same validator: the preview a person approves has to be produced by the
 * code that later acts, or they are approving one thing and getting another.
 */
/** Rows from whichever kind of file was uploaded. */
async function readUpload(content: string, format: UploadFormat): Promise<string[][]> {
  return format === "xlsx" ? xlsxToRows(content) : parseCsv(content);
}

export async function previewItemImport(
  content: string, filename: string, format: UploadFormat = "csv"
) {
  const co = await companyId();
  const master = (await getImportMasterData(co)) as unknown as MasterData;
  const plan = planImport(await readUpload(content, format), master);
  return { plan, filename };
}

export async function runItemImport(
  _prev: unknown, fd: FormData
): Promise<ActionResult> {
  let done: { ref: string; itemsCreated: number; itemsMatched: number };
  try {
    const co = await companyId();
    const content = str(fd, "csv");
    const filename = str(fd, "filename") || "import.csv";
    const format = (str(fd, "format") === "xlsx" ? "xlsx" : "csv") as UploadFormat;
    if (!content) return { error: "No file was uploaded" };

    // Re-validated here, against the database as it is now rather than as it
    // was when the preview was drawn. Master data can be edited, or another
    // import run, between the two — and the check that matters most (stock
    // already present) is exactly the kind that changes underneath you.
    const master = (await getImportMasterData(co)) as unknown as MasterData;
    const plan = planImport(await readUpload(content, format), master);

    if (plan.errors.length > 0) {
      return {
        error:
          `${plan.errors.length} problem${plan.errors.length === 1 ? "" : "s"} found on re-checking the ` +
          `file — the first is row ${plan.errors[0].row}: ${plan.errors[0].message}`,
      };
    }
    if (plan.rows.length === 0) return { error: "There is nothing to import" };

    done = await importItems({
      companyId: co,
      filename,
      rowCount: plan.summary.rows,
      rows: plan.rows,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/items");
  redirectWithToast(
    "/items/import",
    `${done.ref}: ${done.itemsCreated} item${done.itemsCreated === 1 ? "" : "s"} created` +
    (done.itemsMatched > 0 ? `, ${done.itemsMatched} already existed` : "")
  );
}

/**
 * The blank workbook to fill in.
 *
 * Built server-side and handed back as bytes, so the Barcode column can be
 * formatted as Text before anyone types in it. That is the whole point: the
 * barcode damage happens in Excel, before any file reaches us, and a template
 * that arrives already formatted is the only fix that works by default rather
 * than by the user remembering.
 */
export async function itemImportTemplate(): Promise<{ base64: string }> {
  const { buildImportTemplate } = await import("./read-spreadsheet");
  return { base64: await buildImportTemplate() };
}

// ------------------------------------------ cash / bank receipt import --

export async function previewVoucherImport(
  content: string, filename: string, format: UploadFormat, kind: VoucherKind
) {
  const co = await companyId();
  const master = (await getVoucherImportMasterData(co)) as unknown as VoucherMasterData;
  const rows = format === "xlsx" ? await xlsxToRows(content) : parseCsv(content);
  return { plan: planVoucherImport(rows, master, kind), filename };
}

/** The blank workbook for a receipt import, columns matching the screen. */
export async function voucherImportTemplate(kind: VoucherKind): Promise<{ base64: string }> {
  const { buildVoucherTemplate } = await import("./read-spreadsheet");
  return { base64: await buildVoucherTemplate(voucherColumns(kind), kind) };
}

export async function runVoucherImport(_prev: unknown, fd: FormData): Promise<ActionResult> {
  let done: { ref: string; posted: number; total: number };
  let kind: VoucherKind = "cash";
  try {
    const co = await companyId();
    const content = str(fd, "csv");
    const filename = str(fd, "filename") || "receipts.xlsx";
    const format = (str(fd, "format") === "xlsx" ? "xlsx" : "csv") as UploadFormat;
    kind = str(fd, "kind") === "bank" ? "bank" : "cash";
    if (!content) return { error: "No file was uploaded" };

    // Re-checked against the database as it is now, not as it was when the
    // preview was drawn — a period can be closed, or an account deactivated,
    // between looking and confirming.
    const master = (await getVoucherImportMasterData(co)) as unknown as VoucherMasterData;
    const rows = format === "xlsx" ? await xlsxToRows(content) : parseCsv(content);
    const plan = planVoucherImport(rows, master, kind);

    if (plan.errors.length > 0) {
      return {
        error:
          `${plan.errors.length} problem${plan.errors.length === 1 ? "" : "s"} found on re-checking the ` +
          `file — the first is row ${plan.errors[0].row}: ${plan.errors[0].message}`,
      };
    }
    if (plan.rows.length === 0) return { error: "There is nothing to import" };

    done = await importVouchers({
      companyId: co, kind, filename, rowCount: plan.summary.rows,
      rows: plan.rows.map((r) => ({
        docDate: r.docDate,
        moneyAccountId: r.moneyAccountId,
        otherAccountId: r.otherAccountId,
        amount: r.amount,
        locationId: r.locationId,
        reference: r.reference,
        memo: r.memo,
      })),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  financeRevalidate();
  redirectWithToast(
    kind === "cash" ? "/finance/cash-receipt/import" : "/finance/bank-receipt/import",
    `${done.ref}: ${done.posted} receipt${done.posted === 1 ? "" : "s"} posted, ${done.total.toLocaleString()} total`
  );
}

/**
 * Registers brands an import file named that the brand master does not have.
 *
 * Deliberately its own action with its own button rather than something the
 * import does on its way past. Auto-creating master data from a spreadsheet
 * is how a chart ends up holding Coca-Cola, Coca Cola and COKE as three
 * brands, each with a share of the sales — a typo becomes a permanent record
 * and nobody sees it happen. Asking first costs one click and makes the
 * decision visible, which is the whole difference.
 *
 * The code is derived from the name, since a brand code is an internal handle
 * rather than something the trade recognises, and a person invited to invent
 * one for each of forty brands will not enjoy it.
 */
export type MissingEntry = {
  kind: "brand" | "category" | "subcategory";
  name: string;
  /** For a sub category: the name of the category it belongs under. */
  parent?: string;
};

/**
 * Registers names an import sheet used that this database does not have.
 *
 * Categories first, then sub categories, then brands — a sub category cannot
 * be created before the category it hangs off, and the same call may be
 * asked to create both. Within one transaction, so a partial registration
 * cannot leave a sub category orphaned by a category that failed.
 *
 * Nothing here decides that two names mean the same thing. "Coca Cola" and
 * "Coca-Cola" are registered as two brands if that is what is asked for; the
 * preview is where the resemblance is pointed out, and choosing is the
 * user's. Guessing would silently merge two real products, which is worse
 * than the duplicate it avoids.
 */
export async function createMissingMasterData(
  entries: MissingEntry[]
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  try {
    const co = await companyId();

    // A generated code, letters and digits only so it stays typeable, with a
    // numeric suffix settling the rare collision between two similar names.
    const codeFor = async (
      tx: typeof sql, table: "brand" | "item_group", column: "code" | "segment",
      name: string, fallback: string
    ) => {
      const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || fallback;
      let code = base;
      for (let i = 2; ; i++) {
        const clash = await tx.unsafe(
          `select 1 from ${table} where company_id = $1 and ${column} = $2`, [co, code]);
        if (clash.length === 0) break;
        code = `${base.slice(0, 12 - String(i).length)}${i}`;
      }
      return code;
    };

    const order = { category: 0, subcategory: 1, brand: 2 } as const;
    const wanted = entries
      .filter((e) => e.name?.trim())
      .map((e) => ({ ...e, name: e.name.trim(), parent: e.parent?.trim() }))
      .sort((a, b) => order[a.kind] - order[b.kind]);
    if (wanted.length === 0) return { ok: true, created: 0 };

    let created = 0;
    await sql.begin(async (tx) => {
      for (const e of wanted) {
        if (e.kind === "brand") {
          const [existing] = await tx`
            select id from brand where company_id = ${co} and lower(name) = ${e.name.toLowerCase()}`;
          if (existing) continue;   // added by someone else since the preview
          const code = await codeFor(tx as never, "brand", "code", e.name, "BRAND");
          await tx`insert into brand (company_id, code, name) values (${co}, ${code}, ${e.name})`;
          created++;
          continue;
        }

        let parentId: string | null = null;
        if (e.kind === "subcategory") {
          if (!e.parent) throw new Error(`"${e.name}" needs the category it belongs under`);
          const [parent] = await tx`
            select id from item_group
             where company_id = ${co} and parent_id is null
               and lower(name) = ${e.parent.toLowerCase()}`;
          if (!parent) {
            // Either the category was not in this batch, or it failed. Saying
            // so beats creating a second root category with the sub's name.
            throw new Error(`Category "${e.parent}" does not exist, so "${e.name}" cannot go under it`);
          }
          parentId = parent.id;
        }

        const [existing] = await tx`
          select id from item_group
           where company_id = ${co} and lower(name) = ${e.name.toLowerCase()}
             and parent_id is not distinct from ${parentId}`;
        if (existing) continue;

        const segment = await codeFor(tx as never, "item_group", "segment", e.name, "CAT");
        // Composed the same way createCategory does it. A trigger maintains
        // `code` from the parent chain and this segment, but the composed
        // value is written here too so the row is right the moment it exists.
        const [composed] = await tx`
          select fn_compose_group_code(${parentId}::uuid, ${segment}) as code`;
        await tx`
          insert into item_group (company_id, parent_id, segment, code, name)
          values (${co}, ${parentId}, ${segment}, ${composed.code}, ${e.name})`;
        created++;
      }
    });

    // Already committed. Revalidation is a hint, and letting it throw here
    // would report failure for master data that now exists — the caller would
    // show an error and the user would go and find it there.
    try {
      revalidatePath("/items/brands");
      revalidatePath("/items/categories");
      revalidatePath("/items/subcategories");
      revalidatePath("/items");
    } catch {
      // Outside a request context (scripts, tests). Nothing to revalidate.
    }
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createMissingBrands(
  names: string[]
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  try {
    const co = await companyId();
    const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) return { ok: true, created: 0 };

    let created = 0;
    await sql.begin(async (tx) => {
      for (const name of wanted) {
        const [existing] = await tx`
          select id from brand where company_id = ${co} and lower(name) = ${name.toLowerCase()}`;
        if (existing) continue;   // added by someone else since the preview

        // Letters and digits only, so the code stays typeable; a numeric
        // suffix settles the rare collision between two similar names.
        const base = (name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "BRAND");
        let code = base;
        for (let i = 2; ; i++) {
          const [clash] = await tx`select 1 from brand where company_id = ${co} and code = ${code}`;
          if (!clash) break;
          code = `${base.slice(0, 12 - String(i).length)}${i}`;
        }

        await tx`insert into brand (company_id, code, name) values (${co}, ${code}, ${name})`;
        created++;
      }
    });

    // The brands are already committed. Cache revalidation is a hint, and
    // letting it throw here would report failure for brands that now exist —
    // the caller would show an error, the user would look in Master data and
    // find them there. Same guard as createItemInline, for the same reason.
    try {
      revalidatePath("/items/brands");
      revalidatePath("/items");
    } catch {
      // Outside a request context (scripts, tests). Nothing to revalidate.
    }
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
