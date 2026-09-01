import Link from "next/link";
import { getCompany, getOpenPurchaseOrders } from "@/lib/queries";
import { createGoodsReceipt } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";

export default async function Receive() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const openLines = await getOpenPurchaseOrders(company.id);

  const orders = new Map<string, {
    orderId: string; orderNo: string; partnerId: string; partnerName: string; locationId: string;
    lines: { lineId: string; itemId: string; itemCode: string; itemName: string; remainingQty: number; expectedPrice: number }[];
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
      remainingQty: Number(r.remaining_qty), expectedPrice: Number(r.expected_price ?? 0),
    });
  }

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
        [...orders.values()].map((o) => (
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
    </>
  );
}
