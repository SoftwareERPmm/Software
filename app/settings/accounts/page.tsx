import { sql } from "@/lib/db";
import { getCompany, getChartOfAccounts } from "@/lib/queries";
import { createAccount, updateAccount, deactivateAccount, activateAccount, deleteAccount } from "@/lib/actions";
import { AddAccountForm } from "@/components/account-form";
import { AccountRow, type CoaAccount } from "@/components/account-row";

export default async function ChartOfAccounts() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [accounts, currencyRows] = await Promise.all([
    getChartOfAccounts(company.id) as unknown as Promise<CoaAccount[]>,
    sql`select code from currency order by code`,
  ]);
  const currencies = (currencyRows as any[]).map((c) => c.code);

  /**
   * Parents before their children, each branch in code order — the shape an
   * accountant expects to read, rather than one flat list sorted by code.
   */
  function walk(parentId: string | null, depth: number): React.ReactNode[] {
    return accounts
      .filter((a) => a.parent_id === parentId)
      .flatMap((a) => [
        <AccountRow
          key={a.id}
          account={a}
          accounts={accounts}
          depth={depth}
          currencies={currencies}
          updateAction={updateAccount}
          deactivateAction={deactivateAccount}
          activateAction={activateAccount}
          deleteAction={deleteAccount}
        />,
        ...walk(a.id, depth + 1),
      ]);
  }

  const active = accounts.filter((a) => a.is_active).length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>Chart of accounts</h1>
        <span className="page-sub">
          Created with the company and yours to customise. Accounts nest to any
          depth; a heading exists to group and cannot be posted to, only its
          children can. Anything the posting engine resolves by role is marked
          and protected &mdash; retiring one would turn a routine sale into an
          error.
        </span>
      </div>

      <AddAccountForm action={createAccount} accounts={accounts} currencies={currencies} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Accounts</h2>
            <span className="page-sub">
              {accounts.length} total · {active} active
            </span>
          </div>

          {accounts.length === 0 ? (
            <div className="empty">No accounts exist yet.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th><th>Type</th><th /><th />
                  </tr>
                </thead>
                <tbody>{walk(null, 0)}</tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
