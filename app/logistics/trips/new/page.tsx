import { sql } from "@/lib/db";
import { getCompany, getVehicles, getDrivers, getSalesmen, getLocations,
         getUncarriedDeliveries } from "@/lib/queries";
import { createTrip } from "@/lib/actions";
import { NewTripForm } from "@/components/new-trip-form";
import { HelpHint } from "@/components/help-hint";

export default async function NewTrip() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [vehicles, drivers, salesmen, locations, candidates] = await Promise.all([
    getVehicles(company.id), getDrivers(company.id), getSalesmen(company.id),
    getLocations(company.id), getUncarriedDeliveries(company.id),
  ]) as unknown as [
    Array<{ id: string; code: string; plate_no: string; is_active: boolean }>,
    Array<{ id: string; code: string; name: string; is_active: boolean }>,
    Array<{ id: string; code: string; name: string; is_active: boolean }>,
    Array<{ id: string; code: string; name: string; parent_id: string | null }>,
    Array<Parameters<typeof NewTripForm>[0]["candidates"][number]>,
  ];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>New trip</h1>
        <HelpHint>
          Pick the truck and who is on it, then tick the deliveries it is
          carrying. The order they are ticked in is the order they are
          visited, and it can be changed afterwards.
        </HelpHint>
      </div>

      <NewTripForm
        action={createTrip}
        today={today}
        vehicles={vehicles.filter((v) => v.is_active)}
        drivers={drivers.filter((d) => d.is_active)}
        salesmen={salesmen.filter((s) => s.is_active)}
        branches={locations.filter((l) => l.parent_id === null)}
        candidates={candidates}
      />
    </>
  );
}
