import Link from "next/link";
import { money, shortDate } from "@/lib/db";
import {
  invoiceDisplayStatus, INVOICE_STATUS_LABEL, INVOICE_STATUS_PILL,
  type InvoiceDisplayStatus,
} from "@/lib/format";
import { getCompany, getInvoiceList } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const TABS: Array<["" | InvoiceDisplayStatus, string]> = [
  ["", "All"],
  ["DRAFT", "Draft"],
  ["OPEN", "Posted"],
  ["PARTIALLY_PAID", "Partially Paid"],
  ["PAID", "Paid"],
  ["OVERDUE", "Overdue"],
  ["CANCELLED", "Cancelled"],
];

export default async function PurchaseInvoices({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; supplier?: string }>;
}) {
  const { status, supplier } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const all = (await getInvoiceList(company.id, "PURCHASE_INVOICE")) as any[];

  const withStatus = all.map((r) => ({
    ...r,
    display: invoiceDisplayStatus({
      docStatus: r.doc_status, paymentStatus: r.payment_status,
      outstanding: r.outstanding, daysOverdue: r.days_overdue,
    }),
  }));

  const forSupplier = supplier ? withStatus.filter((r) => r.partner_id === supplier) : withStatus;
  const invoices = status ? forSupplier.filter((r) => r.display === status) : forSupplier;

  const posted = forSupplier.filter((r) => r.doc_status === "POSTED");
  const totalBilled = posted.reduce((s, r) => s + Number(r.gross_total), 0);
  const totalOutstanding = posted.reduce((s, r) => s + Number(r.outstanding), 0);
  const totalOverdue = posted
    .filter((r) => r.display === "OVERDUE")
    .reduce((s, r) => s + Number(r.outstanding), 0);
  const totalPaid = posted.reduce((s, r) => s + Number(r.paid), 0);

  const supplierName = supplier ? forSupplier[0]?.partner_name : null;

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
          <Link href={`/documents/${i.document_id}`} style={{ color: "var(--brand)" }}>
            {i.doc_no ?? "draft"}
          </Link>
        </td>
        <td className="code">{shortDate(i.posting_date)}</td>
        <td className="code">{i.due_date ? shortDate(i.due_date) : "—"}</td>
        <td className="wrap">
          <Link href={`/purchases/invoices?supplier=${i.partner_id}`} style={{ color: "inherit" }}>
            {i.partner_name}
          </Link>
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
            <Link href={`/payables/pay?partner=${i.partner_id}&invoice=${i.document_id}`} className="btn ghost tiny">
              Pay
            </Link>
          )}
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Purchase Invoices</h1>
        <span className="page-sub">
          {supplierName ? (
            <>
              Filtered to <strong>{supplierName}</strong>.{" "}
              <Link href="/purchases/invoices" style={{ color: "var(--brand)" }}>Clear</Link>
            </>
          ) : (
            "Manage purchase invoices."
          )}
        </span>
      </div>

      <div className="actions">
        <Link href="/purchases/new" className="btn">+ New Purchase Invoice</Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total Billed</span>
          <span className="kpi-value">{money(totalBilled)}</span>
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
              (value ? `/purchases/invoices?status=${value}` : "/purchases/invoices") +
              (supplier && value ? `&supplier=${supplier}` : supplier ? `?supplier=${supplier}` : "")
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
            emptyLabel="No purchase invoices"
            searchPlaceholder="Search invoices…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Invoice #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "due_date", label: "Due Date", sortable: true },
              { key: "partner_name", label: "Supplier", sortable: true },
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
