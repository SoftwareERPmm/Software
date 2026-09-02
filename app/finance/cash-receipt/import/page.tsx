import Link from "next/link";
import { getCompany, getImportBatches } from "@/lib/queries";
import { runVoucherImport } from "@/lib/actions";
import { VoucherImport } from "@/components/voucher-import";

export default async function ImportCashReceipts() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const batches = (await getImportBatches(company.id)) as unknown as Array<{
    id: string; ref: string; filename: string; row_count: number;
    status: string; created_at: string; documents: number;
  }>;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; bank</span>
        <h1>Import cash receipts</h1>
        <span className="page-sub">
          A spreadsheet of receipts, posted as cash vouchers — the same two lines the
          receipt screen writes, so an imported receipt and a typed one are
          indistinguishable once posted. Nothing is written until you confirm,
          and then every row posts or none does.
        </span>
        <Link href="/finance/cash-receipt" className="btn ghost">Enter one by hand</Link>
      </div>

      <VoucherImport kind="cash" action={runVoucherImport} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Past imports</h2>
            <span className="page-sub">{batches.length}</span>
          </div>
          {batches.length === 0 ? (
            <div className="empty">Nothing imported yet.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Reference</th><th>File</th><th>When</th>
                    <th className="r">Rows</th><th className="r">Documents</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td className="code">{b.ref}</td>
                      <td className="wrap">{b.filename}</td>
                      <td>{new Date(b.created_at).toLocaleString("en-GB", {
                            day: "2-digit", month: "short", year: "numeric",
                            hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="r">{b.row_count}</td>
                      <td className="r">{b.documents}</td>
                      <td>
                        <span className={`pill ${b.status === "COMPLETED" ? "ok" : "overdue"}`}>
                          {b.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
