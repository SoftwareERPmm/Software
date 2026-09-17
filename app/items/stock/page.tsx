import Link from "next/link";
import { Boxes, PackageCheck, TrendingDown, AlertTriangle, HandCoins } from "lucide-react";
import { money, qty, shortDate } from "@/lib/db";
import {
  getCompany, getItems, getReservedQty, getIncomingQty, getLowStock, getReorderPoints, getLocations,
  getStockByLocation, getConsignedStockOnHand,
} from "@/lib/queries";
import { createReorderPoint, updateReorderPoint, deleteReorderPoint } from "@/lib/actions";
import { type DataRow } from "@/components/data-table";
import { StockTable } from "@/components/stock-table";
import { StockRow, type StockRowItem } from "@/components/stock-row";
import { AddReorderPointForm } from "@/components/reorder-point-form";
import { ReorderPointRow } from "@/components/reorder-point-row";
import { AccountPicker } from "@/components/account-picker";

type Row = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; group_name: string; parent_group_name: string | null;
  brand_name: string | null; barcode: string | null;
  uom_code: string; qty_on_hand: string; value_on_hand: string; is_stocked: boolean;
  last_purchase_price: string | null;
  last_purchase_document_id: string | null;
  last_purchase_doc_no: string | null;
  last_purchase_date: string | null;
};

export default async function Stock({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const { location } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [items, reserved, incoming, lowStock, reorderPoints, locations, stockByLocation, consigned] = await Promise.all([
    getItems(company.id) as unknown as Promise<Row[]>,
    getReservedQty(company.id) as unknown as Promise<Array<{ item_id: string; location_id: string; reserved_qty: string }>>,
    getIncomingQty(company.id) as unknown as Promise<Array<{ item_id: string; location_id: string; incoming_qty: string }>>,
    getLowStock(company.id) as unknown as Promise<Array<{
      item_id: string; item_code: string; item_name: string;
      location_id: string; location_code: string; qty_on_hand: string; min_qty: string | null;
      reason: "below_reorder" | "out_of_stock";
    }>>,
    getReorderPoints(company.id) as unknown as Promise<Array<{
      id: string; item_id: string; location_id: string; min_qty: string;
      item_code: string; item_name: string; location_code: string;
    }>>,
    getLocations(company.id) as unknown as Promise<Array<{ id: string; code: string; name: string; is_stock_location: boolean }>>,
    getStockByLocation(company.id) as unknown as Promise<Array<{
      item_id: string; location_id: string; qty_on_hand: string; value_on_hand: string;
    }>>,
    getConsignedStockOnHand(company.id) as unknown as Promise<Array<{
      item_id: string; location_id: string; on_hand: string; consignor_name: string;
    }>>,
  ]);

  const reorderableLocations = locations.filter((l) => l.is_stock_location);

  const selectedLocationId = location && reorderableLocations.some((l) => l.id === location) ? location : "all";
  const allLocations = selectedLocationId === "all";

  // Company-wide: sum across every row for that item. One warehouse: the
  // single row for that item and location, or 0 if it's never touched it.
  const onHandOf = (itemId: string, companyWide: number) =>
    allLocations
      ? companyWide
      : Number(stockByLocation.find((r) => r.item_id === itemId && r.location_id === selectedLocationId)?.qty_on_hand ?? 0);
  const valueOf = (itemId: string, companyWide: number) =>
    allLocations
      ? companyWide
      : Number(stockByLocation.find((r) => r.item_id === itemId && r.location_id === selectedLocationId)?.value_on_hand ?? 0);
  const reservedOf = (itemId: string) =>
    allLocations
      ? reserved.filter((r) => r.item_id === itemId).reduce((s, r) => s + Number(r.reserved_qty), 0)
      : Number(reserved.find((r) => r.item_id === itemId && r.location_id === selectedLocationId)?.reserved_qty ?? 0);
  const incomingOf = (itemId: string) =>
    allLocations
      ? incoming.filter((r) => r.item_id === itemId).reduce((s, r) => s + Number(r.incoming_qty), 0)
      : Number(incoming.find((r) => r.item_id === itemId && r.location_id === selectedLocationId)?.incoming_qty ?? 0);
  // Every consigned row visible under the current location choice. The KPI
  // counts these rather than the whole company's, or picking a warehouse
  // would leave the tile reading the same number for every warehouse.
  const consignedHere = allLocations
    ? consigned
    : consigned.filter((r) => r.location_id === selectedLocationId);
  const consignedOf = (itemId: string) =>
    consignedHere.filter((r) => r.item_id === itemId).reduce((s, r) => s + Number(r.on_hand), 0);

  const stocked = items.filter((i) => i.is_stocked).map((i) => {
    const onHand = onHandOf(i.id, Number(i.qty_on_hand));
    const valueOnHand = valueOf(i.id, Number(i.value_on_hand));
    const reservedQty = reservedOf(i.id);
    const incomingQty = incomingOf(i.id);
    const consignedQty = consignedOf(i.id);
    const available = onHand - reservedQty;
    const projected = available + incomingQty;
    return { ...i, onHand, valueOnHand, reservedQty, incomingQty, consignedQty, available, projected };
  });
  /**
   * Which items this view is about.
   *
   * Every stocked item, when the question is "what does the company hold" —
   * an item at zero everywhere is the whole point of a Low stock tile, and
   * dropping it would hide exactly the row somebody is looking for.
   *
   * But a warehouse is a narrower question. Asked what is in Mandalay, the
   * answer is not the entire catalogue with zeroes against the things that
   * have never been there: that listed all seven items under all three
   * choices, so picking a warehouse appeared to do nothing at all. Held,
   * reserved, on its way, or there on consignment — any of those is presence
   * at that warehouse. None of them is absence.
   */
  const visible = allLocations
    ? stocked
    : stocked.filter((i) =>
        i.onHand !== 0 || i.reservedQty !== 0 || i.incomingQty !== 0 || i.consignedQty !== 0);

  const totalValue = visible.reduce((s, i) => s + i.valueOnHand, 0);

  /** Which consignors an item's held-but-unowned stock belongs to. */
  const consignorsOf = (itemId: string) =>
    Array.from(new Set(
      consignedHere.filter((r) => r.item_id === itemId).map((r) => r.consignor_name)
    ));

  /**
   * Where an item actually sits. Only warehouses holding some of it, and only
   * the chosen one when a location is picked — a panel listing every empty
   * warehouse is a longer answer to a shorter question.
   */
  const warehousesOf = (itemId: string) =>
    stockByLocation
      .filter((r) =>
        r.item_id === itemId
        && (allLocations || r.location_id === selectedLocationId)
        && Number(r.qty_on_hand) !== 0)
      .map((r) => {
        const loc = locations.find((l) => l.id === r.location_id);
        return {
          locationId: r.location_id,
          code: loc?.code ?? "—",
          name: loc?.name ?? "",
          onHand: Number(r.qty_on_hand),
          reserved: Number(
            reserved.find((x) => x.item_id === itemId && x.location_id === r.location_id)
              ?.reserved_qty ?? 0),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

  const STOCK_COLUMNS = 12;

  const rows: DataRow[] = visible.map((i) => {
    const consignors = consignorsOf(i.id);
    const category = i.parent_group_name ? `${i.parent_group_name} / ${i.group_name}` : i.group_name;

    const rowItem: StockRowItem = {
      id: i.id,
      code: i.code,
      name: i.name,
      nameMy: i.name_my,
      itemGroupId: i.item_group_id,
      category,
      uomCode: i.uom_code,
      barcode: i.barcode,
      brandName: i.brand_name,
      onHand: i.onHand,
      consignedQty: i.consignedQty,
      reservedQty: i.reservedQty,
      available: i.available,
      incomingQty: i.incomingQty,
      projected: i.projected,
      valueOnHand: i.valueOnHand,
      lastCost: i.last_purchase_price,
      lastCostDocNo: i.last_purchase_doc_no,
      lastCostDocId: i.last_purchase_document_id,
      lastCostDate: i.last_purchase_date ? shortDate(i.last_purchase_date) : null,
      consignors,
      warehouses: warehousesOf(i.id),
    };

    return {
      key: i.id,
      searchText: [i.code, i.name, i.name_my, i.group_name, i.parent_group_name, i.barcode,
                   ...consignors].filter(Boolean).join(" "),
      sort: {
        code: i.code,
        name: i.name,
        ownership: consignors.length > 0 ? `Consignment ${consignors.join(" ")}` : "Company-owned",
        group_name: category,
        uom_code: i.uom_code,
        onHand: i.onHand,
        reservedQty: i.reservedQty,
        available: i.available,
        incomingQty: i.incomingQty,
        projected: i.projected,
        value_on_hand: i.valueOnHand,
        last_cost: Number(i.last_purchase_price ?? 0),
      },
      node: <StockRow item={rowItem} columnCount={STOCK_COLUMNS} />,
    };
  });

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Stock</h1>
      </div>

      {reorderableLocations.length > 1 && (
        <AccountPicker
          accounts={[{ id: "all", code: "—", name: "All warehouses" }, ...reorderableLocations]}
          selectedId={selectedLocationId}
          basePath="/items/stock"
          paramName="location"
          label="Warehouse"
        />
      )}

      {/* Each figure gets its own tinted mark. Five tiles of identical grey
          text is five things to read; a colour and a shape per tile is one
          thing to recognise. */}
      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "var(--brand)",
            background: "color-mix(in srgb, var(--brand) 12%, transparent)",
          }}>
            <Boxes size={17} aria-hidden="true" />
          </span>
          <span className="kpi-body">
            <span className="kpi-label">Stock value</span>
            <span className="kpi-value">{money(totalValue)}</span>
            <span className="kpi-note">{visible.length} stocked item{visible.length === 1 ? "" : "s"}</span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "var(--warn)",
            background: "color-mix(in srgb, var(--warn) 14%, transparent)",
          }}>
            <AlertTriangle size={17} aria-hidden="true" />
          </span>
          <span className="kpi-body">
            <span className="kpi-label">Low stock</span>
            <span className="kpi-value" style={{ color: lowStock.length > 0 ? "var(--bad)" : undefined }}>
              {lowStock.length}
            </span>
            <span className="kpi-note">
              item/warehouse pair{lowStock.length === 1 ? "" : "s"} out of stock or below reorder point
            </span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "#3B6FD4",
            background: "color-mix(in srgb, #3B6FD4 12%, transparent)",
          }}>
            <PackageCheck size={17} aria-hidden="true" />
          </span>
          <span className="kpi-body">
            <span className="kpi-label">Incoming</span>
            <span className="kpi-value">{incoming.length}</span>
            <span className="kpi-note">item/warehouse pair{incoming.length === 1 ? "" : "s"} on an open purchase order</span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "#C2610A",
            background: "color-mix(in srgb, #C2610A 12%, transparent)",
          }}>
            <TrendingDown size={17} aria-hidden="true" />
          </span>
          <span className="kpi-body">
            <span className="kpi-label">Reserved</span>
            <span className="kpi-value">{reserved.length}</span>
            <span className="kpi-note">item/warehouse pair{reserved.length === 1 ? "" : "s"} committed to an open sales order</span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "#6C5CE0",
            background: "color-mix(in srgb, #6C5CE0 12%, transparent)",
          }}>
            <HandCoins size={17} aria-hidden="true" />
          </span>
          <span className="kpi-body">
            <span className="kpi-label">Consigned</span>
            <span className="kpi-value">
              <Link href="/inventory/consignment" style={{ color: "inherit" }}>{consignedHere.length}</Link>
            </span>
            <span className="kpi-note">
              item/warehouse/consignor combination{consignedHere.length === 1 ? "" : "s"} on hand but not owned
              {!allLocations && " at this warehouse"}
            </span>
          </span>
        </div>
      </div>

      {lowStock.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Low stock</h2>
              <span className="page-sub">out of stock, or below the reorder point set on that item and warehouse</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Item</th><th>Warehouse</th><th>Status</th>
                    <th className="r">On hand</th><th className="r">Reorder point</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.map((r) => (
                    <tr key={`${r.item_id}-${r.location_id}`}>
                      <td className="code">{r.item_code}</td>
                      <td className="wrap">{r.item_name}</td>
                      <td className="code">{r.location_code}</td>
                      <td>
                        <span className={`pill ${r.reason === "out_of_stock" ? "overdue" : "warn"}`}>
                          {r.reason === "out_of_stock" ? "Out of stock" : "Below reorder"}
                        </span>
                      </td>
                      <td className="r" style={{ color: Number(r.qty_on_hand) <= 0 ? "var(--bad)" : undefined }}>
                        {qty(r.qty_on_hand)}
                      </td>
                      <td className="r">{r.min_qty !== null ? qty(r.min_qty) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Reorder points</h2>
            <span className="page-sub">{reorderPoints.length} set</span>
          </div>
          <div className="card-body">
            <AddReorderPointForm
              action={createReorderPoint}
              items={stocked.map((i) => ({ id: i.id, code: i.code, name: i.name }))}
              locations={reorderableLocations}
            />
          </div>
          {reorderPoints.length > 0 && (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Item</th><th>Warehouse</th>
                    <th className="r">Reorder point</th><th />
                  </tr>
                </thead>
                <tbody>
                  {reorderPoints.map((p) => (
                    <ReorderPointRow
                      key={p.id}
                      point={p}
                      updateAction={updateReorderPoint}
                      deleteAction={deleteReorderPoint}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Stock position</h2>
            <span className="page-sub">
              {visible.length} stocked item{visible.length === 1 ? "" : "s"}
              {!allLocations && ` here · ${reorderableLocations.find((l) => l.id === selectedLocationId)?.name ?? ""}`}
            </span>
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              {allLocations ? (
                <>
                  No stocked items yet.{" "}
                  <Link href="/items" style={{ color: "var(--brand)" }}>Add an item</Link>
                </>
              ) : (
                <>
                  Nothing held, reserved or on its way at this warehouse.{" "}
                  <Link href="/items/stock" style={{ color: "var(--brand)" }}>See all warehouses</Link>
                </>
              )}
            </div>
          ) : (
            <StockTable
              rows={rows}
              consignmentItemIds={visible.filter((i) => i.consignedQty > 0).map((i) => i.id)}
              emptyLabel="No stocked items"
              searchPlaceholder="Search stock…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                // No label: the chevron column is a control, not a field.
                { key: "expand", label: "" },
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Item", sortable: true },
                { key: "ownership", label: "Ownership", sortable: true },
                { key: "group_name", label: "Category", sortable: true },
                { key: "uom_code", label: "Unit", sortable: true },
                { key: "onHand", label: "On hand", sortable: true, align: "r" },
                { key: "reservedQty", label: "Reserved", sortable: true, align: "r" },
                { key: "available", label: "Available", sortable: true, align: "r" },
                { key: "incomingQty", label: "Incoming", sortable: true, align: "r" },
                { key: "projected", label: "Projected", sortable: true, align: "r" },
                { key: "value_on_hand", label: "Value (MMK)", sortable: true, align: "r" },
              ]}
              footerCells={{
                span: <>Total stock value{!allLocations ? " at this warehouse" : ""}</>,
                cells: { value_on_hand: money(totalValue) },
              }}
            />
          )}
        </div>
      </section>
    </>
  );
}
