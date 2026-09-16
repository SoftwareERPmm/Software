import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { getCompany, getIncomeStatement, getBranches, getUnassignedBranchActivity, getAccountTree, UNASSIGNED_BRANCH } from "@/lib/queries";
import { buildStatement, type ChartRow } from "@/lib/report-tree";
import { StatementTable } from "@/components/statement-table";
import { ErpCrumbs } from "@/components/erp-worklist";

function defaultFrom() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function IncomeStatement({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; branch?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { from, to, branch } = await searchParams;
  const range = { from: from || defaultFrom(), to: to || today() };

  const branches = (await getBranches(company.id)) as unknown as Array<{
    id: string; code: string; name: string; warehouse_count: number;
  }>;
  // "All branches" is the consolidated company view, and is the default. A
  // branch id that no longer exists falls back to it rather than showing an
  // empty statement that looks like a business with no trade.
  const unassignedLines = await getUnassignedBranchActivity(company.id);
  const branchId =
    branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : branch && branches.some((b) => b.id === branch) ? branch
    : null;
  const branchName =
    branchId === UNASSIGNED_BRANCH ? "No branch"
    : branches.find((b) => b.id === branchId)?.name ?? "All branches";

  const rows = (await getIncomeStatement(company.id, range.from, range.to, branchId)) as unknown as Array<{
    id: string; code: string; name: string; account_type: "REVENUE" | "COGS" | "EXPENSE"; amount: string;
  }>;

  /**
   * The chart's own shape, applied to the ledger's own figures. Amounts come
   * from the query exactly as before; this only decides which account sits
   * under which, and every subtotal is the sum of the rows beneath it rather
   * than a second calculation that could disagree with them.
   */
  const chart = (await getAccountTree(company.id)) as unknown as ChartRow[];
  const amounts = new Map(rows.map((r) => [r.id, Number(r.amount)]));
  const revenueTree = buildStatement(chart, amounts, ["REVENUE"]);
  const cogsTree = buildStatement(chart, amounts, ["COGS"]);
  const expenseTree = buildStatement(chart, amounts, ["EXPENSE"]);

  const revenue = revenueTree.total;
  const cogs = cogsTree.total;
  const expense = expenseTree.total;
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - expense;

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Accounting" },
        { label: "Financial reports" },
        { label: "Income statement" },
      ]} />
      <div className="page-head">
        <h1>Income statement</h1>
        <span className="page-sub">
          Revenue less cost of goods sold less expense, read straight from the
          ledger for the period below. Choose a branch to see that branch
          alone, or leave it on all branches for the consolidated company
          figures — the branches add up to the company total, less whatever
          carries no branch at all.
        </span>
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
          {money(unassignedLines.debits)} of activity carries no branch — opening
          balances, and anything posted without one. It is in the company
          total and in none of the branches, so the branches will not add up
          to it. Choose &ldquo;No branch&rdquo; above to see exactly what.
        </p>
      )}

      <StatementTable
        title="Statement"
        currency={company.base_currency}
        scope={`${branchName} · ${range.from} to ${range.to}`}
        summaries={[
          { label: "Total revenue", value: revenue, note: "what the period earned" },
          { label: "Gross profit", value: grossProfit, note: "revenue less cost of goods sold" },
          { label: "Net income", value: netIncome, note: "after every expense" },
        ]}
        sections={[
          { key: "REVENUE", label: "Revenue", nodes: revenueTree.nodes,
            total: revenue, totalLabel: "Total revenue" },
          { key: "COGS", label: "Cost of goods sold", nodes: cogsTree.nodes,
            total: cogs, totalLabel: "Total cost of goods sold" },
          { key: "EXPENSE", label: "Operating expenses", nodes: expenseTree.nodes,
            total: expense, totalLabel: "Total operating expenses" },
        ]}
        subtotals={[
          { after: "COGS", label: "Gross profit", value: grossProfit },
          { after: "EXPENSE", label: "Net income", value: netIncome, strong: true },
        ]}
      />
    </>
  );
}
