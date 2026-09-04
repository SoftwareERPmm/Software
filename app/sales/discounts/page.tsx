import { sql } from "@/lib/db";
import { getCompany } from "@/lib/queries";
import { createVolumeDiscount, deactivateVolumeDiscount, activateVolumeDiscount } from "@/lib/actions";
import { VolumeDiscountForm } from "@/components/volume-discount-form";
import { VolumeDiscountRow } from "@/components/volume-discount-row";
import { money } from "@/lib/format";

export default async function Discounts() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [bands, items, groups] = await Promise.all([
    sql`select v.id, v.code, v.name, v.basis, v.min_value, v.max_value, v.discount_pct,
               v.is_active, to_char(v.valid_from,'YYYY-MM-DD') as valid_from,
               to_char(v.valid_to,'YYYY-MM-DD') as valid_to,
               i.name as item_name, g.name as group_name
          from volume_discount v
          left join item i on i.id = v.item_id
          left join item_group g on g.id = v.item_group_id
         where v.company_id = ${company.id}
         order by v.basis, v.min_value`,
    sql`select id, code, name from item where company_id = ${company.id} and is_active order by code`,
    sql`select id, name from item_group where company_id = ${company.id} and is_active order by code`,
  ]);

  const qtyBands = (bands as any[]).filter((b) => b.basis === "QUANTITY");
  const invBands = (bands as any[]).filter((b) => b.basis === "INVOICE_TOTAL");

  const table = (rows: any[], unit: (v: string | null) => string) => (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Code</th><th>Name</th><th>Applies to</th>
            <th className="r">From</th><th className="r">To</th>
            <th className="r">Discount</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <VolumeDiscountRow
              key={b.id} band={b} fromLabel={unit(b.min_value)} toLabel={unit(b.max_value)}
              deactivateAction={deactivateVolumeDiscount}
              activateAction={activateVolumeDiscount}
            />
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Volume discounts</h1>
        <span className="page-sub">
          Discounts the order earns, as opposed to the one a seller types on a
          line. A quantity band is read against what a line buys; an invoice
          band against the whole bill. <strong>Both can apply</strong> &mdash;
          a hundred units earning 5%, and the invoice passing ten million
          earning another 3% on what that leaves. Each is recorded on the
          invoice separately, so a line can say which rule gave which part.
        </span>
      </div>

      <VolumeDiscountForm action={createVolumeDiscount} items={items as never} groups={groups as never} />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>By quantity</h2>
            <span className="page-sub">read against a line&rsquo;s quantity</span>
          </div>
          {qtyBands.length === 0
            ? <div className="empty">No quantity bands. Every line is priced as entered.</div>
            : table(qtyBands, (v) => (v === null ? "and above" : String(Number(v))))}
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>By invoice total</h2>
            <span className="page-sub">read against the bill, after line discounts</span>
          </div>
          {invBands.length === 0
            ? <div className="empty">No invoice bands. Nothing is discounted for the size of the bill.</div>
            : table(invBands, (v) => (v === null ? "and above" : money(v)))}
        </div>
      </section>
    </>
  );
}
