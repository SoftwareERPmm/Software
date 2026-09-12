"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import type { AwaitingLine } from "@/lib/queries";
import { ItemPicker } from "./item-picker";
import { PartnerPicker } from "./partner-picker";
import { AwaitingOrders, AlreadyAwaited } from "./awaiting-orders";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Partner = { id: string; code: string; name: string; payment_terms_days: number };
type Location = { id: string; code: string; name: string };
type Line = { key: number; itemId: string; qty: string; unitPrice: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A commitment, not a posting: no stock check, no cost column, nothing to
 * balance. Orders exist to be fulfilled later, so this is just "what, how
 * much, roughly what price" for the record.
 */
export function OrderForm({
  kind,
  action,
  partners,
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  awaiting = [],
}: {
  kind: "sales" | "purchase";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  partners: Partner[];
  items: Item[];
  locations: Location[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
  /** Open orders to this partner that nothing has happened to yet. */
  awaiting?: AwaitingLine[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", qty: "", unitPrice: "" }]);
  const [partnerId, setPartnerId] = useState("");
  const [docDate, setDocDate] = useState(today);
  const [dueDate, setDueDate] = useState("");

  const isSales = kind === "sales";
  const byId = (id: string) => items.find((i) => i.id === id);

  // Everything already awaited from whoever is chosen. Held for the whole
  // form so the banner and the line flags cannot disagree: same rows, read
  // twice, once as a list of orders and once per item.
  const awaited = useMemo(
    () => (partnerId ? awaiting.filter((a) => a.partner_id === partnerId) : []),
    [awaiting, partnerId]
  );

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    const price = !item ? "" : isSales ? item.sale_price : item.next_cost;
    setLine(key, { itemId, unitPrice: Number(price) > 0 ? String(Number(price)) : "" });
  }

  function pickPartner(id: string) {
    setPartnerId(id);
    const p = partners.find((x) => x.id === id);
    if (p && p.payment_terms_days > 0) setDueDate(addDays(docDate, p.payment_terms_days));
  }

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
  const total = lines.reduce((s, l) => s + amount(l), 0);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitPrice: Number(l.unitPrice) || 0 }))
  );

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>{isSales ? "Customer" : "Supplier"} and dates</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isSales ? "Customer" : "Supplier"}</label>
              <PartnerPicker
                partners={partners as never}
                value={partnerId}
                onPick={pickPartner}
              />
            </div>

            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              <select id="location_id" name="location_id" defaultValue={locations[0]?.id ?? ""} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="doc_date">Order date</label>
              <input id="doc_date" name="doc_date" type="date" value={docDate}
                onChange={(e) => setDocDate(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="due_date">Needed by</label>
              <input id="due_date" name="due_date" type="date" value={dueDate}
                onChange={(e) => setDueDate(e.target.value)} />
              <span className="hint">Optional</span>
            </div>
          </div>
        </div>
      </div>

      <AwaitingOrders lines={awaited} sales={isSales} />

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th><th className="r">Qty</th><th className="r">Expected price</th>
                <th className="r">Amount</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode={kind}
                        items={items}
                        categories={categories}
                        uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => pickItem(l.key, id)}
                        onCreated={addItem}
                      />
                      <AlreadyAwaited
                        lines={awaited.filter((a) => a.item_id === l.itemId)}
                        sales={isSales}
                      />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity" />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.unitPrice}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                        aria-label="Expected price" />
                    </td>
                    <td className="r">{fmt(amount(l))}</td>
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

        <div className="totalbar">
          <span style={{ color: "var(--muted)" }}>Expected total</span>
          <span className="big">{fmt(total)} MMK</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || total === 0}>
          {pending ? "Saving…" : `Save ${isSales ? "sales" : "purchase"} order`}
        </button>
        <span className="page-sub">
          Commits nothing yet — no stock moves and nothing posts to the ledger
          until this is delivered {isSales ? "" : "or received"}.
        </span>
      </div>
    </form>
  );
}
