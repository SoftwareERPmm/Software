import { getCompany, getPartnerCategories } from "@/lib/queries";
import { createPartnerCategory, updatePartnerCategory,
         setPartnerCategoryActive, deletePartnerCategory } from "@/lib/actions";
import { PartnerCategoryRow } from "@/components/partner-category-row";
import { SimpleForm } from "@/components/simple-form";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

export default async function PartnerCategories() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const cats = (await getPartnerCategories(company.id)) as unknown as Array<
    Parameters<typeof PartnerCategoryRow>[0]["category"]
  >;
  const filed = cats.reduce((t, c) => t + Number(c.partners), 0);

  const rows: DataRow[] = cats.map((c) => ({
    key: c.id,
    searchText: [c.code, c.name, c.name_my, c.note].filter(Boolean).map(String).join(" "),
    sort: {
      sort_order: Number(c.sort_order),
      code: c.code,
      name: c.name,
      partners: Number(c.partners),
      customers: Number(c.customers),
      is_active: c.is_active ? 1 : 0,
    },
    node: (
      <PartnerCategoryRow
        category={c}
        updateAction={updatePartnerCategory}
        setActiveAction={setPartnerCategoryActive}
        deleteAction={deletePartnerCategory}
      />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Customer categories</h1>
        <HelpHint>
          What kind of shop a partner is — a supermarket chain, a township
          wholesaler, a corner store, a pharmacy. They buy differently, are
          visited differently and are worth different money, and without this
          the only way to tell them apart is to recognise the name.
          <br /><br />
          <strong>Classification only.</strong> A category sets no price, no
          credit limit and no payment terms. Those were agreed with the shop
          and live on the shop, so that one customer&rsquo;s terms never depend
          on a field edited on a different screen.
          <br /><br />
          Flat rather than nested: a shop is a supermarket or it is not, and a
          second level would be filled with guesses.
        </HelpHint>
      </div>

      <SimpleForm action={createPartnerCategory} submitLabel="Add category">
        <div className="card">
          <div className="card-head"><h2>New category</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" name="code" type="text" placeholder="SUPER" required />
              </div>
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" placeholder="Supermarket" required />
              </div>
              <div className="field">
                <label htmlFor="name_my">Name (Burmese)</label>
                <input id="name_my" name="name_my" type="text" placeholder="မြန်မာလို အမည်" />
              </div>
              <div className="field">
                <label htmlFor="sort_order">Order</label>
                <input id="sort_order" name="sort_order" type="number" defaultValue={0} />
                <span className="hint">Where it sits on a report</span>
              </div>
            </div>
            <div className="field" style={{ marginTop: "1rem" }}>
              <label htmlFor="note">Note</label>
              <input id="note" name="note" type="text"
                     placeholder="What counts as this kind of shop" />
            </div>
          </div>
        </div>
      </SimpleForm>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Categories</h2>
            <span className="page-sub">
              {cats.length} categor{cats.length === 1 ? "y" : "ies"} · {filed} partner
              {filed === 1 ? "" : "s"} filed
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No categories yet"
            searchPlaceholder="Search categories…"
            defaultSort={{ key: "sort_order", dir: "asc" }}
            columns={[
              { key: "sort_order", label: "#", sortable: true, align: "r" },
              { key: "code", label: "Code", sortable: true },
              { key: "name", label: "Category", sortable: true },
              { key: "note", label: "Note" },
              { key: "customers", label: "Customers", sortable: true, align: "r" },
              { key: "partners", label: "All partners", sortable: true, align: "r" },
              { key: "is_active", label: "Status", sortable: true },
              { key: "actions", label: "" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
