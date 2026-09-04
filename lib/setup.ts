import { sql } from "./db";

/**
 * First-run setup: turns an empty database into a working company.
 *
 * Everything here is scaffolding a business cannot post without — a chart of
 * accounts, a fiscal calendar, the accounts the posting engine looks up by
 * role, and the rules that map item groups to them. None of it is demo data;
 * there are no customers, products or documents.
 *
 * The chart below is a conventional Myanmar trading layout. It is a starting
 * point, not a constraint: accounts nest to any depth and can be renamed,
 * added to, or deactivated afterwards.
 */

export type SetupInput = {
  code: string;
  name: string;
  nameMy?: string | null;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  fiscalYearStart: string; // yyyy-mm-dd
  officeName: string;
  warehouseName: string;
};

type AcctSpec = [
  parent: string | null,
  code: string,
  name: string,
  nameMy: string | null,
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COGS" | "EXPENSE",
  control: boolean,
  cash: boolean,
  bank: boolean,
];

const HEADINGS: AcctSpec[] = [
  [null, "1000", "Assets", null, "ASSET", false, false, false],
  [null, "2000", "Liabilities", null, "LIABILITY", false, false, false],
  [null, "3000", "Equity", null, "EQUITY", false, false, false],
  [null, "4000", "Revenue", null, "REVENUE", false, false, false],
  [null, "5000", "Cost of Sales", null, "COGS", false, false, false],
  [null, "6000", "Expenses", null, "EXPENSE", false, false, false],
];

const ACCOUNTS: AcctSpec[] = [
  ["1000", "1110", "Cash in Hand", "လက်ကျန်ငွေ", "ASSET", false, true, false],
  ["1000", "1120", "Bank", "ဘဏ်", "ASSET", false, true, true],
  ["1000", "1200", "Accounts Receivable", "ရရန်ရှိငွေ", "ASSET", true, false, false],
  ["1000", "1300", "Inventory", "ကုန်ပစ္စည်း", "ASSET", false, false, false],
  ["1000", "1310", "GR/IR Clearing", null, "ASSET", false, false, false],
  ["2000", "2100", "Accounts Payable", "ပေးရန်ရှိငွေ", "LIABILITY", true, false, false],
  ["2000", "2200", "Commercial Tax Payable", "ကုန်သွယ်လုပ်ငန်းခွန်", "LIABILITY", false, false, false],
  ["3000", "3100", "Share Capital", "ရင်းနှီးငွေ", "EQUITY", false, false, false],
  ["3000", "3200", "Retained Earnings", null, "EQUITY", false, false, false],
  ["3000", "3900", "Opening Balance Equity", null, "EQUITY", false, false, false],
  ["4000", "4100", "Sales Revenue", "ရောင်းရငွေ", "REVENUE", false, false, false],
  ["4000", "4200", "Sales Returns", null, "REVENUE", false, false, false],
  ["4000", "4300", "Purchase Discount Received", null, "REVENUE", false, false, false],
  ["4000", "4400", "FX Gain on Settlement", null, "REVENUE", false, false, false],
  // Carriage charged to the customer. Its own account on purpose: sending it
  // to Sales Revenue inflates what the goods sold for and flatters gross
  // margin by the same amount, which is the mistake migration 0032 was
  // written to undo. A chart with nowhere to put it leaves the company
  // unable to charge a delivery fee at all.
  ["4000", "4500", "Delivery Income", null, "REVENUE", false, false, false],
  ["5000", "5100", "Cost of Goods Sold", "ကုန်ကျစရိတ်", "COGS", false, false, false],
  ["5000", "5200", "Purchase Price Variance", null, "COGS", false, false, false],
  ["5000", "5300", "Stock Adjustment", null, "COGS", false, false, false],
  ["6000", "6100", "Promotion Expense", null, "EXPENSE", false, false, false],
  ["6000", "6200", "Sales Discount Allowed", null, "EXPENSE", false, false, false],
  ["6000", "6300", "Salaries", "လစာ", "EXPENSE", false, false, false],
  ["6000", "6400", "Rent", "အငှားခ", "EXPENSE", false, false, false],
  ["6000", "6500", "FX Loss on Settlement", null, "EXPENSE", false, false, false],
  ["6000", "6600", "Rounding Difference", null, "EXPENSE", false, false, false],
];

/** Accounts the posting engine resolves by role rather than by code. */
const SYSTEM_ROLES: [role: string, code: string][] = [
  ["GRIR_CLEARING", "1310"],
  ["PURCHASE_PRICE_VARIANCE", "5200"],
  ["PURCHASE_DISCOUNT_RECEIVED", "4300"],
  ["SALES_DISCOUNT_ALLOWED", "6200"],
  ["STOCK_ADJUSTMENT", "5300"],
  ["PROMOTION_EXPENSE", "6100"],
  ["FX_GAIN", "4400"],
  ["FX_LOSS", "6500"],
  ["ROUNDING_DIFFERENCE", "6600"],
  ["OPENING_BALANCE_EQUITY", "3900"],
  ["RETAINED_EARNINGS", "3200"],
  ["DELIVERY_INCOME", "4500"],
];

/** Company-wide defaults. Categories can override these later. */
const RULES: [role: string, code: string][] = [
  ["INVENTORY", "1300"],
  ["COGS", "5100"],
  ["REVENUE", "4100"],
  ["SALES_RETURN", "4200"],
  ["AR_CONTROL", "1200"],
  ["AP_CONTROL", "2100"],
];

const FOC_REASONS: [code: string, name: string, acct: string][] = [
  ["PROMOTION", "Promotional giveaway", "6100"],
  ["SAMPLE", "Customer sample", "6100"],
  ["OFFICE", "Office use", "6100"],
  ["DAMAGED", "Damaged or expired", "5300"],
];

const SERIES: [type: string, prefix: string][] = [
  ["PURCHASE_ORDER", "PO-"], ["GOODS_RECEIPT", "GR-"], ["PURCHASE_INVOICE", "PI-"],
  ["PURCHASE_RETURN", "PR-"], ["SUPPLIER_PAYMENT", "PAY-"],
  ["SALES_ORDER", "SO-"], ["DELIVERY", "DO-"], ["SALES_INVOICE", "SI-"],
  ["SALES_RETURN", "SR-"], ["CUSTOMER_RECEIPT", "RC-"],
  ["STOCK_ADJUSTMENT", "ADJ-"], ["STOCK_TRANSFER", "TRF-"], ["OPENING_BALANCE", "OB-"],
  ["CASH_VOUCHER", "CV-"], ["BANK_VOUCHER", "BV-"], ["JOURNAL_VOUCHER", "JV-"],
  ["CASH_TRANSFER", "CT-"], ["JOURNAL", "JE-"],
];

export async function scaffoldCompany(input: SetupInput) {
  return sql.begin(async (tx) => {
    const existing = await tx`select 1 from company limit 1`;
    if (existing.length) throw new Error("A company already exists in this database");

    const [co] = await tx`
      insert into company (code, name, name_my, base_currency, fiscal_year_start_month)
      values (${input.code.toUpperCase()}, ${input.name}, ${input.nameMy || null},
              ${input.baseCurrency}, ${input.fiscalYearStartMonth})
      returning id`;

    // ---- fiscal calendar -------------------------------------------------
    const start = new Date(input.fiscalYearStart);
    const endYear = new Date(start);
    endYear.setFullYear(endYear.getFullYear() + 1);
    endYear.setDate(endYear.getDate() - 1);

    const label = `${start.getFullYear()}-${String((start.getFullYear() + 1) % 100).padStart(2, "0")}`;

    const [fy] = await tx`
      insert into fiscal_year (company_id, code, start_date, end_date)
      values (${co.id}, ${label}, ${input.fiscalYearStart},
              ${endYear.toISOString().slice(0, 10)})
      returning id`;

    for (let m = 0; m < 12; m++) {
      const from = new Date(start);
      from.setMonth(from.getMonth() + m);
      const to = new Date(start);
      to.setMonth(to.getMonth() + m + 1);
      to.setDate(to.getDate() - 1);

      await tx`
        insert into fiscal_period
          (company_id, fiscal_year_id, period_no, start_date, end_date, status)
        values (${co.id}, ${fy.id}, ${m + 1},
                ${from.toISOString().slice(0, 10)},
                ${to.toISOString().slice(0, 10)}, 'OPEN')`;
    }

    // ---- chart of accounts ----------------------------------------------
    for (const [, code, name, nameMy, type] of HEADINGS) {
      await tx`
        insert into account (company_id, code, name, name_my, account_type, is_postable)
        values (${co.id}, ${code}, ${name}, ${nameMy}, ${type}, false)`;
    }

    for (const [parent, code, name, nameMy, type, control, cash, bank] of ACCOUNTS) {
      const [p] = await tx`
        select id from account where company_id = ${co.id} and code = ${parent}`;
      await tx`
        insert into account
          (company_id, parent_id, code, name, name_my, account_type,
           is_control, is_cash_account, is_bank_account)
        values (${co.id}, ${p.id}, ${code}, ${name}, ${nameMy}, ${type},
                ${control}, ${cash}, ${bank})`;
    }

    const acctId = async (code: string) =>
      (await tx`select id from account where company_id = ${co.id} and code = ${code}`)[0].id;

    for (const [role, code] of SYSTEM_ROLES) {
      await tx`
        insert into system_account (company_id, role, account_id)
        values (${co.id}, ${role}, ${await acctId(code)})`;
    }

    for (const [role, code] of RULES) {
      await tx`
        insert into account_determination (company_id, role, account_id)
        values (${co.id}, ${role}, ${await acctId(code)})`;
    }

    for (const [code, name, acct] of FOC_REASONS) {
      await tx`
        insert into foc_reason (company_id, code, name, account_id)
        values (${co.id}, ${code}, ${name}, ${await acctId(acct)})`;
    }

    // ---- locations, units, price levels, tax -----------------------------
    const [office] = await tx`
      insert into location (company_id, code, name, is_stock_location)
      values (${co.id}, 'MAIN', ${input.officeName}, false) returning id`;

    await tx`
      insert into location (company_id, parent_id, code, name, is_stock_location)
      values (${co.id}, ${office.id}, 'MAIN-WH', ${input.warehouseName}, true)`;

    await tx`
      insert into uom (company_id, code, name) values
        (${co.id}, 'PCS', 'Pieces'),
        (${co.id}, 'BOX', 'Box'),
        (${co.id}, 'CTN', 'Carton'),
        (${co.id}, 'KG',  'Kilogram')`;

    await tx`
      insert into price_level (company_id, code, name, sort_order) values
        (${co.id}, 'WHOLE',  'Wholesale', 1),
        (${co.id}, 'RETAIL', 'Retail',    2)`;

    // The tax engine is deferred, but every document line points at a code.
    await tx`
      insert into tax_code (company_id, code, name, rate)
      values (${co.id}, 'NONE', 'No Commercial Tax', 0)`;

    for (const [type, prefix] of SERIES) {
      await tx`
        insert into number_series (company_id, document_type, fiscal_year_id, prefix, next_value)
        values (${co.id}, ${type}, ${fy.id}, ${prefix}, 1)`;
    }

    return { id: co.id as string, name: input.name };
  });
}
