"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { createItemInline, type PickerItem } from "@/lib/actions";
import { VariantTags, asVariant } from "@/components/variant-tags";

type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Uom = { id: string; code: string; name: string };

// Category depth is capped at two: Category, then Sub category.
const LEVELS = ["Category", "Sub category"];
/** Exactly this item, as against merely containing the text. */
const isExact = (i: PickerItem, q: string) =>
  (i.barcode ?? "").toLowerCase() === q || i.code.toLowerCase() === q;

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Type to find an item; if it isn't there yet, create it without leaving the
 * voucher. Nobody should have to build the whole catalogue before they can
 * buy anything — but nor should unclassified stock get into inventory, so
 * creating still asks for a category.
 */
export function ItemPicker({
  items,
  categories,
  uoms,
  value,
  onPick,
  onCreated,
  mode,
}: {
  items: PickerItem[];
  categories: Node[];
  uoms: Uom[];
  value: string;
  onPick: (itemId: string) => void;
  onCreated: (item: PickerItem) => void;
  mode: "sales" | "purchase";
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const selected = items.find((i) => i.id === value);

  const showPanel = open || creating;

  // The dropdown is portalled to <body> and fixed-positioned so a scrollable
  // ancestor (the line table's overflow-x wrapper) can't clip it. Track the
  // input's position while the panel is open, including on scroll/resize —
  // a plain child element would move with the table's own scrollbar.
  useLayoutEffect(() => {
    if (!showPanel || !boxRef.current) return;
    const update = () => {
      const r = boxRef.current!.getBoundingClientRect();
      setRect({ top: r.bottom + 2, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showPanel]);

  // Since the panel now lives in a portal, it's outside boxRef in the DOM —
  // closing has to check both the trigger and the panel itself, or every
  // click on a result row would look like an "outside" click and close it
  // before onPick ever fires.
  useEffect(() => {
    if (!showPanel) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as globalThis.Node;
      if (boxRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
      setCreating(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); setCreating(false); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showPanel]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    const hit = items.filter((i) =>
      i.code.toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q) ||
      (i.barcode ?? "").toLowerCase().includes(q) ||
      (asVariant(i.variant) ?? []).some(
        (v) => v.a.toLowerCase().includes(q) || v.o.toLowerCase().includes(q)));
    // A scanned barcode is an exact answer, not a search term. It sorts to
    // the top so the row the scanner meant is the one under the cursor.
    hit.sort((a, b) => Number(isExact(b, q)) - Number(isExact(a, q)));
    return hit.slice(0, 12);
  }, [items, query]);

  /** The one item this string can only mean: its barcode, or its code. */
  const exactOne = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits = items.filter((i) => isExact(i, q));
    return hits.length === 1 ? hits[0] : null;
  }, [items, query]);

  // Create form state
  const [chain, setChain] = useState<string[]>([]);
  const [uomId, setUomId] = useState(uoms[0]?.id ?? "");
  const [price, setPrice] = useState("");
  const [stocked, setStocked] = useState(true);

  const childrenOf = (parentId: string | null) => categories.filter((c) => c.parent_id === parentId);

  const selects: Array<{ depth: number; options: Node[]; value: string }> = [];
  let parent: string | null = null;
  for (let d = 0; ; d++) {
    const options = childrenOf(parent);
    if (options.length === 0) break;
    const v = chain[d] ?? "";
    selects.push({ depth: d, options, value: v });
    if (!v) break;
    parent = v;
  }

  const groupId = chain.length ? chain[chain.length - 1] : "";
  const groupCode = categories.find((c) => c.id === groupId)?.code ?? "";

  function submitNew() {
    setError(null);
    start(async () => {
      const res = await createItemInline({
        name: query.trim(),
        groupId,
        uomId,
        price: price ? Number(price) : undefined,
        isStocked: stocked,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCreated(res.item);
      onPick(res.item.id);
      setCreating(false);
      setOpen(false);
      setQuery("");
      setChain([]);
      setPrice("");
    });
  }

  if (selected && !open) {
    return (
      /* The name stays a button, because the common thing to do with a
         picked item is pick a different one. Reading what it actually is
         — its units, its packs, what it costs — is a second action, so it
         gets its own control rather than stealing the first one.

         A new tab deliberately: this sits inside a voucher that is being
         typed, and navigating away from half an order to go and look
         something up is how the order gets lost. */
      <span className="pickeditem">
        <button
          type="button"
          className="ghost"
          style={{ flex: 1, textAlign: "left", fontWeight: 400, padding: "0.3rem 0.45rem" }}
          onClick={() => { setOpen(true); setQuery(""); }}
          title="Change item"
        >
          <span className="m">{selected.code}</span> · {selected.name}
          <VariantTags variant={asVariant(selected.variant)} />
        </button>
        <Link
          href={`/items/${selected.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="pickedopen"
          title={`Open ${selected.code} in master data — new tab`}
          aria-label={`Open ${selected.code} in master data in a new tab`}
        >
          <ExternalLink size={13} aria-hidden="true" />
        </Link>
      </span>
    );
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        autoFocus={open}
        placeholder="Scan, or type a code or name…"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setCreating(false); }}
        onFocus={() => setOpen(true)}
        /**
         * A barcode scanner types the code and then sends Enter.
         *
         * Enter in a text input submits the form around it, and the form
         * around this one is the voucher — so scanning an item would have
         * posted the document. Always stopped here, whether or not the
         * scan found anything.
         *
         * What it does instead: take the item the string can only mean, or
         * the only one left in the list. Anything more ambiguous stays open
         * for a person to choose, because guessing at the till is how the
         * wrong thing gets sold.
         */
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const pick = exactOne ?? (matches.length === 1 ? matches[0] : null);
          if (pick) { onPick(pick.id); setOpen(false); setQuery(""); }
        }}
        aria-label="Find an item"
      />

      {open && !creating && rect && createPortal(
        <div ref={panelRef} className="picker" style={{ position: "fixed", top: rect.top, left: rect.left }}>
          {matches.length > 0 ? (
            matches.map((i) => (
              <button
                key={i.id}
                type="button"
                className="picker-row"
                onClick={() => { onPick(i.id); setOpen(false); setQuery(""); }}
              >
                <span className="m">{i.code}</span>
                <span className="picker-name">
                  {i.name}
                  <VariantTags variant={asVariant(i.variant)} labelled />
                </span>
                <span className="picker-meta">
                  {i.is_stocked
                    ? `${fmt(Number(i.on_hand))} on hand`
                    : "service"}
                </span>
              </button>
            ))
          ) : (
            <div className="picker-empty">
              No item matches &ldquo;{query}&rdquo;
            </div>
          )}

          {query.trim() && (
            <button
              type="button"
              className="picker-row picker-create"
              onClick={() => { setCreating(true); setError(null); }}
            >
              + Create &ldquo;{query.trim()}&rdquo; as a new item
            </button>
          )}
        </div>,
        document.body
      )}

      {creating && rect && createPortal(
        <div ref={panelRef} className="picker picker-form" style={{ position: "fixed", top: rect.top, left: rect.left }}>
          <div className="picker-head">
            <strong>New item</strong>
            <button type="button" className="ghost tiny" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>

          {error && <div className="alert" style={{ margin: "0 0 0.6rem" }}>{error}</div>}

          <div className="field">
            <label>Name</label>
            <div className="readout">{query.trim()}</div>
          </div>

          {selects.map((s) => (
            <div className="field" key={s.depth}>
              <label>{LEVELS[s.depth] ?? `Level ${s.depth + 1}`}</label>
              <select
                value={s.value}
                onChange={(e) => {
                  const id = e.target.value;
                  setChain(id ? [...chain.slice(0, s.depth), id] : chain.slice(0, s.depth));
                }}
              >
                <option value="">{s.depth === 0 ? "Choose…" : "— file it here —"}</option>
                {s.options.map((o) => (
                  <option key={o.id} value={o.id}>{o.segment} · {o.name}</option>
                ))}
              </select>
            </div>
          ))}

          <div className="field">
            <label>Unit</label>
            <select value={uomId} onChange={(e) => setUomId(e.target.value)}>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{mode === "sales" ? "Sale price" : "Purchase price"}</label>
            <input type="number" min="0" step="any" value={price}
              onChange={(e) => setPrice(e.target.value)} placeholder="0" />
          </div>

          <label className="check" style={{ margin: "0.4rem 0" }}>
            <input type="checkbox" checked={stocked} onChange={(e) => setStocked(e.target.checked)} />
            Stocked
          </label>

          <div className="actions">
            <button type="button" onClick={submitNew} disabled={pending || !groupId}>
              {pending ? "Creating…" : groupCode ? `Create under ${groupCode}` : "Create"}
            </button>
            {!groupId && <span className="hint">Choose a category</span>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
