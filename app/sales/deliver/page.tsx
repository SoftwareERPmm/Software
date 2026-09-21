import Link from "next/link";
import { Truck, FileText, Clock, Plus } from "lucide-react";
import { money, shortDate } from "@/lib/db";
import {
  getCompany, getOpenSalesOrders, getPendingDeliveries, getStockByLocation,
  getDeliveryHistory, getOpenDeliveries,
} from "@/lib/queries";
import { sql } from "@/lib/db";
import { createDelivery, deliverPendingInvoice } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";
import { DeliverNowButton } from "@/components/deliver-now-button";
import { DataTable, type DataRow } from "@/components/data-table";
import {
  ErpBackCrumb, ErpPageHead, ErpSection, ErpSummary, type Summary,
} from "@/components/erp-worklist";

type Delivery = {
  id: string; doc_no: string | null; doc_date: string; status: string;
  gross_total: string; partner_name: string | null; location_code: string | null;
  source_id: string | null; source_no: string | null;
  line_count: number;
};

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

export default async function Deliver({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; open?: string }>;
}) {
  const { order, open } = await searchParams;
  /**
   * Only the deliveries that have gone out and never been billed.
   *
   * The dashboard counts these because they are goods given away: stock left,
   * cost of sale was booked, and no receivable was ever raised — so the
   * customer owes nothing, appears on no aging report, and nothing about the
   * books looks wrong. A count is only useful if clicking it lands on those
   * deliveries rather than on every delivery ever recorded.
   */
  const onlyUnbilled = open === "uninvoiced";
  /**
   * The mirror: invoices raised as “to deliver” whose goods never went out.
   * The customer owes the money and has nothing to show for it, which surfaces
   * as a complaint rather than as anything wrong in the ledger.
   */
  const onlyUndelivered = open === "undelivered";
  const focused = onlyUnbilled || onlyUndelivered;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [openLines, pending, stockByLocation, history, stillToBill, focReasons] = await Promise.all([
    getOpenSalesOrders(company.id),
    getPendingDeliveries(company.id),
    getStockByLocation(company.id),
    getDeliveryHistory(company.id) as unknown as Promise<Delivery[]>,
    // What each delivery still has to bill, read off the same function the
    // invoice form offers from — and which counts an invoice naming the
    // delivery as well as a delivery line naming the invoice. Either bills it.
    getOpenDeliveries(company.id, null) as unknown as Promise<{ id: string }[]>,
    // Why units might leave free — a delivery can carry a giveaway alongside
    // what was ordered, and the reason decides where its cost lands.
    sql`select id, code, name from foc_reason
         where company_id = ${company.id} order by code`,
  ]);

  const orders = new Map<string, {
    orderId: string; orderNo: string; partnerId: string; partnerName: string;
    locationId: string; locationCode: string | null; locationName: string | null;
    dueDate: string | null;
    lines: { lineId: string; itemId: string; itemCode: string; itemName: string;
             uomCode: string; remainingQty: number }[];
  }>();
  for (const r of openLines as any[]) {
    if (!orders.has(r.order_id)) {
      orders.set(r.order_id, {
        orderId: r.order_id, orderNo: r.order_no, partnerId: r.partner_id,
        partnerName: r.partner_name, locationId: r.location_id,
        locationCode: r.location_code ?? null, locationName: r.location_name ?? null,
        dueDate: r.due_date ? String(r.due_date) : null,
        lines: [],
      });
    }
    orders.get(r.order_id)!.lines.push({
      lineId: r.line_id, itemId: r.item_id, itemCode: r.item_code, itemName: r.item_name,
      uomCode: r.uom_code, remainingQty: Number(r.remaining_qty),
    });
  }

  const posted = history.filter((d) => d.status === "POSTED");
  const deliveredValue = posted.reduce((s, d) => s + Number(d.gross_total), 0);
  const unbilled = new Set(stillToBill.map((d) => d.id));
  const notInvoiced = posted.filter((d) => unbilled.has(d.id)).length;

  /**
   * One order asked for by name — from its own document page, or from the row
   * above. The reader has already chosen; showing them the worklist again and
   * making them find it is the step this removes.
   */
  const chosen = order ? orders.get(order) : undefined;

  if (order) {
    return (
      <div className="erp-page">
        <ErpBackCrumb
          listHref="/sales/deliver"
          listLabel="Deliveries"
          doc={chosen ? { id: chosen.orderId, docNo: chosen.orderNo } : null}
          here="Deliver goods"
        />

        {chosen ? (
          <>
            <ErpPageHead
              eyebrow="Sales"
              title={`Deliver against ${chosen.orderNo}`}
              lead={`${chosen.partnerName} · ${chosen.lines.length} order line${
                chosen.lines.length === 1 ? "" : "s"} awaiting delivery${
                chosen.locationName ? ` · ${chosen.locationName}` : ""}`}
              action={
                orders.size > 1 ? (
                  <Link href="/sales/deliver" className="erp-hbtn">
                    All {orders.size} open orders
                  </Link>
                ) : null
              }
            />
            <FulfillOrderForm
              kind="sales"
              defaultOpen
              orderId={chosen.orderId}
              orderNo={chosen.orderNo}
              partnerName={chosen.partnerName}
              partnerId={chosen.partnerId}
              locationId={chosen.locationId}
              lines={chosen.lines}
              action={createDelivery}
              stockByLocation={stockByLocation as never}
              focReasons={focReasons as never}
            />
          </>
        ) : (
          <div className="empty">
            That order has nothing left to deliver.{" "}
            <Link href="/sales/deliver" style={{ color: "var(--brand)" }}>
              See what is still open
            </Link>
          </div>
        )}
      </div>
    );
  }

  const awaiting: DataRow[] = [...orders.values()].map((o) => {
    const remaining = o.lines.reduce((s, l) => s + l.remainingQty, 0);
    const unit = o.lines[0]?.uomCode;
    const oneUnit = o.lines.every((l) => l.uomCode === unit);
    return {
      key: o.orderId,
      searchText: [o.orderNo, o.partnerName, o.locationCode].filter(Boolean).join(" "),
      facet: { warehouse: o.locationCode ?? "" },
      sort: {
        order_no: o.orderNo,
        partner_name: o.partnerName ?? "",
        due_date: toTime(o.dueDate),
        remaining,
      },
      node: (
        <tr>
          <td>
            <Link href={`/documents/${o.orderId}`} className="code"
                  style={{ color: "var(--brand)" }}>{o.orderNo}</Link>
            <span className="erp-row-sub">
              {o.lines.length} order line{o.lines.length === 1 ? "" : "s"} awaiting delivery
            </span>
          </td>
          <td className="wrap">{o.partnerName ?? "—"}</td>
          <td className="code">{o.dueDate ? shortDate(o.dueDate) : "—"}</td>
          <td className="wrap">{o.locationName ?? o.locationCode ?? "—"}</td>
          <td className="r">
            {/* The quantity itself. One number only when the lines share a
                unit — 40 CTN + 12 PCS is not 52 of anything. */}
            {oneUnit ? `${money(remaining)}${unit ? ` ${unit}` : ""}` : `${o.lines.length} lines`}
          </td>
          <td className="tight">
            <Link href={`/sales/deliver?order=${o.orderId}`} className="btn primary">
              Deliver goods
            </Link>
          </td>
        </tr>
      ),
    };
  });

  const warehouses = [...new Map(
    [...orders.values()]
      .filter((o) => o.locationCode)
      .map((o) => [o.locationCode!, o.locationName ?? o.locationCode!])
  ).entries()].map(([value, label]) => ({ value, label }));

  const shown = onlyUnbilled
    ? history.filter((d) => d.status === "POSTED" && unbilled.has(d.id))
    : history;

  const rows: DataRow[] = shown.map((d) => {
    const voided = d.status !== "POSTED";
    const short = unbilled.has(d.id);
    return {
      key: d.id,
      searchText: [d.doc_no, d.partner_name, d.source_no, d.location_code]
        .filter(Boolean).join(" "),
      facet: { status: voided ? "voided" : short ? "awaiting" : "invoiced" },
      sort: {
        doc_no: d.doc_no ?? "",
        doc_date: toTime(d.doc_date),
        partner_name: d.partner_name ?? "",
        location_code: d.location_code ?? "",
        source_no: d.source_no ?? "",
        gross_total: Number(d.gross_total),
        invoiced: voided ? 2 : short ? 1 : 0,
      },
      node: (
        <tr className="link">
          <td className="code">
            <Link href={`/documents/${d.id}`} style={{ color: "var(--brand)" }}>
              {d.doc_no ?? "draft"}
            </Link>
          </td>
          <td className="code">{shortDate(d.doc_date)}</td>
          <td className="wrap">{d.partner_name ?? "—"}</td>
          <td className="code">{d.location_code ?? "—"}</td>
          <td className="code">
            {d.source_no ? (
              <Link href={`/documents/${d.source_id}`} style={{ color: "inherit" }}>
                {d.source_no}
              </Link>
            ) : (
              <span style={{ color: "var(--muted)" }}>no order</span>
            )}
          </td>
          <td className="r">{money(d.gross_total)}</td>
          <td>
            {voided ? (
              <span className="pill draft">Voided</span>
            ) : short ? (
              <span className="pill warn">Awaiting invoice</span>
            ) : (
              <span className="pill ok">Fully invoiced</span>
            )}
          </td>
        </tr>
      ),
    };
  });

  const summary: Summary[] = [
    {
      icon: Truck,
      label: "Delivered value",
      value: `${company.base_currency} ${money(deliveredValue)}`,
      note: `${posted.length} posted deliver${posted.length === 1 ? "y" : "ies"}`,
    },
    {
      icon: FileText,
      label: "Awaiting sales invoice",
      value: String(notInvoiced),
      note: `deliver${notInvoiced === 1 ? "y" : "ies"} the customer has not been billed for`,
      tone: notInvoiced > 0 ? "warn" : undefined,
    },
    {
      icon: Clock,
      label: "Invoiced, not delivered",
      value: String(pending.length),
      note: `invoice${pending.length === 1 ? "" : "s"} marked “to deliver”`,
      tone: pending.length > 0 ? "warn" : undefined,
    },
  ];

  return (
    <div className="erp-page">
      <ErpPageHead
        eyebrow="Sales"
        title="Deliveries"
        lead={
          onlyUnbilled ? "One thing only: goods that went out and were never billed."
          : onlyUndelivered ? "One thing only: invoices whose goods never went out."
          : "Record stock leaving your warehouse."}
      />

      {!focused && (
        <ErpSection
          title="Sales orders awaiting delivery"
          count={orders.size}
          lead="Choose an order to record the quantities sent."
          action={
            <Link href="/sales/deliver/new" className="erp-hbtn">
              <Plus size={15} aria-hidden="true" /> Deliver without a sales order
            </Link>
          }
          foot={
            orders.size > 0
              ? <span>Check quantities against what is on hand before posting.</span>
              : undefined
          }
        >
          {orders.size === 0 ? (
            <div className="empty">
              Nothing outstanding.{" "}
              <Link href="/sales/orders/new" style={{ color: "var(--brand)" }}>New sales order</Link>
              {" "}to start one, or{" "}
              <Link href="/sales/deliver/new" style={{ color: "var(--brand)" }}>deliver without one</Link>
              {" "}if the goods have already gone.
            </div>
          ) : (
            <DataTable
              rows={awaiting}
              columns={[
                { key: "order_no", label: "Sales order", sortable: true },
                { key: "partner_name", label: "Customer", sortable: true },
                { key: "due_date", label: "Promised by", sortable: true },
                { key: "warehouse", label: "Warehouse" },
                { key: "remaining", label: "Remaining", sortable: true, align: "r" as const },
                { key: "action", label: "Action" },
              ]}
              filters={[{ key: "warehouse", allLabel: "All warehouses", options: warehouses }]}
              searchPlaceholder="Search SO number or customer"
              defaultSort={{ key: "due_date", dir: "asc" }}
              emptyLabel="No order matches that."
            />
          )}
        </ErpSection>
      )}

      {/* Invoices raised before the goods went out. The purchase side has no
          equivalent — a bill arriving before its goods is a GR/IR balance,
          not a queue of things to do — so this card is sales-only. */}
      {pending.length > 0 && !onlyUnbilled && (
        <ErpSection
          title={onlyUndelivered ? "Invoiced, not yet delivered" : "Invoiced, waiting on delivery"}
          count={pending.length}
          lead={onlyUndelivered
            ? "Billed and owed for, but the goods are still in the warehouse — the customer is paying for something they have not received."
            : "These were billed as “to deliver”. The stock has not left yet."}
          foot={onlyUndelivered
            ? <Link href="/sales/deliver">Show the whole deliveries page</Link>
            : undefined}
        >
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
                    <td className="tight">
                      <DeliverNowButton invoiceId={p.id} action={deliverPendingInvoice} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ErpSection>
      )}

      <ErpSection title="Delivery summary">
        <ErpSummary stats={summary} />
      </ErpSection>

      {!onlyUndelivered && (
        <ErpSection
          title={onlyUnbilled ? "Delivered, not yet invoiced" : "Delivery history"}
          lead={onlyUnbilled
            ? "Goods that have left the warehouse with no invoice raised against them — the customer has them and owes nothing."
            : "Previously recorded deliveries."}
          foot={
            onlyUnbilled ? (
              <>
                <span>
                  {rows.length} deliver{rows.length === 1 ? "y" : "ies"} awaiting an invoice
                </span>
                <Link href="/sales/deliver">Show every delivery</Link>
              </>
            ) : posted.length > 0 ? (
              <>
                <span>{posted.length} posted deliver{posted.length === 1 ? "y" : "ies"}</span>
                <span>Total <strong>{company.base_currency} {money(deliveredValue)}</strong></span>
              </>
            ) : undefined
          }
        >
          <DataTable
            rows={rows}
            columns={[
              { key: "doc_no", label: "Delivery", sortable: true },
              { key: "doc_date", label: "Delivered date", sortable: true },
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "location_code", label: "Warehouse", sortable: true },
              { key: "source_no", label: "Source", sortable: true },
              { key: "gross_total", label: `Value (${company.base_currency})`,
                sortable: true, align: "r" as const },
              { key: "invoiced", label: "Invoice status", sortable: true },
            ]}
            filters={[{
              key: "status",
              allLabel: "All statuses",
              options: [
                { value: "invoiced", label: "Fully invoiced" },
                { value: "awaiting", label: "Awaiting invoice" },
                { value: "voided", label: "Voided" },
              ],
            }]}
            searchPlaceholder="Search delivery number, customer or SO"
            defaultSort={{ key: "doc_date", dir: "desc" }}
            emptyLabel="Nothing has been delivered yet."
          />
        </ErpSection>
      )}
    </div>
  );
}
