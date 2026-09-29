"use client";

import { useMemo, useState } from "react";

export type PickerAttribute = {
  id: string; code: string; name: string;
  options: { id: string; code: string; name: string }[];
};

/**
 * Turning one product into the things that sit on a shelf.
 *
 * Off by default and silent when off, because most of a trading catalogue
 * has no variants: a tin of condensed milk is one item and stays one. The
 * panel only appears once somebody says this product is different.
 *
 * Ticking Black, White, S, M and L describes six combinations, and a shop
 * that stocks Black in all three sizes but White only in M sells four of
 * them. So the combinations are listed and each one can be dropped — the
 * grid is the starting point, not the answer. Generating all six and
 * expecting somebody to delete two afterwards makes two dead items that
 * reports have to keep explaining.
 *
 * What it produces is a plan, not the items — the server builds those, so
 * that a form replayed or a request repeated cannot make two sets.
 */
export function VariantPicker({
  attributes, serial, name = "",
}: {
  attributes: PickerAttribute[];
  /** Shown in the preview so the generated codes are visible before saving. */
  serial: string;
  name?: string;
}) {
  const [on, setOn] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  /** Combinations the grid offers but this product does not sell, by key.
   *  Held as exclusions rather than inclusions so that ticking another
   *  colour adds its combinations already on, which is what is wanted
   *  nearly every time. */
  const [dropped, setDropped] = useState<Set<string>>(new Set());

  const toggleAttribute = (id: string) =>
    setChosen((c) => {
      const next = { ...c };
      if (id in next) delete next[id]; else next[id] = [];
      return next;
    });

  const toggleOption = (attrId: string, optId: string) =>
    setChosen((c) => {
      const have = c[attrId] ?? [];
      return {
        ...c,
        [attrId]: have.includes(optId) ? have.filter((x) => x !== optId) : [...have, optId],
      };
    });

  // Only attributes with something ticked count: one with none would multiply
  // the combinations by zero.
  const plan = useMemo(
    () => attributes
      .filter((a) => (chosen[a.id]?.length ?? 0) > 0)
      .map((a) => ({ attributeId: a.id, optionIds: chosen[a.id]! })),
    [attributes, chosen],
  );

  /** Every combination the choices describe, in the order the attributes
   *  are declared, so a shirt is "M / Red" and never "Red / M". */
  const combos = useMemo(() => {
    if (plan.length === 0) return [];
    let rows: { id: string; code: string; label: string }[][] = [[]];
    for (const p of plan) {
      const attr = attributes.find((a) => a.id === p.attributeId)!;
      const opts = attr.options.filter((o) => p.optionIds.includes(o.id));
      rows = rows.flatMap((c) => opts.map((o) =>
        [...c, { id: o.id, code: o.code, label: o.name }]));
    }
    return rows.map((parts) => ({
      key: parts.map((p) => p.id).join("|"),
      optionIds: parts.map((p) => p.id),
      suffix: parts.map((p) => p.code).join("-"),
      label: parts.map((p) => p.label).join(" / "),
    }));
  }, [plan, attributes]);

  const kept = combos.filter((c) => !dropped.has(c.key));

  const toggleCombo = (key: string) =>
    setDropped((d) => {
      const next = new Set(d);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const setAll = (keep: boolean) =>
    setDropped(keep ? new Set() : new Set(combos.map((c) => c.key)));

  /**
   * What the server is asked to build.
   *
   * The attributes travel separately from the combinations because they are
   * different facts: the attributes are what this product varies by and are
   * recorded against the parent even for a combination nobody stocks, while
   * the combinations are the items to create.
   */
  const payload = useMemo(() => JSON.stringify({
    attributes: plan.map((p) => p.attributeId),
    combos: kept.map((c) => c.optionIds),
  }), [plan, kept]);

  if (attributes.length === 0) {
    return (
      <p className="hint" style={{ marginTop: "1rem" }}>
        No variant attributes are set up yet. Add Size or Colour under Master
        data → Variant attributes, and this product can then be offered in them.
      </p>
    );
  }

  return (
    <fieldset className="trackbox" style={{ marginTop: "0.75rem" }}>
      <legend>Variants</legend>

      <label className="trackbox-opt" htmlFor="has_variants">
        <input
          id="has_variants" type="checkbox" checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            if (!e.target.checked) { setChosen({}); setDropped(new Set()); }
          }}
        />
        <span>
          <strong>This product comes in variants</strong>
          <span className="trackbox-note">
            One item is created for each combination you keep, and those are
            what carry the stock, the price and the barcode. This row becomes
            the product they belong to and is not itself sold.
          </span>
        </span>
      </label>

      {on && (
        <>
          <input type="hidden" name="variant_plan" value={payload} />

          <div className="varpick">
            {attributes.map((a) => {
              const picked = chosen[a.id];
              return (
                <div key={a.id} className="varpick-attr">
                  <label className="check">
                    <input
                      type="checkbox" checked={a.id in chosen}
                      onChange={() => toggleAttribute(a.id)}
                    />
                    <strong>{a.name}</strong>
                  </label>
                  {a.id in chosen && (
                    <div className="varpick-opts">
                      {a.options.length === 0 ? (
                        <span className="hint">
                          {a.name} has no values yet.
                        </span>
                      ) : a.options.map((o) => (
                        <label key={o.id}
                               className={`varchip${picked?.includes(o.id) ? " on" : ""}`}>
                          <input
                            type="checkbox"
                            checked={picked?.includes(o.id) ?? false}
                            onChange={() => toggleOption(a.id, o.id)}
                          />
                          {o.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {combos.length > 0 && (
            <div className="varpreview">
              <div className="varpreview-head">
                <strong>
                  {kept.length} of {combos.length} will be created
                </strong>
                {/* Only worth offering once there are enough rows for
                    clicking each one to be the tedious way round. */}
                {combos.length > 2 && (
                  <span className="varpreview-acts">
                    <button type="button" className="linkbtn" onClick={() => setAll(true)}>
                      All
                    </button>
                    <button type="button" className="linkbtn" onClick={() => setAll(false)}>
                      None
                    </button>
                  </span>
                )}
              </div>

              <ul className="varcombos">
                {combos.map((c) => {
                  const keep = !dropped.has(c.key);
                  return (
                    <li key={c.key}>
                      <label className={`varcombo${keep ? " on" : ""}`}>
                        <input type="checkbox" checked={keep}
                               onChange={() => toggleCombo(c.key)} />
                        <span className="m">
                          {serial ? `${serial}-${c.suffix}` : "…"}
                        </span>
                        <span className="varcombo-label">
                          {name || "this product"} {c.label}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {kept.length === 0 && (
                <p className="hint" style={{ marginTop: "0.5rem" }}>
                  Nothing is ticked, so this will be saved as an ordinary item
                  with no variants.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
