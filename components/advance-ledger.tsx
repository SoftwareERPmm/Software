import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { DataTable, type DataRow } from "@/components/data-table";
import type { AdvanceRow } from "@/lib/queries";
import { RefundAdvance } from "@/components/refund-advance";

type State = "unapplied" | "partial" | "spent" | "refunded";

/* The four things that can have happened to an advance. Applying and
   refunding draw on the same balance, so an advance closed by a refund is
   told apart from one closed by bills — otherwise money handed back reads
   as money spent against invoices. */
const TABS: Array<["" | State, string]> = [
  ["", "All"],
  ["unapplied", "Unapplied"],
  ["partial", "Partly applied"],
  ["spent", "Fully applied"],
  ["refunded", "Refunded"],
];

/**
 * Every advance, and what became of it.
 *
 * The dashboard says how much is on account and the apply panel offers what
 * is left of it, but neither can answer the question somebody actually asks
 * about a deposit: how much was taken, how much of it has gone, and against
 * which bills. A fully spent advance had left the app altogether — the view
 * those screens read drops an advance the moment nothing is left of it, which
 * is right for offering money to spend and wrong for accounting for money
 * already spent.
 *
 * So each advance keeps its row after it is spent, with its applications
 * underneath: the invoice each went to, the application that did it, and the
 * date. Nothing here is stored — taken is the document, applied is the sum of
 * allocations that still stand, refunded is the posted refunds, and what is
 * left is taken less both.
 */
export function AdvanceLedger({
  side, advances, status, cashAccounts, today,
}: {
  side: "CUSTOMER" | "SUPPLIER";
  advances: AdvanceRow[];
  status?: string;
  /** Where a refund can be paid from or received into. */
  cashAccounts: { id: string; code: string; name: string }[];
  today: string;
}) {
  const sales = side === "CUSTOMER";
  const base = sales ? "/receivables/advances" : "/payables/advances";
  const who = sales ? "Customer" : "Supplier";

  const state = (r: AdvanceRow): State =>
    r.remaining > 0.0001
      ? (r.applied > 0.0001 || r.refunded > 0.0001 ? "partial" : "unapplied")
      : r.refunded > 0.0001 ? "refunded" : "spent";
  const shown = status ? advances.filter((r) => state(r) === status) : advances;

  const onAccount = advances.reduce((s, r) => s + r.remaining, 0);
  const taken = advances.reduce((s, r) => s + r.taken, 0);
  const applied = advances.reduce((s, r) => s + r.applied, 0);
  const refunded = advances.reduce((s, r) => s + r.refunded, 0);

  const rows: DataRow[] = shown.map((r) => ({
    key: r.id,
    searchText: [r.doc_no, r.partner_code, r.partner_name,
      ...r.applications.map((a) => `${a.invoice_no} ${a.application_no ?? ""}`)]
      .filter(Boolean).join(" "),
    sort: {
      doc_date: r.doc_date,
      partner_name: r.partner_name ?? "",
      taken: r.taken,
      applied: r.applied,
      refunded: r.refunded,
      remaining: r.remaining,
    },
    csv: {
      doc_date: r.doc_date,
      doc_no: r.doc_no,
      partner_code: r.partner_code,
      partner_name: r.partner_name,
      branch: r.branch ?? "",
      taken: r.taken,
      applied: r.applied,
      refunded: r.refunded,
      remaining: r.remaining,
      state: state(r),
    },
    node: (
      <>
        <tr>
          <td className="m">{shortDate(r.doc_date)}</td>
          <td className="m">
            <Link href={`/documents/${r.id}`}>{r.doc_no}</Link>
          </td>
          <td className="wrap">
            <strong>{r.partner_name}</strong>
            <div className="m" style={{ color: "var(--muted)" }}>
              {r.partner_code}{r.branch ? ` · ${r.branch}` : ""}
            </div>
          </td>
          <td className="r">{money(r.taken)}</td>
          <td className="r">{r.applied > 0 ? money(r.applied) : "—"}</td>
          <td className="r">{r.refunded > 0 ? money(r.refunded) : "—"}</td>
          <td className="r">
            {r.remaining > 0.0001
              ? <strong>{money(r.remaining)}</strong>
              : <span style={{ color: "var(--muted)" }}>nothing left</span>}
          </td>
          <td className="r">
            {r.remaining > 0.0001 && (
              <RefundAdvance paymentId={r.id} remaining={r.remaining}
                customer={sales} cashAccounts={cashAccounts} today={today} />
            )}
          </td>
        </tr>
        {/* Where it went, under the money it came from — so the two are read
            together rather than as a row and a number that has to be
            reconciled by hand. */}
        {r.applications.map((a) => (
          <tr key={a.invoice_id + (a.application_id ?? "")} className="adv-applied">
            <td />
            <td colSpan={3}>
              <span className="adv-mark" aria-hidden="true">↳</span>
              <span className="adv-when">{shortDate(a.applied_on)}</span>
              {a.application_no
                ? <>
                    {" "}
                    <Link href={`/documents/${a.application_id}`} className="m">
                      {a.application_no}
                    </Link>
                  </>
                : <span className="adv-note"> allocated when taken</span>}
              {" → "}
              <Link href={`/documents/${a.invoice_id}`} className="m">{a.invoice_no}</Link>
            </td>
            <td className="r">{money(a.amount)}</td>
            <td />
            <td />
            <td />
          </tr>
        ))}
        {/* And what was handed back, under the same money. */}
        {r.refunds.map((f) => (
          <tr key={f.id} className="adv-applied">
            <td />
            <td colSpan={3}>
              <span className="adv-mark" aria-hidden="true">↳</span>
              <span className="adv-when">{shortDate(f.doc_date)}</span>{" "}
              <Link href={`/documents/${f.id}`} className="m">{f.doc_no}</Link>
              <span className="adv-note"> {sales ? "refunded to the customer" : "returned by the supplier"}</span>
            </td>
            <td />
            <td className="r">{money(f.amount)}</td>
            <td />
            <td />
          </tr>
        ))}
      </>
    ),
  }));

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">On account</span>
          <span className="kpi-value">{money(onAccount)}</span>
          <span className="kpi-note">
            {sales ? "held for customers" : "paid ahead to suppliers"}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{sales ? "Taken" : "Paid"} in all</span>
          <span className="kpi-value">{money(taken)}</span>
          <span className="kpi-note">{advances.length} advance{advances.length === 1 ? "" : "s"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Applied to bills</span>
          <span className="kpi-value">{money(applied)}</span>
          <span className="kpi-note">
            {taken > 0 ? `${Math.round((applied / taken) * 100)}% of it` : "none yet"}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{sales ? "Refunded" : "Returned to us"}</span>
          <span className="kpi-value">{money(refunded)}</span>
          <span className="kpi-note">
            {refunded > 0 ? (sales ? "handed back to customers" : "deposits returned") : "none"}
          </span>
        </div>
      </div>

      <div className="flow">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `${base}?status=${value}` : base}
            className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{who} advances</h2>
            <span className="actions">
              <span className="page-sub">{shown.length} shown</span>
              <Link href={sales ? "/receivables/receive" : "/payables/pay"} className="btn">
                {sales ? "Receive payment" : "Pay supplier"}
              </Link>
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel={
              status === "spent" ? "None fully applied yet"
                : status === "refunded" ? "Nothing refunded"
                : status === "partial" ? "Nothing partly applied"
                : status === "unapplied" ? "Nothing unapplied"
                  : `No ${sales ? "customer" : "supplier"} advances yet`
            }
            searchPlaceholder={`Search ${sales ? "customers" : "suppliers"}, documents…`}
            defaultSort={{ key: "doc_date", dir: "desc" }}
            columns={[
              { key: "doc_date", label: "Date", sortable: true },
              { key: "doc_no", label: "Document" },
              { key: "partner_name", label: who, sortable: true },
              { key: "taken", label: sales ? "Taken" : "Paid", sortable: true, align: "r" },
              { key: "applied", label: "Applied", sortable: true, align: "r" },
              { key: "refunded", label: "Refunded", sortable: true, align: "r" },
              { key: "remaining", label: "Left", sortable: true, align: "r" },
              { key: "action", label: "" },
            ]}
            footer={
              <tr>
                <td colSpan={3}>Total</td>
                <td className="r">{money(taken)}</td>
                <td className="r">{money(applied)}</td>
                <td className="r">{money(refunded)}</td>
                <td className="r">{money(onAccount)}</td>
                <td />
              </tr>
            }
          />
        </div>
      </section>
    </>
  );
}
