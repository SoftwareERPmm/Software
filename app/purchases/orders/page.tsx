import Link from "next/link";
import { money, shortDate } from "@/lib/db";
import {
  orderDisplayStatus, ORDER_STATUS_LABEL, ORDER_STATUS_PILL,
  type OrderDisplayStatus,
} from "@/lib/format";
import { getCompany, getOrderList, getDocumentDrafts } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

/**
 * "Overdue" is not one of the fulfilment statuses and cannot be: it is an
 * open order whose own Needed-by date has passed, which is a fact about the
 * date, not about the goods. It sits here as a filter beside them because
 * that is what someone is looking for when the dashboard says two orders are
 * overdue and they want to know which two.
 */
const OVERDUE = "overdue";

const TABS: Array<["" | OrderDisplayStatus | typeof OVERDUE, string]> = [
  ["", "All"],
  ["DRAFT", "Draft"],
  ["OPEN", "Open"],
  ["PARTIALLY_FULFILLED", "Partially Fulfilled"],
  [OVERDUE, "Overdue"],
  ["FULFILLED", "Fulfilled"],
];

/** Still owed something, and the date it was wanted by has gone. */
const isOverdue = (r: { display: string; due_date: unknown }) =>
  (r.display === "OPEN" || r.display === "PARTIALLY_FULFILLED")
  && r.due_date != null
  && new Date(String(r.due_date)) < new Date(new Date().toDateString());

export default async function PurchaseOrders({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const saved = (await getOrderList(company.id, "PURCHASE_ORDER")) as any[];

  /**
   * Unfinished orders, in the same shape as the rest of the list.
   *
   * They live in their own table rather than in `document` (migration 0103),
   * so they are joined on here. Nil ordered and nil fulfilled are the truth,
   * not placeholders: nothing has been promised to anybody yet, which is why
   * the Draft pill has always existed and never had a row.
   */
  const drafts = (await getDocumentDrafts(company.id, "PURCHASE_ORDER")) as any[];
  const draftRows = drafts.map((d) => ({
    document_id: d.id, id: d.id, draft_id: d.id as string,
    doc_no: null, posting_date: d.doc_date, due_date: null,
    partner_id: null, partner_name: d.partner_name ?? "Nobody chosen yet",
    gross_total: d.total, ordered_qty: 0, fulfilled_qty: 0,
    doc_status: "DRAFT", line_count: Number(d.line_count ?? 0),
  }));

  const all = [...draftRows, ...saved];

  const withStatus = all.map((r) => ({
    ...r,
    display: orderDisplayStatus({
      docStatus: r.doc_status, orderedQty: r.ordered_qty, fulfilledQty: r.fulfilled_qty,
    }),
  }));

  const orders =
    status === OVERDUE ? withStatus.filter(isOverdue)
    : status ? withStatus.filter((r) => r.display === status)
    : withStatus;
  const openCount = withStatus.filter((r) => r.display === "OPEN" || r.display === "PARTIALLY_FULFILLED").length;

  const rows: DataRow[] = orders.map((o) => ({
    key: o.document_id,
    searchText: [o.doc_no, o.partner_name].filter(Boolean).join(" "),
    sort: {
      doc_no: o.doc_no ?? "",
      posting_date: toTime(o.posting_date),
      partner_name: o.partner_name ?? "",
      due_date: toTime(o.due_date),
      gross_total: Number(o.gross_total),
      display: ORDER_STATUS_LABEL[o.display as OrderDisplayStatus],
    },
    node: (
      <tr className="link">
        <td className="code">
          {/* A draft has no document to open — the link goes back to the
              form it came out of. */}
          <Link href={o.draft_id ? `/purchases/orders/new?draft=${o.draft_id}` : `/documents/${o.document_id}`}
                style={{ color: "var(--brand)" }}>
            {o.doc_no ?? "Resume"}
          </Link>
        </td>
        <td className="code">{shortDate(o.posting_date)}</td>
        <td className="wrap">
          {o.partner_name}
          {o.draft_id && (
            <div className="subline">
              {o.line_count === 1 ? "1 line" : `${o.line_count} lines`} · not saved yet
            </div>
          )}
        </td>
        {/* Why an order is overdue is a date, so the date is on the row.
            Marked where it has passed with something still outstanding —
            the same test the Overdue filter and the dashboard count use. */}
        <td className="code" style={isOverdue(o) ? { color: "var(--warn)", fontWeight: 600 } : undefined}>
          {o.due_date ? shortDate(o.due_date) : "—"}
        </td>
        <td className="r">{money(o.gross_total)}</td>
        <td>
          {/* Overdue overrides the fulfilment pill rather than sitting beside
              it — the same fact isOverdue() already colours the due date
              with, read once and shown consistently in both places. */}
          <span className={`pill ${isOverdue(o) ? "pill-status-overdue"
            : ORDER_STATUS_PILL[o.display as OrderDisplayStatus]}`}>
            {isOverdue(o) ? "Overdue" : ORDER_STATUS_LABEL[o.display as OrderDisplayStatus]}
          </span>
        </td>
        <td className="tight">
          {/* document_id, not id — see the sales list: getOrderList returns
              `o.id as document_id` and no `id`, so this sent every Receive
              click to ?order=undefined. */}
          {(o.display === "OPEN" || o.display === "PARTIALLY_FULFILLED") && (
            <Link href={`/purchases/receive?order=${o.document_id}`} className="btn ghost tiny">Receive</Link>
          )}
        </td>
      </tr>
    ),
  }));

  return (
    <div className="orders-page">
      {/* Title, actions and status tabs share one compact band instead of
          three separately-spaced blocks — see the .orders-head rule for why. */}
      <div className="orders-head">
        <div className="orders-head-row">
          <div className="page-head">
            <span className="eyebrow">Purchases</span>
            <h1>Purchase Orders</h1>
            <HelpHint>
              What has been ordered from suppliers. An order posts nothing on its
              own — stock and payables move on the goods receipt and invoice that follow it.
            </HelpHint>
          </div>

          {/* The primary action sits rightmost and stays there whether or
              not the awaiting-receipt chip is present, rather than shifting
              position depending on the day's data. */}
          <div className="actions">
            {openCount > 0 && (
              <Link href="/purchases/receive" className="btn ghost">{openCount} awaiting receipt</Link>
            )}
            <Link href="/purchases/orders/new" className="btn">+ New Purchase Order</Link>
          </div>
        </div>

        <div className="flow">
          {TABS.map(([value, label]) => (
            <Link
              key={value}
              href={value ? `/purchases/orders?status=${value}` : "/purchases/orders"}
              className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{TABS.find(([v]) => v === (status ?? ""))?.[1] ?? "All"}</h2>
            <span className="page-sub">{orders.length} order{orders.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No purchase orders"
            searchPlaceholder="Search orders…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "doc_no", label: "Order #", sortable: true },
              { key: "posting_date", label: "Date", sortable: true },
              { key: "partner_name", label: "Supplier", sortable: true },
              { key: "due_date", label: "Needed by", sortable: true },
              { key: "gross_total", label: "Total", sortable: true, align: "r" },
              { key: "display", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
