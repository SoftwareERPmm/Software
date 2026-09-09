import { money } from "@/lib/db";
import {
  getCompany, getCashFlowStatement, getBranches,
  getUnassignedBranchActivity, UNASSIGNED_BRANCH,
} from "@/lib/queries";

function defaultFrom() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "operating", label: "Operating activities" },
  { key: "investing", label: "Investing activities" },
  { key: "financing", label: "Financing activities" },
];

export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; branch?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { from, to, branch } = await searchParams;
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

  const { rows, beginningCash, endingCash } =
    await getCashFlowStatement(company.id, range.from, range.to, branchId);
  const typed = rows as unknown as Array<{ category: string; section: string; amount: string }>;

  // Beginning plus what the statement explains should be what the ledger
  // holds. A branch view legitimately differs: a transfer between branches
  // moves that branch's cash but has no contra line to classify, so it is
  // shown as a difference rather than quietly folded into a category.
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

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Reports</span>
        <h1>Cash flow statement</h1>
        <span className="page-sub">
          Direct method &mdash; actual cash in and out, by category, for the
          period below. Movements between your own cash and bank accounts are
          excluded; they are not a real inflow or outflow.
        </span>
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
            {unassignedLines > 0 && (
              <option value={UNASSIGNED_BRANCH}>— No branch ({unassignedLines} lines) —</option>
            )}
          </select>
        </div>
        <div className="actions"><button type="submit">Update</button></div>
      </form>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Statement</h2>
            <span className="page-sub">{range.from} to {range.to}</span>
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
