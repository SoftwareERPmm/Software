import Link from "next/link";
import { getCompany, getDocumentHistory } from "@/lib/queries";
import { money, shortDate, dateTime } from "@/lib/format";

/** Same shape the document pages use — a local one-liner rather than a
 *  shared import, which is how the other pages here do it too. */
const label = (t: string) => t.replace(/_/g, " ").toLowerCase();

type Row = {
  id: string; action: "VOID" | "AMEND"; reason: string | null;
  detail: Record<string, unknown> | null;
  acted_by: string | null; acted_at: string;
  document_id: string; document_no: string; doc_type: string; status: string;
  doc_date: string; gross_total: string; partner_name: string | null;
  related_document_id: string | null; related_no: string | null; related_type: string | null;
};

export default async function DocumentHistory() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const rows = (await getDocumentHistory(company.id)) as unknown as Row[];
  const voids = rows.filter((r) => r.action === "VOID").length;
  const edits = rows.filter((r) => r.action === "AMEND").length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Documents</span>
        <h1>History log</h1>
        <span className="page-sub">
          Every document that has been voided or edited. Nothing here was
          deleted: a voided document keeps its number, its lines and its
          journal entry, and the reversal that cancelled it sits beside it in
          the ledger. This is the record of what was done and when &mdash; so
          a document disappearing from a list is never the same thing as one
          that was never entered.
        </span>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>What was done</h2>
            <span className="page-sub">
              {rows.length === 0 ? "nothing yet" : `${voids} voided · ${edits} edited`}
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              Nothing has been voided or edited. Posted documents are corrected
              rather than changed, and anything corrected will be listed here.
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th><th>Action</th><th>Document</th><th>Partner</th>
                    <th className="r">Amount</th><th>Reversed / replaced by</th>
                    <th>Reason</th><th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{dateTime(r.acted_at)}</td>
                      <td>
                        <span className={`pill ${r.action === "VOID" ? "warn" : ""}`}>
                          {r.action === "VOID" ? "voided" : "edited"}
                        </span>
                      </td>
                      <td className="code">
                        <Link href={`/documents/${r.document_id}`} style={{ color: "var(--brand)" }}>
                          {r.document_no}
                        </Link>
                        <div className="subline" style={{ color: "var(--muted)" }}>
                          {label(r.doc_type)} · {shortDate(r.doc_date)}
                        </div>
                      </td>
                      <td className="wrap">{r.partner_name ?? "—"}</td>
                      <td className="r">{money(r.gross_total)}</td>
                      <td className="code">
                        {r.related_document_id ? (
                          <Link href={`/documents/${r.related_document_id}`} style={{ color: "var(--brand)" }}>
                            {r.related_no}
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="wrap" style={{ color: "var(--muted)" }}>{r.reason || "—"}</td>
                      {/* Null until there is such a thing as a logged-in user.
                          Shown rather than hidden, so the gap is visible
                          instead of being mistaken for an empty audit trail. */}
                      <td style={{ color: "var(--muted)" }}>{r.acted_by ?? "not recorded"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card-body" style={{ paddingTop: 0 }}>
            <span className="page-sub">
              <strong>By</strong> is blank because this system has no login yet.
              The column is here so that when it does, the entries made from
              that day carry a name and these keep their honest blank &mdash;
              rather than being attributed later to whoever happens to be added
              first.
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
