"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/actions";

type Band = {
  id: string; code: string; name: string; basis: string;
  min_value: string; max_value: string | null; discount_pct: string;
  is_active: boolean; valid_from: string; valid_to: string | null;
  item_name: string | null; group_name: string | null;
};

export function VolumeDiscountRow({
  band, fromLabel, toLabel, deactivateAction, activateAction,
}: {
  band: Band;
  fromLabel: string;
  toLabel: string;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  activateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [, deact] = useActionState<ActionResult | null, FormData>(deactivateAction as never, null);
  const [, act] = useActionState<ActionResult | null, FormData>(activateAction as never, null);

  return (
    <tr>
      <td className="code">{band.code}</td>
      <td className="wrap">
        {band.name}
        <div className="subline" style={{ color: "var(--muted)" }}>
          from {band.valid_from}{band.valid_to ? ` to ${band.valid_to}` : ""}
        </div>
      </td>
      <td style={{ color: "var(--muted)" }}>
        {band.item_name ?? band.group_name ?? "everything"}
      </td>
      <td className="r">{fromLabel}</td>
      <td className="r">{toLabel}</td>
      <td className="r"><strong>{Number(band.discount_pct)}%</strong></td>
      <td>
        {band.is_active
          ? <span className="pill ok">active</span>
          : <span className="pill warn">retired</span>}
      </td>
      <td>
        {/* Retired, never deleted — an invoice points at the band that priced
            it, and a discount whose rule has vanished cannot explain itself. */}
        <form action={band.is_active ? deact : act} style={{ display: "inline" }}>
          <input type="hidden" name="id" value={band.id} />
          <button type="submit" className={band.is_active ? "warn tiny" : "ghost tiny"}>
            {band.is_active ? "Retire" : "Reinstate"}
          </button>
        </form>
      </td>
    </tr>
  );
}
