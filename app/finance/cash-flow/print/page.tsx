import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/print-button";
import { StatementSheet, type SheetRow } from "@/components/statement-sheet";
import { getCashFlowData, SECTIONS, type Params } from "../data";

/**
 * The cash flow statement as paper.
 *
 * The reconciliation goes onto the printed copy too. Ending cash is read
 * straight from the ledger while the movements above it are classified from
 * it, so the two are arrived at independently — printing the movements
 * without the check would hide exactly the errors this statement can make.
 */
export default async function CashFlowPrint({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const data = await getCashFlowData(await searchParams);
  if (!data) return <div className="empty">No company found.</div>;
  const {
    company, typed, beginningCash, endingCash, netChange, difference,
    unreconciled, scope, range, branchId,
  } = data;

  const rows: SheetRow[] = [];
  for (const sec of SECTIONS) {
    const items = typed.filter((r) => r.section === sec.key);
    if (items.length === 0) continue;
    const total = items.reduce((s, r) => s + Number(r.amount), 0);
    rows.push({ kind: "section", label: sec.label });
    for (const r of items) {
      rows.push({ kind: "line", label: r.category, depth: 0, amount: Number(r.amount) });
    }
    rows.push({ kind: "total", label: `Net ${sec.label.toLowerCase()}`, amount: total });
  }
  rows.push({ kind: "rule", label: "Net change in cash", amount: netChange });
  rows.push({ kind: "note", label: "Cash at beginning of period", amount: Number(beginningCash) });
  rows.push({ kind: "rule", label: "Cash at end of period", amount: Number(endingCash), strong: true });
  rows.push({
    kind: "note",
    label: unreconciled ? "Unexplained difference" : "Reconciles",
    amount: difference,
  });

  return (
    <>
      <div className="actions noprint" style={{ marginBottom: "0.5rem" }}>
        <Link
          href={{ pathname: "/finance/cash-flow", query: {
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
          title="Cash flow statement"
          scope={scope}
          currency={company.base_currency}
          rows={rows}
        />
      </div>
    </>
  );
}
