import { getCompany, getConsignmentAgreements, getLocations } from "@/lib/queries";
import { createConsignmentReceipt } from "@/lib/actions";
import { ConsignmentReceiveForm } from "@/components/consignment-receive-form";

export default async function ReceiveConsignmentPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [agreements, allLocations] = await Promise.all([
    getConsignmentAgreements(company.id) as any,
    getLocations(company.id) as any,
  ]);
  const locations = allLocations.filter((l: any) => l.is_stock_location);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <ConsignmentReceiveForm
      agreements={agreements}
      locations={locations}
      today={today}
      action={createConsignmentReceipt}
    />
  );
}
