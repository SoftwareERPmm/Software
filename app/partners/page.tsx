import Link from "next/link";
import { getCompany, getPartners } from "@/lib/queries";
import { sql } from "@/lib/db";
import { updatePartner, deactivatePartner, activatePartner, deletePartner } from "@/lib/actions";
import { PartnerRow } from "@/components/partner-row";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

export default async function Partners({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; category?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { role, category } = await searchParams;
  const all = (await getPartners(company.id)) as any[];
  // The price columns this company keeps, so a customer can be put on one.
  const priceLevels = (await sql`
    select id, name from price_level where company_id = ${company.id} order by sort_order`
  ) as unknown as { id: string; name: string }[];
  const allCategories = (await sql`
    select id, name, kind from partner_category
     where company_id = ${company.id} and is_active order by sort_order, name`
  ) as unknown as { id: string; name: string; kind: string }[];
  const categories = allCategories.filter((c) => c.kind === "CUSTOMER");
  const supplierCategories = allCategories.filter((c) => c.kind === "SUPPLIER");

  // Customers and Suppliers in the nav are filtered views of this same
  // table, not separate lists — the same company is routinely both, and
  // splitting the data would mean reconciling one partner against itself.
  const byRole =
    role === "customer" ? all.filter((p) => p.is_customer)
    : role === "supplier" ? all.filter((p) => p.is_supplier)
    : all;

  /* ?category=<id> narrows to one kind of trade, and ?category=none to the
     ones nobody has classified — the second is the useful one while the
     field is still being filled in. */
  const partners =
    category === "none"
      ? byRole.filter((p) => (role === "supplier" ? !p.supplier_category_id : !p.category_id))
    : category
      ? byRole.filter((p) => p.category_id === category || p.supplier_category_id === category)
    : byRole;
  const uncategorised = byRole.filter((p) =>
    role === "supplier" ? !p.supplier_category_id : !p.category_id).length;
  // The filter bar offers the side being looked at.
  const filterCats = role === "supplier" ? supplierCategories : categories;

  const rows: DataRow[] = partners.map((p) => ({
    key: p.id,
    searchText: [p.code, p.name, p.name_my, p.region, p.township].filter(Boolean).join(" "),
    sort: {
      code: p.code,
      name: p.name,
      role: `${p.is_customer ? "Customer" : ""} ${p.is_supplier ? "Supplier" : ""}`.trim(),
      region: p.region ?? "",
      township: p.township ?? "",
      price_level: p.price_level_name ?? "",
      category: (role === "supplier" ? p.supplier_category_name : p.category_name) ?? "",
      payment_terms_days: Number(p.payment_terms_days),
      outstanding: Number(p.outstanding),
      // Sorting by what is left of a limit puts whoever is closest to it at
      // the top. Customers with no limit sort last rather than first, since
      // "not set" is not the same as "nothing left".
      credit_limit: p.credit_limit === null ? -1 : Number(p.credit_limit),
      available: p.credit_limit === null
        ? Number.MAX_SAFE_INTEGER
        : Number(p.available ?? p.credit_limit),
      is_active: p.is_active ? 1 : 0,
    },
    node: (
      <PartnerRow
        partner={p}
        priceLevels={priceLevels}
        categories={categories}
        supplierCategories={supplierCategories}
        updateAction={updatePartner}
        deactivateAction={deactivatePartner}
        activateAction={activatePartner}
        deleteAction={deletePartner}
      />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>{role === "customer" ? "Customers" : role === "supplier" ? "Suppliers" : "Business partners"}</h1>
        <HelpHint>
          {role
            ? "A filtered view of the same partner table — one record can be both a customer and a supplier."
            : "One table with roles rather than separate customer and supplier lists — here the same company is routinely both."}
        </HelpHint>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{role === "customer" ? "Customers" : role === "supplier" ? "Suppliers" : "Partners"}</h2>
            <span className="actions">
              {/* Only offered once categories exist, and the uncategorised
                  count is shown because a classification half filled in is
                  worse than none — it looks complete on a report. */}
              {filterCats.length > 0 && (
                <span className="page-sub">
                  <Link href={role ? `/partners?role=${role}` : "/partners"}
                        style={{ color: !category ? "var(--brand)" : "inherit" }}>
                    All
                  </Link>
                  {filterCats.map((c) => (
                    <span key={c.id}>
                      {" · "}
                      <Link href={`/partners?${role ? `role=${role}&` : ""}category=${c.id}`}
                            style={{ color: category === c.id ? "var(--brand)" : "inherit" }}>
                        {c.name}
                      </Link>
                    </span>
                  ))}
                  {uncategorised > 0 && (
                    <>
                      {" · "}
                      <Link href={`/partners?${role ? `role=${role}&` : ""}category=none`}
                            style={{ color: category === "none" ? "var(--brand)" : "inherit" }}>
                        Not categorised ({uncategorised})
                      </Link>
                    </>
                  )}
                </span>
              )}
              <span className="page-sub">{partners.length} records</span>
              <Link href="/partners/new" className="btn">New partner</Link>
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No partners yet"
            searchPlaceholder="Search partners…"
            defaultSort={{ key: "code", dir: "asc" }}
            columns={[
              { key: "code", label: "Code", sortable: true },
              { key: "name", label: "Name", sortable: true },
              { key: "role", label: "Role", sortable: true },
              { key: "region", label: "Region", sortable: true },
              { key: "township", label: "Township", sortable: true },
              { key: "price_level", label: "Price level", sortable: true },
              { key: "category", label: "Category", sortable: true },
              { key: "payment_terms_days", label: "Terms", sortable: true, align: "r" },
              { key: "outstanding", label: "Outstanding", sortable: true, align: "r" },
              { key: "credit_limit", label: "Credit limit", sortable: true, align: "r" },
              { key: "available", label: "Left to spend", sortable: true, align: "r" },
              { key: "is_active", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
