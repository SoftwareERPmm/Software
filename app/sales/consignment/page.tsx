import { getCompany, getConsignedStockOnHand, getPartners, getLocations } from "@/lib/queries";
import { createConsignmentSale } from "@/lib/actions";
import { ConsignmentSaleForm } from "@/components/consignment-sale-form";

export default async function ConsignmentSalePage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [batches, partners, allLocations] = await Promise.all([
    getConsignedStockOnHand(company.id) as any,
    getPartners(company.id) as any,
    getLocations(company.id) as any,
  ]);

  const customers = partners.filter((p: any) => p.is_customer);
  const locations = allLocations.filter((l: any) => l.is_stock_location);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <ConsignmentSaleForm
      allBatches={batches}
      customers={customers}
      locations={locations}
      today={today}
      action={createConsignmentSale}
    />
  );
}
