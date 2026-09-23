import Link from "next/link";
import { money } from "@/lib/format";
import { AccountPicker } from "@/components/account-picker";
import { HelpHint } from "@/components/help-hint";

type Row = {
  entry_no: string; entry_date: string; memo: string | null;
  doc_no: string | null; partner_name: string | null;
  debit: string; credit: string; running_balance?: string;
  account_code?: string; account_name?: string;
  journal_entry_id: string | null; source_id: string | null;
  source_type: string | null;
};

type Account = { id: string; code: string; name: string };

const day = (v: string) =>
  new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/**
 * A cash or bank book: every movement on an account, with a running balance.
 *
 * Shared by both because they were byte-identical apart from the word "cash",
 * and a copy is where two screens quietly stop agreeing about what a ledger
 * looks like.
 *
 * One account at a time is the default, because the running balance is the
 * point of a book — it is the figure somebody checks against the till or the
 * statement. "All accounts" is offered as well, for the question the
 * per-account view cannot answer ("where did the money go this week"), and
 * it drops the running balance rather than pretending: a balance running
 * across two tills is the sum of things nobody holds together.
 */
export function AccountBook({
  kind, accounts, selected, rows, basePath, newLinks,
}: {
  kind: "cash" | "bank";
  accounts: Account[];
  /** null means every account — the "All" view. */
  selected: Account | null;
  rows: Row[];
  basePath: string;
  newLinks: { href: string; label: string; primary?: boolean }[];
}) {
  const all = selected === null;
  const totalDr = rows.reduce((s, r) => s + Number(r.debit), 0);
  const totalCr = rows.reduce((s, r) => s + Number(r.credit), 0);
  const closing = rows.length && !all
    ? Number(rows[rows.length - 1].running_balance ?? 0)
    : 0;

  // Per account, for the All view — the balances the running column would
  // have shown had it been meaningful.
  const perAccount = all
    ? accounts.map((a) => {
        const mine = rows.filter((r) => r.account_code === a.code);
        return {
          ...a,
          movements: mine.length,
          balance: mine.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0),
        };
      }).filter((a) => a.movements > 0)
    : [];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>{kind === "cash" ? "Cash book" : "Bank book"}</h1>
        <HelpHint>
          Every movement on the account with a running balance, whatever
          document caused it. The entry and document numbers are links — the
          entry opens the full double entry, the document opens what caused it.
          <br /><br />
          <strong>All accounts</strong> lists every {kind} account together and
          drops the running balance, because a balance running across two
          {kind === "cash" ? " tills" : " accounts"} is the sum of things
          nobody holds together. Closing balances are shown per account instead.
        </HelpHint>
      </div>

      <div className="actions" style={{ marginBottom: "1rem" }}>
        {newLinks.map((l) => (
          <Link key={l.href} href={l.href} className={l.primary ? "btn" : "btn ghost"}>
            {l.label}
          </Link>
        ))}
      </div>

      <AccountPicker
        accounts={[{ id: "all", code: "All", name: `${kind === "cash" ? "cash" : "bank"} accounts` },
                   ...accounts]}
        selectedId={selected?.id ?? "all"}
        basePath={basePath}
      />

      {all && perAccount.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Closing balances</h2>
              <span className="page-sub">{perAccount.length} account
                {perAccount.length === 1 ? "" : "s"} with movement</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Account</th><th className="r">Movements</th><th className="r">Balance</th></tr>
                </thead>
                <tbody>
                  {perAccount.map((a) => (
                    <tr key={a.id}>
                      <td className="wrap">
                        <Link href={`${basePath}?account=${a.id}`} style={{ color: "var(--brand)" }}>
                          {a.code} · {a.name}
                        </Link>
                      </td>
                      <td className="r">{a.movements}</td>
                      <td className="r">{money(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{all ? `All ${kind} accounts` : `${selected!.code} · ${selected!.name}`}</h2>
            <span className="page-sub">
              {rows.length} movement{rows.length === 1 ? "" : "s"}
              {!all && <> · closing {money(closing)}</>}
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              {all ? `Nothing has moved on any ${kind} account yet.`
                   : "Nothing has moved on this account yet."}
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    {all && <th>Account</th>}
                    <th>Entry</th><th>Document</th><th>Narration</th>
                    <th className="r">In</th><th className="r">Out</th>
                    {!all && <th className="r">Balance</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="code">{day(r.entry_date)}</td>
                      {all && (
                        <td className="code">
                          {r.account_code}
                          <div className="subline">{r.account_name}</div>
                        </td>
                      )}
                      {/* Both numbers lead somewhere. They were plain text,
                          which on a ledger is the one thing a reader wants to
                          follow — "what is entry GEN…0012" is the question the
                          page exists to answer. */}
                      <td className="code">
                        {r.journal_entry_id ? (
                          <Link href={`/finance/general-ledger/${r.journal_entry_id}`}
                                style={{ color: "var(--brand)" }}>
                            {r.entry_no}
                          </Link>
                        ) : r.entry_no}
                      </td>
                      <td className="code">
                        {r.doc_no && r.source_id ? (
                          <Link href={`/documents/${r.source_id}`}
                                style={{ color: "var(--brand)" }}>
                            {r.doc_no}
                          </Link>
                        ) : (r.doc_no ?? "—")}
                      </td>
                      <td className="wrap">
                        {r.memo ?? "—"}
                        {r.partner_name && <div className="subline">{r.partner_name}</div>}
                      </td>
                      <td className="r dr">{Number(r.debit) ? money(r.debit) : ""}</td>
                      <td className="r cr">{Number(r.credit) ? money(r.credit) : ""}</td>
                      {!all && <td className="r">{money(r.running_balance ?? 0)}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={all ? 5 : 4}>Total</td>
                    <td className="r dr">{money(totalDr)}</td>
                    <td className="r cr">{money(totalCr)}</td>
                    {!all && <td className="r">{money(closing)}</td>}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
