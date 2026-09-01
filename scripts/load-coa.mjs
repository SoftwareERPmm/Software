// Loads the MTK chart of accounts, replacing whatever chart is there.
//
//   node scripts/load-coa.mjs                 -- dry run, shows the target
//   node scripts/load-coa.mjs --confirm       -- replace the chart
//
// Against anything other than the database in .env, name the host too, the
// same way scripts/clear.mjs does:
//
//   DATABASE_URL="<other>" node scripts/load-coa.mjs --confirm --host=<its host>
//
// REFUSES to run if anything has been posted. Replacing a chart under
// existing journal lines would leave those lines pointing at accounts that no
// longer exist, or — worse — at accounts that now mean something else.
//
// Why this file exists: the chart is not seed data. db/seed.sql carries the
// original 29-account chart that every test asserts against; this is the
// customer's own chart, and the two are deliberately separate so that
// adopting one does not silently rewrite the other.
//
// Three accounts marked `added: true` are not in the customer's chart. Every
// other role the engine resolves was pointed at an account the chart already
// has, so these three are what genuinely has no home in it:
//
//   1060 GR/IR Clearing         holds a receipt between the goods arriving
//                               and the bill for them. Without it a receipt
//                               would have to credit Payables, claiming a
//                               debt the supplier has not invoiced.
//   3030 Opening Balance Equity balances opening balances and nets to zero
//                               once they are all in. Posting them against
//                               Owner's Capital instead would overstate it.
//   5050 Purchase Price Variance absorbs a bill that differs from the
//                               receipt it settles. Folding it into Purchase
//                               would hide the difference inside cost.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function envUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

function envFileUrl() {
  const p = join(root, ".env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const url = envUrl();
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }

const confirm = process.argv.includes("--confirm");
const targetHost = new URL(url).host;
const envHost = envFileUrl() ? new URL(envFileUrl()).host : null;
const named = process.argv.find((a) => a.startsWith("--host="))?.slice("--host=".length);

if (confirm && targetHost !== envHost && named !== targetHost) {
  console.error(
    `\n  REFUSING to replace the chart on a database that is not the one in .env.\n\n` +
    `    target   ${targetHost}\n    .env     ${envHost ?? "(none)"}\n\n` +
    `  If that is genuinely what you want, name it:  --host=${targetHost}\n`
  );
  process.exit(1);
}

/** code, name, type, postable, flags
 *
 * Section codes are numbered, not lettered, because the chart is read in
 * `order by code` and letters sort alphabetically: H-CGS lands between H-CA
 * and H-CL, which puts Cost of Sales second, above the liabilities. The
 * leading digit matches the account block beneath it and the hyphen sorts
 * before any digit, so each section lands immediately ahead of its accounts.
 * They are never displayed — the Code column is blank on a section row. */
const CHART = [
  ["1-CA",  "Current Assets",                    "ASSET",     false],
  ["1000",  "Cash on Hand",                      "ASSET",     true,  { cash: true }],
  ["1010",  "Cash at Bank",                      "ASSET",     true,  { bank: true }],
  ["1020",  "Petty Cash",                        "ASSET",     true,  { cash: true }],
  ["1030",  "Accounts Receivable",               "ASSET",     true,  { control: true }],
  ["1040",  "Inventory",                         "ASSET",     true],
  ["1050",  "Prepaid Expenses",                  "ASSET",     true],
  ["1060",  "GR/IR Clearing",                    "ASSET",     true,  { added: true }],
  ["1-FA",  "Non-Current Assets (Fixed Assets)", "ASSET",     false],
  ["1100",  "Land",                              "ASSET",     true],
  ["1110",  "Building",                          "ASSET",     true],
  ["1120",  "Office Equipment",                  "ASSET",     true],
  ["1130",  "Furniture & Fixtures",              "ASSET",     true],
  ["1140",  "Vehicle",                           "ASSET",     true],
  ["1190",  "Accumulated Depreciation",          "ASSET",     true],
  ["1-IA",  "Intangible Assets",                 "ASSET",     false],
  ["1200",  "Software",                          "ASSET",     true],
  ["1210",  "Accumulated Amortization",          "ASSET",     true],
  ["2-CL",  "Current Liabilities",               "LIABILITY", false],
  ["2000",  "Accounts Payable",                  "LIABILITY", true,  { control: true }],
  ["2010",  "Salary Payable",                    "LIABILITY", true],
  ["2020",  "Tax Payable",                       "LIABILITY", true],
  ["2030",  "Accrued Expenses",                  "LIABILITY", true],
  ["2-LT", "Long-Term Liabilities",             "LIABILITY", false],
  ["2040",  "Loan Payable – Short Term",         "LIABILITY", true],
  ["2050",  "Loan Payable – Long Term",          "LIABILITY", true],
  ["3-EQ",  "Owner Equity",                      "EQUITY",    false],
  ["3000",  "Owner's Capital",                   "EQUITY",    true],
  ["3010",  "Owner's Drawing",                   "EQUITY",    true],
  ["3020",  "Retained Earnings",                 "EQUITY",    true],
  ["3030",  "Opening Balance Equity",            "EQUITY",    true,  { added: true }],
  ["4-SA", "Sales",                             "REVENUE",   false],
  ["4000",  "Sales",                             "REVENUE",   true],
  ["4010",  "Sales Return",                      "REVENUE",   true],
  ["4020",  "Sales Discount",                    "REVENUE",   true],
  ["4100",  "Other Income",                      "REVENUE",   true],
  ["5-CG", "Cost of Good Sold",                 "COGS",      false],
  ["5000",  "Purchase",                          "COGS",      true],
  ["5010",  "Purchase Return",                   "COGS",      true],
  ["5020",  "Purchase Discounts",                "COGS",      true],
  ["5030",  "Carriage Inward",                   "COGS",      true],
  ["5050",  "Purchase Price Variance",           "COGS",      true,  { added: true }],
  ["5300",  "Inventory Adjustment",              "COGS",      true],
  ["6-EX", "Expense",                           "EXPENSE",   false],
  ["6-GA",  "General & Administration Expenses", "EXPENSE",   false, { under: "6-EX" }],
  ["6000",  "Salary",                            "EXPENSE",   true],
  ["6010",  "Rent",                              "EXPENSE",   true],
  ["6020",  "Utilities – Electricity & Water",   "EXPENSE",   true],
  ["6030",  "Transportation & Delivery Expense", "EXPENSE",   true],
  ["6060",  "Internet & Phone Bill",             "EXPENSE",   true],
  ["6070",  "Repairs & Maintenance",             "EXPENSE",   true],
  ["6080",  "Printing & Stationery",             "EXPENSE",   true],
  ["6090",  "Office Supplies",                   "EXPENSE",   true],
  ["6100",  "Bank Charges",                      "EXPENSE",   true],
  ["6110",  "Miscellaneous Expenses",            "EXPENSE",   true],
  ["6160",  "Depreciation Expense",              "EXPENSE",   true],
  ["6-SD",  "Selling & Distribution Expenses",   "EXPENSE",   false, { under: "6-EX" }],
  ["6300",  "Discount Allowed",                  "EXPENSE",   true],
  ["6310",  "Advertising Expense",               "EXPENSE",   true],
  ["6320",  "Promotion Expense",                 "EXPENSE",   true],
  ["6330",  "Commission Expenses",               "EXPENSE",   true],
  ["6340",  "Delivery Charges",                  "EXPENSE",   true],
  ["7-TX", "Tax Account",                       "LIABILITY", false],
  ["7000",  "Commercial Tax Payable",            "LIABILITY", true],
  ["7010",  "Income Tax Payable",                "LIABILITY", true],
];

// Where the posting engine resolves each role. Getting one of these wrong
// does not fail — it posts, balanced, to the wrong account, which is the
// failure mode migration 0022 exists to record.
const SYSTEM = {
  GRIR_CLEARING: "1060", OPENING_BALANCE_EQUITY: "3030", RETAINED_EARNINGS: "3020",
  PURCHASE_PRICE_VARIANCE: "5050", PURCHASE_DISCOUNT_RECEIVED: "5020",
  SALES_DISCOUNT_ALLOWED: "6300", PROMOTION_EXPENSE: "6320", STOCK_ADJUSTMENT: "5300",

  // These have homes in the chart already, so they use them rather than
  // adding accounts nobody asked for. Settlement in another currency is other
  // income or a miscellaneous cost; a rounding difference is the same; and a
  // delivery fee charged to the customer is plainly other income too — it is
  // money earned for carrying goods, not for selling them, which is the whole
  // reason it is kept out of 4000 Sales.
  FX_GAIN: "4100", FX_LOSS: "6110", ROUNDING_DIFFERENCE: "6110",
  DELIVERY_INCOME: "4100",
};

// COGS points at 5000 "Purchase" — they are the same account here. The
// customer's chart is written for a periodic system, where purchases
// accumulate in 5000 and cost of sales is computed at period end. This app is
// perpetual FIFO: a goods receipt debits Inventory, never Purchase, and cost
// of goods sold posts as the goods leave. So 5000 is the account doing that
// job, and a second "Cost of Goods Sold" beside it would be the same thing
// under two names.
const DETERMINATION = {
  AR_CONTROL: "1030", AP_CONTROL: "2000", INVENTORY: "1040",
  COGS: "5000", REVENUE: "4000", SALES_RETURN: "4010",
};

// The old chart's accounts, mapped to their home in the new one, so free-of-
// charge reasons keep writing off to the same kind of account.
const FOC_REMAP = { "5300": "5300", "6100": "6320" };

const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {}, max: 1 });

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  if (!co) { console.error("\n  No company exists yet.\n"); process.exit(1); }

  const [j] = await sql`select count(*)::int as c from journal_line`;
  const [a] = await sql`select count(*)::int as c from account where company_id = ${co.id}`;

  console.log(`\n  ${targetHost}`);
  console.log(`  company        ${co.name}`);
  console.log(`  accounts now   ${a.c}`);
  console.log(`  journal lines  ${j.c}`);

  if (j.c > 0) {
    console.error(
      `\n  REFUSING: this database has ${j.c} posted journal lines.\n` +
      `  Replacing the chart under them would orphan every one.\n`
    );
    process.exit(1);
  }

  if (!confirm) {
    const added = CHART.filter((r) => r[4]?.added).map((r) => `${r[0]} ${r[1]}`);
    console.log(`\n  Would load ${CHART.length} accounts (${CHART.filter((r) => !r[3]).length} sections),`);
    console.log(`  including ${added.length} the posting engine requires:\n`);
    for (const x of added) console.log(`    ${x}`);
    console.log(`\n  Nothing changed. Re-run with --confirm.\n`);
    process.exit(0);
  }

  // foc_reason.account_id is NOT NULL, so those rows cannot be parked while
  // the chart is replaced — they are captured, dropped and recreated against
  // the new accounts.
  const focBefore = await sql`
    select f.code, f.name, f.name_my, a.code as acct
      from foc_reason f join account a on a.id = f.account_id
     where f.company_id = ${co.id} order by f.code`;

  await sql.begin(async (tx) => {
    await tx`delete from foc_reason where company_id = ${co.id}`;
    await tx`update tax_code set output_account_id = null, input_account_id = null where company_id = ${co.id}`;
    await tx`update business_partner set ar_control_id = null, ap_control_id = null where company_id = ${co.id}`;
    await tx`delete from account_determination where company_id = ${co.id}`;
    await tx`delete from system_account where company_id = ${co.id}`;
    await tx`delete from account where company_id = ${co.id}`;

    const id = new Map();
    let section = null;
    for (const [code, name, type, postable, flags = {}] of CHART) {
      const parent = postable ? section : (flags.under ? id.get(flags.under) : null);
      const [row] = await tx`
        insert into account (company_id, parent_id, code, name, account_type,
                             is_postable, is_control, is_cash_account, is_bank_account, is_active)
        values (${co.id}, ${parent}, ${code}, ${name}, ${type}::account_type,
                ${postable}, ${!!flags.control}, ${!!flags.cash}, ${!!flags.bank}, true)
        returning id`;
      id.set(code, row.id);
      if (!postable) section = row.id;
    }

    for (const [role, code] of Object.entries(SYSTEM)) {
      await tx`insert into system_account (company_id, role, account_id)
               values (${co.id}, ${role}, ${id.get(code)})`;
    }
    for (const [role, code] of Object.entries(DETERMINATION)) {
      await tx`insert into account_determination (company_id, role, account_id)
               values (${co.id}, ${role}, ${id.get(code)})`;
    }
    for (const f of focBefore) {
      const target = id.get(FOC_REMAP[f.acct] ?? f.acct);
      if (!target) throw new Error(`FOC reason ${f.code} used account ${f.acct}, which the new chart has no home for`);
      await tx`insert into foc_reason (company_id, code, name, name_my, account_id)
               values (${co.id}, ${f.code}, ${f.name}, ${f.name_my}, ${target})`;
    }
  });

  const [after] = await sql`select count(*)::int as c from account where company_id = ${co.id}`;
  const [heads] = await sql`select count(*)::int as c from account where company_id = ${co.id} and not is_postable`;
  const missing = [];
  for (const role of Object.keys(SYSTEM)) {
    const [x] = await sql`select 1 as ok from system_account where company_id = ${co.id} and role = ${role}`;
    if (!x) missing.push(role);
  }
  for (const role of Object.keys(DETERMINATION)) {
    const [x] = await sql`select 1 as ok from account_determination where company_id = ${co.id} and role = ${role}`;
    if (!x) missing.push(role);
  }

  console.log(`\n  loaded ${after.c} accounts, ${heads.c} sections`);
  console.log(`  every posting role resolves: ${missing.length === 0 ? "yes" : "NO — " + missing.join(", ")}`);
  console.log(`\n  Now prove it still posts:  npx tsx scripts/test-empty.mjs\n`);
} catch (err) {
  console.error(`\n  error: ${err.message}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
