"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Level = {
  levelId: string; levelName: string;
  price: string | null; validFrom: string | null; prices: number;
};

type Row = {
  itemId: string; code: string; name: string;
  baseUomId: string; uomCode: string;
  packs: { uomId: string; code: string; factor: number }[];
  levels: Level[];
};

const money = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === ""
    ? null
    : Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * One item, and what it sells for at each level.
 *
 * Setting a price adds the next one from the day it applies rather than
 * overwriting the last: an invoice raised in March was raised at March's
 * price, and the line already records what was charged. So the list is free
 * to move on without dragging history with it — and a price that starts next
 * Monday can be entered today.
 */
export function PriceRow({
  row, today, action,
}: {
  row: Row;
  today: string;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  return (
    <>
      <tr>
        <td className="code">{row.code}</td>
        <td className="wrap">{row.name}</td>
        {row.levels.map((l) => (
          <td key={l.levelId} className="r">
            {l.price === null ? (
              <button type="button" className="linkish" onClick={() => setEditing(l.levelId)}>
                Set
              </button>
            ) : (
              <button type="button" className="linkish" onClick={() => setEditing(l.levelId)}
                      title={`From ${l.validFrom}`}>
                {money(l.price)}
              </button>
            )}
            <div className="subline">
              {l.price === null ? "no price" : `per ${row.uomCode}`}
            </div>
          </td>
        ))}
      </tr>

      {editing && (
        <tr>
          <td colSpan={2 + row.levels.length}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <form action={formAction} className="form">
              <input type="hidden" name="item_id" value={row.itemId} />
              <input type="hidden" name="price_level_id" value={editing} />
              <div className="row">
                <div className="field">
                  <label>Price</label>
                  <input
                    name="price" type="number" min="0" step="any" required
                    defaultValue={row.levels.find((l) => l.levelId === editing)?.price ?? ""}
                  />
                  <span className="hint">
                    {row.code} · {row.levels.find((l) => l.levelId === editing)?.levelName}
                  </span>
                </div>
                <div className="field">
                  <label>Per unit</label>
                  <select name="uom_id" defaultValue={row.baseUomId}>
                    <option value={row.baseUomId}>{row.uomCode}</option>
                    {row.packs.map((p) => (
                      <option key={p.uomId} value={p.uomId}>
                        {p.code} ({p.factor} {row.uomCode})
                      </option>
                    ))}
                  </select>
                  <span className="hint">What one of this price buys</span>
                </div>
                <div className="field">
                  <label>Charged from</label>
                  <input name="valid_from" type="date" defaultValue={today} required />
                  <span className="hint">Invoices dated before this keep the old price</span>
                </div>
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Set price"}
                </button>
                <button type="button" className="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
