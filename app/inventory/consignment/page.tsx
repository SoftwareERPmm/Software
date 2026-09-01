import {
  getCompany, getConsignmentAgreements, getConsignedStockOnHand,
  getOwnedStockForItems, getConsignmentSupplierChoices, getItems,
} from "@/lib/queries";
import { createConsignmentAgreement, addConsignmentAgreementLine, getFormData } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { ConsignmentHub } from "@/components/consignment-hub";

export default async function ConsignmentPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [agreements, consignedStock, suppliers, items] = await Promise.all([
    getConsignmentAgreements(company.id) as any,
    getConsignedStockOnHand(company.id) as any,
    getConsignmentSupplierChoices(company.id) as any,
    getItems(company.id) as any,
  ]);

  const itemIds = [...new Set(consignedStock.map((r: any) => r.item_id))] as string[];
  const ownedStock = (await getOwnedStockForItems(company.id, itemIds)) as any;

  // A consignor often wants to place a product the catalogue has never
  // carried. Rather than sending the user off to Master Data and losing the
  // agreement they were part-way through, the item can be created from here —
  // into the ordinary item master, not a consignment-only one. Creating the
  // item says what the product IS; it says nothing about who owns the units,
  // which is settled by the consignment lot at receipt.
  const categories = await allCategories(company.id);
  const { uoms } = await getFormData();

  return (
    <ConsignmentHub
      agreements={agreements}
      consignedStock={consignedStock}
      ownedStock={ownedStock}
      suppliers={suppliers}
      items={items.filter((i: any) => i.is_stocked)}
      categories={categories as any}
      uoms={uoms as any}
      createAgreementAction={createConsignmentAgreement}
      addLineAction={addConsignmentAgreementLine}
    />
  );
}
