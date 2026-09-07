"use client";

import { Printer } from "lucide-react";

/** The only interactive thing on a printed page, and it prints it. */
export function PrintButton() {
  return (
    <button type="button" className="tiny" onClick={() => window.print()}>
      <Printer size={13} aria-hidden="true" /> Print
    </button>
  );
}
