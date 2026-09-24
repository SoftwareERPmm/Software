import Link from "next/link";
import { money, shortDate } from "@/lib/db";
import {
  invoiceDisplayStatus, INVOICE_STATUS_LABEL, INVOICE_STATUS_PILL,
  type InvoiceDisplayStatus,
} from "@/lib/format";
import { getCompany, getInvoiceList, getDocumentDrafts } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const TABS: Array<["" | InvoiceDisplayStatus, string]> = [
  ["", "All"],
  ["DRAFT", "Draft"],
  ["OPEN", "Posted"],
  ["PARTIALLY_PAID", "Partially Paid"],
  ["PAID", "Paid"],
  ["OVERDUE", "Overdue"],
];

export default async function SalesInvoices({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; customer?: string }>;
}) {
  const { status, customer } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const posted_ = (await getInvoiceList(company.id, "SALES_INVOICE")) as any[];

  /**
   * Unfinished vouchers, wearing the same shape as the rest of the list.
   *
   * They live in their own table rather than in `document` (see migration
   * 0103), so they are joined on here instead of coming back from the same
   * query. Nil paid and nil outstanding are the truth, not placeholders: a
   * draft has never been a receivable. The Draft tab has existed all along
   * and had nothing to show.
   */
  const drafts = (await getDocumentDrafts(company.id, "SALES_INVOICE")) as any[];
  const draftRows = drafts.map((d) => ({
    document_id: d.id, draft_id: d.id as string,
    doc_no: null, posting_date: d.doc_date, due_date: null,
    partner_id: null, partner_code: d.partner_code,
    partner_name: d.partner_name ?? "No customer yet",
    gross_total: d.total, paid: 0, outstanding: 0,
    doc_status: "DRAFT", payment_status: null, days_overdue: null,
    line_count: Number(d.line_count ?? 0),
  }));

  const all = [...draftRows, ...posted_];

  const withStatus = all.map((r) => ({
    ...r,
    display: invoiceDisplayStatus({
      docStatus: r.doc_status, paymentStatus: r.payment_status,
      outstanding: r.outstanding, daysOverdue: r.days_overdue,
    }),
  }));

  // A draft has no partner_id on the row, so filtering by customer hides
  // them — which is right: that view is "this customer's invoices", and an
  // unposted one is not yet anybody's.
  const forCustomer = customer ? withStatus.filter((r) => r.partner_id === customer) : withStatus;
  const invoices = status ? forCustomer.filter((r) => r.display === status) : forCustomer;

  // Only what actually posted counts toward the KPIs — a draft or a
  // cancelled invoice was never a real receivable.
  const posted = forCustomer.filter((r) => r.doc_status === "POSTED");
  const totalInvoiced = posted.reduce((s, r) => s + Number(r.gross_total), 0);
  const totalOutstanding = posted.reduce((s, r) => s + Number(r.outstanding), 0);
  const totalOverdue = posted
    .filter((r) => r.display === "OVERDUE")
    .reduce((s, r) => s + Number(r.outstanding), 0);
  const totalPaid = posted.reduce((s, r) => s + Number(r.paid), 0);

  const customerName = customer ? forCustomer[0]?.partner_name : null;

  const rows: DataRow[] = invoices.map((i) => ({
    key: i.document_id,
    searchText: [i.doc_no, i.partner_name].filter(Boolean).join(" "),
    sort: {
      doc_no: i.doc_no ?? "",
      posting_date: toTime(i.posting_date),
      due_date: toTime(i.due_date),
      partner_name: i.partner_name ?? "",
      gross_total: Number(i.gross_total),
      paid: Number(i.paid),
      outstanding: Number(i.outstanding),
      display: INVOICE_STATUS_LABEL[i.display as InvoiceDisplayStatus],
    },
    node: (
      <tr className="link">
        <td className="code">
          {/* A draft has no document to open — the link goes back to the
              form it came out of, which is the only thing you can do with
              one. */}
          <Link href={i.draft_id ? `/sales/new?draft=${i.draft_id}` : `/documents/${i.document_id}`}
                style={{ color: "var(--brand)" }}>
            {i.doc_no ?? "Resume"}
          </Link>
        </td>
        <td className="code">{shortDate(i.posting_date)}</td>
        <td className="code">{i.due_date ? shortDate(i.due_date) : "—"}</td>
        <td className="wrap">
          {i.draft_id ? (
            <>
              {i.partner_name}
              <div className="subline">
                {i.line_count === 1 ? "1 line" : `${i.line_count} lines`} · not posted
              </div>
            </>
          ) : (
            <Link href={`/sales/invoices?customer=${i.partner_id}`} style={{ color: "inherit" }}>
              {i.partner_name}
            </Link>
          )}
        </td>
        <td className="r">{money(i.gross_total)}</td>
        <td className="r">{money(i.paid)}</td>
        <td className="r">{money(i.outstanding)}</td>
        <td>
          <span className={`pill ${INVOICE_STATUS_PILL[i.display as InvoiceDisplayStatus]}`}>
            {INVOICE_STATUS_LABEL[i.display as InvoiceDisplayStatus]}
          </span>
        </td>
        <td className="tight">
          {i.doc_status === "POSTED" && Number(i.outstanding) > 0 && (
            <Link href={`/receivables/receive?partner=${i.partner_id}&invoice=${i.document_id}`} className="btn ghost tiny">
              Receive
            </Link>
          )}
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Sales Invoices</h1>
        <HelpHint>
          {customerName ? (
            <>
              Filtered to <strong>{customerName}</strong>.{" "}
              <Link href="/sales/invoices" style={{ color: "var(--brand)" }}>Clear</Link>
            </>
          ) : (
            "Manage sales invoices."
          )}
        </HelpHint>
      </div>

      <div className="actions">
        <Link href="/sales/new" className="btn">+ New Sales Invoice</Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total Invoiced</span>
          <span className="kpi-value">{money(totalInvoiced)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Outstanding</span>
          <span className="kpi-value">{money(totalOutstanding)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Overdue</span>
          <span className="kpi-value" style={{ color: totalOverdue > 0 ? "var(--bad)" : undefined }}>
            {money(totalOverdue)}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Paid</span>
          <span className="kpi-value">{money(totalPaid)}</span>
        </div>
      </div>

      <div className="flow">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={
              (value ? `/sales/invoices?status=${value}` : "/sales/invoices") +
              (customer && value ? `&customer=${customer}` : customer ? `?customer=${customer}` : "")
            }
            className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{TABS.find(([v]) => v === (status ?? ""))?.[1] ?? "All"}</h2>
            <span className="page-sub">{invoices.length} invoice{invoices.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No sales invoices"
            searchPlaceholder="Search invoices…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Invoice #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "due_date", label: "Due Date", sortable: true },
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "gross_total", label: "Total", sortable: true, align: "r" },
              { key: "paid", label: "Paid", sortable: true, align: "r" },
              { key: "outstanding", label: "Balance", sortable: true, align: "r" },
              { key: "display", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
