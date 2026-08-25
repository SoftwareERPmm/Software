import Link from "next/link";
import { Boxes, PackageCheck, TrendingDown, AlertTriangle } from "lucide-react";
import { money, qty } from "@/lib/db";
import {
  getCompany, getItems, getReservedQty, getIncomingQty, getLowStock, getReorderPoints, getLocations,
  getStockByLocation,
} from "@/lib/queries";
import { createReorderPoint, updateReorderPoint, deleteReorderPoint } from "@/lib/actions";
import { DataTable, type DataRow } from "@/components/data-table";
import { AddReorderPointForm } from "@/components/reorder-point-form";
import { ReorderPointRow } from "@/components/reorder-point-row";
import { AccountPicker } from "@/components/account-picker";

type Row = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; group_name: string; parent_group_name: string | null;
  uom_code: string; qty_on_hand: string; value_on_hand: string; is_stocked: boolean;
};

export default async function Stock({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const { location } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [items, reserved, incoming, lowStock, reorderPoints, locations, stockByLocation] = await Promise.all([
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

  const stocked = items.filter((i) => i.is_stocked).map((i) => {
    const onHand = onHandOf(i.id, Number(i.qty_on_hand));
    const valueOnHand = valueOf(i.id, Number(i.value_on_hand));
    const reservedQty = reservedOf(i.id);
    const incomingQty = incomingOf(i.id);
    const available = onHand - reservedQty;
    const projected = available + incomingQty;
    return { ...i, onHand, valueOnHand, reservedQty, incomingQty, available, projected };
  });
  const totalValue = stocked.reduce((s, i) => s + i.valueOnHand, 0);

  const rows: DataRow[] = stocked.map((i) => ({
    key: i.id,
    searchText: [i.code, i.name, i.name_my, i.group_name, i.parent_group_name].filter(Boolean).join(" "),
    sort: {
      code: i.code,
      name: i.name,
      group_name: i.parent_group_name ? `${i.parent_group_name} / ${i.group_name}` : i.group_name,
      uom_code: i.uom_code,
      onHand: i.onHand,
      reservedQty: i.reservedQty,
      available: i.available,
      incomingQty: i.incomingQty,
      projected: i.projected,
      value_on_hand: i.valueOnHand,
    },
    node: (
      <tr>
        <td className="code">
          <Link href={`/items/categories/${i.item_group_id}`} style={{ color: "var(--brand)" }}>
            {i.code}
          </Link>
        </td>
        <td className="wrap">
          {i.name}
          {i.name_my && (
            <div className="subline">{i.name_my}</div>
          )}
        </td>
        <td style={{ color: "var(--muted)" }}>
          {i.parent_group_name ? `${i.parent_group_name} / ${i.group_name}` : i.group_name}
        </td>
        <td className="code">{i.uom_code}</td>
        <td className="r">{qty(String(i.onHand))}</td>
        <td className="r" style={{ color: i.reservedQty > 0 ? "var(--warn)" : undefined }}>
          {i.reservedQty > 0 ? qty(String(i.reservedQty)) : "—"}
        </td>
        <td className="r" style={{ fontWeight: 600 }}>
          {qty(String(i.available))}
        </td>
        <td className="r" style={{ color: i.incomingQty > 0 ? "var(--ok)" : undefined }}>
          {i.incomingQty > 0 ? qty(String(i.incomingQty)) : "—"}
        </td>
        <td className="r">{qty(String(i.projected))}</td>
        <td className="r">{money(i.valueOnHand)}</td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Stock</h1>
        <span className="page-sub">
          On hand is summed live from the stock ledger — nothing here is a
          stored column that could drift. Reserved and Incoming come from
          open orders and unfulfilled deliveries; Available and Projected are
          both derived, never stored.
        </span>
      </div>

      {reorderableLocations.length > 1 && (
        <AccountPicker
          accounts={[{ id: "all", code: "—", name: "All locations" }, ...reorderableLocations]}
          selectedId={selectedLocationId}
          basePath="/items/stock"
          paramName="location"
          label="Location"
        />
      )}

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label"><Boxes size={13} /> Stock value</span>
          <span className="kpi-value">{money(totalValue)}</span>
          <span className="kpi-note">{stocked.length} stocked item{stocked.length === 1 ? "" : "s"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><AlertTriangle size={13} /> Low stock</span>
          <span className="kpi-value" style={{ color: lowStock.length > 0 ? "var(--bad)" : undefined }}>
            {lowStock.length}
          </span>
          <span className="kpi-note">
            item/location pair{lowStock.length === 1 ? "" : "s"} out of stock or below reorder point
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><PackageCheck size={13} /> Incoming</span>
          <span className="kpi-value">{incoming.length}</span>
          <span className="kpi-note">item/location pair{incoming.length === 1 ? "" : "s"} on an open purchase order</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><TrendingDown size={13} /> Reserved</span>
          <span className="kpi-value">{reserved.length}</span>
          <span className="kpi-note">item/location pair{reserved.length === 1 ? "" : "s"} committed to an open sales order</span>
        </div>
      </div>

      {lowStock.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Low stock</h2>
              <span className="page-sub">out of stock, or below the reorder point set on that item and location</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Item</th><th>Location</th><th>Status</th>
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
                    <th>Code</th><th>Item</th><th>Location</th>
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
              {stocked.length} stocked items
              {!allLocations && ` · ${reorderableLocations.find((l) => l.id === selectedLocationId)?.name ?? ""}`}
            </span>
          </div>

          {stocked.length === 0 ? (
            <div className="empty">
              No stocked items yet.{" "}
              <Link href="/items" style={{ color: "var(--brand)" }}>Add an item</Link>
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No stocked items"
              searchPlaceholder="Search stock…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "group_name", label: "Category", sortable: true },
                { key: "uom_code", label: "Unit", sortable: true },
                { key: "onHand", label: "On hand", sortable: true, align: "r" },
                { key: "reservedQty", label: "Reserved", sortable: true, align: "r" },
                { key: "available", label: "Available", sortable: true, align: "r" },
                { key: "incomingQty", label: "Incoming", sortable: true, align: "r" },
                { key: "projected", label: "Projected", sortable: true, align: "r" },
                { key: "value_on_hand", label: "Value", sortable: true, align: "r" },
              ]}
              footer={
                <tr>
                  <td colSpan={9}>Total stock value{!allLocations ? " at this location" : ""}</td>
                  <td className="r">{money(totalValue)}</td>
                </tr>
              }
            />
          )}
        </div>
      </section>
    </>
  );
}
