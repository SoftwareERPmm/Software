"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Download, Printer } from "lucide-react";
import { money } from "@/lib/format";
import type { StatementNode } from "@/lib/report-tree";

export type Section = {
  key: string;
  label: string;
  nodes: StatementNode[];
  total: number;
  /** "Total cost of goods sold" — stated under the section it closes. */
  totalLabel: string;
};

export type Summary = {
  label: string;
  value: number;
  /** A line stating what the figure closes over, not a computed trend. */
  note: string;
  /**
   * Whether this figure carries a verdict. A profit is good and a loss is
   * bad, so those cards take their colour from the sign. Total assets is
   * neither — a big balance sheet is not a good one — so most figures stay
   * plain and the colour keeps meaning something.
   */
  tone?: "verdict" | "plain";
};

/**
 * A statement read as the chart is written: section, group, account.
 *
 * Expanding and collapsing is the whole reason this is a client component. The
 * figures are computed on the server and passed in whole, so nothing here can
 * arrive at a different number from the one the ledger returned — this only
 * decides what is on screen.
 */
export function StatementTable({
  title, sections, summaries, subtotals, scope, currency,
}: {
  title: string;
  sections: Section[];
  summaries: Summary[];
  /** Lines struck between sections — gross profit, net income. */
  subtotals: { after: string; label: string; value: number; strong?: boolean }[];
  /** "All branches · 2026-01-01 to 2026-09-16" */
  scope: string;
  currency: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showCodes, setShowCodes] = useState(true);
  const [showPct, setShowPct] = useState(true);

  /** Every group, with how deep it sits — the level control needs both. */
  const groups = useMemo(() => {
    const out: { id: string; depth: number }[] = [];
    const walk = (ns: StatementNode[]) => ns.forEach((n) => {
      if (n.children.length > 0) { out.push({ id: n.id, depth: n.depth }); walk(n.children); }
    });
    sections.forEach((s) => walk(s.nodes));
    return out;
  }, [sections]);
  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);

  /**
   * How many ranks this chart actually has. Offering "Level 3" to a company
   * whose accounts go two deep is a choice that changes nothing — the same
   * reason the worklist filters hide themselves when there is one option.
   */
  const depth = useMemo(() => {
    let max = 0;
    const walk = (ns: StatementNode[]) => ns.forEach((n) => {
      if (n.depth > max) max = n.depth;
      walk(n.children);
    });
    sections.forEach((s) => walk(s.nodes));
    return max;
  }, [sections]);
  const levels = depth + 1;

  /** Showing levels 1..n means collapsing every group sitting at or below n. */
  const collapsedFor = (n: number) =>
    new Set(groups.filter((g) => g.depth >= n - 1).map((g) => g.id));

  /**
   * Which level the table is currently showing, or "" when somebody has
   * opened one branch by hand. Derived rather than stored, so the dropdown
   * cannot claim a level the rows have stopped matching.
   */
  const level = useMemo(() => {
    for (let n = 1; n <= levels; n++) {
      const want = collapsedFor(n);
      if (want.size === collapsed.size && [...want].every((id) => collapsed.has(id))) return String(n);
    }
    return "";
  }, [collapsed, groups, levels]);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /**
   * Exports what the statement says, at the depth it is written — a file that
   * disagrees with the page it came from is worse than no file, because the
   * difference is invisible until somebody acts on it.
   */
  function exportCsv() {
    const q = (v: string | number) => {
      const t = String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const out: string[] = [[`Code`, `Description`, `Amount (${currency})`].join(",")];
    const walk = (ns: StatementNode[]) => ns.forEach((n) => {
      out.push([q(n.code), q("  ".repeat(n.depth) + n.name), n.amount.toFixed(2)].join(","));
      if (!collapsed.has(n.id)) walk(n.children);
    });
    for (const s of sections) {
      out.push([q(""), q(s.label.toUpperCase()), s.total.toFixed(2)].join(","));
      walk(s.nodes);
      out.push([q(""), q(s.totalLabel), s.total.toFixed(2)].join(","));
      for (const st of subtotals.filter((x) => x.after === s.key)) {
        out.push([q(""), q(st.label), st.value.toFixed(2)].join(","));
      }
    }
    const blob = new Blob(["﻿" + out.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${scope.replace(/[^\d-]+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const pct = (v: number) => {
    const base = summaries[0]?.value ?? 0;
    if (!base) return null;
    return `${((v / base) * 100).toFixed(1)}%`;
  };

  /**
   * Flat list of <tr>, not nested <tbody> — a tbody inside a tbody is invalid
   * and browsers silently reparent it, which moves rows out of their section.
   */
  const renderNodes = (ns: StatementNode[]): React.ReactNode[] =>
    ns.flatMap((n) => {
      const isGroup = n.children.length > 0;
      const shut = collapsed.has(n.id);
      const row = (
        <tr key={n.id} className={isGroup ? "stmt-group" : undefined}>
          <td style={{ paddingLeft: `${1.25 + n.depth * 1.35}rem` }}>
            {isGroup ? (
              <button type="button" className="stmt-toggle" onClick={() => toggle(n.id)}
                      aria-expanded={!shut}>
                <ChevronRight size={14} aria-hidden="true"
                              style={{ transform: shut ? "none" : "rotate(90deg)" }} />
                {showCodes && <span className="stmt-code">{n.code}</span>}
                {n.name}
              </button>
            ) : (
              <span className="stmt-leaf">
                {/* Holds the width the chevron would take. Without it a leaf's
                    extra indent is spent on the gap its parent uses for the
                    arrow, and the two land in the same column — which is what
                    made a detail row look like the group above it. */}
                <span className="stmt-spacer" aria-hidden="true" />
                {showCodes && <span className="stmt-code">{n.code}</span>}
                {n.name}
              </span>
            )}
          </td>
          <td className="r">{money(n.amount)}</td>
          {showPct && <td className="r stmt-pct">{pct(n.amount) ?? "\u2014"}</td>}
        </tr>
      );
      return shut ? [row] : [row, ...renderNodes(n.children)];
    });

  return (
    <section className="erp-card stmt">
      <div className="erp-card-head stmt-head">
        <h2>{title}</h2>
        <div className="stmt-controls">
          {levels > 1 && (
            <label className="stmt-level">
              Detail
              <select value={level}
                      onChange={(e) => setCollapsed(collapsedFor(Number(e.target.value)))}>
                {Array.from({ length: levels }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    Level {n}{n === levels ? " — full detail" : ""}
                  </option>
                ))}
                {/* Only reachable by opening a branch by hand, and shown so
                    the control describes what is on screen rather than the
                    last button pressed. */}
                {level === "" && <option value="">Custom</option>}
              </select>
            </label>
          )}
          <button type="button" className="erp-hbtn" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button type="button" className="erp-hbtn"
                  onClick={() => setCollapsed(new Set(groupIds))}>
            Collapse all
          </button>
          <label className="stmt-switch">
            <input type="checkbox" checked={showCodes}
                   onChange={(e) => setShowCodes(e.target.checked)} />
            <span className="stmt-track" aria-hidden="true" />
            Account codes
          </label>
          <label className="stmt-switch">
            <input type="checkbox" checked={showPct}
                   onChange={(e) => setShowPct(e.target.checked)} />
            <span className="stmt-track" aria-hidden="true" />
            Percentages
          </label>
          <button type="button" className="erp-hbtn noprint" onClick={exportCsv}>
            <Download size={15} aria-hidden="true" /> Export
          </button>
          <button type="button" className="erp-hbtn noprint" onClick={() => window.print()}>
            <Printer size={15} aria-hidden="true" /> Print
          </button>
        </div>
      </div>

      <div className="stmt-summaries">
        {summaries.map((s) => {
          const verdict = s.tone === "verdict"
            ? (s.value < 0 ? " bad" : " good")
            : "";
          return (
            <div key={s.label} className={`stmt-summary${verdict}`}>
              <span className="stmt-summary-label">{s.label}</span>
              <strong className="stmt-summary-value">{currency} {money(s.value)}</strong>
              <span className="stmt-summary-note">{s.note}</span>
            </div>
          );
        })}
      </div>

      <div className="stmt-scope">{scope}</div>

      <div className="tablewrap">
        <table className="stmt-table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="r">Amount ({currency})</th>
              {showPct && (
                <th className="r">% of {summaries[0]?.label.toLowerCase() ?? "total"}</th>
              )}
            </tr>
          </thead>
          {sections.map((s) => (
            <tbody key={s.key} className="stmt-section">
              {/* A heading, not a figure. It used to carry the section total
                  and so did the row closing the section — the same number
                  twice, three rows apart, with the detail in between. */}
              <tr className="stmt-section-head">
                <td colSpan={showPct ? 3 : 2}>{s.label}</td>
              </tr>
              {s.nodes.length === 0 && (
                <tr><td colSpan={showPct ? 3 : 2} className="stmt-none">Nothing posted in this period.</td></tr>
              )}
              {renderNodes(s.nodes)}
              <tr className="stmt-total">
                <td>{s.totalLabel}</td>
                <td className="r">{money(s.total)}</td>
                {showPct && <td className="r stmt-pct">{pct(s.total) ?? "—"}</td>}
              </tr>
              {/* A loss reads as a loss. The only colour in the table, and it
                  is on the lines that carry a verdict. */}
              {subtotals.filter((x) => x.after === s.key).map((st) => (
                <tr key={st.label}
                    className={`stmt-subtotal${st.strong ? " strong" : ""}`
                      + (st.value < 0 ? " bad" : "")}>
                  <td>{st.label}</td>
                  <td className="r">{money(st.value)}</td>
                  {showPct && <td className="r stmt-pct">{pct(st.value) ?? "—"}</td>}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
