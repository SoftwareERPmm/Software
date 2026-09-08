import Link from "next/link";
import { PackageCheck, Clock, Boxes } from "lucide-react";
import { money, shortDate } from "@/lib/db";
import { getCompany, getOpenPurchaseOrders, getGoodsReceiptHistory } from "@/lib/queries";
import { createGoodsReceipt } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";
import { DataTable, type DataRow } from "@/components/data-table";

type Receipt = {
  id: string; doc_no: string | null; doc_date: string; status: string;
  gross_total: string; partner_id: string | null; partner_name: string | null;
  location_code: string | null; source_id: string | null;
  source_no: string | null; source_type: string | null;
  line_count: number; grir_open: string;
};

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const COLUMNS = [
  { key: "doc_no", label: "Receipt", sortable: true },
  { key: "doc_date", label: "Received", sortable: true },
  { key: "partner_name", label: "Supplier", sortable: true },
  { key: "location_code", label: "Warehouse", sortable: true },
  { key: "source_no", label: "Against", sortable: true },
  { key: "line_count", label: "Lines", sortable: true, align: "r" as const },
  { key: "gross_total", label: "Value", sortable: true, align: "r" as const },
  { key: "billed", label: "Supplier invoice", sortable: true },
];

export default async function Receive({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [openLines, history] = await Promise.all([
    getOpenPurchaseOrders(company.id),
    getGoodsReceiptHistory(company.id) as unknown as Promise<Receipt[]>,
  ]);

  const orders = new Map<string, {
    orderId: string; orderNo: string; partnerId: string; partnerName: string; locationId: string;
    lines: { lineId: string; itemId: string; itemCode: string; itemName: string;
             uomCode: string; remainingQty: number; expectedPrice: number }[];
  }>();
  for (const r of openLines as any[]) {
    if (!orders.has(r.order_id)) {
      orders.set(r.order_id, {
        orderId: r.order_id, orderNo: r.order_no, partnerId: r.partner_id,
        partnerName: r.partner_name, locationId: r.location_id, lines: [],
      });
    }
    orders.get(r.order_id)!.lines.push({
      lineId: r.line_id, itemId: r.item_id, itemCode: r.item_code, itemName: r.item_name,
      uomCode: r.uom_code, remainingQty: Number(r.remaining_qty), expectedPrice: Number(r.expected_price ?? 0),
    });
  }

  // Received and not yet billed: the clearing balance itself, so the figure on
  // screen and the one in GR/IR Clearing cannot disagree.
  const posted = history.filter((r) => r.status === "POSTED");
  const awaiting = posted.filter((r) => Number(r.grir_open) !== 0);
  const awaitingValue = awaiting.reduce((s, r) => s + Math.abs(Number(r.grir_open)), 0);
  const receivedValue = posted.reduce((s, r) => s + Number(r.gross_total), 0);

  const rows: DataRow[] = history.map((r) => {
    const open = Number(r.grir_open) !== 0;
    const voided = r.status !== "POSTED";
    return {
      key: r.id,
      searchText: [r.doc_no, r.partner_name, r.source_no, r.location_code]
        .filter(Boolean).join(" "),
      sort: {
        doc_no: r.doc_no ?? "",
        doc_date: toTime(r.doc_date),
        partner_name: r.partner_name ?? "",
        location_code: r.location_code ?? "",
        source_no: r.source_no ?? "",
        line_count: r.line_count,
        gross_total: Number(r.gross_total),
        billed: voided ? 2 : open ? 1 : 0,
      },
      node: (
        <tr className="link">
          <td className="code">
            <Link href={`/documents/${r.id}`} style={{ color: "var(--brand)" }}>
              {r.doc_no ?? "draft"}
            </Link>
          </td>
          <td className="code">{shortDate(r.doc_date)}</td>
          <td className="wrap">{r.partner_name ?? "—"}</td>
          <td className="code">{r.location_code ?? "—"}</td>
          <td className="code">
            {r.source_no ? (
              <Link href={`/documents/${r.source_id}`} style={{ color: "inherit" }}>
                {r.source_no}
              </Link>
            ) : (
              <span style={{ color: "var(--muted)" }}>no order</span>
            )}
          </td>
          <td className="r">{r.line_count}</td>
          <td className="r">{money(r.gross_total)}</td>
          <td>
            {voided ? (
              <span className="pill draft">Voided</span>
            ) : open ? (
              <Link href={`/purchases/new?goods_receipt_id=${r.id}`}>
                <span className="pill warn">Awaiting · {money(Math.abs(Number(r.grir_open)))}</span>
              </Link>
            ) : (
              <span className="pill ok">Billed</span>
            )}
          </td>
        </tr>
      ),
    };
  });

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Goods receipts</h1>
        <span className="page-sub">
          Record goods as they physically arrive, against an open purchase
          order. The supplier&rsquo;s invoice can come before or after — it
          doesn&rsquo;t have to line up with the day the goods show up.
        </span>
      </div>

      <div className="actions" style={{ marginBottom: "1.5rem" }}>
        <Link href="/purchases/receive/new" className="btn ghost">+ Receive goods (no PO)</Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label"><Boxes size={13} /> Waiting to arrive</span>
          <span className="kpi-value">{orders.size}</span>
          <span className="kpi-note">
            open purchase order{orders.size === 1 ? "" : "s"} with something still to receive
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><PackageCheck size={13} /> Received</span>
          <span className="kpi-value">{money(receivedValue)}</span>
          <span className="kpi-note">
            across {posted.length} posted receipt{posted.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><Clock size={13} /> Awaiting supplier invoice</span>
          <span className="kpi-value" style={{ color: awaiting.length > 0 ? "var(--warn)" : undefined }}>
            {money(awaitingValue)}
          </span>
          <span className="kpi-note">
            {awaiting.length} receipt{awaiting.length === 1 ? "" : "s"} sitting in GR/IR clearing
          </span>
        </div>
      </div>

      {orders.size === 0 ? (
        <div className="empty">
          No open purchase order to receive against.{" "}
          <Link href="/purchases/orders/new" style={{ color: "var(--brand)" }}>New purchase order</Link>
          {" "}to start one. If the goods have already arrived with no order
          behind them, use{" "}
          <Link href="/purchases/receive/new" style={{ color: "var(--brand)" }}>Receive goods</Link>
          {" "}above instead.
        </div>
      ) : (
        // Arrived from one order's own row or its document page: show that
        // order alone, rather than making someone find it again in the list.
        [...orders.values()]
          .filter((o) => !order || o.orderId === order)
          .map((o) => (
          <FulfillOrderForm
            key={o.orderId}
            kind="purchase"
            orderId={o.orderId}
            orderNo={o.orderNo}
            partnerName={o.partnerName}
            partnerId={o.partnerId}
            locationId={o.locationId}
            lines={o.lines}
            action={createGoodsReceipt}
          />
        ))
      )}

      {order && orders.size > 1 && (
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <Link href="/purchases/receive" className="btn ghost">
            Show all {orders.size} open orders
          </Link>
        </div>
      )}
      {order && !orders.has(order) && (
        <div className="empty">
          That order has nothing left to receive.{" "}
          <Link href="/purchases/receive" style={{ color: "var(--brand)" }}>
            See what is still open
          </Link>
        </div>
      )}

      <div className="card" style={{ marginTop: "1.5rem" }}>
        <div className="card-head">
          <h2>Received so far</h2>
          <span className="page-sub">
            Newest first. &ldquo;Awaiting&rdquo; is what the supplier has not
            billed yet — the receipt&rsquo;s own balance in GR/IR clearing.
          </span>
        </div>
        <div className="card-body">
          <DataTable
            rows={rows}
            columns={COLUMNS}
            searchPlaceholder="Search receipt no., supplier, order"
            defaultSort={{ key: "doc_date", dir: "desc" }}
            emptyLabel="Nothing has been received yet."
          />
        </div>
      </div>
    </>
  );
}
