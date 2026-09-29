import Link from "next/link";
import { sql } from "@/lib/db";
import { getCompany, getVariantGrid, getVariantStock } from "@/lib/queries";
import { saveVariantGrid } from "@/lib/actions";
import { VariantGrid, type GridRow } from "@/components/variant-grid";
import { variantPhotos } from "@/lib/variants";
import { HelpHint } from "@/components/help-hint";

/**
 * One product's variants, all editable at once.
 *
 * Reached from the catalogue, because that is where somebody is when they
 * realise the twelve sizes they just created have no barcodes on them.
 */
export default async function VariantsOfProduct({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [parent] = await sql`
    select id, code, name, base_uom_id from item
     where id = ${id} and company_id = ${company.id}`;
  if (!parent) return <div className="empty">No such product.</div>;

  const [uom] = await sql`select code from uom where id = ${parent.base_uom_id}`;

  const { level, rows } = (await getVariantGrid(company.id, id)) as unknown as
    { level: { id: string; name: string } | null; rows: any[] };

  if (rows.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Master data</span>
          <h1>{parent.name}</h1>
        </div>
        <div className="empty">
          {parent.code} has no variants. A product only has them if it was
          created with sizes or colours.{" "}
          <Link href="/items" style={{ color: "var(--brand)" }}>Back to items</Link>
        </div>
      </>
    );
  }

  // The garment for each row, resolved by colour the same way every other
  // screen does it, so a size with no photograph of its own still shows one.
  const variantStock = (await getVariantStock(company.id)) as unknown as
    Parameters<typeof variantPhotos>[0];
  const photos = variantPhotos(variantStock);
  const srcOf = (itemId: string) => {
    const v = variantStock.find((x) => x.id === itemId);
    return v ? photos.srcFor(v) : null;
  };

  const gridRows: GridRow[] = rows.map((r) => ({
    id: r.id, code: r.code, name: r.name,
    barcode: r.barcode, price: r.price,
    is_active: r.is_active, on_hand: r.on_hand,
    photoSrc: srcOf(r.id),
    parts: r.parts,
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/items" style={{ color: "inherit" }}>Items</Link> · {parent.code}
        </span>
        <h1>{parent.name} — variants</h1>
        <HelpHint>
          Barcode and selling price for every size and colour, saved
          together. A barcode names one thing on a shelf, so the same one
          cannot be put on two variants — clashes are shown as you type and
          refused on save.
          <br /><br />
          The price here is the {level?.name ?? "first"} level. A product
          sold at several levels still needs the price list.
        </HelpHint>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{rows.length} variant{rows.length === 1 ? "" : "s"}</h2>
            <span className="page-sub">
              scan straight into the barcode column — the field takes whatever
              the scanner types
            </span>
          </div>
          <div className="card-body">
            <VariantGrid
              action={saveVariantGrid}
              parentId={parent.id}
              rows={gridRows}
              levelName={level?.name ?? null}
              uom={uom?.code ?? ""}
            />
          </div>
        </div>
      </section>
    </>
  );
}
