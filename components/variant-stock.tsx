import Link from "next/link";
import { ItemThumb } from "./item-thumb";
import { variantPhotos, type VariantPart } from "@/lib/variants";

/**
 * What is on the shelf, read by colour — or by size.
 *
 * A stock table has one line per sellable thing, which is the only grain
 * the ledger has and the only one a count can be checked against. But
 * "twelve rows of Polo Shirt" is not how anybody thinks about a rail of
 * shirts. The question is how much Red there is, or whether M has run out
 * across every colour, and neither is answerable by reading twelve lines.
 *
 * So the same rows are offered folded, and which way they fold is a tab.
 * Nothing here is a new figure: every total is the sum of the lines the
 * table already shows, and the lines are still there to be checked against.
 *
 * The picture belongs to the colour rather than to the combination. Black
 * in S, M and L is one photograph of one shirt, and making somebody upload
 * it three times would get it wrong on the third.
 */

export type { VariantPart };

export type VariantStockRow = {
  id: string; code: string; name: string; is_active: boolean;
  parent_item_id: string; parent_code: string; parent_name: string;
  category_name: string;
  photo_version: string | null;
  qty_on_hand: string; value_on_hand: string; uom_code: string;
  parts: VariantPart[] | null;
};

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function VariantStock({
  rows, groupBy, basePath, keep = {},
}: {
  rows: VariantStockRow[];
  /** The attribute being folded on, from the query string. */
  groupBy?: string;
  basePath: string;
  /** Other query parameters this page owns, so switching tab keeps them. */
  keep?: Record<string, string | undefined>;
}) {
  const withParts = rows.filter((r) => r.parts && r.parts.length > 0);
  if (withParts.length === 0) return null;

  // Every attribute in use, in the order products declare them.
  const attrs = new Map<string, { id: string; name: string; sort: number }>();
  for (const r of withParts) {
    for (const p of r.parts!) {
      if (!attrs.has(p.attributeId)) {
        attrs.set(p.attributeId, { id: p.attributeId, name: p.attribute, sort: p.attributeSort });
      }
    }
  }
  const attrList = [...attrs.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  /**
   * Which tab opens first.
   *
   * The one carrying the pictures, because that is the one somebody is
   * looking at rather than reading — and in a clothing catalogue that is
   * the colour. Falls back to the first declared when nothing has a photo
   * yet, which is only true of a catalogue nobody has put pictures in.
   */
  const photos = variantPhotos(withParts);
  const photoAttr = attrList.find((a) => a.id === photos.photoAttributeId) ?? attrList[0];
  const hasPhotos = photos.photoAttributeId !== null;
  const active = attrList.find((a) => a.id === groupBy) ?? photoAttr;

  /** Only the tab the pictures belong to carries them. */
  const showThumbs = hasPhotos && active.id === photoAttr.id;

  const href = (attributeId: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
    q.set("group", attributeId);
    return `${basePath}?${q.toString()}`;
  };

  // Only products that actually vary by the chosen attribute. A shirt that
  // comes in colours but one size has nothing to say on the Size tab, and
  // listing it with a single row under each heading is noise.
  const products = new Map<string, VariantStockRow[]>();
  for (const r of withParts) {
    if (!r.parts!.some((p) => p.attributeId === active.id)) continue;
    const list = products.get(r.parent_item_id) ?? [];
    list.push(r);
    products.set(r.parent_item_id, list);
  }
  if (products.size === 0) return null;

  return (
    <section>
      <div className="card">
        <div className="card-head">
          <h2>By {active.name.toLowerCase()}</h2>
          <span className="page-sub">
            the same stock as the table above, folded — totals are its lines added up
          </span>
        </div>

        {attrList.length > 1 && (
          <div className="card-body" style={{ paddingBottom: 0 }}>
            <div className="scopetabs" style={{ margin: 0 }}>
              {attrList.map((a) => (
                <Link key={a.id} className="scopetab" data-active={a.id === active.id}
                      href={href(a.id)}>
                  By {a.name.toLowerCase()}
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="card-body">
          {[...products.entries()].map(([parentId, variants]) => {
            const head = variants[0];

            /**
             * The unit these figures are in.
             *
             * Every variant of a product inherits the parent's base unit, so
             * there is normally exactly one and it belongs in the column
             * heading rather than repeated down the rows. If that ever stops
             * being true the totals would be adding boxes to pieces, so the
             * heading says so instead of quietly summing them.
             */
            const units = [...new Set(variants.map((v) => v.uom_code))];
            const unit = units.length === 1 ? units[0] : null;

            /**
             * Whether there is anything left to break down.
             *
             * A shirt that comes in colours and nothing else has no sizes to
             * list under Red, and a Breakdown column that can only ever hold
             * a dash reads as data that failed to arrive. So the column goes
             * rather than the explanation being left to the reader.
             */
            const hasBreakdown = variants.some(
              (v) => v.parts!.some((x) => x.attributeId !== active.id));

            // One bucket per value of the chosen attribute.
            const groups = new Map<string, { label: string; sort: number; members: VariantStockRow[] }>();
            for (const v of variants) {
              const p = v.parts!.find((x) => x.attributeId === active.id)!;
              const g = groups.get(p.optionId)
                ?? { label: p.option, sort: p.optionSort, members: [] };
              g.members.push(v);
              groups.set(p.optionId, g);
            }
            const ordered = [...groups.values()].sort((a, b) => a.sort - b.sort);

            return (
              <div key={parentId} className="vgroup">
                <div className="vgroup-head">
                  <span className="m">{head.parent_code}</span>
                  <strong>{head.parent_name}</strong>
                  <span className="page-sub">
                    {variants.length} variant{variants.length === 1 ? "" : "s"}
                    {unit ? ` \u00b7 counted in ${unit}` : ""}
                    {!hasBreakdown ? ` \u00b7 varies by ${active.name.toLowerCase()} only` : ""}
                  </span>
                  {!unit && (
                    <span className="pill warn">
                      mixed units: {units.join(", ")} — totals not comparable
                    </span>
                  )}
                </div>

                <table className="vgroup-table">
                  <thead>
                    <tr>
                      <th colSpan={showThumbs ? 2 : 1}>{active.name}</th>
                      {hasBreakdown && <th>Breakdown</th>}
                      <th className="r">
                        On hand{unit ? ` (${unit})` : ""}
                      </th>
                      <th className="r">Value (MMK)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map((g) => {
                      const total = g.members.reduce((s, m) => s + Number(m.qty_on_hand), 0);
                      const value = g.members.reduce((s, m) => s + Number(m.value_on_hand), 0);
                      // The colour's picture, looked up by the colour so
                      // that every size of it shows the same shirt.
                      const shot = showThumbs ? photos.pictureFor(g.members[0]) : null;
                      // What is left of a variant once the grouping
                      // attribute is taken out: the sizes, on a colour row.
                      const rest = (v: VariantStockRow) => v.parts!
                        .filter((p) => p.attributeId !== active.id)
                        .sort((a, b) => a.attributeSort - b.attributeSort)
                        .map((p) => p.option).join(" / ");

                      return (
                        <tr key={g.label}>
                          {showThumbs && (
                            <td className="vgroup-thumb">
                              <ItemThumb
                                src={shot ? `/items/${shot.id}/photo?v=${shot.photo_version}` : null}
                                name={`${head.parent_name} ${g.label}`}
                              />
                            </td>
                          )}
                          <td><strong>{g.label}</strong></td>
                          {hasBreakdown && (
                          <td className="wrap">
                                <span className="vbreak">
                                  {g.members
                                    .slice()
                                    .sort((a, b) => {
                                      const oa = a.parts!.find((p) => p.attributeId !== active.id);
                                      const ob = b.parts!.find((p) => p.attributeId !== active.id);
                                      return (oa?.optionSort ?? 0) - (ob?.optionSort ?? 0);
                                    })
                                    .map((m) => (
                                      <span key={m.id}
                                            className={`vbreak-cell${Number(m.qty_on_hand) === 0 ? " zero" : ""}`}
                                            title={m.code}>
                                        {!showThumbs && hasPhotos && (() => {
                                          const c = photos.pictureFor(m);
                                          return c ? (
                                            <ItemThumb
                                              src={`/items/${c.id}/photo?v=${c.photo_version}`}
                                              name={rest(m) || m.code}
                                            />
                                          ) : null;
                                        })()}
                                        <span className="vbreak-label">{rest(m) || m.code}</span>
                                        <span className="vbreak-qty">{qty(Number(m.qty_on_hand))}</span>
                                      </span>
                                    ))}
                                </span>
                          </td>
                          )}
                          <td className="r" style={{ color: total === 0 ? "var(--muted)" : undefined }}>
                            {qty(total)}
                          </td>
                          <td className="r">{money(value)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
