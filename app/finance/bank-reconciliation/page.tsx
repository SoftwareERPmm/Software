import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { getCompany, getBankStatements } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

export default async function BankReconciliation() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const statements = (await getBankStatements(company.id)) as unknown as Array<{
    id: string; statement_no: string; account_code: string; account_name: string;
    from_date: string; to_date: string; status: string;
    lines: string; matched: string; ignored: string; unmatched: string;
    net_movement: string; unmatched_value: string;
  }>;

  const rows: DataRow[] = statements.map((s) => ({
    key: s.id,
    searchText: [s.statement_no, s.account_code, s.account_name].filter(Boolean).join(" "),
    sort: {
      statement_no: s.statement_no,
      to_date: toTime(s.to_date),
      account_name: s.account_name,
      lines: Number(s.lines),
      unmatched: Number(s.unmatched),
      status: s.status,
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/finance/bank-reconciliation/${s.id}`} style={{ color: "var(--brand)" }}>
            {s.statement_no}
          </Link>
        </td>
        <td className="wrap">
          {s.account_name}
          <div className="subline">{s.account_code}</div>
        </td>
        <td className="code">
          {shortDate(s.from_date)} – {shortDate(s.to_date)}
        </td>
        <td className="r">{s.lines}</td>
        <td>
          {Number(s.unmatched) > 0 ? (
            <span className="subline">
              <strong style={{ color: "var(--warn)" }}>{s.unmatched} unexplained</strong>
              {" · "}{s.matched} matched
              {Number(s.ignored) > 0 && <> · {s.ignored} set aside</>}
            </span>
          ) : (
            <span className="subline">
              {s.matched} matched
              {Number(s.ignored) > 0 && <> · {s.ignored} set aside</>}
            </span>
          )}
        </td>
        <td className="r">{money(s.net_movement)}</td>
        <td>
          <span className={`pill ${s.status === "RECONCILED" ? "ok" : ""}`}>
            {s.status.toLowerCase()}
          </span>
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; bank</span>
        <h1>Bank reconciliation</h1>
        <HelpHint>
          The bank&rsquo;s record of an account beside ours, so every line that
          appears on one and not the other has to be accounted for — a cheque
          written but not yet presented, a charge nobody told us about, a
          transfer that arrived without a reference.
          <br /><br />
          <strong>Nothing here posts.</strong> Matching records that a line in
          our books and a line on the statement are the same event; it writes
          no journal and changes no figure. A charge on the statement that the
          books have never seen is a real transaction and wants a real bank
          payment voucher — then match against that.
        </HelpHint>
        <Link href="/finance/bank-reconciliation/new" className="btn">Import statement</Link>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Statements</h2>
            <span className="page-sub">
              {statements.length} statement{statements.length === 1 ? "" : "s"}
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No statements imported yet"
            searchPlaceholder="Search statements…"
            defaultSort={{ key: "to_date", dir: "desc" }}
            columns={[
              { key: "statement_no", label: "Statement", sortable: true },
              { key: "account_name", label: "Account", sortable: true },
              { key: "period", label: "Period" },
              { key: "lines", label: "Lines", sortable: true, align: "r" },
              { key: "progress", label: "Progress" },
              { key: "net_movement", label: "Net movement", align: "r" },
              { key: "status", label: "Status", sortable: true },
            ]}
          />
        </div>
      </section>
    </>
  );
}
