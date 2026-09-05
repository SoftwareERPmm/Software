import Link from "next/link";
import { money, shortDate } from "@/lib/db";
import {
  orderDisplayStatus, ORDER_STATUS_LABEL, ORDER_STATUS_PILL,
  type OrderDisplayStatus,
} from "@/lib/format";
import { getCompany, getOrderList } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const TABS: Array<["" | OrderDisplayStatus, string]> = [
  ["", "All"],
  ["DRAFT", "Draft"],
  ["OPEN", "Open"],
  ["PARTIALLY_FULFILLED", "Partially Fulfilled"],
  ["FULFILLED", "Fulfilled"],
  ["CANCELLED", "Cancelled"],
];

export default async function SalesOrders({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const all = (await getOrderList(company.id, "SALES_ORDER")) as any[];

  const withStatus = all.map((r) => ({
    ...r,
    display: orderDisplayStatus({
      docStatus: r.doc_status, orderedQty: r.ordered_qty, fulfilledQty: r.fulfilled_qty,
    }),
  }));

  const orders = status ? withStatus.filter((r) => r.display === status) : withStatus;
  const openCount = withStatus.filter((r) => r.display === "OPEN" || r.display === "PARTIALLY_FULFILLED").length;

  const rows: DataRow[] = orders.map((o) => ({
    key: o.document_id,
    searchText: [o.doc_no, o.partner_name].filter(Boolean).join(" "),
    sort: {
      doc_no: o.doc_no ?? "",
      posting_date: toTime(o.posting_date),
      partner_name: o.partner_name ?? "",
      gross_total: Number(o.gross_total),
      display: ORDER_STATUS_LABEL[o.display as OrderDisplayStatus],
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/documents/${o.document_id}`} style={{ color: "var(--brand)" }}>
            {o.doc_no ?? "draft"}
          </Link>
        </td>
        <td className="code">{shortDate(o.posting_date)}</td>
        <td className="wrap">{o.partner_name}</td>
        <td className="r">{money(o.gross_total)}</td>
        <td>
          <span className={`pill ${ORDER_STATUS_PILL[o.display as OrderDisplayStatus]}`}>
            {ORDER_STATUS_LABEL[o.display as OrderDisplayStatus]}
          </span>
        </td>
        <td className="tight">
          {(o.display === "OPEN" || o.display === "PARTIALLY_FULFILLED") && (
            <Link href={`/sales/deliver?order=${o.id}`} className="btn ghost tiny">Deliver</Link>
          )}
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Sales Orders</h1>
        <span className="page-sub">
          What customers have committed to buy. An order posts nothing on its
          own — stock and revenue move on the delivery and invoice that follow it.
        </span>
      </div>

      <div className="actions">
        <Link href="/sales/orders/new" className="btn">+ New Sales Order</Link>
        {openCount > 0 && (
          <Link href="/sales/deliver" className="btn ghost">{openCount} awaiting delivery</Link>
        )}
      </div>

      <div className="flow">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/sales/orders?status=${value}` : "/sales/orders"}
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
            <span className="page-sub">{orders.length} order{orders.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No sales orders"
            searchPlaceholder="Search orders…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Order #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "gross_total", label: "Total", sortable: true, align: "r" },
              { key: "display", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
