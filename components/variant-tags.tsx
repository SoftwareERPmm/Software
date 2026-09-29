/**
 * What a variant is, said in the row rather than left in its name.
 *
 * "T-Shirt Red" already carries the colour, but only as words at the end of
 * a name a narrow column truncates, and only if whoever named it was
 * consistent. These come from item_variant_option, so they are the same
 * facts reporting groups by — and they carry which attribute each value
 * belongs to, which the name never does: "Small" alone does not say whether
 * it is a size or a packaging.
 *
 * No hooks and no imports, so it renders on the server for a table and
 * inside a client picker without a second copy.
 */
export type VariantPart = { a: string; o: string };

/** Postgres hands back json, which is unknown until something checks it. */
export function asVariant(raw: unknown): VariantPart[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts = raw
    .filter((p): p is VariantPart =>
      !!p && typeof p === "object" &&
      typeof (p as any).a === "string" && typeof (p as any).o === "string")
    .map((p) => ({ a: p.a, o: p.o }));
  return parts.length > 0 ? parts : null;
}

export function VariantTags({
  variant,
  /** Names the attribute as well as the value. Off in a dense table, where
   *  the column is already narrow and "Red" is not ambiguous; on where the
   *  row has the width to be unambiguous about it. */
  labelled = false,
  className,
}: {
  variant: VariantPart[] | null | undefined;
  labelled?: boolean;
  className?: string;
}) {
  if (!variant || variant.length === 0) return null;
  return (
    <span className={`vartags${className ? " " + className : ""}`}>
      {variant.map((p, i) => (
        // The attribute is the title even when not shown, so hovering
        // answers "small what?" without spending the width on it.
        <span className="vartag" key={`${p.a}-${p.o}-${i}`} title={p.a}>
          {labelled && <span className="vartag-a">{p.a}</span>}
          {p.o}
        </span>
      ))}
    </span>
  );
}
