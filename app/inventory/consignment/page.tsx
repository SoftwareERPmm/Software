import {
  getCompany, getConsignmentAgreements, getConsignedStockOnHand,
  getOwnedStockForItems, getConsignmentSuppliers, getItems,
} from "@/lib/queries";
import { createConsignmentAgreement, addConsignmentAgreementLine } from "@/lib/actions";
import { ConsignmentHub } from "@/components/consignment-hub";

export default async function ConsignmentPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [agreements, consignedStock, suppliers, items] = await Promise.all([
    getConsignmentAgreements(company.id) as any,
    getConsignedStockOnHand(company.id) as any,
    getConsignmentSuppliers(company.id) as any,
    getItems(company.id) as any,
  ]);

  const itemIds = [...new Set(consignedStock.map((r: any) => r.item_id))] as string[];
  const ownedStock = (await getOwnedStockForItems(company.id, itemIds)) as any;

  return (
    <ConsignmentHub
      agreements={agreements}
      consignedStock={consignedStock}
      ownedStock={ownedStock}
      suppliers={suppliers}
      items={items.filter((i: any) => i.is_stocked)}
      createAgreementAction={createConsignmentAgreement}
      addLineAction={addConsignmentAgreementLine}
    />
  );
}
