import { getCompany, getItems, getPartners, getSupplierItems } from "@/lib/queries";
import { saveSupplierItem, deleteSupplierItem } from "@/lib/actions";
import { SupplierItemForm, SupplierItemRow } from "@/components/supplier-item-form";
import { HelpHint } from "@/components/help-hint";

/**
 * Purchasing terms, recorded only where they are unusual.
 *
 * Nearly every item comes from its supplier at that supplier's usual
 * speed, and nearly every company will leave this page empty. It exists
 * for the one product that is made to order while everything else sits in
 * a warehouse — the exception that a single figure on the supplier cannot
 * express.
 *
 * Three levels, most specific first:
 *   this item from this supplier  → a row here
 *   this supplier generally       → Partners, on the supplier
 *   knowing nothing               → the company default
 */
export default async function PurchasingTerms() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [rows, partners, items] = await Promise.all([
    getSupplierItems(company.id) as unknown as Promise<any[]>,
    getPartners(company.id) as unknown as Promise<any[]>,
    getItems(company.id) as unknown as Promise<any[]>,
  ]);

  const suppliers = partners
    .filter((p) => p.is_supplier && p.is_active)
    .map((p) => ({ id: p.id, code: p.code, name: p.name,
                   lead_time_days: p.lead_time_days as number | null }));
  // A product with variants cannot be bought — its variants are.
  const buyable = items
    .filter((i) => i.is_stocked && i.variant_count === 0)
    .map((i) => ({ id: i.id, code: i.code, name: i.name }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Purchasing terms</h1>
        <HelpHint>
          How long one item takes from one supplier, where it differs from
          that supplier&rsquo;s usual lead time. Most items need no row here:
          leave it blank and the supplier&rsquo;s own figure is used, and
          failing that the company default of{" "}
          {company.default_lead_time_days} days.
          <br /><br />
          This is the <strong>expected</strong> lead time — the planned
          figure replenishment orders against. What the receipts say
          actually happened is measured separately and shown beside it, and
          never overwrites what you set here.
        </HelpHint>
      </div>

      <SupplierItemForm
        action={saveSupplierItem}
        suppliers={suppliers}
        items={buyable}
        companyDefault={company.default_lead_time_days}
      />

      {rows.length === 0 ? (
        <div className="empty">
          No exceptions recorded. Every item is assumed to arrive at its
          supplier&rsquo;s usual speed, which is usually true.
        </div>
      ) : (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Exceptions</h2>
              <span className="page-sub">
                {rows.length} item/supplier pair{rows.length === 1 ? "" : "s"} that
                differ from the usual
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Item / Supplier</th>
                    <th className="r">Usual</th>
                    <th className="r">Override</th>
                    <th className="r">Effective</th>
                    <th>Their code</th><th>Note</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <SupplierItemRow
                      key={r.id}
                      row={r}
                      companyDefault={company.default_lead_time_days}
                      remove={deleteSupplierItem}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
