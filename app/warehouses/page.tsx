import { getCompany, getLocations } from "@/lib/queries";
import { createLocation, updateLocation, deleteLocation, deactivateLocation, activateLocation } from "@/lib/actions";
import { AddLocationForm } from "@/components/location-form";
import { LocationRow } from "@/components/location-row";

export type Location = {
  id: string; code: string; name: string; name_my: string | null;
  parent_id: string | null; parent_name: string | null;
  is_stock_location: boolean; is_active: boolean;
};
export type LocationNode = Location & { depth: number };

/**
 * Flattened parent-before-children order, each location immediately
 * followed by its own descendants — what makes indentation alone read as a
 * tree, without a separate nested-page structure like Categories has.
 * Locations are few enough (offices and the warehouses inside them, not
 * hundreds of items) that one page with depth is enough; no separate flat
 * list is needed the way Sub categories exists for items.
 */
function treeOrder(locations: Location[]): LocationNode[] {
  const byParent = new Map<string | null, Location[]>();
  for (const l of locations) {
    const key = l.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  const out: LocationNode[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const l of byParent.get(parentId) ?? []) {
      out.push({ ...l, depth });
      walk(l.id, depth + 1);
    }
  }
  walk(null, 0);

  // Anything whose parent isn't in this list at all (shouldn't happen —
  // parent_id is a foreign key — but a defensive fallback beats silently
  // dropping a row) surfaces at the top rather than disappearing.
  const seen = new Set(out.map((l) => l.id));
  for (const l of locations) if (!seen.has(l.id)) out.unshift({ ...l, depth: 0 });

  return out;
}

export default async function Warehouses() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const locations = (await getLocations(company.id)) as unknown as Location[];
  const nodes = treeOrder(locations);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Warehouses</h1>
        <span className="page-sub">
          Offices and the warehouses inside them, shown as one tree — a
          warehouse (holds stock) always sits inside an office (a site that
          doesn&rsquo;t hold stock itself).
        </span>
      </div>

      <AddLocationForm action={createLocation} locations={nodes} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Warehouses</h2>
            <span className="page-sub">{locations.length}</span>
          </div>

          {nodes.length === 0 ? (
            <div className="empty">None yet. Add your first warehouse above.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((l) => (
                    <LocationRow
                      key={l.id}
                      location={l}
                      depth={l.depth}
                      locations={nodes}
                      updateAction={updateLocation}
                      deleteAction={deleteLocation}
                      deactivateAction={deactivateLocation}
                      activateAction={activateLocation}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
