import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/print-button";
import {
  StatementSheet, flattenNodes, type SheetRow,
} from "@/components/statement-sheet";
import { getBalanceSheetData, type Params } from "../data";

/** The balance sheet as paper, from the same function the screen reads. */
export default async function BalanceSheetPrint({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const data = await getBalanceSheetData(await searchParams);
  if (!data) return <div className="empty">No company found.</div>;
  const { company, sections, subtotals, scope, asOf, branchId } = data;

  const rows: SheetRow[] = [];
  for (const s of sections) {
    rows.push({ kind: "section", label: s.label });
    rows.push(...flattenNodes(s.nodes));
    rows.push({ kind: "total", label: s.totalLabel, amount: s.total });
    for (const t of subtotals.filter((t) => t.after === s.key)) {
      rows.push({ kind: "rule", label: t.label, amount: t.value, strong: t.strong });
    }
  }

  return (
    <>
      <div className="actions noprint" style={{ marginBottom: "0.5rem" }}>
        <Link
          href={{ pathname: "/finance/balance-sheet", query: {
            asOf, ...(branchId ? { branch: branchId } : {}),
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
          title="Balance sheet"
          scope={scope}
          currency={company.base_currency}
          rows={rows}
        />
      </div>
    </>
  );
}
