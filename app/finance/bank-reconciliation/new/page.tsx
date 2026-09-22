import { sql } from "@/lib/db";
import { getCompany } from "@/lib/queries";
import { importBankStatement, previewBankStatement } from "@/lib/actions";
import { BankStatementImport } from "@/components/bank-statement-import";
import { HelpHint } from "@/components/help-hint";

export default async function ImportBankStatement() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const accounts = (await sql`
    select id, code, name from account
     where company_id = ${company.id} and is_bank_account and is_active
     order by code`) as unknown as { id: string; code: string; name: string }[];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; bank</span>
        <h1>Import a bank statement</h1>
        <HelpHint>
          A CSV or spreadsheet as the bank exported it — no template. The
          columns are read from the header row and what was understood is
          shown before anything is imported, because a paid-out column read as
          paid-in reverses every sign and reconciles nothing.
          <br /><br />
          Importing creates no accounting entries. It only puts the bank&rsquo;s
          list somewhere it can be compared with ours.
        </HelpHint>
      </div>

      <BankStatementImport
        accounts={accounts}
        preview={previewBankStatement}
        action={importBankStatement}
      />
    </>
  );
}
