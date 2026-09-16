"use client";

import { useEffect } from "react";

/**
 * Opens the calendar when a date field is clicked anywhere, not only on its
 * icon.
 *
 * Reported from Windows: the due date on a purchase invoice could not be
 * chosen. It works on macOS because Chrome there opens the picker when the
 * field itself is clicked. On Windows, Chrome and Edge open it only from the
 * small calendar button at the right edge — clicking the text simply puts the
 * cursor in the day segment — and in a field sized for a dense header that
 * button is a few pixels wide. So the field looked live, took focus, and gave
 * no calendar.
 *
 * showPicker() is the documented way to ask for it. It throws when the
 * browser has no picker to show or when the call is not inside a user
 * gesture, and Safari does not implement it at all — all of which are fine,
 * because those are exactly the cases where clicking already works. Hence the
 * empty catch: this only ever adds a way in.
 *
 * Delegated from the document rather than wired into thirty-six inputs, so a
 * form written tomorrow gets it without knowing about it.
 */
export function DatePickerFix() {
  useEffect(() => {
    const open = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!(el instanceof HTMLInputElement)) return;
      if (el.type !== "date" && el.type !== "time" && el.type !== "month") return;
      if (el.disabled || el.readOnly) return;
      try {
        (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
      } catch {
        // No picker, or the browser declined. Clicking still focuses the
        // field and typing still works, which is what happened before.
      }
    };
    document.addEventListener("click", open);
    return () => document.removeEventListener("click", open);
  }, []);

  return null;
}
