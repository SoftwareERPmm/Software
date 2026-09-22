import { getCompany, getPriceList } from "@/lib/queries";
import { sql } from "@/lib/db";
import { setItemPrice } from "@/lib/actions";
import { PriceRow } from "@/components/price-row";
import { HelpHint } from "@/components/help-hint";

export default async function Prices() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [list, packs] = await Promise.all([
    getPriceList(company.id) as unknown as Promise<Array<{
      item_id: string; code: string; name: string; base_uom_id: string; uom_code: string;
      level_id: string; level_name: string; sort_order: number;
      price: string | null; valid_from: string | null; prices: number;
    }>>,
    sql`select iu.item_id, iu.uom_id, iu.factor, u.code
          from item_uom iu
          join uom u on u.id = iu.uom_id
          join item i on i.id = iu.item_id
         where i.company_id = ${company.id}` as unknown as Promise<Array<{
      item_id: string; uom_id: string; factor: string; code: string;
    }>>,
  ]);

  // The query returns one row per item per level; the table wants one row per
  // item with a column per level.
  const levels = [...new Map(list.map((r) => [r.level_id, r])).values()]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({ id: r.level_id, name: r.level_name }));

  const items = [...new Map(list.map((r) => [r.item_id, r])).values()].map((r) => ({
    itemId: r.item_id,
    code: r.code,
    name: r.name,
    baseUomId: r.base_uom_id,
    uomCode: r.uom_code,
    packs: packs
      .filter((p) => p.item_id === r.item_id)
      .map((p) => ({ uomId: p.uom_id, code: p.code, factor: Number(p.factor) })),
    levels: levels.map((l) => {
      const cell = list.find((x) => x.item_id === r.item_id && x.level_id === l.id);
      return {
        levelId: l.id,
        levelName: l.name,
        price: cell?.price ?? null,
        validFrom: cell?.valid_from ?? null,
        prices: Number(cell?.prices ?? 0),
      };
    }),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const priced = items.filter((i) => i.levels.some((l) => l.price !== null)).length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Price list</h1>
        <HelpHint>
          What each item sells for, at each level. A customer on a level gets
          that column filled in on their sales lines; a customer on none gets
          the first.
          <br /><br />
          A price belongs to a date. Changing one adds the next price from the
          day it applies rather than overwriting the last, so an invoice
          raised in March keeps March&rsquo;s price — the line records what
          was actually charged, and this list is only ever the suggestion.
          <br /><br />
          A price is per unit, and the unit can be a pack: an item sold in
          cartons can carry a carton price beside its piece price.
        </HelpHint>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Prices</h2>
            <span className="page-sub">
              {priced} of {items.length} item{items.length === 1 ? "" : "s"} priced
            </span>
          </div>

          {items.length === 0 ? (
            <div className="empty">No items yet.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Item</th>
                    {levels.map((l) => (
                      <th key={l.id} className="r">{l.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <PriceRow key={row.itemId} row={row} today={today} action={setItemPrice} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
