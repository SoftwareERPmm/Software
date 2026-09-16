// Gives a branch to ledger entries posted before one was required.
//
//   DATABASE_URL="<url>" node scripts/fix-branchless-history.mjs \
//     --branch=MAIN --host=<host of that url> --confirm
//
// Journal lines are immutable — the database refuses to change one, which is
// the point of a ledger. So an entry that carries no branch cannot be given
// one; it can only be reversed and posted again naming it. That is what this
// does, one document at a time, each in its own transaction: void, then
// repost the same lines, the same date, the same memo and reference, at the
// branch named on the command line.
//
// Both halves of a reversal are branchless, so the count of branchless lines
// goes UP while the net goes to zero. getUnassignedBranchActivity ignores
// reversed entries and reversals for exactly that reason; without that, this
// repair would make the figure it is fixing look worse.
//
// It writes to whatever DATABASE_URL names, which may be the pilot database,
// so it asks for that database to be named twice — the URL and --host — the
// way clear.mjs and copy-company-data.mjs do. Dry run unless --confirm.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const namedHost = args.find((a) => a.startsWith("--host="))?.slice("--host=".length);
const branchCode = args.find((a) => a.startsWith("--branch="))?.slice("--branch=".length);

if (!process.env.DATABASE_URL) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
  }
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
if (!branchCode) { console.error("Name the branch to repost at, e.g. --branch=MAIN"); process.exit(1); }

const host = new URL(url).host;
if (namedHost && namedHost !== host) {
  console.error(`\n  --host=${namedHost} is not the host DATABASE_URL points at (${host}).\n`);
  process.exit(1);
}
if (confirm && !namedHost) {
  console.error(`\n  Name the database again to write to it: --host=${host}\n`);
  process.exit(1);
}

const { voidDocument, postCashVoucher, postBankVoucher, postJournalVoucher, postAccountOpening } =
  await import("../lib/posting.ts");

const sql = postgres(url, {
  ssl: url.includes("localhost") ? false : "require",
  prepare: !url.includes("-pooler."),
});

try {
  const [co] = await sql`select id, name from company order by created_at limit 1`;
  if (!co) throw new Error("no company");
  const [branch] = await sql`
    select id, code, name from location
     where company_id = ${co.id} and code = ${branchCode} and parent_id is null and is_active`;
  if (!branch) throw new Error(`no active top-level branch with code ${branchCode}`);

  console.log(`\n  ${co.name} — ${host}`);
  console.log(`  reposting branchless entries at ${branch.code} · ${branch.name}\n`);

  // Only live ones. A reversed entry and its reversal net to nothing, so
  // repairing them would post two more lines to no purpose.
  const docs = await sql`
    select distinct d.id, d.doc_no, d.doc_type, d.doc_date,
           to_char(d.doc_date, 'YYYY-MM-DD') as doc_date_text, d.memo, d.reference
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join document d on d.id = je.source_id
     where jl.company_id = ${co.id}
       and jl.location_id is null
       and d.status = 'POSTED'
       and d.reverses_document_id is null
     order by d.doc_date, d.doc_no`;

  if (docs.length === 0) { console.log("  nothing to repair\n"); process.exit(0); }

  const POSTER = {
    CASH_VOUCHER: postCashVoucher,
    BANK_VOUCHER: postBankVoucher,
    JOURNAL_VOUCHER: postJournalVoucher,
    OPENING_BALANCE: postAccountOpening,
  };

  for (const d of docs) {
    const lines = await sql`
      select jl.account_id, jl.base_amount::numeric as amount, a.code, a.name
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join account a on a.id = jl.account_id
       where je.source_id = ${d.id}
       order by jl.line_no`;

    const post = POSTER[d.doc_type];
    console.log(`  ${d.doc_no}  ${d.doc_type}  ${d.doc_date_text}  ${d.memo ?? ""}`);
    for (const l of lines) {
      console.log(`      ${l.code} ${String(l.name).padEnd(24)} ${String(l.amount).padStart(14)}`);
    }
    if (!post) { console.log("      — no reposting rule for this type, skipped\n"); continue; }
    if (!confirm) { console.log("      would void and repost at " + branch.code + "\n"); continue; }

    // A void and its replacement ought to be one transaction — a void with no
    // replacement is a deletion, and posting.ts says so. They cannot be: the
    // post* functions each open their own. So the replacement is posted
    // FIRST. If the void then fails, the books hold a visible duplicate,
    // which is recoverable by voiding it; the other order risks money simply
    // leaving the books with nothing to show where it went.
    const input = {
      companyId: co.id,
      docDate: d.doc_date_text,
      memo: d.memo,
      reference: d.reference,
      locationId: branch.id,
      lines: lines.map((l) => ({ accountId: l.account_id, amount: Number(l.amount) })),
    };
    const posted = await post(input);
    try {
      await voidDocument({ documentId: d.id, reason: `Reposted at ${branch.code} as ${posted.docNo}` });
    } catch (e) {
      // Undo the replacement rather than leave the books doubled.
      try {
        await voidDocument({ documentId: posted.id, reason: "Original could not be voided" });
        throw new Error(`${d.doc_no} could not be voided (${e.message}); ${posted.docNo} was voided back out. Nothing changed for this document.`);
      } catch (inner) {
        throw new Error(`${d.doc_no} could not be voided (${e.message}) AND its replacement ${posted.docNo} could not be voided back out. The books now hold BOTH — void ${posted.docNo} by hand.`);
      }
    }
    console.log(`      reposted as ${posted.docNo} at ${branch.code}, ${d.doc_no} voided\n`);
  }

  // Keyed on the document, which is where a void is recorded — journal_entry
  // has reverses_entry_id and reversed_by_entry_id, and voidDocument sets
  // neither, so testing those counts a repaired entry as still broken.
  const [after] = await sql`
    select count(*)::int as lines
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      left join document d on d.journal_entry_id = je.id
     where jl.company_id = ${co.id} and jl.location_id is null
       and (d.id is null
            or (d.status <> 'REVERSED' and d.reverses_document_id is null))`;
  console.log(confirm
    ? `  done — ${after.lines} live branchless lines remain\n`
    : "  dry run — nothing was written. Add --confirm to act.\n");
} catch (e) {
  console.error("\n  " + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
