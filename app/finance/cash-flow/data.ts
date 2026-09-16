import {
  getCompany, getCashFlowStatement, getBranches,
  getUnassignedBranchActivity, UNASSIGNED_BRANCH,
} from "@/lib/queries";

/**
 * The cash flow statement, computed once for both the screen and the paper.
 *
 * Unlike the other two this is not an account tree — the categories come out
 * of the query already classified, so there is nothing to roll up. What it
 * shares with them is the rule: the printed statement reads the same function
 * as the screen, so the two cannot arrive at different figures.
 */

export type Params = { from?: string; to?: string; branch?: string };

function defaultFrom() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "operating", label: "Operating activities" },
  { key: "investing", label: "Investing activities" },
  { key: "financing", label: "Financing activities" },
];

export async function getCashFlowData({ from, to, branch }: Params) {
  const company = await getCompany();
  if (!company) return null;

  const range = { from: from || defaultFrom(), to: to || today() };

  const branches = (await getBranches(company.id)) as unknown as
    Array<{ id: string; code: string; name: string }>;
  const unassignedLines = await getUnassignedBranchActivity(company.id);
  // A branch id that no longer exists falls back to the consolidated view
  // rather than showing an empty report with no explanation.
  const branchId =
    branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : branch && branches.some((b) => b.id === branch) ? branch
    : null;
  const branchName =
    branchId === UNASSIGNED_BRANCH ? "No branch"
    : branches.find((b) => b.id === branchId)?.name ?? "All branches";

  const { rows, beginningCash, endingCash } =
    await getCashFlowStatement(company.id, range.from, range.to, branchId);
  const typed = rows as unknown as Array<{ category: string; section: string; amount: string }>;

  const netChange = SECTIONS.reduce(
    (s, sec) => s + typed.filter((r) => r.section === sec.key).reduce((s2, r) => s2 + Number(r.amount), 0),
    0
  );

  // Beginning plus what the statement explains should be what the ledger
  // holds. A branch view legitimately differs: a transfer between branches
  // moves that branch's cash but has no contra line to classify, so it shows
  // as a difference rather than being quietly folded into a category.
  const difference = Number(endingCash) - (Number(beginningCash) + netChange);
  const unreconciled = Math.abs(difference) > 0.01;

  return {
    company, branches, unassignedLines, branchId, branchName, range,
    typed, beginningCash, endingCash, netChange, difference, unreconciled,
    scope: `${branchName} · ${range.from} to ${range.to}`,
  };
}
