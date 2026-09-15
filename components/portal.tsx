"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children at the end of <body> instead of where they sit in the tree.
 *
 * Exists for one reason: a modal whose trigger lives inside a menu. The menu
 * unmounts when it closes, and a <dialog> that is a DOM child of it goes with
 * it — so clicking "Cancel order" would open a drawer and destroy it in the
 * same tick. Portalled, the drawer outlives the menu that offered it.
 *
 * React context still reaches through a portal, so form actions, useActionState
 * and everything else keep working exactly as they did.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  return host ? createPortal(children, host) : null;
}
