"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PickerPartner = {
  id: string;
  code: string;
  name: string;
  /** Anything else worth matching on — a phone number, a township. */
  phone?: string | null;
  township?: string | null;
};

/**
 * Type to find a customer or a supplier.
 *
 * A dropdown is a list you read. That is fine at a dozen partners and useless
 * at four hundred: the name is somewhere in there and the only way to find it
 * is with your eyes, one row at a time, while somebody waits at the counter.
 * Typing two letters of the name — or the code, or the phone number, which is
 * often what the person on the phone gives you — narrows it to the one.
 *
 * It stays a real form field. The chosen id sits in a hidden input under the
 * name the form already posts, so every action reading `partner_id` keeps
 * working and nothing about submission changes.
 */
export function PartnerPicker({
  partners, value, onPick, name = "partner_id", id = "partner_id",
  placeholder, disabled = false, required = true,
}: {
  partners: PickerPartner[];
  value: string;
  onPick: (id: string) => void;
  name?: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const chosen = partners.find((p) => p.id === value) ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return partners.slice(0, 50);
    return partners
      .filter((p) =>
        [p.code, p.name, p.phone ?? "", p.township ?? ""]
          .join(" ").toLowerCase().includes(q))
      .slice(0, 50);
  }, [partners, query]);

  // Clicking anywhere else closes it without choosing — the same thing a
  // dropdown does, which is what people expect of something shaped like one.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (p: PickerPartner) => {
    onPick(p.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="ppick" ref={box}>
      <input type="hidden" name={name} value={value} />
      <input
        id={id}
        type="text"
        autoComplete="off"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        role="combobox"
        placeholder={placeholder ?? "Type a name, code or phone…"}
        value={open ? query : chosen ? `${chosen.code} · ${chosen.name}` : ""}
        onFocus={() => { setOpen(true); setQuery(""); setActive(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); choose(matches[active]); }
          else if (e.key === "Escape") { setOpen(false); }
        }}
      />
      {/* The browser's own "please fill this in" needs something required to
          point at, and a hidden input cannot be focused to show it. */}
      {required && !value && (
        <input
          className="ppick-guard" tabIndex={-1} required
          aria-hidden="true" value="" onChange={() => {}}
        />
      )}

      {open && (
        <ul className="ppick-list" id={`${id}-list`} role="listbox">
          {matches.length === 0 ? (
            <li className="ppick-none">Nobody matches “{query}”</li>
          ) : (
            matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? "on" : undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(p); }}
              >
                <span className="code">{p.code}</span> {p.name}
                {p.township && <span className="ppick-where"> · {p.township}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
