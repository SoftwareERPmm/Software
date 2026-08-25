import Link from "next/link";
import { money, shortDate } from "@/lib/db";
import { getCompany, getDocuments } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

export default async function CustomerReturns() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const returns = (await getDocuments(company.id, "SALES_RETURN")) as any[];
  const total = returns.reduce((s, r) => s + Number(r.gross_total), 0);

  const rows: DataRow[] = returns.map((r) => ({
    key: r.id,
    searchText: [r.doc_no, r.partner_name, r.source_doc_no].filter(Boolean).join(" "),
    sort: {
      doc_no: r.doc_no ?? "",
      posting_date: toTime(r.posting_date),
      partner_name: r.partner_name ?? "",
      gross_total: Number(r.gross_total),
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/documents/${r.id}`} style={{ color: "var(--brand)" }}>{r.doc_no ?? "draft"}</Link>
        </td>
        <td className="code">{shortDate(r.posting_date)}</td>
        <td className="wrap">{r.partner_name}</td>
        <td className="code">{r.source_doc_no ?? "—"}</td>
        <td className="r">{money(r.gross_total)}</td>
        <td><span className={`pill ${r.status.toLowerCase()}`}>{r.status}</span></td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Customer Returns</h1>
        <span className="page-sub">
          Stock comes back in and revenue reverses against the invoice it came from.
        </span>
      </div>

      <div className="actions">
        <Link href="/sales/returns/new" className="btn">+ New Return</Link>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Returns</h2>
            <span className="page-sub">{returns.length} return{returns.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No customer returns"
            searchPlaceholder="Search returns…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Return #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "source_doc_no", label: "Against" },
              { key: "gross_total", label: "Amount", sortable: true, align: "r" },
              { key: "status", label: "Status" },
            ]}
            footer={<tr><td colSpan={4}>Total</td><td className="r">{money(total)}</td><td /></tr>}
          />
        </div>
      </section>
    </>
  );
}
