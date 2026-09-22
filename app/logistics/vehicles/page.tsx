import { getCompany, getVehicles } from "@/lib/queries";
import { createVehicle, updateVehicle, setVehicleActive } from "@/lib/actions";
import { FleetRow, type FleetField } from "@/components/fleet-row";
import { SimpleForm } from "@/components/simple-form";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const FIELDS: FleetField[] = [
  { name: "plate_no", label: "Plate", placeholder: "3K/1234", required: true },
  { name: "name", label: "Description", placeholder: "Hino 2-ton" },
  { name: "capacity_note", label: "Capacity", placeholder: "~120 cases" },
];

export default async function Vehicles() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const vehicles = (await getVehicles(company.id)) as unknown as Array<
    Parameters<typeof FleetRow>[0]["record"]
  >;

  const rows: DataRow[] = vehicles.map((v) => ({
    key: v.id,
    searchText: [v.code, v.plate_no, v.name].filter(Boolean).map(String).join(" "),
    sort: {
      code: v.code,
      plate_no: String(v.plate_no ?? ""),
      name: String(v.name ?? ""),
      capacity_note: String(v.capacity_note ?? ""),
      trips: Number(v.trips),
      is_active: v.is_active ? 1 : 0,
    },
    node: (
      <FleetRow record={v} fields={FIELDS}
                updateAction={updateVehicle} setActiveAction={setVehicleActive} />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>Vehicles</h1>
        <HelpHint>
          The trucks that carry deliveries. Capacity is a note rather than a
          number: a real load check needs weight and volume per item, which
          the item master does not keep, and a figure here would look like a
          limit while enforcing nothing.
        </HelpHint>
      </div>

      <SimpleForm action={createVehicle} submitLabel="Add vehicle">
        <div className="card">
          <div className="card-head"><h2>New vehicle</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" name="code" type="text" placeholder="VAN-01" required />
              </div>
              <div className="field">
                <label htmlFor="plate_no">Plate number</label>
                <input id="plate_no" name="plate_no" type="text" placeholder="3K/1234" required />
                <span className="hint">What the yard actually calls it</span>
              </div>
              <div className="field">
                <label htmlFor="name">Description</label>
                <input id="name" name="name" type="text" placeholder="Hino 2-ton" />
              </div>
              <div className="field">
                <label htmlFor="capacity_note">Capacity</label>
                <input id="capacity_note" name="capacity_note" type="text" placeholder="~120 cases" />
              </div>
            </div>
          </div>
        </div>
      </SimpleForm>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Fleet</h2>
            <span className="page-sub">{vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No vehicles yet"
            searchPlaceholder="Search vehicles…"
            defaultSort={{ key: "code", dir: "asc" }}
            columns={[
              { key: "code", label: "Code", sortable: true },
              { key: "plate_no", label: "Plate", sortable: true },
              { key: "name", label: "Description", sortable: true },
              { key: "capacity_note", label: "Capacity" },
              { key: "trips", label: "Trips", sortable: true, align: "r" },
              { key: "is_active", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
