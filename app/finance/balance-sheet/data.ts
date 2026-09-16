import {
  getCompany, getBalanceSheet, getBranches, getUnassignedBranchActivity,
  getAccountTree, UNASSIGNED_BRANCH,
} from "@/lib/queries";
import { buildStatement, type ChartRow, type StatementNode } from "@/lib/report-tree";
import { money } from "@/lib/db";
import type { Section, Summary } from "@/components/statement-table";

/**
 * The balance sheet, computed once for both the screen and the paper. The
 * reasoning is the income statement's: a printed statement that disagreed
 * with the screen it was printed from would be worse than no print button.
 */

export type Params = { asOf?: string; branch?: string };

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getBalanceSheetData({ asOf: asOfParam, branch }: Params) {
  const company = await getCompany();
  if (!company) return null;

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

  const summaries: Summary[] = [
    { label: "Total assets", value: assets, note: "what the company holds" },
    { label: "Total liabilities", value: liabilities, note: "what it owes" },
    { label: "Total equity", value: equity, note: "including this period's result" },
  ];

  const sections: Section[] = [
    { key: "ASSET", label: "Assets", nodes: assetTree.nodes,
      total: assets, totalLabel: "Total assets" },
    { key: "LIABILITY", label: "Liabilities", nodes: liabilityTree.nodes,
      total: liabilities, totalLabel: "Total liabilities" },
    { key: "EQUITY", label: "Equity", nodes: equityNodes,
      total: equity, totalLabel: "Total equity" },
  ];

  const subtotals = [
    { after: "EQUITY", label: "Total liabilities and equity",
      value: liabilities + equity, strong: true },
  ];

  return {
    company, branches, unassignedLines, branchId, branchName, asOf,
    assets, liabilities, equity, balanced,
    summaries, sections, subtotals,
    scope: `${branchName} · as of ${asOf} · ${
      balanced ? "Balanced" : `Out by ${money(assets - (liabilities + equity))}`}`,
  };
}
