import { Fragment } from "react";
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
/*
 * This panel deliberately carries no accounting summary. It had one, and it
 * was a second, shorter copy of the journal printed a few centimetres above
 * the real one — two renderings of the same entry inviting the reader to
 * check whether they agree. What a document did to the ledger is answered
 * once, in full, under Posting.
 */
export function RelatedDocumentsPanel({
  related,
}: {
  related: RelatedDocuments;
}) {
  const { source, downstream } = related;
  if (source.length === 0 && downstream.length === 0) return null;

  /**
   * A grid, not a table.
   *
   * A table sizes itself to its content and will happily grow past the flex
   * box it sits in, which is how "PO20260901001 · 01 Sept 2026 · 100 units"
   * came to be painted across the DOWNSTREAM column beside it. Grid tracks
   * cannot do that: minmax(0, 1fr) lets the value column shrink, and the text
   * wraps instead of escaping.
   */
  const section = (heading: string, groups: RelatedDocuments["source"]) =>
    groups.length === 0 ? null : (
      <div className="reldoc-section">
        <div className="reldoc-heading">{heading}</div>
        <dl className="reldoc-list">
          {groups.map((g) => (
            <Fragment key={g.label}>
              <dt>{g.label}</dt>
              <dd>
                {g.docs.length === 0 ? (
                  <span style={{ color: "var(--ghost)" }}>None</span>
                ) : (
                  g.docs.map((d) => (
                    <div key={d.id + g.label} className="reldoc-doc">
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
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>

    );

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      <div className="card-head">
        <h2>Related documents</h2>
        <span className="page-sub">what this is linked to, and what it is not</span>
      </div>
      <div className="card-body reldoc-body">
        {section("Source", source)}
        {section("Downstream", downstream)}
      </div>
    </div>
  );
}
