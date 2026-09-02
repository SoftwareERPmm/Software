import Link from "next/link";
import { getCompany, getImportBatches } from "@/lib/queries";
import { runItemImport } from "@/lib/actions";
import { ItemImport } from "@/components/item-import";

export default async function ImportItems() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const batches = (await getImportBatches(company.id)) as unknown as Array<{
    id: string; ref: string; filename: string; row_count: number;
    status: string; created_at: string; items_created: number; documents: number;
  }>;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Import items</h1>
        <span className="page-sub">
          The item master, from a spreadsheet — what the items <em>are</em>, not
          how many there are. Quantity and cost are the result of stock
          documents, so they are not on this sheet; a new item exists with no
          stock until a goods receipt or an opening stock adjustment gives it
          some. The spreadsheet is the input and this database stays the source
          of truth: a row naming a category, brand or unit that does not exist
          here is refused rather than creating one, because two spellings of the
          same category is the mess an importer is supposed to prevent. Nothing
          is written until you confirm, and then all of it is written or none.
        </span>
        <Link href="/items" className="btn ghost">Back to items</Link>
      </div>

      <ItemImport action={runItemImport} />

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
                    <th className="r">Rows</th><th className="r">Items created</th>
                    <th className="r">Documents</th><th>Status</th>
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
                      <td className="r">{b.items_created}</td>
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
