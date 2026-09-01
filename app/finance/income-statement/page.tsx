import { money } from "@/lib/db";
import { getCompany, getIncomeStatement, getBranches, getUnassignedBranchActivity, UNASSIGNED_BRANCH } from "@/lib/queries";

function defaultFrom() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function IncomeStatement({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; branch?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { from, to, branch } = await searchParams;
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

  const sumOf = (type: string) =>
    rows.filter((r) => r.account_type === type).reduce((s, r) => s + Number(r.amount), 0);
  const revenue = sumOf("REVENUE");
  const cogs = sumOf("COGS");
  const expense = sumOf("EXPENSE");
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - expense;

  const section = (type: "REVENUE" | "COGS" | "EXPENSE", label: string) => {
    const items = rows.filter((r) => r.account_type === type);
    if (items.length === 0) return null;
    return (
      <tbody key={type}>
        <tr><td colSpan={2} style={{ background: "var(--line-soft)" }}><span className="eyebrow">{label}</span></td></tr>
        {items.map((r) => (
          <tr key={r.id}>
            <td className="wrap"><span className="code">{r.code}</span> {r.name}</td>
            <td className="r">{money(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    );
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Reports</span>
        <h1>Income statement</h1>
        <span className="page-sub">
          Revenue less cost of goods sold less expense, read straight from the
          ledger for the period below. Choose a branch to see that branch
          alone, or leave it on all branches for the consolidated company
          figures — the branches always add up to the company total.
        </span>
      </div>

      <form className="row" style={{ marginBottom: "1rem", alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches (consolidated)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
            {unassignedLines > 0 && (
              <option value={UNASSIGNED_BRANCH}>— No branch ({unassignedLines} lines) —</option>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={range.to} />
        </div>
        <div className="actions"><button type="submit">Update</button></div>
      </form>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Statement</h2>
            <span className="page-sub">{branchName} · {range.from} to {range.to}</span>
          </div>
          <div className="tablewrap">
            <table>
              {section("REVENUE", "Revenue")}
              <tbody>
                <tr><td>Total revenue</td><td className="r" style={{ fontWeight: 600 }}>{money(revenue)}</td></tr>
              </tbody>
              {section("COGS", "Cost of goods sold")}
              <tbody>
                <tr><td>Gross profit</td><td className="r" style={{ fontWeight: 600 }}>{money(grossProfit)}</td></tr>
              </tbody>
              {section("EXPENSE", "Expense")}
              <tfoot>
                <tr>
                  <td>Net income</td>
                  <td className="r" style={{ fontWeight: 700 }}>{money(netIncome)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
