"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound, LogOut, ChevronsUpDown } from "lucide-react";
import { signOut } from "@/lib/auth-actions";

/**
 * Who is signed in, at the foot of the rail: a round mark with their
 * initials, their name, and what they can do. The two things a person does
 * with their own account — change the password, sign out — open above it.
 */
export function AccountMenu({ name, initials, roles }: { name: string; initials: string; roles: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="acct" ref={box}>
      {open && (
        <div className="acct-menu" role="menu">
          <Link href="/account/password" role="menuitem" onClick={() => setOpen(false)}>
            <KeyRound size={15} aria-hidden="true" /> Change password
          </Link>
          <form action={signOut}>
            <button type="submit" role="menuitem"><LogOut size={15} aria-hidden="true" /> Sign out</button>
          </form>
        </div>
      )}
      <button type="button" className="acct-btn" aria-haspopup="menu" aria-expanded={open}
              onClick={() => setOpen((v) => !v)} title={`${name} · ${roles}`}>
        <span className="acct-mark" aria-hidden="true">{initials}</span>
        <span className="acct-who">
          <span className="acct-name">{name}</span>
          <span className="acct-roles">{roles}</span>
        </span>
        <ChevronsUpDown size={15} aria-hidden="true" className="acct-chev" />
      </button>
    </div>
  );
}
