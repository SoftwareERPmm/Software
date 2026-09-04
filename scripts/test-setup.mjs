// A completely empty database becoming a working company.
//
// DESTRUCTIVE, and more so than the other suites: it truncates `company` and
// `account` too, then scaffolds "Bootstrap Test Co". The chart comes back
// identical now that there is only one, but the company name and code are
// this fixture's — and the app is single-company, so the UI then reads them.
// Afterwards:
//
//   update company set name = 'MTK Co Ltd — DEV', code = 'MTK';


import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  // Anchored and read line by line — .env can carry more than one
  // "DATABASE_URL=" occurrence (an active line plus a commented alternative
  // documenting another branch), and an unanchored match against the whole
  // file grabs whichever occurs FIRST regardless of a leading "# ". That
  // silently pointed this script at the wrong Neon branch the moment .env
  // gained a second mention, with no error to notice it by.
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["\']|["\']$/g, ""); break; }
  }
}

const { scaffoldCompany } = await import("../lib/setup.ts");
const { postPurchaseInvoice } = await import("../lib/posting.ts");

const url = process.env.DATABASE_URL;
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require",
  prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };

try {
  // Strip the database back to nothing but the schema.
  await sql.unsafe(`truncate table payment_allocation, stock_movement, document_line,
    document, journal_line, journal_entry, promotion, item_alias, item_uom,
    item_reorder, item_price, item, item_group, business_partner, salesman,
    foc_reason, account_determination, system_account, number_series,
    tax_code, price_level, uom, location, fiscal_period, fiscal_year,
    account, company restart identity cascade`);

  check("database is bare", (await sql`select 1 from company`).length === 0);

  const co = await scaffoldCompany({
    code: "TEST", name: "Bootstrap Test Co", baseCurrency: "MMK",
    fiscalYearStartMonth: 4, fiscalYearStart: "2026-04-01",
    officeName: "Head Office", warehouseName: "Main Warehouse",
  });
  check("company created", Boolean(co.id));

  const count = async (t) => Number((await sql.unsafe(`select count(*)::int as n from ${t}`))[0].n);
  // One chart everywhere now: the same 65 the loader and the seed build.
  check("65 accounts", await count("account") === 65, String(await count("account")));
  check("12 fiscal periods", await count("fiscal_period") === 12);
  // Twelve since delivery income got an account of its own: a scaffolded
  // company that cannot charge carriage is not fully set up.
  check("12 system accounts", await count("system_account") === 12,
    String(await count("system_account")));
  check("6 posting rules", await count("account_determination") === 6,
    String(await count("account_determination")));
  check("2 locations", await count("location") === 2);
  check("4 units", await count("uom") === 4);
  check("18 numbering series", await count("number_series") === 18);
  check("no catalogue or partners",
    await count("item") === 0 && await count("item_group") === 0 &&
    await count("business_partner") === 0);
  check("no transactions", await count("document") === 0 && await count("journal_entry") === 0);

  // It has to actually be able to post.
  const [grp] = await sql`
    insert into item_group (company_id, segment, code, name)
    values (${co.id}, '01', 'x', 'Test') returning id`;
  const [uom] = await sql`select id from uom where company_id = ${co.id} limit 1`;
  const [item] = await sql`
    insert into item (company_id, item_group_id, serial, code, name, base_uom_id)
    values (${co.id}, ${grp.id}, '001', 'x', 'Test Item', ${uom.id}) returning id`;
  const [sup] = await sql`
    insert into business_partner (company_id, code, name, is_supplier)
    values (${co.id}, 'S1', 'Test Supplier', true) returning id`;
  const [loc] = await sql`
    select id from location where company_id = ${co.id} and is_stock_location limit 1`;

  const pi = await postPurchaseInvoice({
    companyId: co.id, partnerId: sup.id, locationId: loc.id,
    docDate: "2026-04-15", dueDate: null,
    lines: [{ itemId: item.id, qty: 10, unitPrice: 1000 }],
  });
  // Type + document date + that day's sequence since 0035, so a purchase
  // invoice dated 15 April 2026 prints DP20260415001. The fiscal-year form
  // PI-2627-000001 is the scheme this replaced.
  check("a freshly set up company can post",
    /^DP20260415\d{3}$/.test(pi.docNo), pi.docNo);

  const [tb] = await sql`select coalesce(sum(balance),0) as v from v_trial_balance`;
  check("ledger balances", Math.abs(Number(tb.v)) < 0.0001);
  check("inventory reconciles",
    (await sql`select 1 from v_check_inventory_reconciliation`).length === 0);

  let refused = false;
  try {
    await scaffoldCompany({
      code: "X", name: "Second", baseCurrency: "MMK", fiscalYearStartMonth: 4,
      fiscalYearStart: "2026-04-01", officeName: "b", warehouseName: "w",
    });
  } catch { refused = true; }
  check("refuses to set up twice", refused);

  console.log(bad === 0 ? "\n  a bare database bootstraps cleanly\n" : `\n  ${bad} failed\n`);
} catch (e) {
  console.error(`\n  error: ${e.message}\n`); bad++;
} finally { await sql.end(); }

process.exit(bad === 0 ? 0 : 1);
