import Link from "next/link";
import { getFinanceData, getAccountLedger } from "@/lib/actions";
import { money } from "@/lib/db";
import { AccountPicker } from "@/components/account-picker";

export default async function BankDetail({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const data = await getFinanceData();
  const list = data.bankAccounts as never as { id: string; code: string; name: string }[];

  const selected = list.find((a) => a.id === account) ?? list[0];
  const rows = selected ? await getAccountLedger(selected.id, from, to) : [];

  const totalDr = rows.reduce((s: number, r: any) => s + Number(r.debit), 0);
  const totalCr = rows.reduce((s: number, r: any) => s + Number(r.credit), 0);
  const closing = rows.length ? Number((rows[rows.length - 1] as any).running_balance) : 0;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Bank book</h1>
        <span className="page-sub">
          Every movement on the account with a running balance, whatever document
          caused it.
        </span>
      </div>

      {list.length === 0 ? (
        <div className="alert">No bank account is set up.</div>
      ) : (
        <>
          <div className="actions" style={{ marginBottom: "1rem" }}>
            <Link href="/finance/bank-receipt" className="btn">+ Bank receipt</Link>
            <Link href="/finance/bank-payment" className="btn ghost">+ Bank payment</Link>
          </div>

          <AccountPicker accounts={list} selectedId={selected.id} basePath="/finance/bank-detail" />

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
                        <th className="r">In</th><th className="r">Out</th><th className="r">Balance</th>
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
