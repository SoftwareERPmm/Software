import { getCompany, getVehicles, getDrivers, getSalesmen, getLocations } from "@/lib/queries";
import { createRoute } from "@/lib/actions";
import { SimpleForm } from "@/components/simple-form";
import { HelpHint } from "@/components/help-hint";

const DAYS = [
  { n: 1, label: "Monday" }, { n: 2, label: "Tuesday" }, { n: 3, label: "Wednesday" },
  { n: 4, label: "Thursday" }, { n: 5, label: "Friday" }, { n: 6, label: "Saturday" },
  { n: 7, label: "Sunday" },
];

export default async function NewRoute() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [vehicles, drivers, salesmen, locations] = await Promise.all([
    getVehicles(company.id), getDrivers(company.id),
    getSalesmen(company.id), getLocations(company.id),
  ]) as unknown as [
    Array<{ id: string; code: string; plate_no: string; is_active: boolean }>,
    Array<{ id: string; name: string; is_active: boolean }>,
    Array<{ id: string; name: string; is_active: boolean }>,
    Array<{ id: string; code: string; name: string; parent_id: string | null }>,
  ];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>New route</h1>
        <HelpHint>
          Name the beat and say which days it runs. Who normally takes it is a
          default copied on to each generated trip — the trip records who
          actually went, so changing this later never rewrites a past run.
        </HelpHint>
      </div>

      <SimpleForm action={createRoute} submitLabel="Create route">
        <div className="card">
          <div className="card-head"><h2>The beat</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" name="code" type="text" placeholder="BAHAN-MON" required />
              </div>
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text"
                       placeholder="Bahan — Monday beat" required />
              </div>
              <div className="field">
                <label htmlFor="location_id">Runs out of</label>
                <select id="location_id" name="location_id" defaultValue="">
                  <option value="">Not set</option>
                  {locations.filter((l) => l.parent_id === null).map((l) => (
                    <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field" style={{ marginTop: "1rem" }}>
              <label>Days it runs</label>
              <div className="row">
                {DAYS.map((d) => (
                  <label className="check" key={d.n} htmlFor={`day-${d.n}`}>
                    <input id={`day-${d.n}`} name="weekday" type="checkbox" value={d.n} />
                    {d.label}
                  </label>
                ))}
              </div>
              <span className="hint">
                Used to tell you whether today is one of this beat&rsquo;s days.
                Nothing generates by itself.
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Who normally takes it</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="salesman_id">Salesperson</label>
                <select id="salesman_id" name="salesman_id" defaultValue="">
                  <option value="">Not set</option>
                  {salesmen.filter((s) => s.is_active).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="driver_id">Driver</label>
                <select id="driver_id" name="driver_id" defaultValue="">
                  <option value="">Not set</option>
                  {drivers.filter((d) => d.is_active).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="vehicle_id">Vehicle</label>
                <select id="vehicle_id" name="vehicle_id" defaultValue="">
                  <option value="">Not set</option>
                  {vehicles.filter((v) => v.is_active).map((v) => (
                    <option key={v.id} value={v.id}>{v.code} · {v.plate_no}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginTop: "1rem" }}>
              <label htmlFor="note">Note</label>
              <input id="note" name="note" type="text"
                     placeholder="Carried on to each trip generated from this beat" />
            </div>
          </div>
        </div>
      </SimpleForm>
    </>
  );
}
