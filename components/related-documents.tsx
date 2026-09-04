import Link from "next/link";
import { money, qty, shortDate } from "@/lib/format";
import type { RelatedDocuments } from "@/lib/queries";

/** Documents whose link is about goods rather than money. */
const MOVES_GOODS = new Set(["DELIVERY", "GOODS_RECEIPT", "SALES_ORDER", "PURCHASE_ORDER"]);

const STATUS_PILL: Record<string, string> = {
  POSTED: "ok",
  REVERSED: "warn",
  DRAFT: "",
  CANCELLED: "warn",
};

/**
 * What this document is actually linked to — and, just as importantly, what
 * it is not.
 *
 * Every heading is listed even when it has nothing under it, reading "None".
 * That is the point rather than an oversight: a sale raised without an order
 * is ordinary here, and a panel that simply omitted the missing heading would
 * leave the reader unsure whether there was no order or whether the screen
 * had not looked. "Sales order — None" answers the question; silence does
 * not.
 *
 * Nothing here is styled as a warning. A missing link is only a problem when
 * some particular operation needs it, and the operation says so at the time.
 */
export type AccountingLine = { accountName: string; debit: number; credit: number };

export function RelatedDocumentsPanel({
  related, accounting = [],
}: {
  related: RelatedDocuments;
  /** What the document did to the ledger, in Dr/Cr form. Shown beside the
   *  links because "what did this do" and "what is it attached to" are the
   *  two questions someone opens a posted document to answer, and both were
   *  previously below the fold. The full entry, with line numbers, account
   *  codes and the balance proof, stays further down — this is the headline,
   *  not a second copy of the ledger. */
  accounting?: AccountingLine[];
}) {
  const { source, downstream } = related;
  if (source.length === 0 && downstream.length === 0 && accounting.length === 0) return null;

  const section = (heading: string, groups: RelatedDocuments["source"]) =>
    groups.length === 0 ? null : (
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <div className="page-sub" style={{
          textTransform: "uppercase", letterSpacing: "0.06em",
          fontSize: "var(--t-xs)", marginBottom: "0.35rem",
        }}>
          {heading}
        </div>
        <table style={{ width: "100%" }}>
          <tbody>
            {groups.map((g) => (
              <tr key={g.label} style={{ verticalAlign: "top" }}>
                <td style={{ color: "var(--muted)", whiteSpace: "nowrap", paddingRight: "0.75rem" }}>
                  {g.label}
                </td>
                <td>
                  {g.docs.length === 0 ? (
                    <span style={{ color: "var(--ghost)" }}>None</span>
                  ) : (
                    g.docs.map((d) => (
                      <div key={d.id + g.label} style={{ marginBottom: "0.15rem" }}>
                        <Link href={`/documents/${d.id}`} className="code"
                              style={{ color: "var(--brand)" }}>
                          {d.docNo}
                        </Link>
                        <span style={{ color: "var(--muted)" }}>
                          {" "}· {shortDate(d.docDate)}
                          {/* Units where the link is about goods moving, value
                              where it is about money. A delivery against an
                              order is read as "6 units" long before anyone
                              reads what it was worth. */}
                          {d.qty > 0 && MOVES_GOODS.has(d.docType)
                            ? ` · ${qty(d.qty)} units`
                            : ` · ${money(d.amount)}`}
                        </span>
                        {d.status !== "POSTED" && (
                          <> <span className={`pill ${STATUS_PILL[d.status] ?? ""}`}>
                            {d.status.toLowerCase()}
                          </span></>
                        )}
                      </div>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      <div className="card-head">
        <h2>Related documents</h2>
        <span className="page-sub">what this is linked to, and what it is not</span>
      </div>
      <div className="card-body" style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        {section("Source", source)}
        {section("Downstream", downstream)}
        {accounting.length > 0 && (
          <div style={{ minWidth: 0, flex: "1 1 240px" }}>
            <div className="page-sub" style={{
              textTransform: "uppercase", letterSpacing: "0.06em",
              fontSize: "var(--t-xs)", marginBottom: "0.35rem",
            }}>
              Accounting impact
            </div>
            <table style={{ width: "100%" }}>
              <tbody>
                {/* Debits first, credits under them — the order an entry is
                    written in, regardless of the order the posting code
                    happened to insert the lines. The full journal below
                    keeps the real line numbers; this is the reading. */}
                {[...accounting]
                  .sort((a, b) => (a.credit ? 1 : 0) - (b.credit ? 1 : 0))
                  .map((a, i) => (
                  <tr key={i}>
                    {/* Credits are indented under their debit, the way an
                        entry is written by hand. The shape carries the
                        meaning before any number is read. */}
                    <td style={{ paddingLeft: a.credit ? "1rem" : 0 }}>
                      <span style={{ color: "var(--muted)" }}>{a.credit ? "Cr" : "Dr"}</span>{" "}
                      {a.accountName}
                    </td>
                    <td className="r" style={{ whiteSpace: "nowrap" }}>
                      <span className={a.credit ? "cr" : "dr"}>
                        {money(a.credit || a.debit)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
