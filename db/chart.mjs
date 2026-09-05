// The chart of accounts, in one place.
//
// Three things build a chart and they must not disagree: lib/setup.ts when a
// company is created, scripts/load-coa.mjs when an existing company is
// re-charted, and db/seed.sql for the demo. They used to carry three
// different charts, so a report could be right in the demo and wrong in the
// product. This file is the one they all read.
//
// Plain .mjs on purpose: scripts/load-coa.mjs runs under node with no build
// step, and lib/setup.ts imports it through allowJs.

/** code, name, type, postable, flags
 *
 * Section codes are numbered, not lettered, because the chart is read in
 * `order by code` and letters sort alphabetically: H-CGS lands between H-CA
 * and H-CL, which puts Cost of Sales second, above the liabilities. The
 * leading digit matches the account block beneath it and the hyphen sorts
 * before any digit, so each section lands immediately ahead of its accounts.
 * They are never displayed — the Code column is blank on a section row. */
export const CHART = [
  ["1-CA",  "Current Assets",                    "ASSET",     false],
  ["1000",  "Cash on Hand",                      "ASSET",     true,  { cash: true }],
  // Both flags, deliberately. is_bank_account puts it in the bank book; the
  // payment and sales screens ask for is_cash_account, and a bank account you
  // cannot pay a supplier from is not much of a bank account. The cash book
  // asks for "cash and not bank", so this still stays out of it.
  ["1010",  "Cash at Bank",                      "ASSET",     true,  { cash: true, bank: true }],
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
export const SYSTEM = {
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
export const DETERMINATION = {
  AR_CONTROL: "1030", AP_CONTROL: "2000", INVENTORY: "1040",
  COGS: "5000", REVENUE: "4000", SALES_RETURN: "4010",
};

/**
 * Free-of-charge reasons a new company starts with. The account each writes
 * off to is what keeps a giveaway out of cost of sales, so a promotion is
 * visible as promotion rather than quietly eroding gross margin.
 */
export const FOC_REASONS = [
  ["PROMOTION", "Promotional giveaway", "6320"],
  ["SAMPLE",    "Customer sample",      "6320"],
  ["OFFICE",    "Office use",           "6320"],
  ["DAMAGED",   "Damaged or expired",   "5300"],
];
