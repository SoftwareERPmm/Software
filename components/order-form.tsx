"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import type { AwaitingLine } from "@/lib/queries";
import { UnitToggle, AddPackInline } from "@/components/unit-toggle";
import { addItemPack } from "@/lib/actions";
import { ItemPicker } from "./item-picker";
import { PartnerPicker } from "./partner-picker";
import { AwaitingOrders, AlreadyAwaited } from "./awaiting-orders";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Partner = {
  id: string; code: string; name: string; payment_terms_days: number;
  /** Which column of the price list this customer is quoted from.
   *  Absent on a supplier, who is not quoted at all. */
  price_level_id?: string | null;
};
type ItemPrice = { item_id: string; price_level_id: string; price: string };
type PriceLevel = { id: string; name: string };
type Location = { id: string; code: string; name: string };
type Line = {
  key: number; itemId: string; qty: string; unitPrice: string;
  /** "" is the item's own unit. A pack's uom id otherwise. */
  uomId?: string;
};

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
  action, saveDraft, draft,
  partners,
  itemPrices = [],
  priceLevels = [],
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  awaiting = [],
}: {
  kind: "sales" | "purchase";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  /** Keeps the order without saving it as a real one. */
  saveDraft?: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  /** A draft being resumed: its row id, and the editor state it held. */
  draft?: { id: string; state: string } | null;
  partners: Partner[];
  /** The price list, and the levels it is organised by. Sales only — a
   *  purchase order suggests the last cost paid, not a list price. */
  itemPrices?: ItemPrice[];
  priceLevels?: PriceLevel[];
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

  /** See the hidden field below. */
  const [attemptKey] = useState(() => crypto.randomUUID());

  // A resumed draft, as the editor last held it. Unparseable means a blank
  // form rather than a crash.
  const restored = useMemo(() => {
    if (!draft?.state) return null;
    try {
      const v = JSON.parse(draft.state);
      return v && typeof v === "object" ? v as Record<string, any> : null;
    } catch { return null; }
  }, [draft]);

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>(
    Array.isArray(restored?.lines) && restored!.lines.length > 0
      ? restored!.lines as Line[]
      : [{ key: 1, itemId: "", qty: "", unitPrice: "" }],
  );
  // The line whose pack builder is open, and the packs added in this
  // session — the item list came from the server and will not know about
  // them until the page reloads, which must not be mid-order.
  const [addingPack, setAddingPack] = useState<number | null>(null);
  const [packPending, setPackPending] = useState(false);
  const [extraPacks, setExtraPacks] = useState<Record<string, { uomId: string; code: string; factor: number }[]>>({});
  const [partnerId, setPartnerId] = useState(restored?.partnerId ?? "");
  const [docDate, setDocDate] = useState(restored?.docDate ?? today);
  const [dueDate, setDueDate] = useState(restored?.dueDate ?? "");

  const isSales = kind === "sales";

  /**
   * Saving a draft, and remembering which row it became, so pressing Save
   * twice updates one draft rather than leaving a trail of copies.
   */
  const [draftId, setDraftId] = useState(draft?.id ?? "");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [draftResult, draftFormAction, savingDraft] =
    useActionState<ActionResult | null, FormData>(
      (saveDraft ?? (async () => ({ ok: true } as ActionResult))) as never, null);

  useEffect(() => {
    if (!draftResult || !("ok" in draftResult)) return;
    if (draftResult.draftId) setDraftId(draftResult.draftId);
    setSavedAt(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
  }, [draftResult]);

  const draftState = JSON.stringify({ lines, partnerId, docDate, dueDate });
  const byId = (id: string) => items.find((i) => i.id === id);

  // Everything already awaited from whoever is chosen. Held for the whole
  // form so the banner and the line flags cannot disagree: same rows, read
  // twice, once as a list of orders and once per item.
  const awaited = useMemo(
    () => (partnerId ? awaiting.filter((a) => a.partner_id === partnerId) : []),
    [awaiting, partnerId]
  );

  /** An item's packs, including any defined on this page since it loaded. */
  function packsFor(item: Item) {
    const fromServer = (item.packs ?? []).map((p) => ({
      uomId: p.uomId, code: p.code, factor: Number(p.factor),
    }));
    const added = (extraPacks[item.id] ?? []).filter(
      (a) => !fromServer.some((f) => f.uomId === a.uomId));
    return [...fromServer, ...added];
  }

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /* Master data supplies the suggestion; the line stores what was agreed.
     Lifted from the sales voucher deliberately — an order and the invoice
     that follows it quoting different prices for the same customer is the
     kind of difference nobody can explain to a buyer. */
  const defaultLevelId = priceLevels[0]?.id ?? null;
  const activeLevelId =
    partners.find((x) => x.id === partnerId)?.price_level_id ?? defaultLevelId;

  function priceFor(itemId: string): number {
    const atLevel = itemPrices.find(
      (p) => p.item_id === itemId && p.price_level_id === activeLevelId);
    if (atLevel) return Number(atLevel.price);
    const anyLevel = itemPrices.find((p) => p.item_id === itemId);
    return anyLevel ? Number(anyLevel.price) : 0;
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    // A sale is quoted from the price list at the customer's level; a
    // purchase suggests what the goods last cost.
    const price = !item ? 0 : isSales ? priceFor(itemId) : Number(item.next_cost);
    setLine(key, {
      itemId, unitPrice: price > 0 ? String(price) : "",
      // A carton of the old item is not a carton of the new one.
      uomId: "",
    });
  }

  function pickPartner(id: string) {
    setPartnerId(id);
    const p = partners.find((x) => x.id === id);
    if (p && p.payment_terms_days > 0) setDueDate(addDays(docDate, p.payment_terms_days));

    // Re-quote lines already entered, since this customer's level may
    // differ from the one they were quoted at. A price somebody typed
    // over is theirs and is left alone.
    if (!isSales || !p) return;
    const level = p.price_level_id ?? defaultLevelId;
    setLines((ls) =>
      ls.map((l) => {
        if (!l.itemId) return l;
        const wasSuggested = Number(l.unitPrice) === priceFor(l.itemId) || !l.unitPrice;
        if (!wasSuggested) return l;
        const at = itemPrices.find(
          (x) => x.item_id === l.itemId && x.price_level_id === level);
        return { ...l, unitPrice: at ? String(Number(at.price)) : l.unitPrice };
      }),
    );
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
      .map((l) => ({
        itemId: l.itemId, qty: Number(l.qty), unitPrice: Number(l.unitPrice) || 0,
        uomId: l.uomId || null,
      }))
  );

  return (
    <form action={formAction} className="form wide">
      {/* One submission, one posting. Generated when this form mounts, so a
          double-click or a resent request carries the same key and is handed
          the document the first one posted; a new form is a new key. */}
      <input type="hidden" name="idempotency_key" value={attemptKey} />

      {/* What the editor holds, for a draft to put back. */}
      {saveDraft && (
        <>
          <input type="hidden" name="draft_id" value={draftId} />
          <input type="hidden" name="draft_doc_type"
                 value={isSales ? "SALES_ORDER" : "PURCHASE_ORDER"} />
          <input type="hidden" name="draft_state" value={draftState} />
        </>
      )}
      {draftResult && "error" in draftResult && (
        <div className="alert">{draftResult.error}</div>
      )}

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

      <AwaitingOrders
        lines={awaited}
        sales={isSales}
        backTo={isSales ? "/sales/orders/new" : "/purchases/orders/new"}
      />

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th><th className="r">Qty</th><th>Unit</th>
                <th className="r">Expected price</th>
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
                        backTo={isSales ? "/sales/orders/new" : "/purchases/orders/new"}
                      />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity" />
                    </td>
                    {/* "10" is not an order until the unit beside it says
                        whether it means pieces or cartons. Shown even for an
                        item with no packs, because the buyer still needs to
                        know what they are promising. */}
                    <td className="narrow">
                      {!item ? (
                        <span className="code" style={{ color: "var(--muted)" }}>&mdash;</span>
                      ) : addingPack === l.key ? (
                        <AddPackInline
                          base={{ uomId: item.base_uom_id ?? "", code: item.uom_code }}
                          uoms={uoms}
                          taken={[
                            item.base_uom_id ?? "",
                            ...packsFor(item).map((x) => x.uomId),
                          ]}
                          pending={packPending}
                          onCancel={() => setAddingPack(null)}
                          onSave={async (uomId, factor) => {
                            setPackPending(true);
                            const r = await addItemPack(l.itemId, uomId, factor);
                            setPackPending(false);
                            if ("pack" in r) {
                              setExtraPacks((m) => ({
                                ...m,
                                [l.itemId]: [...(m[l.itemId] ?? []),
                                             { uomId: r.uomId, code: r.code, factor: r.factor }],
                              }));
                              setLine(l.key, { uomId: r.uomId });
                              setAddingPack(null);
                            } else if ("error" in r) {
                              alert(r.error);
                            }
                          }}
                        />
                      ) : (
                        <UnitToggle
                          base={{ uomId: item.base_uom_id ?? "", code: item.uom_code }}
                          packs={packsFor(item)}
                          value={l.uomId ?? ""}
                          onChange={(id) => setLine(l.key, { uomId: id ?? "" })}
                          onAddPack={() => setAddingPack(l.key)}
                          label={`Unit for ${item.code}`}
                          qty={Number(l.qty) || 0}
                        />
                      )}
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
        {saveDraft && (
          <button type="submit" formAction={draftFormAction} className="btn ghost"
                  formNoValidate disabled={savingDraft || pending}>
            {savingDraft ? "Saving…" : draftId ? "Update draft" : "Save as draft"}
          </button>
        )}
        {savedAt && (
          <span className="page-sub" style={{ color: "var(--ok)" }}>
            Draft saved {savedAt}
          </span>
        )}
        <span className="page-sub">
          Commits nothing yet — no stock moves and nothing posts to the ledger
          until this is delivered {isSales ? "" : "or received"}.
        </span>
      </div>
    </form>
  );
}
