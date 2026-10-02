"use client";

import { useState } from "react";

export type Pack = { uomId: string; code: string; factor: number };

/**
 * Which unit a line is counted in.
 *
 * A dropdown hid the decision: a tester buying by the carton could not see
 * that cartons were available, and "10" on a line is meaningless until the
 * unit beside it is visible. Buttons put every option on the screen at
 * once, so the choice is made rather than discovered.
 *
 * Past three or four packs the buttons stop fitting and stop helping, so
 * the control falls back to the select it replaced. The decision is the
 * same either way; only the affordance changes.
 *
 * The buttons carry the unit and nothing else. An earlier version put the
 * factor on the button — "CTN 10" — which reads as ten cartons, the one
 * thing it does not mean. The relationship is a sentence, so it is written
 * as one underneath, and once a quantity is typed it stops being a rule
 * about cartons and becomes this line's own arithmetic: 10 CTN = 100 PCS.
 */
export function UnitToggle({
  base, packs, value, onChange, onAddPack, disabled, label, qty,
}: {
  /** The item's own unit — always an option, always first. */
  base: { uomId: string; code: string };
  packs: Pack[];
  /** null or "" means the base unit. */
  value: string | null | undefined;
  onChange: (uomId: string | null) => void;
  /** Opens the inline pack builder. Omitted where a pack cannot be added. */
  onAddPack?: () => void;
  disabled?: boolean;
  label?: string;
  /** What is typed on this line, so the echo can show where it lands. */
  qty?: number;
}) {
  const options = [{ uomId: "", code: base.code, factor: 1 }, ...packs];
  const current = value || "";

  if (disabled) {
    const picked = options.find((o) => o.uomId === current) ?? options[0];
    return <span className="code" style={{ color: "var(--muted)" }}>{picked.code}</span>;
  }

  if (options.length > 4) {
    return (
      <select value={current} onChange={(e) => onChange(e.target.value || null)}
              aria-label={label ?? "Unit"}>
        {options.map((o) => (
          <option key={o.uomId || "base"} value={o.uomId}>
            {o.code}{o.factor > 1 ? ` (${o.factor})` : ""}
          </option>
        ))}
        {onAddPack && <option value="__add">+ pack size…</option>}
      </select>
    );
  }

  const picked = options.find((o) => o.uomId === current) ?? options[0];

  return (
    <span className="unitpick">
      <span className="unittoggle" role="group" aria-label={label ?? "Unit"}>
        {options.map((o) => (
          <button
            key={o.uomId || "base"}
            type="button"
            className={o.uomId === current ? "on" : undefined}
            aria-pressed={o.uomId === current}
            title={o.factor > 1
              ? `1 ${o.code} = ${o.factor} ${base.code}`
              : `Counted in ${o.code}`}
            onClick={() => onChange(o.uomId || null)}
          >
            {o.code}
          </button>
        ))}
        {onAddPack && (
          <button type="button" className="add" onClick={onAddPack}
                  title="Define a pack for this item">+</button>
        )}
      </span>
      {picked.factor > 1 && (
        <span className="unitecho">
          {qty && qty > 0
            ? `${qty} ${picked.code} = ${round(qty * picked.factor)} ${base.code}`
            : `1 ${picked.code} = ${picked.factor} ${base.code}`}
        </span>
      )}
    </span>
  );
}

/** Trailing zeros help nobody read a quantity. */
const round = (n: number) => Number(n.toFixed(4));

/**
 * Define a pack without leaving the voucher. Hitting a missing pack size
 * mid-document otherwise means abandoning it, editing the item, and
 * starting again — which is where the entry gets abandoned instead.
 */
export function AddPackInline({
  base, uoms, taken, onCancel, onSave, pending,
}: {
  base: { uomId: string; code: string };
  uoms: { id: string; code: string; name: string }[];
  /** Units already used by this item, including its base. */
  taken: string[];
  onCancel: () => void;
  onSave: (uomId: string, factor: number) => void;
  pending?: boolean;
}) {
  const free = uoms.filter((u) => !taken.includes(u.id) && u.id !== base.uomId);
  const [uomId, setUomId] = useState(free[0]?.id ?? "");
  const [factor, setFactor] = useState("");

  if (free.length === 0) {
    return (
      <span className="hint">
        Every unit is already a pack for this item. Add another under Units.
      </span>
    );
  }

  const n = Number(factor);
  const ok = uomId && Number.isFinite(n) && n > 0;

  return (
    <span className="addpack">
      1
      <select value={uomId} onChange={(e) => setUomId(e.target.value)} aria-label="Pack unit">
        {free.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
      </select>
      =
      <input type="number" min="0" step="any" value={factor} inputMode="decimal"
             onChange={(e) => setFactor(e.target.value)}
             aria-label={`How many ${base.code}`} placeholder="10" />
      {base.code}
      <button type="button" disabled={!ok || pending}
              onClick={() => ok && onSave(uomId, n)}>
        {pending ? "Saving…" : "Add"}
      </button>
      <button type="button" className="ghost tiny" onClick={onCancel}>Cancel</button>
    </span>
  );
}
