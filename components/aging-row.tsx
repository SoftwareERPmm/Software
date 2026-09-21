"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { money } from "@/lib/format";
import { BUCKETS } from "@/components/aging-bands";

export type AgingInvoice = {
  documentId: string;
  docNo: string;
  postingDate: string | null;
  dueDate: string | null;
  grossTotal: number;
  outstanding: number;
  bucket: string;
  daysOverdue: number | null;
};

export type AgingPartner = {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  buckets: Record<string, number>;
  total: number;
  worstDays: number | null;
  invoices: AgingInvoice[];
};

const bucketOf = (b: string) => BUCKETS.find((x) => x.bucket === b);

/**
 * A partner's balance, with the invoices behind it one click away.
 *
 * The totals answer "who owes us and how much is late". The next question is
 * always "which bills", and it was being answered by a link to the whole
 * receivables list — which drops you somewhere you then have to search. The
 * bills are already on the page; they only needed somewhere to appear.
 *
 * Nothing is fetched when a row opens. Every invoice was loaded with the
 * totals it adds up to, so opening one cannot fail, cannot spin, and cannot
 * show a figure that disagrees with the row above it.
 */
export function AgingRow({
  partner, columnCount, backTo, owedToUs,
}: {
  partner: AgingPartner;
  columnCount: number;
  /** Where the document's back arrow should return to. */
  backTo: string;
  /** True on the customer side. Decides which way round the debt runs. */
  owedToUs: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="stockrow" data-open={open || undefined}>
        <td className="expandcell">
          <button
            type="button"
            className="rowexpand"
            aria-expanded={open}
            aria-label={open
              ? `Hide invoices for ${partner.partnerName}`
              : `Show invoices for ${partner.partnerName}`}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </td>

        <td className="wrap">
          <strong>{partner.partnerName}</strong>
          <div className="m" style={{ color: "var(--muted)" }}>
            {partner.partnerCode}
            {" · "}
            {partner.invoices.length} invoice{partner.invoices.length === 1 ? "" : "s"}
          </div>
        </td>

        {BUCKETS.map((b, i) => {
          const amount = partner.buckets[b.bucket] ?? 0;
          return (
            <td key={b.key} className="r"
                style={{ color: amount > 0 && i > 0 ? b.ink : undefined }}>
              {amount > 0 ? money(amount) : "—"}
            </td>
          );
        })}

        <td className="r"><strong>{money(partner.total)}</strong></td>
        <td className="r" style={{ color: "var(--muted)" }}>
          {partner.worstDays && partner.worstDays > 0 ? `${partner.worstDays} d` : "—"}
        </td>
      </tr>

      {open && (
        <tr className="stockdetail-row">
          <td colSpan={columnCount}>
            <div className="stockdetail" style={{ gridTemplateColumns: "1fr" }}>
              <section className="stockpanel">
                {/* Which way the money runs. A customer owes us; we owe a
                    supplier, and saying "what Delivery Fee Supplier owes"
                    above a list of their bills had the debt backwards. */}
                <h3>
                  {owedToUs
                    ? `What ${partner.partnerName} owes`
                    : `What we owe ${partner.partnerName}`}
                </h3>
                <table className="stockpanel-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Issued</th>
                      <th>Due</th>
                      <th>Band</th>
                      <th className="r">Invoiced</th>
                      <th className="r">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partner.invoices.map((inv) => {
                      const b = bucketOf(inv.bucket);
                      return (
                        <tr key={inv.documentId}>
                          <td className="code">
                            {/* back carries this screen's name, so the arrow on
                                the document says where it came from rather than
                                just "Back". */}
                            <Link href={`/documents/${inv.documentId}?back=${encodeURIComponent(backTo)}`}
                                  style={{ color: "var(--brand)" }}>
                              {inv.docNo}
                            </Link>
                          </td>
                          <td className="m">{inv.postingDate ?? "—"}</td>
                          <td className="m">{inv.dueDate ?? "—"}</td>
                          <td>
                            <span className="agingpill"
                                  style={{ background: b ? `${b.band}33` : undefined,
                                           color: b?.ink }}>
                              {b?.label ?? inv.bucket}
                            </span>
                          </td>
                          <td className="r">{money(inv.grossTotal)}</td>
                          <td className="r"><strong>{money(inv.outstanding)}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>Total</td>
                      <td className="r">{money(partner.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
