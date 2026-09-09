import Link from "next/link";
import { ArrowLeft, FileText, BookOpen } from "lucide-react";
import { notFound } from "next/navigation";
import { getCompany, getJournalEntry, getRelatedDocuments } from "@/lib/queries";
import { money } from "@/lib/db";

/**
 * One entry, in full: what it debited, what it credited, and what wrote it.
 *
 * A page rather than a modal. The ledger row it came from is a row in a list
 * someone was scanning, and a modal would trap that reading — no address to
 * send anyone, no browser back, nothing to open in a second tab beside the
 * document it argues with. The back link carries the ledger's filters, so
 * returning lands on the same view rather than the top of an unfiltered list.
 */

const LABEL: Record<string, string> = {
  PURCHASE_ORDER: "Purchase order", GOODS_RECEIPT: "Goods receipt",
  PURCHASE_INVOICE: "Purchase invoice", PURCHASE_RETURN: "Purchase return",
  SUPPLIER_PAYMENT: "Supplier payment", SALES_ORDER: "Sales order",
  DELIVERY: "Delivery", SALES_INVOICE: "Sales invoice",
  SALES_RETURN: "Sales return", CUSTOMER_RECEIPT: "Customer receipt",
  STOCK_ADJUSTMENT: "Stock adjustment", STOCK_TRANSFER: "Stock transfer",
  JOURNAL_VOUCHER: "Journal voucher", CASH_VOUCHER: "Cash voucher",
  BANK_VOUCHER: "Bank voucher", OPENING_BALANCE: "Opening balance",
};

export default async function JournalEntryDetail({
  params, searchParams,
}: {
  params: Promise<{ entry: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { entry: entryId } = await params;
  const p = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const found = await getJournalEntry(company.id, entryId);
  if (!found) notFound();
  const { entry, lines } = found as any;

  // Everything except the entry id itself goes back into the ledger link, so
  // the period, account and document filters survive the round trip.
  const back = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) back.set(k, v);
  const backHref = `/finance/general-ledger${back.toString() ? `?${back}` : ""}`;

  const label = LABEL[entry.doc_type ?? entry.source_type]
    ?? (entry.doc_type ?? entry.source_type ?? "Journal entry");
  const totalDr = lines.reduce((s: number, l: any) =>
    s + (Number(l.base_amount) > 0 ? Number(l.base_amount) : 0), 0);
  const totalCr = lines.reduce((s: number, l: any) =>
    s + (Number(l.base_amount) < 0 ? -Number(l.base_amount) : 0), 0);

  const related = entry.document_id
    ? await getRelatedDocuments(entry.document_id)
    : { source: [], downstream: [] };
  const links = [...related.source, ...related.downstream]
    .flatMap((g: any) => g.docs.map((d: any) => ({ ...d, label: g.label })));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href={backHref} className="backlink">
            <ArrowLeft size={13} aria-hidden="true" /> General ledger
          </Link>
        </span>
        <h1>{entry.entry_no}</h1>
        <span className="page-sub">
          {label}
          {entry.partner_name && ` · ${entry.partner_name}`}
          {" · "}{entry.entry_date}
        </span>
        <span className="actions">
          {entry.status && <span className={`pill ${entry.status.toLowerCase()}`}>{entry.status}</span>}
        </span>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Accounting lines</h2>
            <span className="page-sub">
              {lines.length} line{lines.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Account</th><th>Memo</th>
                  <th className="r">Debit</th><th className="r">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l: any) => {
                  const dr = Number(l.base_amount) > 0 ? Number(l.base_amount) : 0;
                  const cr = Number(l.base_amount) < 0 ? -Number(l.base_amount) : 0;
                  return (
                    <tr key={l.line_no}>
                      <td className="code">{l.line_no}</td>
                      <td>
                        <span className="code" style={{ color: "var(--muted)" }}>{l.account_code}</span>
                        {" "}
                        {/* Credits sit in from their debit, the way an entry
                            is written by hand. */}
                        <span style={{ paddingLeft: cr ? "1rem" : 0 }}>{l.account_name}</span>
                      </td>
                      <td className="wrap" style={{ color: "var(--muted)" }}>
                        {[l.partner_name, l.location_code, l.memo].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="r dr">{dr ? money(dr) : ""}</td>
                      <td className="r cr">{cr ? money(cr) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="r dr">{money(totalDr)}</td>
                  <td className="r cr">{money(totalCr)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {entry.document_id && (
        <div className="actions" style={{ marginTop: "1rem" }}>
          <Link href={`/documents/${entry.document_id}?back=${encodeURIComponent(backHref)}`}
                className="btn">
            <FileText size={14} aria-hidden="true" /> Open {label.toLowerCase()}
            {entry.doc_no && <span className="m"> {entry.doc_no}</span>}
          </Link>
        </div>
      )}

      {links.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head"><h2>Related documents</h2></div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Type</th><th>Document</th><th>Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {links.map((d: any) => (
                    <tr key={d.id}>
                      <td>{d.label}</td>
                      <td>
                        <Link href={`/documents/${d.id}?back=${encodeURIComponent(backHref)}`}
                              className="code" style={{ color: "var(--brand)" }}>
                          {d.docNo}
                        </Link>
                      </td>
                      <td className="code">{d.docDate ?? "—"}</td>
                      <td>
                        {d.status && <span className={`pill ${String(d.status).toLowerCase()}`}>{d.status}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {!entry.document_id && (
        <div className="alert" style={{ marginTop: "1rem" }}>
          <BookOpen size={14} aria-hidden="true" />{" "}
          This entry has no document behind it. Every posting route writes one,
          so an entry without one was written straight into the ledger.
        </div>
      )}
    </>
  );
}
