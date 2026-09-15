import Link from "next/link";
import { Package, FileText, FileClock, Plus } from "lucide-react";
import { money, shortDate } from "@/lib/db";
import {
  getCompany, getOpenPurchaseOrders, getGoodsReceiptHistory, getGrirPositions,
  getOpenGoodsReceipts, getGrirCollisions, getOpenPurchaseInvoices,
  getBillsRaisedFromOrders,
} from "@/lib/queries";
import { createGoodsReceipt } from "@/lib/actions";
import { FulfillOrderForm } from "@/components/fulfill-order-form";
import { DataTable, type DataRow } from "@/components/data-table";
import {
  ErpBackCrumb, ErpPageHead, ErpSection, ErpSummary, type Summary,
} from "@/components/erp-worklist";

type Receipt = {
  id: string; doc_no: string | null; doc_date: string; status: string;
  gross_total: string; partner_id: string | null; partner_name: string | null;
  location_code: string | null; source_id: string | null;
  source_no: string | null; source_type: string | null;
  line_count: number; grir_open: string;
};

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

export default async function Receive({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [openLines, history, grir, stillToBill, collisionRows, openBills, raisedFrom] =
    await Promise.all([
    getOpenPurchaseOrders(company.id),
    getGoodsReceiptHistory(company.id) as unknown as Promise<Receipt[]>,
    getGrirPositions(company.id),
    getOpenGoodsReceipts(company.id) as unknown as Promise<
      { id: string; lines: { qty: number; unitPrice: number }[] }[]>,
    getGrirCollisions(company.id),
    getOpenPurchaseInvoices(company.id) as unknown as Promise<Array<{
      id: string; doc_no: string; doc_date: string; partner_id: string;
      lines: { itemId: string; itemName: string; qty: number }[];
    }>>,
    getBillsRaisedFromOrders(company.id),
  ]);

  // Goods already in and a bill already waiting for them, per supplier: the
  // one case where receiving against this order is the wrong move.
  const collisions = new Map<string, typeof collisionRows>();
  for (const r of collisionRows) {
    const list = collisions.get(r.partner_id) ?? [];
    list.push(r);
    collisions.set(r.partner_id, list);
  }

  // What each receipt is still owed a bill for, from the same reckoning the
  // invoice form offers to bill. The clearing account's own balance cannot
  // answer this per receipt: a receipt matched to an invoice clears through
  // that invoice's anchor, so it reads as nil however much of what it brought
  // in was never on the bill.
  const unbilledBy = new Map(stillToBill.map((r) =>
    [r.id, r.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)]));

  const orders = new Map<string, {
    orderId: string; orderNo: string; partnerId: string; partnerName: string;
    locationId: string; locationCode: string | null; locationName: string | null;
    dueDate: string | null;
    lines: { lineId: string; itemId: string; itemCode: string; itemName: string;
             uomCode: string; remainingQty: number; expectedPrice: number }[];
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
      uomCode: r.uom_code, remainingQty: Number(r.remaining_qty), expectedPrice: Number(r.expected_price ?? 0),
    });
  }

  // Received and not yet billed: the clearing balance itself, so the figure on
  // screen and the one in GR/IR Clearing cannot disagree.
  const posted = history.filter((r) => r.status === "POSTED");
  const receivedValue = posted.reduce((s, r) => s + Number(r.gross_total), 0);

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
          listHref="/purchases/receive"
          listLabel="Goods receipts"
          doc={chosen ? { id: chosen.orderId, docNo: chosen.orderNo } : null}
          here="Receive goods"
        />

        {chosen ? (
          <>
            <ErpPageHead
              eyebrow="Purchases"
              title={`Receive against ${chosen.orderNo}`}
              lead={`${chosen.partnerName} · ${chosen.lines.length} order line${
                chosen.lines.length === 1 ? "" : "s"} awaiting receipt${
                chosen.locationName ? ` · ${chosen.locationName}` : ""}`}
              action={
                orders.size > 1 ? (
                  <Link href="/purchases/receive" className="erp-hbtn">
                    All {orders.size} open orders
                  </Link>
                ) : null
              }
            />
            <FulfillOrderForm
              kind="purchase"
              defaultOpen
              orderId={chosen.orderId}
              orderNo={chosen.orderNo}
              partnerName={chosen.partnerName}
              partnerId={chosen.partnerId}
              locationId={chosen.locationId}
              lines={chosen.lines}
              action={createGoodsReceipt}
              collisions={collisions.get(chosen.partnerId) ?? []}
              openBills={openBills
                .filter((b) => b.partner_id === chosen.partnerId)
                .map((b) => ({
                  ...b,
                  linked: raisedFrom.some(
                    (r) => r.bill_id === b.id && r.order_id === chosen.orderId),
                }))}
            />
          </>
        ) : (
          <div className="empty">
            That order has nothing left to receive.{" "}
            <Link href="/purchases/receive" style={{ color: "var(--brand)" }}>
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
              {o.lines.length} order line{o.lines.length === 1 ? "" : "s"} awaiting receipt
            </span>
          </td>
          <td className="wrap">{o.partnerName ?? "—"}</td>
          <td className="code">{o.dueDate ? shortDate(o.dueDate) : "—"}</td>
          <td className="wrap">{o.locationName ?? o.locationCode ?? "—"}</td>
          <td className="r">
            {/* The quantity itself, where the reference drew a "view
                quantities" link. It is one number when the lines share a
                unit, and only then — 100 CTN + 30 PCS is not 130 of
                anything. */}
            {oneUnit ? `${money(remaining)}${unit ? ` ${unit}` : ""}` : `${o.lines.length} lines`}
          </td>
          <td className="tight">
            <Link href={`/purchases/receive?order=${o.orderId}`} className="btn primary">
              Receive goods
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

  const rows: DataRow[] = history.map((r) => {
    const openValue = unbilledBy.get(r.id) ?? 0;
    const open = openValue > 0;
    const voided = r.status !== "POSTED";
    return {
      key: r.id,
      searchText: [r.doc_no, r.partner_name, r.source_no, r.location_code]
        .filter(Boolean).join(" "),
      facet: { status: voided ? "voided" : open ? "awaiting" : "billed" },
      sort: {
        doc_no: r.doc_no ?? "",
        doc_date: toTime(r.doc_date),
        partner_name: r.partner_name ?? "",
        location_code: r.location_code ?? "",
        source_no: r.source_no ?? "",
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
          <td className="r">{money(r.gross_total)}</td>
          <td>
            {voided ? (
              <span className="pill draft">Voided</span>
            ) : open ? (
              <Link href={`/purchases/new?goods_receipt_id=${r.id}`}>
                <span className="pill warn">Awaiting · {money(openValue)}</span>
              </Link>
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
      icon: Package,
      label: "Received value",
      value: `${company.base_currency} ${money(receivedValue)}`,
      note: `${posted.length} posted receipt${posted.length === 1 ? "" : "s"}`,
    },
    {
      icon: FileText,
      label: "Awaiting supplier invoice",
      value: `${company.base_currency} ${money(grir.unbilled)}`,
      note: "goods in that nobody has billed for",
      tone: grir.unbilled > 0 ? "warn" : undefined,
    },
    {
      icon: FileClock,
      label: "Billed, not received",
      value: `${company.base_currency} ${money(grir.awaited)}`,
      note: "invoices holding goods still to come",
    },
  ];

  return (
    <div className="erp-page">
      <ErpPageHead
        eyebrow="Purchases"
        title="Goods receipts"
        lead="Record goods arriving at your warehouse."
      />

      <ErpSection
        title="Purchase orders awaiting receipt"
        count={orders.size}
        lead="Choose an order to record the quantities delivered."
        action={
          <Link href="/purchases/receive/new" className="erp-hbtn">
            <Plus size={15} aria-hidden="true" /> Receive without purchase order
          </Link>
        }
        foot={
          orders.size > 0
            ? <span>Check delivered quantities before posting the receipt.</span>
            : undefined
        }
      >
        {orders.size === 0 ? (
          <div className="empty">
            No open purchase order to receive against.{" "}
            <Link href="/purchases/orders/new" style={{ color: "var(--brand)" }}>New purchase order</Link>
            {" "}to start one. If the goods have already arrived with no order
            behind them, use{" "}
            <Link href="/purchases/receive/new" style={{ color: "var(--brand)" }}>Receive without purchase order</Link>
            {" "}above instead.
          </div>
        ) : (
          <DataTable
            rows={awaiting}
            columns={[
              { key: "order_no", label: "Purchase order", sortable: true },
              { key: "partner_name", label: "Supplier", sortable: true },
              { key: "due_date", label: "Expected delivery", sortable: true },
              { key: "warehouse", label: "Warehouse" },
              { key: "remaining", label: "Remaining", sortable: true, align: "r" as const },
              { key: "action", label: "Action" },
            ]}
            filters={[{ key: "warehouse", allLabel: "All warehouses", options: warehouses }]}
            searchPlaceholder="Search PO number or supplier"
            defaultSort={{ key: "due_date", dir: "asc" }}
            emptyLabel="No order matches that."
          />
        )}
      </ErpSection>

      <ErpSection title="Receipt summary">
        <ErpSummary stats={summary} />
        {/* GR/IR nets, and a net balance hides which way each half points. A
            bill for 70,000 with 7,000 received, plus 40 of goods nobody
            billed, reads 62,960 — which looks like a wrong 63,000 until it is
            split. */}
        {(grir.awaited !== 0 || grir.unbilled !== 0) && (
          <p className="hint" style={{ marginTop: "1rem" }}>
            GR/IR clearing nets to {money(grir.awaited - grir.unbilled)} of
            those two. Both are counted from the documents themselves, so they
            add up to what the account says — which is why neither is cut to a
            period.
          </p>
        )}
      </ErpSection>

      <ErpSection
        title="Receipt history"
        lead="Previously recorded goods receipts."
        foot={
          posted.length > 0 ? (
            <>
              <span>{posted.length} posted receipt{posted.length === 1 ? "" : "s"}</span>
              <span>Total <strong>{company.base_currency} {money(receivedValue)}</strong></span>
            </>
          ) : undefined
        }
      >
        <DataTable
          rows={rows}
          columns={[
            { key: "doc_no", label: "Receipt", sortable: true },
            { key: "doc_date", label: "Received date", sortable: true },
            { key: "partner_name", label: "Supplier", sortable: true },
            { key: "location_code", label: "Warehouse", sortable: true },
            { key: "source_no", label: "Source", sortable: true },
            { key: "gross_total", label: `Value (${company.base_currency})`,
              sortable: true, align: "r" as const },
            { key: "billed", label: "Invoice status", sortable: true },
          ]}
          filters={[{
            key: "status",
            allLabel: "All statuses",
            options: [
              { value: "billed", label: "Fully invoiced" },
              { value: "awaiting", label: "Awaiting invoice" },
              { value: "voided", label: "Voided" },
            ],
          }]}
          searchPlaceholder="Search receipt number, supplier or PO"
          defaultSort={{ key: "doc_date", dir: "desc" }}
          emptyLabel="Nothing has been received yet."
        />
      </ErpSection>
    </div>
  );
}
