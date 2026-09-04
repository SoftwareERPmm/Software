import { getFinanceData, getAccountLedger } from "@/lib/actions";
import { money } from "@/lib/db";
import { AccountPicker } from "@/components/account-picker";

export default async function GeneralLedger({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const data = await getFinanceData();
  const list = data.accounts as never as {
    id: string; code: string; name: string; parent_id: string | null; account_type: string;
  }[];
  // The chart including its headings, so the picker can group accounts under
  // the same sections Master data draws them under.
  const tree = data.accountTree as never as {
    id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
  }[];

  const selected = list.find((a) => a.id === account) ?? list[0];
  const rows = selected ? await getAccountLedger(selected.id, from, to) : [];

  const totalDr = rows.reduce((s: number, r: any) => s + Number(r.debit), 0);
  const totalCr = rows.reduce((s: number, r: any) => s + Number(r.credit), 0);
  const closing = rows.length ? Number((rows[rows.length - 1] as any).running_balance) : 0;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>General ledger</h1>
        <span className="page-sub">
          Every movement on any account, with a running balance, whatever
          document caused it. Cash and bank accounts have their own books
          with a running till/account balance — this is the same idea for
          everything else: inventory, revenue, expense, equity.
        </span>
      </div>

      {list.length === 0 ? (
        <div className="empty">No accounts are set up.</div>
      ) : (
        <>
          <AccountPicker accounts={list} selectedId={selected.id} tree={tree}
                         basePath="/finance/general-ledger" />

          <section>
            <div className="card">
              <div className="card-head">
                <h2>{selected.code} &middot; {selected.name}</h2>
                <span className="page-sub">
                  {rows.length} movement{rows.length === 1 ? "" : "s"} &middot; closing {money(closing)}
                </span>
              </div>

              {rows.length === 0 ? (
                <div className="empty">Nothing has moved on this account yet.</div>
              ) : (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th><th>Entry</th><th>Document</th><th>Narration</th>
                        <th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: any, i: number) => (
                        <tr key={i}>
                          <td className="code">
                            {new Date(r.entry_date).toLocaleDateString("en-GB",
                              { day: "2-digit", month: "short", year: "numeric" })}
                          </td>
                          <td className="code">{r.entry_no}</td>
                          <td className="code">{r.doc_no ?? "—"}</td>
                          <td className="wrap">
                            {r.memo ?? "—"}
                            {r.partner_name && (
                              <div className="subline">
                                {r.partner_name}
                              </div>
                            )}
                          </td>
                          <td className="r dr">{Number(r.debit) ? money(r.debit) : ""}</td>
                          <td className="r cr">{Number(r.credit) ? money(r.credit) : ""}</td>
                          <td className="r">{money(r.running_balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>Total</td>
                        <td className="r dr">{money(totalDr)}</td>
                        <td className="r cr">{money(totalCr)}</td>
                        <td className="r">{money(closing)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
