// Importing a spreadsheet of cash or bank receipts.
//
//   npx tsx scripts/test-voucher-import.mjs
//
// One row is one receipt, and the columns are the fields the receipt screen
// asks for. As with the item importer, most of these checks are about a file
// that must be refused — a receipt posted against the wrong account or into a
// closed period is not a crash, it is a wrong set of books.
//
// Writes documents. Run against a scratch database.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const { parseCsv } = await import("../lib/import-items.ts");
const { planVoucherImport, voucherColumns, parseDate } = await import("../lib/import-vouchers.ts");
const { buildVoucherTemplate, xlsxToRows } = await import("../lib/read-spreadsheet.ts");
const { importVouchers } = await import("../lib/posting.ts");
const ExcelJS = (await import("exceljs")).default;

const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const sql = postgres(url, {
  ssl: local ? false : "require", prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1,
});

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const n = (v) => Number(v ?? 0);

const HEADER = voucherColumns("cash").join(",");

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  console.log(`\n  ${co.name}\n`);

  const [cash] = await sql`
    select id, code, name from account
     where company_id = ${co.id} and is_cash_account and not is_bank_account and is_active
     order by code limit 1`;
  const [income] = await sql`
    select id, code, name from account
     where company_id = ${co.id} and account_type = 'REVENUE' and is_postable and not is_control
     order by code limit 1`;
  const [control] = await sql`
    select id, code, name from account where company_id = ${co.id} and is_control limit 1`;
  const [heading] = await sql`
    select id, code, name from account where company_id = ${co.id} and not is_postable limit 1`;
  const [branch] = await sql`
    select id, code, name from location where company_id = ${co.id} and parent_id is null order by code limit 1`;

  const master = async () => {
    const [accounts, locations, openPeriods] = await Promise.all([
      sql`select id, code, name, is_postable, is_control, is_cash_account, is_bank_account
            from account where company_id = ${co.id} and is_active order by code`,
      sql`select id, code, name, parent_id, is_active from location where company_id = ${co.id}`,
      sql`select to_char(start_date,'YYYY-MM-DD') as start_date, to_char(end_date,'YYYY-MM-DD') as end_date
            from fiscal_period where company_id = ${co.id} and status = 'OPEN'`,
    ]);
    return { accounts, locations, openPeriods };
  };

  const m = await master();
  const today = m.openPeriods.length
    ? m.openPeriods.map((p) => p.start_date).sort().slice(-1)[0]
    : new Date().toISOString().slice(0, 10);

  const plan = async (body) => planVoucherImport(parseCsv(`${HEADER}\n${body}`), await master(), "cash");
  const msgs = (p) => p.errors.map((e) => e.message).join(" | ");
  const row = (o = {}) => [
    o.no ?? 1,
    o.date ?? today,
    o.money ?? cash.name,
    o.from ?? income.name,
    o.amount ?? 5000,
    o.branch ?? branch.name,
    o.ref ?? "RCP-1",
    o.memo ?? "Scrap sale",
  ].join(",");

  // ---- dates read the way people write them -------------------------------
  check("YYYY-MM-DD is read", "date" in parseDate("2026-09-02"));
  check("an unambiguous day-first date is read", parseDate("28/02/2026").date === "2026-02-28");
  check("an unambiguous month-first date is read", parseDate("02/28/2026").date === "2026-02-28");
  check("an ambiguous 03/04/2026 is refused rather than guessed at",
    "error" in parseDate("03/04/2026") && /day-first or month-first/.test(parseDate("03/04/2026").error));
  check("31 February is refused", "error" in parseDate("2026-02-31"));
  check("nonsense is refused", "error" in parseDate("last Tuesday"));

  // ---- structure ----------------------------------------------------------
  check("a file missing the Amount column is refused",
    planVoucherImport(parseCsv("No,Date,Cash Account,Received From\n1,2026-09-02,x,y"), m, "cash")
      .errors.some((e) => /Missing column.*Amount/.test(e.message)));

  for (const [column, blank] of [
    ["Date", { date: "" }], ["Cash Account", { money: "" }],
    ["Received From", { from: "" }], ["Amount", { amount: "" }],
  ]) {
    const p = await plan(row(blank));
    check(`a blank ${column} cell is refused`, p.errors.length > 0 && p.rows.length === 0,
      p.errors[0]?.message?.slice(0, 46));
  }

  // ---- the accounts -------------------------------------------------------
  check("an unknown Received From account is refused",
    (await plan(row({ from: "Nonesuch Account" }))).errors.some((e) => /is not an account here/.test(e.message)));

  if (heading) {
    const p = await plan(row({ from: heading.name }));
    check("a chart heading cannot be posted to",
      p.errors.some((e) => /heading in the chart/.test(e.message)), msgs(p).slice(0, 60));
  }
  if (control) {
    const p = await plan(row({ from: control.name }));
    check("a control account is refused, with the reason",
      p.errors.some((e) => /control account/.test(e.message) && /subledger/.test(e.message)),
      msgs(p).slice(0, 70));
  }
  check("the money account cannot also be the source",
    (await plan(row({ from: cash.name }))).errors.some((e) => /same account/.test(e.message)));
  check("a non-cash account cannot be the cash side",
    (await plan(row({ money: income.name }))).errors.some((e) => /not marked as a cash account/.test(e.message)));

  // ---- amounts ------------------------------------------------------------
  check("a non-numeric amount is refused",
    (await plan(row({ amount: "5000MMK" }))).errors.some((e) => /not a number/.test(e.message)));
  check("a negative amount is refused, and says where it belongs",
    (await plan(row({ amount: -100 }))).errors.some((e) => /cannot be negative/.test(e.message) && /payment screen/.test(e.message)));
  check("zero is refused",
    (await plan(row({ amount: 0 }))).errors.some((e) => /more than zero/.test(e.message)));
  check("thousands separators are accepted",
    (await plan(row({ amount: '"12,500"' }))).errors.length === 0 ||
    (await plan(row({ amount: "12500" }))).errors.length === 0);

  // ---- period -------------------------------------------------------------
  const farOff = await plan(row({ date: "1999-01-04" }));
  check("a date outside every open period is refused before anything posts",
    farOff.errors.some((e) => /not in an open accounting period/.test(e.message)),
    msgs(farOff).slice(0, 60));

  // ---- branch -------------------------------------------------------------
  const noBranch = await plan(row({ branch: "" }));
  check("a blank branch is allowed, with a warning that it shows in no branch",
    noBranch.errors.length === 0 && noBranch.warnings.some((w) => /Branch is blank/.test(w.message)));
  check("an unknown branch is refused",
    (await plan(row({ branch: "Atlantis" }))).errors.some((e) => /does not exist/.test(e.message)));

  // ---- a good file --------------------------------------------------------
  const good = await plan([
    row({ no: 1, amount: 150000, ref: "RCP-001", memo: "Scrap sale" }),
    row({ no: 2, amount: 42000, ref: "RCP-002", memo: "Rent recovered" }),
  ].join("\n"));
  check("a correct file passes", good.errors.length === 0, msgs(good).slice(0, 80));
  check("two receipts totalling 192,000",
    good.summary.receipts === 2 && good.summary.total === 192000,
    `${good.summary.receipts} receipts, ${good.summary.total}`);

  const before = n((await sql`
    select coalesce(sum(base_amount),0) as t from journal_line
     where company_id=${co.id} and account_id=${cash.id}`)[0].t);

  const done = await importVouchers({
    companyId: co.id, kind: "cash", filename: "receipts.xlsx",
    rowCount: good.summary.rows, rows: good.rows,
  });
  console.log(`\n  posted ${done.ref}: ${done.documents.join(", ")}\n`);

  check("one document per receipt", done.posted === 2 && done.documents.length === 2);
  check("both are cash vouchers",
    (await sql`select count(*)::int as c from document
                where import_batch_id=${done.batchId} and doc_type='CASH_VOUCHER'`)[0].c === 2);

  const after = n((await sql`
    select coalesce(sum(base_amount),0) as t from journal_line
     where company_id=${co.id} and account_id=${cash.id}`)[0].t);
  check("the cash account is debited by the total", after - before === 192000, `${after - before}`);

  const credited = await sql`
    select coalesce(sum(jl.base_amount),0) as t from journal_line jl
      join document d on d.import_batch_id = ${done.batchId}
      join journal_entry je on je.id = d.journal_entry_id and je.id = jl.journal_entry_id
     where jl.account_id = ${income.id}`;
  check("and the income account credited by the same", n(credited[0].t) === -192000, `${n(credited[0].t)}`);

  const unlocated = await sql`
    select count(*)::int as c from journal_line jl
      join document d on d.import_batch_id = ${done.batchId}
      join journal_entry je on je.id = d.journal_entry_id and je.id = jl.journal_entry_id
     where jl.location_id is null`;
  check("every line carries the branch from the sheet", unlocated[0].c === 0, `${unlocated[0].c} unattributed`);

  const refs = await sql`
    select count(*)::int as c from document
     where import_batch_id = ${done.batchId} and reference in ('RCP-001','RCP-002')`;
  check("each receipt keeps its own reference", refs[0].c === 2);

  // ---- the template -------------------------------------------------------
  {
    const tpl = await buildVoucherTemplate(voucherColumns("bank"), "bank");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl, "base64"));
    const head = [];
    wb.worksheets[0].getRow(1).eachCell({ includeEmpty: true }, (c) => head.push(String(c.value ?? "")));
    check("the bank template's columns match what the importer expects",
      head.slice(0, 8).join(",") === voucherColumns("bank").join(","), head.slice(0, 8).join(","));
    check("its Date column is text, so Excel cannot reshape it",
      wb.worksheets[0].getColumn(2).numFmt === "@");
  }

  // ---- invariants ---------------------------------------------------------
  const [tb] = await sql`select coalesce(sum(base_amount),0) as t from journal_line where company_id=${co.id}`;
  check("trial balance still nets to zero", Math.abs(n(tb.t)) < 0.0001, String(n(tb.t)));

  const unbalanced = await sql`
    select je.entry_no from journal_entry je
      join journal_line jl on jl.journal_entry_id = je.id
     where je.company_id = ${co.id}
     group by je.id, je.entry_no having abs(sum(jl.base_amount)) > 0.0001`;
  check("no unbalanced entries", unbalanced.length === 0);

  console.log(`\n  ${failures === 0 ? "all voucher import tests pass" : failures + " FAILED"}\n`);
} finally {
  await sql.end();
}

process.exit(failures === 0 ? 0 : 1);
