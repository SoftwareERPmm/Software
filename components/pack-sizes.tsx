"use client";

import { useState } from "react";

type Uom = { id: string; code: string; name: string };
type Pack = { key: number; uomId: string; factor: string };

/**
 * The packs an item is bought and sold in, each holding so many base units.
 *
 * The item's own unit is never one of them — it is what they convert to, its
 * factor is 1 by definition, and offering it would be a second answer to a
 * question already settled. It is excluded from the picker rather than
 * merely rejected on save, so the rule is visible before the mistake.
 *
 * Editing this list cannot disturb a posted document: every line stores the
 * factor it used, so a carton that becomes 20s next year leaves last year's
 * receipts saying 24.
 */
export function PackSizes({
  uoms, baseUomId, initial,
}: {
  uoms: Uom[];
  baseUomId: string;
  initial: { uomId: string; factor: number }[];
}) {
  const [packs, setPacks] = useState<Pack[]>(
    initial.map((p, i) => ({ key: i, uomId: p.uomId, factor: String(p.factor) })),
  );
  const base = uoms.find((u) => u.id === baseUomId);
  const available = uoms.filter((u) => u.id !== baseUomId);

  const set = (key: number, patch: Partial<Pack>) =>
    setPacks((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const payload = JSON.stringify(
    packs
      .filter((p) => p.uomId && Number(p.factor) > 0)
      .map((p) => ({ uomId: p.uomId, factor: Number(p.factor) })),
  );

  return (
    <div className="field" style={{ marginTop: "0.6rem" }}>
      <label>Pack sizes</label>
      <input type="hidden" name="packs" value={payload} />

      {packs.length === 0 ? (
        <span className="hint">
          Bought and sold in {base?.code ?? "its own unit"} only.
        </span>
      ) : (
        packs.map((p) => (
          <div key={p.key} className="packrow">
            <select value={p.uomId} onChange={(e) => set(p.key, { uomId: e.target.value })}>
              <option value="">Choose a unit…</option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
              ))}
            </select>
            <span className="packrow-eq">holds</span>
            <input
              type="number" min="0" step="any" value={p.factor}
              onChange={(e) => set(p.key, { factor: e.target.value })}
              aria-label="Base units per pack"
            />
            <span className="packrow-eq">{base?.code ?? "units"}</span>
            <button type="button" className="ghost tiny"
                    onClick={() => setPacks((ps) => ps.filter((x) => x.key !== p.key))}>
              Remove
            </button>
          </div>
        ))
      )}

      <button
        type="button" className="ghost tiny" style={{ marginTop: "0.4rem" }}
        onClick={() => setPacks((ps) => [...ps, { key: Date.now(), uomId: "", factor: "" }])}
      >
        + Pack size
      </button>
      <span className="hint">
        A carton of 24 means one carton moves 24 {base?.code ?? "units"} of stock.
        Prices on a line are per whatever unit that line names.
      </span>
    </div>
  );
}
