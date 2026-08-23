import { getCompany, getSalesmen, getLocations } from "@/lib/queries";
import { createSalesman, updateSalesman, deleteSalesman, deactivateSalesman, activateSalesman } from "@/lib/actions";
import { AddSalesmanForm } from "@/components/salesman-form";
import { SalesmanRow } from "@/components/salesman-row";
import { DataTable, type DataRow } from "@/components/data-table";

export default async function Salespersons() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [salesmen, locations] = (await Promise.all([
    getSalesmen(company.id),
    getLocations(company.id),
  ])) as unknown as [
    Array<{
      id: string; code: string; name: string; name_my: string | null;
      phone: string | null; location_id: string | null; location_name: string | null;
      commission_pct: string; is_active: boolean;
    }>,
    Array<{ id: string; code: string; name: string }>,
  ];

  const rows: DataRow[] = salesmen.map((s) => ({
    key: s.id,
    searchText: [s.code, s.name, s.name_my, s.phone, s.location_name].filter(Boolean).join(" "),
    sort: {
      code: s.code,
      name: s.name,
      phone: s.phone ?? "",
      location_name: s.location_name ?? "",
      commission_pct: Number(s.commission_pct),
    },
    node: (
      <SalesmanRow
        salesman={s}
        locations={locations}
        updateAction={updateSalesman}
        deleteAction={deleteSalesman}
        deactivateAction={deactivateSalesman}
        activateAction={activateSalesman}
      />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Salespersons</h1>
        <span className="page-sub">
          Staff who get credited on a sale. Commission is reported on here,
          not paid automatically &mdash; paying it out is a payroll matter.
        </span>
      </div>

      <AddSalesmanForm action={createSalesman} locations={locations} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Salespersons</h2>
            <span className="page-sub">{salesmen.length}</span>
          </div>

          {salesmen.length === 0 ? (
            <div className="empty">None yet. Add your first salesperson above.</div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No salespersons"
              searchPlaceholder="Search salespersons…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "phone", label: "Phone", sortable: true },
                { key: "location_name", label: "Branch", sortable: true },
                { key: "commission_pct", label: "Commission", sortable: true, align: "r" },
                { key: "actions", label: "" },
              ]}
            />
          )}
        </div>
      </section>
    </>
  );
}
