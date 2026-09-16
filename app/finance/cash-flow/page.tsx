import Link from "next/link";
import { Printer } from "lucide-react";
import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { UNASSIGNED_BRANCH } from "@/lib/queries";
import { HelpHint } from "@/components/help-hint";
import { getCashFlowData, SECTIONS, type Params } from "./data";

export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const data = await getCashFlowData(await searchParams);
  if (!data) return <div className="empty">No company found.</div>;
  const {
    company, branches, unassignedLines, branchId, range, typed,
    beginningCash, endingCash, netChange, difference, unreconciled,
  } = data;

  return (
    <>
      <div className="page-head">
        <h1>Cash flow statement</h1>
        <HelpHint label="What this statement shows">
          Direct method &mdash; actual cash in and out, by category, for the
          period below. Movements between your own cash and bank accounts are
          excluded; they are not a real inflow or outflow.
        </HelpHint>
      </div>

      <form className="row" style={{ marginBottom: "1rem", alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={range.to} />
        </div>
        {/* Which branch's cash moved. The cash side of the entry decides it:
            money leaving the Yangon till is Yangon's outflow whatever it was
            spent on, and the other leg may carry a different branch or none. */}
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
            {unassignedLines.lines > 0 && (
              <option value={UNASSIGNED_BRANCH}>— No branch ({unassignedLines.lines} lines) —</option>
            )}
          </select>
        </div>
        <div className="actions">
          <AutoApply />
          <button type="submit" data-apply>Update</button>
        </div>
      </form>

      {unassignedLines.lines > 0 && branchId === null && (
        <p className="hint" style={{ margin: "0 0 1rem" }}>
          {money(unassignedLines.debits)} was posted without choosing a branch.
          It counts in the company total but in none of the branches, so adding
          the branches together will not reach this total. Choose
          &ldquo;No branch&rdquo; above to see what those entries are.
        </p>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Statement</h2>
            <span className="page-sub">{range.from} to {range.to}</span>
            {/* The same statement as paper, carrying the same period and
                branch — a link rather than window.print(), so what prints is
                the statement rather than the screen it was read on. */}
            <Link
              href={{ pathname: "/finance/cash-flow/print", query: {
                from: range.from, to: range.to,
                ...(branchId ? { branch: branchId } : {}),
              } }}
              className="erp-hbtn noprint"
              style={{ marginLeft: "auto" }}
            >
              <Printer size={15} aria-hidden="true" /> Print
            </Link>
          </div>
          <div className="tablewrap">
            <table>
              {SECTIONS.map((sec) => {
                const items = typed.filter((r) => r.section === sec.key);
                const total = items.reduce((s, r) => s + Number(r.amount), 0);
                if (items.length === 0) return null;
                return (
                  <tbody key={sec.key}>
                    <tr><td colSpan={2} style={{ background: "var(--line-soft)" }}><span className="eyebrow">{sec.label}</span></td></tr>
                    {items.map((r) => (
                      <tr key={r.category}>
                        <td className="wrap">{r.category}</td>
                        <td className="r">{money(r.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>Net {sec.label.toLowerCase()}</td>
                      <td className="r" style={{ fontWeight: 600 }}>{money(total)}</td>
                    </tr>
                  </tbody>
                );
              })}
              <tfoot>
                <tr><td>Net change in cash</td><td className="r" style={{ fontWeight: 700 }}>{money(netChange)}</td></tr>
                <tr><td>Cash at beginning of period</td><td className="r">{money(beginningCash)}</td></tr>
                <tr><td>Cash at end of period</td><td className="r" style={{ fontWeight: 700 }}>{money(endingCash)}</td></tr>
                {/* The statement's own proof. Ending cash is read straight
                    from the ledger while the movements above are classified
                    from it, so the two are arrived at independently and
                    printing both without comparing them hides exactly the
                    errors this report can make. */}
                <tr>
                  <td style={{ color: unreconciled ? "var(--bad)" : "var(--muted)" }}>
                    {unreconciled ? "Unexplained difference" : "Reconciles"}
                  </td>
                  <td className="r" style={{ color: unreconciled ? "var(--bad)" : "var(--muted)" }}>
                    {money(difference)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
