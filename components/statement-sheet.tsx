import type { StatementNode } from "@/lib/report-tree";
import { money } from "@/lib/format";

/**
 * A financial statement as paper.
 *
 * The same decision the documents made in app/documents/[id]/print: a page of
 * its own rather than @media print over the screen. Printing by subtraction
 * leaves a statement carrying its own toggles, summary cards and detail
 * dropdown onto A4 — controls that mean nothing once the page is in a hand —
 * and it cannot be looked at before it comes out of the printer.
 *
 * One row model for all three statements. The income statement and balance
 * sheet arrive as account trees and the cash flow as flat categories, but on
 * paper they are the same object: headings, indented lines, and totals ruled
 * off. Flattening happens at each caller, where the shape is known.
 */

export type SheetRow =
  | { kind: "section"; label: string }
  | { kind: "line"; label: string; code?: string | null; depth: number; amount: number }
  | { kind: "total"; label: string; amount: number; strong?: boolean }
  /** A figure struck across the statement — gross profit, net income. */
  | { kind: "rule"; label: string; amount: number; strong?: boolean }
  /** Stated, not summed: "Reconciles", "Cash at end of period". */
  | { kind: "note"; label: string; amount: number };

/** An account tree as indented lines, deepest last, in chart order. */
export function flattenNodes(nodes: StatementNode[], showCodes = true): SheetRow[] {
  const out: SheetRow[] = [];
  const walk = (ns: StatementNode[]) => ns.forEach((n) => {
    out.push({
      kind: "line",
      label: n.name,
      code: showCodes ? n.code : null,
      depth: n.depth,
      amount: n.amount,
    });
    walk(n.children);
  });
  walk(nodes);
  return out;
}

export function StatementSheet({
  company, title, scope, currency, rows,
}: {
  company: { name: string; nameMy?: string | null };
  title: string;
  /** "All branches · 2026-01-01 to 2026-09-16" — what the figures cover. */
  scope: string;
  currency: string;
  rows: SheetRow[];
}) {
  return (
    <article className="sheet">
      <header className="sheet-head">
        <div>
          <div className="sheet-co">{company.name}</div>
          {company.nameMy && (
            <div className="sheet-co-my name-my">{company.nameMy}</div>
          )}
        </div>
        <div className="sheet-title">
          <h1>{title}</h1>
          <div className="sheet-no stmt-sheet-scope">{scope}</div>
        </div>
      </header>

      <table className="sheet-table stmt-sheet-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="c-num">Amount ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === "section") {
              return (
                <tr key={i} className="stmt-sheet-section">
                  <td colSpan={2}>{r.label}</td>
                </tr>
              );
            }
            if (r.kind === "line") {
              return (
                <tr key={i}>
                  <td style={{ paddingLeft: `${4 + r.depth * 6}mm` }}>
                    {r.code && <span className="m sheet-code">{r.code}</span>}
                    {r.label}
                  </td>
                  <td className="c-num">{money(r.amount)}</td>
                </tr>
              );
            }
            const cls =
              r.kind === "rule" ? `stmt-sheet-rule${r.strong ? " strong" : ""}`
              : r.kind === "total" ? `stmt-sheet-total${r.strong ? " strong" : ""}`
              : "stmt-sheet-note";
            return (
              <tr key={i} className={cls}>
                <td>{r.label}</td>
                <td className="c-num">{money(r.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}
