import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { getCompany, getBalanceSheet, getBranches, getUnassignedBranchActivity, getAccountTree, UNASSIGNED_BRANCH } from "@/lib/queries";
import { buildStatement, type ChartRow, type StatementNode } from "@/lib/report-tree";
import { StatementTable } from "@/components/statement-table";
import { ErpCrumbs } from "@/components/erp-worklist";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function BalanceSheet({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; branch?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { asOf: asOfParam, branch } = await searchParams;
  const asOf = asOfParam || today();

  const branches = (await getBranches(company.id)) as unknown as Array<{
    id: string; code: string; name: string; warehouse_count: number;
  }>;
  const unassignedLines = await getUnassignedBranchActivity(company.id);
  const branchId =
    branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : branch && branches.some((b) => b.id === branch) ? branch
    : null;
  const branchName =
    branchId === UNASSIGNED_BRANCH ? "No branch"
    : branches.find((b) => b.id === branchId)?.name ?? "All branches";

  const { rows, netIncome } = await getBalanceSheet(company.id, asOf, branchId);
  const typed = rows as unknown as Array<{
    id: string; code: string; name: string; account_type: "ASSET" | "LIABILITY" | "EQUITY"; amount: string;
  }>;

  const chart = (await getAccountTree(company.id)) as unknown as ChartRow[];
  const amounts = new Map(typed.map((r) => [r.id, Number(r.amount)]));
  const assetTree = buildStatement(chart, amounts, ["ASSET"]);
  const liabilityTree = buildStatement(chart, amounts, ["LIABILITY"]);
  const equityTree = buildStatement(chart, amounts, ["EQUITY"]);

  /**
   * This period's result, not yet closed to an equity account — so it belongs
   * in equity but has no account in the chart to hang from. Appended as its
   * own row rather than folded into one, because a reader has to be able to
   * tell what the books recorded from what the statement is adding on their
   * behalf.
   */
  const retained: StatementNode = {
    id: "retained-earnings-current", code: "", depth: 0, postable: true,
    name: "Retained earnings (current, unclosed)", amount: netIncome, children: [],
  };
  const equityNodes = netIncome !== 0
    ? [...equityTree.nodes, retained]
    : equityTree.nodes;

  const assets = assetTree.total;
  const liabilities = liabilityTree.total;
  const equity = equityTree.total + netIncome;
  const balanced = Math.abs(assets - (liabilities + equity)) < 0.0001;

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Accounting" },
        { label: "Financial reports" },
        { label: "Balance sheet" },
      ]} />
      <div className="page-head">
        <h1>Balance sheet</h1>
        <span className="page-sub">
          A snapshot, not a period. Revenue and expense are never closed to
          equity here, so their running net through the date below is folded
          into retained earnings — otherwise the two sides wouldn&rsquo;t match.
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
          <label htmlFor="asOf">As of</label>
          <input id="asOf" name="asOf" type="date" defaultValue={asOf} />
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
        scope={`${branchName} · as of ${asOf} · ${
          balanced ? "Balanced" : `Out by ${money(assets - (liabilities + equity))}`}`}
        summaries={[
          { label: "Total assets", value: assets, note: "what the company holds" },
          { label: "Total liabilities", value: liabilities, note: "what it owes" },
          { label: "Total equity", value: equity, note: "including this period's result" },
        ]}
        sections={[
          { key: "ASSET", label: "Assets", nodes: assetTree.nodes,
            total: assets, totalLabel: "Total assets" },
          { key: "LIABILITY", label: "Liabilities", nodes: liabilityTree.nodes,
            total: liabilities, totalLabel: "Total liabilities" },
          { key: "EQUITY", label: "Equity", nodes: equityNodes,
            total: equity, totalLabel: "Total equity" },
        ]}
        subtotals={[
          { after: "EQUITY", label: "Total liabilities and equity",
            value: liabilities + equity, strong: true },
        ]}
      />
    </>
  );
}
