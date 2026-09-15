"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * A link to a document that knows the way back to this screen.
 *
 * These links used to open a new tab, so the half-filled form behind them
 * survived. It also left the reader with two tabs and no way back in either,
 * and a tab to remember to close. The document page already accepts `back` as
 * a path within the app and draws it as a named arrow, so the document opens
 * here and the arrow leads home — at the cost of whatever was typed, which is
 * the honest trade: these links appear exactly where what you were about to
 * enter may be the wrong thing to enter.
 *
 * The query string travels too. Arriving at a bill from a receipt and then
 * following a link out of it should come back to that same bill, not to a
 * blank one.
 */
export function useBackHere() {
  const path = usePathname();
  const params = useSearchParams();
  const q = params.toString();
  const here = q ? `${path}?${q}` : path;
  return (id: string) => `/documents/${id}?back=${encodeURIComponent(here)}`;
}
