import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/print-button";
import {
  StatementSheet, flattenNodes, type SheetRow,
} from "@/components/statement-sheet";
import { getIncomeStatementData, type Params } from "../data";

/**
 * The income statement as paper.
 *
 * Reads the same function the screen does, so the two cannot disagree, and
 * carries the period and branch through the query string — printing has to
 * produce the statement that was on screen, not a default one.
 */
export default async function IncomeStatementPrint({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const sp = await searchParams;
  const data = await getIncomeStatementData(sp);
  if (!data) return <div className="empty">No company found.</div>;
  const { company, sections, subtotals, scope, range, branchId } = data;

  const rows: SheetRow[] = [];
  for (const s of sections) {
    rows.push({ kind: "section", label: s.label });
    rows.push(...flattenNodes(s.nodes));
    rows.push({ kind: "total", label: s.totalLabel, amount: s.total });
    // Gross profit after cost of sales, net income at the end — struck where
    // the screen strikes them, from the same list.
    for (const t of subtotals.filter((t) => t.after === s.key)) {
      rows.push({ kind: "rule", label: t.label, amount: t.value, strong: t.strong });
    }
  }

  return (
    <>
      <div className="actions noprint" style={{ marginBottom: "0.5rem" }}>
        <Link
          href={{ pathname: "/finance/income-statement", query: {
            from: range.from, to: range.to, ...(branchId ? { branch: branchId } : {}),
          } }}
          className="btn ghost tiny"
        >
          <ArrowLeft size={13} aria-hidden="true" /> Back to the statement
        </Link>
        <PrintButton />
      </div>

      <div className="sheetwrap">
        <StatementSheet
          company={{ name: company.name, nameMy: company.name_my }}
          title="Income statement"
          scope={scope}
          currency={company.base_currency}
          rows={rows}
        />
      </div>
    </>
  );
}
