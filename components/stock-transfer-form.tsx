"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { NegativeStockConfirm, type Shortfall } from "./negative-stock-confirm";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Location = { id: string; code: string; name: string };
type StockRow = { item_id: string; location_id: string; qty_on_hand: string };
type Line = { key: number; itemId: string; qty: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Moves stock between two of the company's own warehouses. No partner, no
 * price — it leaves the source at whatever it was already carried at and
 * reopens at the destination at that same cost, so the company-wide total
 * never moves, only which location holds it.
 */
export function StockTransferForm({
  action,
  items: initialItems,
  locations,
  stockByLocation,
  today,
  categories,
  uoms,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  items: Item[];
  locations: Location[];
  stockByLocation: StockRow[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", qty: "" }]);
  const [fromLocationId, setFromLocationId] = useState(locations[0]?.id ?? "");
  const [toLocationId, setToLocationId] = useState(locations[1]?.id ?? locations[0]?.id ?? "");
  const [docDate, setDocDate] = useState(today);
  const [receivedTime, setReceivedTime] = useState("");

  useEffect(() => {
    setReceivedTime(new Date().toTimeString().slice(0, 5));
  }, []);

  const byId = (id: string) => items.find((i) => i.id === id);

  const onHandAtFrom = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of stockByLocation) if (r.location_id === fromLocationId) m.set(r.item_id, Number(r.qty_on_hand));
    return m;
  }, [stockByLocation, fromLocationId]);
  const availableHere = (itemId: string) => onHandAtFrom.get(itemId) ?? 0;

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    setLine(key, { itemId });
  }

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }))
  );

  const sameLocation = fromLocationId && toLocationId && fromLocationId === toLocationId;

  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [askNegative, setAskNegative] = useState(false);

  const shortages = lines.filter((l) => {
    if (!l.itemId) return false;
    const item = byId(l.itemId);
    return item?.is_stocked && Number(l.qty) > availableHere(l.itemId);
  });

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>From and to</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="from_location_id">From warehouse</label>
              <select id="from_location_id" name="from_location_id" value={fromLocationId}
                onChange={(e) => setFromLocationId(e.target.value)} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="to_location_id">To warehouse</label>
              <select id="to_location_id" name="to_location_id" value={toLocationId}
                onChange={(e) => setToLocationId(e.target.value)} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" value={docDate}
                onChange={(e) => setDocDate(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="received_time">Time</label>
              <input id="received_time" name="received_time" type="time" value={receivedTime}
                onChange={(e) => setReceivedTime(e.target.value)} />
              <span className="hint">When it actually arrived at the destination — orders FIFO correctly</span>
            </div>

            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text" placeholder="Delivery run, driver, vehicle" />
            </div>
          </div>

          {sameLocation && <div className="alert" style={{ marginTop: "0.75rem" }}>Choose two different warehouses.</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th><th className="r">Available here</th>
                <th className="r">Qty to move</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const short = item?.is_stocked && Number(l.qty) > availableHere(l.itemId);
                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode="purchase"
                        items={items}
                        categories={categories}
                        uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => pickItem(l.key, id)}
                        onCreated={addItem}
                      />
                    </td>
                    <td className="r" style={{ color: short ? "var(--bad)" : undefined }}>
                      {item ? (item.is_stocked ? fmt(availableHere(item.id)) : "service") : "—"}
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity" />
                    </td>
                    <td className="tight">
                      <button type="button" className="ghost tiny" onClick={() => removeLine(l.key)}
                        aria-label="Remove line" disabled={lines.length === 1}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {shortages.length > 0 && !negativeConfirmed && (
        <div className="alert">
          <strong>Recorded stock is insufficient</strong> at the source
          warehouse for {shortages.map((l) => byId(l.itemId)?.code).join(", ")}.
          Reduce the quantity, or confirm the goods physically exist &mdash;
          posting will ask before recording negative stock.
        </div>
      )}

      {shortages.length > 0 && negativeConfirmed && (
        <div className="alert">
          <strong>Confirmed:</strong> the goods physically exist at the source
          though the record shows fewer. This will post negative stock there,
          listed under Inventory &rarr; Negative stock until a receipt covers
          it.{" "}
          <button type="button" className="ghost tiny"
                  onClick={() => setNegativeConfirmed(false)}>Undo</button>
        </div>
      )}

      {negativeConfirmed && (
        <input type="hidden" name="allow_negative_stock" value="true" />
      )}

      <NegativeStockConfirm
        open={askNegative}
        shortfalls={shortages.map((l): Shortfall => {
          const item = byId(l.itemId);
          return {
            itemCode: item?.code ?? "",
            itemName: item?.name ?? "",
            uomCode: item?.uom_code ?? "",
            required: Number(l.qty),
            recorded: availableHere(l.itemId),
          };
        })}
        onCancel={() => setAskNegative(false)}
        onConfirm={() => { setNegativeConfirmed(true); setAskNegative(false); }}
      />

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="What this move is for — English or Myanmar" />
      </div>

      <div className="actions">
        <button
          type={shortages.length > 0 && !negativeConfirmed ? "button" : "submit"}
          onClick={
            shortages.length > 0 && !negativeConfirmed
              ? () => setAskNegative(true)
              : undefined
          }
          disabled={
            pending || Boolean(sameLocation) ||
            lines.every((l) => !l.itemId || Number(l.qty) <= 0)
          }
        >
          {pending ? "Posting…" : "Post transfer"}
        </button>
        <span className="page-sub">
          Leaves the source at its FIFO cost and reopens at the destination at that same cost.
        </span>
      </div>
    </form>
  );
}
