import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { UNASSIGNED_BRANCH } from "@/lib/queries";
import { StatementTable } from "@/components/statement-table";
import { HelpHint } from "@/components/help-hint";
import { getIncomeStatementData, type Params } from "./data";

export default async function IncomeStatement({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const data = await getIncomeStatementData(await searchParams);
  if (!data) return <div className="empty">No company found.</div>;
  const {
    company, branches, unassignedLines, branchId, range,
    summaries, sections, subtotals, scope,
  } = data;

  return (
    <>
      <div className="page-head">
        <h1>Income statement</h1>
        <HelpHint label="What this statement shows">
          Revenue less cost of goods sold less expenses, read straight from
          the ledger for the period below. Pick a branch to see that branch on
          its own, or leave it on all branches for the whole company.
        </HelpHint>
      </div>

      <form className="row" style={{ marginBottom: "1rem", alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches (consolidated)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
            {unassignedLines.lines > 0 && (
              <option value={UNASSIGNED_BRANCH}>— No branch ({unassignedLines.lines} lines) —</option>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={range.to} />
        </div>
        <div className="actions">
          <AutoApply />
          <button type="submit" data-apply>Update</button>
        </div>
      </form>

      {unassignedLines.lines > 0 && branchId === null && (
        <p className="hint" style={{ margin: "0 0 1rem" }}>
          {money(unassignedLines.debits)} was posted without choosing a branch.
          It counts in the company total but in none of the branches, so adding
          the branches together will not reach this total. Choose
          &ldquo;No branch&rdquo; above to see what those entries are.
        </p>
      )}

      <StatementTable
        title="Statement"
        currency={company.base_currency}
        scope={scope}
        printHref={{ pathname: "/finance/income-statement/print", query: {
          from: range.from, to: range.to, ...(branchId ? { branch: branchId } : {}),
        } }}
        summaries={summaries}
        sections={sections}
        subtotals={subtotals}
      />
    </>
  );
}
