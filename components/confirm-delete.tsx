"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Replaces window.confirm() for destructive row actions.
 *
 * The native dialog cannot be styled, renders differently on every OS, and
 * prefixes the message with the origin ("localhost:3000 says…"), which reads
 * like a browser warning about the site rather than a decision the app is
 * asking for.
 *
 * Built on <dialog showModal()> rather than a hand-rolled overlay so focus
 * trapping, Esc-to-close, inertness of the page behind, and the backdrop all
 * come from the platform instead of being reimplemented (usually badly).
 *
 * The server action is submitted from inside the dialog, so a refusal — a
 * foreign-key violation on something still in use, say — is shown here rather
 * than after the dialog has already disappeared.
 */
export function ConfirmDelete({
  action,
  pending,
  error,
  title,
  detail,
  label = "Delete",
  pendingLabel = "Deleting…",
  confirmLabel = "Delete",
  className = "danger tiny",
  children,
}: {
  action: (fd: FormData) => void;
  pending: boolean;
  /** Server-side refusal, shown in place rather than after the dialog closes. */
  error?: string | null;
  /** Names the exact record, so nobody confirms the wrong row. */
  title: string;
  detail?: string;
  label?: string;
  pendingLabel?: string;
  confirmLabel?: string;
  /** The trigger button's class. Defaults to the standalone red button; a
   *  row menu passes its own so the item sits flush with the others. */
  className?: string;
  /** Hidden inputs the action needs — id, return_to, and so on. */
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // An error only arrives after a submit, which means the dialog was open;
  // reopen it so the reason is attached to the thing that caused it.
  useEffect(() => {
    if (error && !ref.current?.open) ref.current?.showModal();
  }, [error]);

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={() => ref.current?.showModal()}
      >
        {pending ? pendingLabel : label}
      </button>

      <dialog ref={ref} className="confirm" onClick={(e) => {
        // Clicking the backdrop closes. The dialog element itself fills the
        // whole viewport, so the target is only the dialog when the click
        // landed outside the panel.
        if (e.target === ref.current) ref.current?.close();
      }}>
        <div className="confirm-panel">
          <div className="confirm-icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </div>

          <h2 className="confirm-title">{title}</h2>
          {detail && <p className="confirm-detail">{detail}</p>}
          {error && <div className="alert" style={{ marginTop: "var(--s2)" }}>{error}</div>}

          <form action={action} className="confirm-actions">
            {children}
            <button type="button" className="ghost" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="danger" disabled={pending}>
              {pending ? pendingLabel : confirmLabel}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
