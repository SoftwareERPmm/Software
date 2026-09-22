import { getCompany, getDrivers } from "@/lib/queries";
import { createDriver, updateDriver, setDriverActive } from "@/lib/actions";
import { FleetRow, type FleetField } from "@/components/fleet-row";
import { SimpleForm } from "@/components/simple-form";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const FIELDS: FleetField[] = [
  { name: "name", label: "Name", required: true },
  { name: "name_my", label: "Name (Burmese)" },
  { name: "phone", label: "Phone", placeholder: "09-…" },
  { name: "licence_no", label: "Licence" },
];

export default async function Drivers() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const drivers = (await getDrivers(company.id)) as unknown as Array<
    Parameters<typeof FleetRow>[0]["record"]
  >;

  const rows: DataRow[] = drivers.map((d) => ({
    key: d.id,
    searchText: [d.code, d.name, d.name_my, d.phone].filter(Boolean).map(String).join(" "),
    sort: {
      code: d.code,
      name: String(d.name ?? ""),
      name_my: String(d.name_my ?? ""),
      phone: String(d.phone ?? ""),
      licence_no: String(d.licence_no ?? ""),
      trips: Number(d.trips),
      is_active: d.is_active ? 1 : 0,
    },
    node: (
      <FleetRow record={d} fields={FIELDS}
                updateAction={updateDriver} setActiveAction={setDriverActive} />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>Drivers</h1>
        <HelpHint>
          Who drives. Kept apart from salespersons because on a route the
          driver and the salesman are routinely two people on one truck, and
          one record for both loses which of them was there.
          <br /><br />
          A driver who leaves is retired, never deleted — they still appear on
          the trips they drove, and removing the record would blank the answer
          to who carried goods on a journey that already happened.
        </HelpHint>
      </div>

      <SimpleForm action={createDriver} submitLabel="Add driver">
        <div className="card">
          <div className="card-head"><h2>New driver</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" name="code" type="text" placeholder="DRV-01" required />
              </div>
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" placeholder="U Aung" required />
              </div>
              <div className="field">
                <label htmlFor="name_my">Name (Burmese)</label>
                <input id="name_my" name="name_my" type="text" placeholder="မြန်မာလို အမည်" />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" name="phone" type="text" placeholder="09-…" />
              </div>
              <div className="field">
                <label htmlFor="licence_no">Licence</label>
                <input id="licence_no" name="licence_no" type="text" />
              </div>
            </div>
          </div>
        </div>
      </SimpleForm>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Drivers</h2>
            <span className="page-sub">{drivers.length} driver{drivers.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No drivers yet"
            searchPlaceholder="Search drivers…"
            defaultSort={{ key: "code", dir: "asc" }}
            columns={[
              { key: "code", label: "Code", sortable: true },
              { key: "name", label: "Name", sortable: true },
              { key: "name_my", label: "Burmese" },
              { key: "phone", label: "Phone", sortable: true },
              { key: "licence_no", label: "Licence" },
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
