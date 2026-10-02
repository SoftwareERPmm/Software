"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actions";
import { ItemThumb } from "./item-thumb";
import { VariantTags } from "./variant-tags";
import type { VariantPart } from "@/lib/variants";

export type GridRow = {
  id: string; code: string; name: string;
  barcode: string | null; price: string | null;
  is_active: boolean; on_hand: string;
  photoSrc: string | null;
  parts: VariantPart[] | null;
};

/**
 * Every size and colour of one product, edited together.
 *
 * A form that does one variant at a time is twelve page loads to put
 * twelve barcodes on a shirt, which is why the barcodes never got entered.
 * This is a grid because the job is a grid.
 *
 * Clashing barcodes are shown while typing, before the save is attempted:
 * the database refuses them anyway, but finding out at the end of twelve
 * rows is finding out too late to remember which scanner slipped.
 */
export function VariantGrid({
  action, parentId, rows: initial, levelName, uom,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  parentId: string;
  rows: GridRow[];
  /** Which price is being edited — there may be more on the price list. */
  levelName: string | null;
  uom: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(action as never, null);

  const [rows, setRows] = useState(() => initial.map((r) => ({
    id: r.id,
    barcode: r.barcode ?? "",
    price: r.price !== null ? String(Number(r.price)) : "",
    isActive: r.is_active,
  })));

  useEffect(() => { if (state && "ok" in state) router.refresh(); }, [state, router]);

  const set = (id: string, patch: Partial<(typeof rows)[number]>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Barcodes typed twice in this grid, flagged as they are typed. */
  const clashing = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows) {
      const b = r.barcode.trim();
      if (b) count.set(b, (count.get(b) ?? 0) + 1);
    }
    return new Set([...count.entries()].filter(([, n]) => n > 1).map(([b]) => b));
  }, [rows]);

  const dirty = rows.some((r, i) =>
    r.barcode !== (initial[i].barcode ?? "") ||
    r.price !== (initial[i].price !== null ? String(Number(initial[i].price)) : "") ||
    r.isActive !== initial[i].is_active);

  const byId = new Map(initial.map((r) => [r.id, r]));

  return (
    <form action={formAction}>
      <input type="hidden" name="parent_id" value={parentId} />
      <input type="hidden" name="rows" value={JSON.stringify(rows)} />

      {state && "error" in state && <div className="alert">{state.error}</div>}
      {state && "ok" in state && !dirty && (
        <div className="page-sub" style={{ color: "var(--ok)", marginBottom: "0.5rem" }}>
          Saved.
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th colSpan={2}>Variant</th>
              <th>Code</th>
              <th>Barcode</th>
              <th className="r">
                {levelName ? `${levelName} price` : "Price"}
                {levelName && <div className="subline">per {uom}</div>}
              </th>
              <th className="r">On hand</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = byId.get(r.id)!;
              const dup = r.barcode.trim() !== "" && clashing.has(r.barcode.trim());
              return (
                <tr key={r.id}>
                  <td className="vgroup-thumb">
                    <ItemThumb src={v.photoSrc} name={v.name} />
                  </td>
                  <td className="wrap">
                    {v.name}
                    {/* lib/variants carries the ids for grouping; the tag
                        only needs the two words. */}
                    <VariantTags className="vartags-inline"
                      variant={v.parts?.map((x) => ({ a: x.attribute, o: x.option })) ?? null} />
                  </td>
                  <td className="code">{v.code}</td>
                  <td>
                    <input
                      type="text" inputMode="numeric" aria-label={`Barcode for ${v.name}`}
                      value={r.barcode}
                      onChange={(e) => set(r.id, { barcode: e.target.value })}
                      placeholder="scan or type"
                      style={dup ? { borderColor: "var(--bad)" } : undefined}
                    />
                    {dup && (
                      <div className="subline" style={{ color: "var(--bad)" }}>
                        also on another row
                      </div>
                    )}
                  </td>
                  <td className="narrow">
                    <input
                      type="number" min="0" step="any" aria-label={`Price for ${v.name}`}
                      value={r.price}
                      onChange={(e) => set(r.id, { price: e.target.value })}
                    />
                  </td>
                  <td className="r">{Number(v.on_hand)}</td>
                  <td>
                    <label className="check">
                      <input type="checkbox" checked={r.isActive}
                             onChange={(e) => set(r.id, { isActive: e.target.checked })}
                             aria-label={`${v.name} active`} />
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || !dirty || clashing.size > 0}>
          {pending ? "Saving…" : `Save ${rows.length} variant${rows.length === 1 ? "" : "s"}`}
        </button>
        {clashing.size > 0 && (
          <span className="page-sub" style={{ color: "var(--bad)" }}>
            Two rows share a barcode — a barcode names one thing on a shelf.
          </span>
        )}
        {!dirty && clashing.size === 0 && (
          <span className="page-sub">Nothing changed yet.</span>
        )}
      </div>
    </form>
  );
}
