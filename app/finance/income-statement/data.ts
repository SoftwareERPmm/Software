import {
  getCompany, getIncomeStatement, getBranches, getUnassignedBranchActivity,
  getAccountTree, UNASSIGNED_BRANCH,
} from "@/lib/queries";
import { buildStatement, type ChartRow } from "@/lib/report-tree";
import type { Section, Summary } from "@/components/statement-table";

/**
 * The income statement, computed once for both the screen and the paper.
 *
 * The print view is a second reader of the same figures, and the one thing it
 * must never be is a second calculation of them: a printed statement that
 * disagreed with the screen it was printed from would be worse than no print
 * button at all. So this returns the finished sections and subtotals, and
 * neither page decides anything about the numbers.
 */

export type Params = { from?: string; to?: string; branch?: string };

function defaultFrom() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getIncomeStatementData({ from, to, branch }: Params) {
  const company = await getCompany();
  if (!company) return null;

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
  const cogsTree = buildStatement(chart, amounts, ["COGS"]);
  const expenseTree = buildStatement(chart, amounts, ["EXPENSE"]);

  /**
   * Revenue is credit-natured money in, and two different things wear that
   * nature: what the business sold, and everything else — a delivery charge,
   * an exchange gain. Both are REVENUE to the ledger and only one is turnover,
   * so the chart keeps them in separate groups (0071) and the statement reads
   * them as separate sections. Without that, other income inflates the top
   * line, inflates gross profit with it, and widens the base of every
   * percentage measured against revenue.
   *
   * Matched on the group's code, which is the one place the chart names this
   * distinction; a company whose chart has no such group simply shows no
   * other-income section, and the statement reads as it did before.
   */
  const OTHER_INCOME_GROUP = "4-OI";
  const NON_OPERATING_EXPENSE_GROUP = "6-NO";
  const revenueAll = buildStatement(chart, amounts, ["REVENUE"]);
  const revenueNodes = revenueAll.nodes.filter((n) => n.code !== OTHER_INCOME_GROUP);
  const otherNodes = revenueAll.nodes.filter((n) => n.code === OTHER_INCOME_GROUP);

  /**
   * The expense side of the same line. An exchange loss is not a cost of
   * running the business, so operating profit must not carry it — and it sat
   * in Miscellaneous Expenses until 0072, where it did.
   *
   * Found by walking the tree rather than the roots, because the group hangs
   * under 6-EX rather than standing on its own.
   */
  const findGroup = (nodes: typeof expenseTree.nodes, code: string): typeof nodes =>
    nodes.flatMap((n) => (n.code === code ? [n] : findGroup(n.children, code)));
  const nonOpNodes = findGroup(expenseTree.nodes, NON_OPERATING_EXPENSE_GROUP);
  const nonOpExpense = nonOpNodes.reduce((t, n) => t + n.amount, 0);

  /** Operating expenses with the non-operating group taken back out. */
  const stripNonOp = (nodes: typeof expenseTree.nodes): typeof nodes =>
    nodes
      .filter((n) => n.code !== NON_OPERATING_EXPENSE_GROUP)
      .map((n) => ({ ...n, children: stripNonOp(n.children),
                     amount: n.amount - findGroup([n], NON_OPERATING_EXPENSE_GROUP)
                                          .reduce((t, g) => t + g.amount, 0) }));
  const operatingNodes = stripNonOp(expenseTree.nodes).filter((n) => n.amount !== 0 || n.children.length > 0);

  const revenue = revenueNodes.reduce((t, n) => t + n.amount, 0);
  const otherIncome = otherNodes.reduce((t, n) => t + n.amount, 0);
  const cogs = cogsTree.total;
  const expense = expenseTree.total - nonOpExpense;
  const grossProfit = revenue - cogs;
  // What trading itself made, before anything earned or lost another way.
  const operatingProfit = grossProfit - expense;
  const netIncome = operatingProfit + otherIncome - nonOpExpense;
  /** Whether anything sits below the operating line at all. */
  const belowTheLine = otherNodes.length > 0 || nonOpNodes.length > 0;

  const summaries: Summary[] = [
    /* Revenue is a size, not a verdict — a big one is not automatically
       good. Profit is the other way round, so those two take their
       colour from the sign and revenue stays plain. */
    { label: "Total revenue", value: revenue, note: "what the period earned" },
    { label: "Operating profit", value: operatingProfit,
      note: "what trading itself made", tone: "verdict" },
    { label: "Net income", value: netIncome,
      note: otherIncome !== 0 ? "including income earned other ways" : "after every expense",
      tone: "verdict" },
  ];

  const sections: Section[] = [
    { key: "REVENUE", label: "Revenue", nodes: revenueNodes,
      total: revenue, totalLabel: "Total revenue" },
    { key: "COGS", label: "Cost of goods sold", nodes: cogsTree.nodes,
      total: cogs, totalLabel: "Total cost of goods sold" },
    { key: "EXPENSE", label: "Operating expenses", nodes: operatingNodes,
      total: expense, totalLabel: "Total operating expenses" },
    /* Only when there is some. A company that never earns outside its
       trade should not read a section of zeroes. */
    ...(otherNodes.length > 0
      ? [{ key: "OTHER", label: "Other income", nodes: otherNodes,
           total: otherIncome, totalLabel: "Total other income" }]
      : []),
    ...(nonOpNodes.length > 0
      ? [{ key: "NONOP", label: "Non-operating expenses", nodes: nonOpNodes,
           total: nonOpExpense, totalLabel: "Total non-operating expenses" }]
      : []),
  ];

  const subtotals = [
    { after: "COGS", label: "Gross profit", value: grossProfit },
    /* Operating profit closes the trading story; net income closes the
       statement. With no other income the two are the same figure, so
       only one of them is drawn. */
    ...(belowTheLine
      ? [{ after: "EXPENSE", label: "Operating profit", value: operatingProfit },
         { after: nonOpNodes.length > 0 ? "NONOP" : "OTHER",
           label: "Net income", value: netIncome, strong: true }]
      : [{ after: "EXPENSE", label: "Net income", value: netIncome, strong: true }]),
  ];

  return {
    company, branches, unassignedLines, branchId, branchName, range,
    summaries, sections, subtotals,
    scope: `${branchName} · ${range.from} to ${range.to}`,
  };
}
