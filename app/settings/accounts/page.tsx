import Link from "next/link";
import { sql } from "@/lib/db";
import { getCompany, getChartOfAccounts } from "@/lib/queries";
import { createAccount, updateAccount, deactivateAccount, activateAccount, deleteAccount } from "@/lib/actions";
import { AddAccountForm } from "@/components/account-form";
import { AccountRow, type CoaAccount } from "@/components/account-row";

const TABS: [string, string][] = [["", "All"], ["active", "Active"], ["inactive", "Deactivated"]];

export default async function ChartOfAccounts({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [accounts, currencyRows] = await Promise.all([
    getChartOfAccounts(company.id) as unknown as Promise<CoaAccount[]>,
    sql`select code from currency order by code`,
  ]);
  const currencies = (currencyRows as any[]).map((c) => c.code);

  const active = accounts.filter((a) => a.is_active);
  const inactive = accounts.filter((a) => !a.is_active);

  /**
   * Parents before their children, each branch in code order — the shape an
   * accountant expects to read, rather than one flat list sorted by code.
   *
   * Roots are computed rather than assumed to be `parent_id is null`, because
   * a filtered view can hide a parent while keeping its children: deactivate
   * a heading and its still-active children would otherwise belong to nobody
   * on screen and never be drawn at all. Anything whose parent is not in the
   * set being drawn is a root of that set.
   */
  function walk(within: CoaAccount[], parentId: string | null, depth: number): React.ReactNode[] {
    const ids = new Set(within.map((a) => a.id));
    const isRoot = (a: CoaAccount) => a.parent_id === null || !ids.has(a.parent_id);
    return within
      .filter((a) => (parentId === null ? isRoot(a) : a.parent_id === parentId))
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
        ...walk(within, a.id, depth + 1),
      ]);
  }

  /**
   * Deactivated accounts are shown flat, at depth zero.
   *
   * Drawing them as a tree would mean drawing their parents too — which are
   * usually still active, so the answer to "what did I deactivate?" would
   * arrive surrounded by accounts that are not the answer. A retired account
   * is a thing to find, reactivate or delete, and its position in the
   * hierarchy is not what is being asked about.
   */
  const body =
    status === "inactive"
      ? inactive.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            accounts={accounts}
            depth={0}
            currencies={currencies}
            updateAction={updateAccount}
            deactivateAction={deactivateAccount}
            activateAction={activateAccount}
            deleteAction={deleteAccount}
          />
        ))
      : status === "active"
        ? walk(active, null, 0)
        : walk(accounts, null, 0);

  const shown =
    status === "inactive" ? inactive.length
    : status === "active" ? active.length
    : accounts.length;

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

      <div className="flow">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/settings/accounts?status=${value}` : "/settings/accounts"}
            className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
          >
            {label}
            <span className="page-sub" style={{ marginLeft: "0.4rem" }}>
              {value === "inactive" ? inactive.length : value === "active" ? active.length : accounts.length}
            </span>
          </Link>
        ))}
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>
              {status === "inactive" ? "Deactivated accounts"
                : status === "active" ? "Active accounts"
                : "Accounts"}
            </h2>
            <span className="page-sub">
              {accounts.length} total · {active.length} active
              {inactive.length > 0 && ` · ${inactive.length} deactivated`}
            </span>
          </div>

          {status === "inactive" && inactive.length > 0 && (
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <span className="page-sub">
                Retired, not removed. Nothing posted to one of these has moved or
                changed &mdash; a deactivated account keeps every entry it ever
                carried and still appears in the ledger and the reports. What it
                stops doing is showing up as somewhere new to post.
              </span>
            </div>
          )}

          {accounts.length === 0 ? (
            <div className="empty">No accounts exist yet.</div>
          ) : shown === 0 ? (
            <div className="empty">
              {status === "inactive"
                ? "Nothing is deactivated. Every account in the chart is available to post to."
                : "No accounts are active."}
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th><th>Type</th><th /><th />
                  </tr>
                </thead>
                <tbody>{body}</tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
