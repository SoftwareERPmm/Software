import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";
import { NoteReasons, NOTE_REASONS, reasonLabel } from "@/components/note-reasons";

type Note = {
  id: string; doc_no: string; posting_date: string; status: string;
  net_total: string; tax_total: string; gross_total: string;
  memo: string | null; adjustment_reason: string | null; reference: string | null;
  partner_name: string | null; partner_code: string | null;
  source_id: string | null; source_doc_no: string | null;
};

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const COLOUR: Map<string, string> =
  new Map(NOTE_REASONS.map((r) => [r.key as string, r.colour as string]));

/**
 * Every correction of one kind, in one place.
 *
 * Both notes list the same six columns and differ only in who the partner is
 * and which way the money went, so they share this body rather than being
 * copied — the copy is where the two drift apart and one quietly stops
 * showing the category.
 *
 * A note was previously reachable only from the invoice it reduced, which
 * meant the question the category exists to answer — how much went back as
 * billing errors this year — had nowhere to be asked.
 */
export function NotesList({
  kind, notes,
}: {
  kind: "credit" | "debit";
  notes: Note[];
}) {
  const isCredit = kind === "credit";
  const total = notes.reduce((t, n) => t + Number(n.gross_total), 0);

  const rows: DataRow[] = notes.map((n) => ({
    key: n.id,
    searchText: [n.doc_no, n.partner_name, n.source_doc_no, n.memo,
                 reasonLabel(n.adjustment_reason, isCredit)]
      .filter(Boolean).join(" "),
    sort: {
      doc_no: n.doc_no ?? "",
      posting_date: toTime(n.posting_date),
      partner_name: n.partner_name ?? "",
      // Uncategorised sorts last rather than first: it is the absence of an
      // answer, not an answer that happens to start with a letter.
      adjustment_reason: n.adjustment_reason ?? "zzz",
      source_doc_no: n.source_doc_no ?? "",
      gross_total: Number(n.gross_total),
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/documents/${n.id}`} style={{ color: "var(--brand)" }}>
            {n.doc_no}
          </Link>
        </td>
        <td className="code">{shortDate(n.posting_date)}</td>
        <td className="wrap">{n.partner_name}</td>
        <td>
          <span className="agingdot" aria-hidden="true"
                style={{ background: COLOUR.get(n.adjustment_reason ?? "UNCATEGORISED")
                                     ?? "#9AA5B4", marginRight: "0.4rem" }} />
          {reasonLabel(n.adjustment_reason, isCredit)}
          {/* The sentence, not just the category. It is the part a tax
              office reads, and hiding it behind a click makes the list
              answer less than the document it summarises. */}
          {n.memo && <div className="subline">{n.memo}</div>}
        </td>
        <td className="code">
          {n.source_id
            ? <Link href={`/documents/${n.source_id}`} style={{ color: "var(--brand)" }}>
                {n.source_doc_no}
              </Link>
            : "—"}
        </td>
        <td className="r">{money(n.gross_total)}</td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">{isCredit ? "Sales" : "Purchases"}</span>
        <h1>{isCredit ? "Credit notes" : "Debit notes"}</h1>
        <HelpHint>
          {isCredit
            ? "Money taken off a customer's invoice after it was issued — a "
              + "billing error, a cancellation, a discount agreed late, or goods "
              + "written off. The invoice is left exactly as it was raised and the "
              + "note carries the correction, so the history reads as what "
              + "happened rather than as what was decided afterwards."
            : "Money taken off a supplier's bill after it arrived — an "
              + "overcharge, a short shipment, or goods rejected on arrival. "
              + "The bill stays as they sent it and the note records what we "
              + "are not paying, with the reason attached."}
          <br /><br />
          A note moves money only. Goods {isCredit ? "coming back into" : "going back out of"}{" "}
          the warehouse are a{" "}
          <Link href={isCredit ? "/sales/returns" : "/purchases/returns"}>
            {isCredit ? "customer return" : "supplier return"}
          </Link>, which moves the stock and its cost as well.
        </HelpHint>
      </div>

      {/* The breakdown sits above the table because the question it answers
          is the one worth asking of a list of corrections. The table is
          still where the reading happens. */}
      <section>
        <NoteReasons notes={notes} isCredit={isCredit} />
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{isCredit ? "Credit notes" : "Debit notes"}</h2>
            <span className="page-sub">
              {notes.length} note{notes.length === 1 ? "" : "s"}
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel={isCredit
              ? "No credit notes — raise one from an invoice"
              : "No debit notes — raise one from a bill"}
            searchPlaceholder="Search notes, reasons, invoices…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Note #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "partner_name",
                label: isCredit ? "Customer" : "Supplier", sortable: true },
              { key: "adjustment_reason", label: "Why", sortable: true },
              { key: "source_doc_no",
                label: isCredit ? "Against invoice" : "Against bill", sortable: true },
              { key: "gross_total", label: "Amount", sortable: true, align: "r" },
            ]}
            footer={
              <tr>
                <td colSpan={5}>Total taken off</td>
                <td className="r">{money(total)}</td>
              </tr>
            }
          />
        </div>
      </section>
    </>
  );
}
