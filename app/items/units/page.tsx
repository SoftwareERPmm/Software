import { sql } from "@/lib/db";
import { createUnit, updateUnit, deactivateUnit, activateUnit, deleteUnit } from "@/lib/actions";
import { AddUnitForm } from "@/components/unit-form";
import { UnitRow } from "@/components/unit-row";
import { DataTable, type DataRow } from "@/components/data-table";

export default async function Units() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const units = (await sql`
    select u.id, u.code, u.name, u.name_my, u.is_active,
           count(i.id)::int as items
      from uom u
      left join item i on i.base_uom_id = u.id
     where u.company_id = ${co.id}
     group by u.id
     order by u.name`) as any[];

  const rows: DataRow[] = units.map((u) => ({
    key: u.id,
    searchText: [u.code, u.name, u.name_my].filter(Boolean).join(" "),
    sort: { code: u.code, name: u.name, items: Number(u.items), is_active: u.is_active ? 1 : 0 },
    node: (
      <UnitRow
        unit={u}
        updateAction={updateUnit}
        deactivateAction={deactivateUnit}
        activateAction={activateUnit}
        deleteAction={deleteUnit}
      />
    ),
  }));

  const active = units.filter((u) => u.is_active).length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Units</h1>
        <span className="page-sub">
          What quantities are counted in. Each item is stored in one base unit
          and every quantity of it &mdash; on hand, received, sold &mdash; is
          held in that unit, so a unit is settled when the item is created and
          not changed underneath it afterwards. Retiring one takes it off the
          pickers and leaves every existing item counting exactly as before.
        </span>
      </div>

      <AddUnitForm action={createUnit} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Units</h2>
            <span className="page-sub">
              {units.length} total · {active} active
            </span>
          </div>

          {units.length === 0 ? (
            <div className="empty">
              Nothing yet. Add the units your items are counted in &mdash; Piece,
              Box, Carton &mdash; before creating items, since every item needs one.
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No units"
              searchPlaceholder="Search units…"
              defaultSort={{ key: "name", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "items", label: "Items", sortable: true, align: "r" },
                { key: "is_active", label: "Status", sortable: true },
                { key: "actions", label: "" },
              ]}
            />
          )}
        </div>
      </section>
    </>
  );
}
