import Link from "next/link";
import { shortDate } from "@/lib/db";
import { getCompany, getOpenSalesOrders, getPendingDeliveries, getStockByLocation } from "@/lib/queries";
import { sql } from "@/lib/db";
import { createDelivery, deliverPendingInvoice } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";
import { DeliverNowButton } from "@/components/deliver-now-button";

export default async function Deliver({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [openLines, pending, stockByLocation, focReasons] = await Promise.all([
    getOpenSalesOrders(company.id),
    getPendingDeliveries(company.id),
    getStockByLocation(company.id),
    // Why units might leave free — a delivery can carry a giveaway alongside
    // what was ordered, and the reason decides where its cost lands.
    sql`select id, code, name from foc_reason
         where company_id = ${company.id} order by code`,
  ]);

  const orders = new Map<string, {
    orderId: string; orderNo: string; partnerId: string; partnerName: string; locationId: string;
    lines: { lineId: string; itemId: string; itemCode: string; itemName: string;
             uomCode: string; remainingQty: number }[];
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
      uomCode: r.uom_code, remainingQty: Number(r.remaining_qty),
    });
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Deliveries</h1>
        <span className="page-sub">
          Where stock actually leaves. Fulfil an open sales order, or deliver
          against an invoice that was marked &ldquo;to deliver&rdquo;.
        </span>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Pending deliveries</h2>
            <span className="page-sub">{pending.length}</span>
          </div>
          {pending.length === 0 ? (
            <div className="empty">Nothing invoiced is waiting on delivery.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="r">Lines</th><th /></tr>
                </thead>
                <tbody>
                  {(pending as any[]).map((p) => (
                    <tr key={p.id}>
                      <td className="code">
                        <Link href={`/documents/${p.id}`} style={{ color: "var(--brand)" }}>{p.doc_no}</Link>
                      </td>
                      <td className="wrap">{p.partner_name}</td>
                      <td className="code">{shortDate(p.doc_date)}</td>
                      <td className="r">{p.lines}</td>
                      <td>
                        <DeliverNowButton invoiceId={p.id} action={deliverPendingInvoice} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <div className="page-head" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Open sales orders</h2>
        <Link href="/sales/deliver/new" className="btn">Deliver without an order</Link>
      </div>

      {orders.size === 0 ? (
        <div className="empty">
          Nothing outstanding.{" "}
          <Link href="/sales/orders/new" style={{ color: "var(--brand)" }}>New sales order</Link>
        </div>
      ) : (
        // Arrived from one order's own row or its document page: show that
        // order alone. The worklist is where you pick from everything open;
        // following a link from a particular order and then having to find it
        // again in the list is the step this parameter removes.
        [...orders.values()]
          .filter((o) => !order || o.orderId === order)
          .map((o) => (
          <FulfillOrderForm
            key={o.orderId}
            kind="sales"
            orderId={o.orderId}
            orderNo={o.orderNo}
            partnerName={o.partnerName}
            partnerId={o.partnerId}
            locationId={o.locationId}
            lines={o.lines}
            action={createDelivery}
            stockByLocation={stockByLocation as never}
            focReasons={focReasons as never}
          />
        ))
      )}

      {order && orders.size > 1 && (
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <Link href="/sales/deliver" className="btn ghost">
            Show all {orders.size} open orders
          </Link>
        </div>
      )}
      {order && !orders.has(order) && (
        <div className="empty">
          That order has nothing left to deliver.{" "}
          <Link href="/sales/deliver" style={{ color: "var(--brand)" }}>
            See what is still open
          </Link>
        </div>
      )}
    </>
  );
}
