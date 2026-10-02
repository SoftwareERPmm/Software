import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { getCompany, getStockMovements } from "@/lib/queries";
import { VariantTags, asVariant } from "@/components/variant-tags";
import { ItemThumb } from "@/components/item-thumb";
import { HelpHint } from "@/components/help-hint";

const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const qty = (v: unknown) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * One item, everything true about it.
 *
 * The catalogue could only ever show an item as a row among others, and
 * the only way to see one on its own was to open its editor — which is a
 * form for changing things, not a page for reading them. A voucher line
 * naming an item had nowhere to point.
 *
 * Read-only on purpose. Editing stays in the catalogue panel, so there is
 * one place where an item is changed rather than two that can disagree.
 */
export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [item] = (await sql`
    select i.id, i.code, i.name, i.name_my, i.barcode, i.is_stocked, i.is_active,
           i.valuation_method, i.tracks_batch, i.tracks_expiry,
           i.parent_item_id,
           to_char(i.photo_updated_at, 'YYYYMMDDHH24MISSMS') as photo_version,
           u.code as uom_code,
           b.name as brand_name,
           g.name as group_name, g.id as group_id,
           pg.name as parent_group_name,
           p.code as parent_code, p.name as parent_name,
           (select json_agg(json_build_object('a', va.name, 'o', vo.name)
                      order by iva.sort_order)
              from item_variant_option ivo
              join variant_option vo on vo.id = ivo.option_id
              join variant_attribute va on va.id = vo.attribute_id
              left join item_variant_attribute iva
                     on iva.item_id = coalesce(i.parent_item_id, i.id)
                    and iva.attribute_id = va.id
             where ivo.item_id = i.id) as variant
      from item i
      join uom u on u.id = i.base_uom_id
      join item_group g on g.id = i.item_group_id
      left join item_group pg on pg.id = g.parent_id
      left join brand b on b.id = i.brand_id
      left join item p on p.id = i.parent_item_id
     where i.id = ${id} and i.company_id = ${company.id}`) as any[];

  if (!item) notFound();

  const [packs, prices, stock, movements, variants] = await Promise.all([
    sql`select u.code, iu.factor from item_uom iu
          join uom u on u.id = iu.uom_id
         where iu.item_id = ${id} order by iu.factor` as unknown as Promise<
      Array<{ code: string; factor: string }>>,
    // The price standing today at each level — a future-dated price is
    // real but not yet the answer, so it is not shown as one.
    sql`select pl.name as level, pl.sort_order, ip.price, u.code as uom_code,
               to_char(ip.valid_from, 'YYYY-MM-DD') as valid_from
          from price_level pl
          left join lateral (
            select ip.price, ip.uom_id, ip.valid_from from item_price ip
             where ip.item_id = ${id} and ip.price_level_id = pl.id
               and ip.valid_from <= current_date
             order by ip.valid_from desc limit 1) ip on true
          left join uom u on u.id = ip.uom_id
         where pl.company_id = ${company.id}
         order by pl.sort_order, pl.code` as unknown as Promise<
      Array<{ level: string; price: string | null; uom_code: string | null; valid_from: string | null }>>,
    sql`select l.code, l.name, s.qty_on_hand
          from v_stock_on_hand s join location l on l.id = s.location_id
         where s.item_id = ${id} and s.qty_on_hand <> 0
         order by l.code` as unknown as Promise<
      Array<{ code: string; name: string; qty_on_hand: string }>>,
    getStockMovements(company.id, id) as unknown as Promise<any[]>,
    sql`select i.id, i.code, i.name from item i
         where i.parent_item_id = ${id} order by i.code` as unknown as Promise<
      Array<{ id: string; code: string; name: string }>>,
  ]);

  const onHand = stock.reduce((s, r) => s + Number(r.qty_on_hand), 0);
  const recent = movements.slice(0, 12);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/items" className="plain">Master data</Link> · Items
        </span>
        <h1>
          {item.code} · {item.name}
          <VariantTags variant={asVariant(item.variant)} className="vartags-inline" />
        </h1>
        <div className="page-sub">
          {item.name_my && <>{item.name_my} · </>}
          {item.parent_group_name ? `${item.parent_group_name} / ` : ""}{item.group_name}
          {item.brand_name && <> · {item.brand_name}</>}
          {!item.is_stocked && <> · <span className="pill">service</span></>}
          {!item.is_active && <> · <span className="pill warn">inactive</span></>}
        </div>
      </div>

      <div className="actions" style={{ marginBottom: "var(--s3)" }}>
        {/* Editing lives in the catalogue, so this page cannot drift from
            the form that actually writes — but it opens on this item with
            its editor already up, rather than dropping you into a list of
            sixteen to find it again. */}
        <Link className="btn ghost" href={`/items?edit=${item.id}`}>Edit this item</Link>
        {item.is_stocked && (
          <Link className="btn ghost" href={`/inventory/movements?item=${item.id}`}>
            All stock movements
          </Link>
        )}
        {item.parent_item_id && (
          <Link className="btn ghost" href={`/items/${item.parent_item_id}`}>
            {item.parent_code} · the product this varies from
          </Link>
        )}
      </div>

      <section className="grid2">
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>How it is counted</h2>
              <HelpHint label="Base unit and packs">
                Stock is held in the base unit and nothing else &mdash; every
                quantity recorded against this item is a number in it, which
                is why it is settled when the item is created and left alone
                afterwards. A pack is a bigger unit priced and ordered in,
                converted to the base unit the moment a line is posted.
              </HelpHint>
            </div>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label>Item code</label>
                <div className="code">{item.code}</div>
              </div>
              <div className="field">
                <label>Base unit</label>
                <div className="code">{item.uom_code}</div>
              </div>
              <div className="field">
                <label>Valuation</label>
                <div className="code">{item.valuation_method}</div>
              </div>
              {item.barcode && (
                <div className="field">
                  <label>Barcode</label>
                  <div className="code">{item.barcode}</div>
                </div>
              )}
            </div>
            <div className="field" style={{ marginTop: "var(--s2)" }}>
              <label>Pack sizes</label>
              {packs.length === 0 ? (
                <span className="hint">
                  Bought and sold in {item.uom_code} only.
                </span>
              ) : (
                <ul className="plainlist">
                  {packs.map((p) => (
                    <li key={p.code} className="code">
                      1 {p.code} = {qty(p.factor)} {item.uom_code}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {(item.tracks_batch || item.tracks_expiry) && (
              <div className="field" style={{ marginTop: "var(--s2)" }}>
                <label>Tracking</label>
                <div>
                  {item.tracks_batch && <span className="pill">batches</span>}{" "}
                  {item.tracks_expiry && <span className="pill">expiry</span>}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Prices</h2>
            <span className="page-sub">today, per level</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Level</th><th className="r">Price</th><th>Per</th><th>From</th></tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.level}>
                    <td>{p.level}</td>
                    <td className="r">
                      {p.price === null
                        ? <span className="page-sub">not priced</span>
                        : <strong>{money(p.price)}</strong>}
                    </td>
                    <td className="code">{p.uom_code ?? "—"}</td>
                    <td className="page-sub">{p.valid_from ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {item.is_stocked && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>On hand</h2>
              <span className="page-sub">
                {qty(onHand)} {item.uom_code} across {stock.length}{" "}
                location{stock.length === 1 ? "" : "s"}
              </span>
            </div>
            {stock.length === 0 ? (
              <div className="empty">None in stock.</div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Warehouse</th><th className="r">Quantity</th></tr>
                  </thead>
                  <tbody>
                    {stock.map((s) => (
                      <tr key={s.code}>
                        <td><span className="code">{s.code}</span> {s.name}</td>
                        <td className="r">{qty(s.qty_on_hand)} {item.uom_code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {variants.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Variants</h2>
              <span className="page-sub">{variants.length}</span>
            </div>
            <div className="tablewrap">
              <table>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id}>
                      <td className="code">
                        <Link href={`/items/${v.id}`} style={{ color: "var(--brand)" }}>
                          {v.code}
                        </Link>
                      </td>
                      <td className="wrap">{v.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {item.is_stocked && recent.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Recent movements</h2>
              <span className="page-sub">newest {recent.length}</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Document</th><th>Warehouse</th>
                    <th className="r">Quantity</th><th className="r">Unit cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((m) => (
                    <tr key={m.id}>
                      <td>{String(m.movement_date).slice(0, 10)}</td>
                      <td>
                        <Link href={`/documents/${m.document_id}`}
                              style={{ color: "var(--brand)" }}>
                          {m.doc_no}
                        </Link>
                        <div className="subline">{m.doc_type}</div>
                      </td>
                      <td className="code">{m.location_code}</td>
                      <td className="r" style={{ color: Number(m.qty) < 0 ? "var(--bad)" : undefined }}>
                        {qty(m.qty)}
                      </td>
                      <td className="r">{m.unit_cost ? money(m.unit_cost) : "—"}</td>
                    </tr>
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
