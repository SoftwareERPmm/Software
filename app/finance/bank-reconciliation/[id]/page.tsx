import Link from "next/link";
import { notFound } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { getCompany, getBankStatement, getBankLedgerCandidates } from "@/lib/queries";
import { matchBankLine, unmatchBankLine, ignoreBankLine,
         autoMatchBankStatement, setBankStatementStatus } from "@/lib/actions";
import { BankReconcile } from "@/components/bank-reconcile";

export default async function BankStatementDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const found = await getBankStatement(company.id, id);
  if (!found) notFound();

  const { statement, lines } = found as unknown as {
    statement: Parameters<typeof BankReconcile>[0]["statement"] & { account_id: string };
    lines: Parameters<typeof BankReconcile>[0]["lines"];
  };

  const candidates = (await getBankLedgerCandidates(
    company.id, statement.account_id, statement.from_date, statement.to_date,
  )) as unknown as Parameters<typeof BankReconcile>[0]["candidates"];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/finance/bank-reconciliation" style={{ color: "inherit" }}>
            Bank reconciliation
          </Link>
        </span>
        <h1>{statement.statement_no}</h1>
        <span className="page-sub">
          {statement.account_code} · {statement.account_name} ·{" "}
          {shortDate(statement.from_date)} to {shortDate(statement.to_date)}
          {statement.closing_balance !== null && (
            <> · bank says {money(statement.closing_balance)} at the close</>
          )}
        </span>
      </div>

      <BankReconcile
        statement={statement}
        lines={lines}
        candidates={candidates}
        matchAction={matchBankLine}
        unmatchAction={unmatchBankLine}
        ignoreAction={ignoreBankLine}
        autoMatchAction={autoMatchBankStatement}
        statusAction={setBankStatementStatus}
      />
    </>
  );
}
