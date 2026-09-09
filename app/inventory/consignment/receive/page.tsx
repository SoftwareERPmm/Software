import { getCompany, getConsignmentAgreements, getLocations } from "@/lib/queries";
import { sql } from "@/lib/db";
import { createConsignmentReceipt } from "@/lib/actions";
import { ConsignmentReceiveForm } from "@/components/consignment-receive-form";

export default async function ReceiveConsignmentPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [agreements, allLocations, items] = await Promise.all([
    getConsignmentAgreements(company.id) as any,
    getLocations(company.id) as any,
    // Everything stocked, so a consignor can send something the agreement
    // does not name yet and its terms are agreed as it arrives.
    sql`select id, code, name, is_stocked from item
         where company_id = ${company.id} and is_stocked and is_active order by code` as any,
  ]);
  const locations = allLocations.filter((l: any) => l.is_stock_location);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <ConsignmentReceiveForm
      agreements={agreements}
      locations={locations}
      today={today}
      action={createConsignmentReceipt}
      items={items}
    />
  );
}
