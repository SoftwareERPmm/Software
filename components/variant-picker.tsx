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

  /** Every combination, so the count and the codes can be seen before saving. */
  const combos = useMemo(() => {
    if (plan.length === 0) return [];
    let out: { code: string; label: string }[][] = [[]];
    for (const p of plan) {
      const attr = attributes.find((a) => a.id === p.attributeId)!;
      const opts = attr.options.filter((o) => p.optionIds.includes(o.id));
      out = out.flatMap((c) => opts.map((o) => [...c, { code: o.code, label: o.name }]));
    }
    return out;
  }, [plan, attributes]);

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
          onChange={(e) => { setOn(e.target.checked); if (!e.target.checked) setChosen({}); }}
        />
        <span>
          <strong>This product comes in variants</strong>
          <span className="trackbox-note">
            One item is created for each combination, and those are what carry
            the stock, the price and the barcode. This row becomes the product
            they belong to and is not itself sold.
          </span>
        </span>
      </label>

      {on && (
        <>
          <input type="hidden" name="variant_plan" value={JSON.stringify(plan)} />

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
              <strong>
                {combos.length} item{combos.length === 1 ? "" : "s"} will be created
              </strong>
              <ul>
                {combos.slice(0, 8).map((c, i) => (
                  <li key={i}>
                    <span className="m">
                      {serial ? `${serial}-${c.map((x) => x.code).join("-")}` : "…"}
                    </span>
                    {" · "}
                    {name || "this product"} {c.map((x) => x.label).join(" / ")}
                  </li>
                ))}
                {combos.length > 8 && <li className="hint">and {combos.length - 8} more</li>}
              </ul>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
