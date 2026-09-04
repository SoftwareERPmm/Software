import { sql } from "./db";
import { CHART, SYSTEM, DETERMINATION, FOC_REASONS } from "../db/chart.mjs";

/**
 * First-run setup: turns an empty database into a working company.
 *
 * Everything here is scaffolding a business cannot post without — a chart of
 * accounts, a fiscal calendar, the accounts the posting engine looks up by
 * role, and the rules that map item groups to them. None of it is demo data;
 * there are no customers, products or documents.
 *
 * The chart itself lives in db/chart.mjs, shared with scripts/load-coa.mjs
 * and the block in db/seed.sql. Three charts used to exist — one here, one
 * for re-charting, one for the demo — which meant a company created through
 * this screen ran on a chart nobody used, and had to be re-charted by hand
 * before it could even charge a delivery fee. It is a starting point, not a
 * constraint: accounts nest to any depth and can be renamed, added to, or
 * deactivated afterwards.
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

type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COGS" | "EXPENSE";

/** One row of db/chart.mjs: code, name, type, whether it can be posted to,
 *  then the flags that are true of only a few accounts. */
type ChartRow = [
  code: string,
  name: string,
  type: AccountType,
  postable: boolean,
  flags?: { control?: boolean; cash?: boolean; bank?: boolean; under?: string; added?: boolean },
];

const chart = CHART as ChartRow[];
const systemRoles = Object.entries(SYSTEM as Record<string, string>);
const rules = Object.entries(DETERMINATION as Record<string, string>);
const focReasons = FOC_REASONS as [code: string, name: string, acct: string][];

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
    // A postable account belongs to the section it follows in the chart; a
    // section belongs to whatever it says it sits under, or to nothing. The
    // same rule scripts/load-coa.mjs applies, because it is reading the same
    // array — the order of the rows is what carries the hierarchy.
    const id = new Map<string, string>();
    let section: string | null = null;
    for (const [code, name, type, postable, flags = {}] of chart) {
      const parent = postable ? section : (flags.under ? id.get(flags.under) ?? null : null);
      const [row] = await tx`
        insert into account
          (company_id, parent_id, code, name, account_type,
           is_postable, is_control, is_cash_account, is_bank_account)
        values (${co.id}, ${parent}, ${code}, ${name}, ${type},
                ${postable}, ${!!flags.control}, ${!!flags.cash}, ${!!flags.bank})
        returning id`;
      id.set(code, row.id as string);
      if (!postable) section = row.id as string;
    }

    const acctId = (code: string) => {
      const found = id.get(code);
      if (!found) throw new Error(`Setup: the chart has no account ${code}`);
      return found;
    };

    for (const [role, code] of systemRoles) {
      await tx`
        insert into system_account (company_id, role, account_id)
        values (${co.id}, ${role}, ${acctId(code)})`;
    }

    for (const [role, code] of rules) {
      await tx`
        insert into account_determination (company_id, role, account_id)
        values (${co.id}, ${role}, ${acctId(code)})`;
    }

    for (const [code, name, acct] of focReasons) {
      await tx`
        insert into foc_reason (company_id, code, name, account_id)
        values (${co.id}, ${code}, ${name}, ${acctId(acct)})`;
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
