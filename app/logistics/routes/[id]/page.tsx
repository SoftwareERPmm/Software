import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getRoute, getRouteCandidates, getVehicles, getDrivers,
         getSalesmen, getLocations } from "@/lib/queries";
import { addRouteStops, removeRouteStop, reorderRouteStops,
         generateTripFromRoute, updateRoute, setRouteActive } from "@/lib/actions";
import { RoutePlan } from "@/components/route-plan";

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function RouteDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const found = await getRoute(company.id, id);
  if (!found) notFound();

  const { route, stops, runs } = found as unknown as {
    route: Parameters<typeof RoutePlan>[0]["route"];
    stops: Parameters<typeof RoutePlan>[0]["stops"];
    runs: Parameters<typeof RoutePlan>[0]["runs"];
  };
  const candidates = (await getRouteCandidates(company.id, id)) as unknown as
    Parameters<typeof RoutePlan>[0]["candidates"];

  const [vehicles, drivers, salesmen, locations] = await Promise.all([
    getVehicles(company.id), getDrivers(company.id),
    getSalesmen(company.id), getLocations(company.id),
  ]) as unknown as [
    Array<{ id: string; code: string; plate_no: string; is_active: boolean }>,
    Array<{ id: string; name: string; is_active: boolean }>,
    Array<{ id: string; name: string; is_active: boolean }>,
    Array<{ id: string; code: string; name: string; parent_id: string | null }>,
  ];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/logistics/routes" style={{ color: "inherit" }}>Routes</Link>
        </span>
        <h1>{route.name}</h1>
        <span className="page-sub">
          {route.code}
          {route.weekdays.length > 0 && (
            <> · runs {route.weekdays.map((d) => DAYS[d]).join(", ")}</>
          )}
          {route.location_name && <> · from {route.location_name}</>}
          {!route.is_active && <> · retired</>}
        </span>
      </div>

      <RoutePlan
        route={route}
        stops={stops}
        runs={runs}
        candidates={candidates}
        today={today}
        vehicles={vehicles.filter((v) => v.is_active)}
        drivers={drivers.filter((d) => d.is_active)}
        salesmen={salesmen.filter((x) => x.is_active)}
        branches={locations.filter((l) => l.parent_id === null)}
        addAction={addRouteStops}
        removeAction={removeRouteStop}
        reorderAction={reorderRouteStops}
        generateAction={generateTripFromRoute}
        updateAction={updateRoute}
        setActiveAction={setRouteActive}
      />
    </>
  );
}
