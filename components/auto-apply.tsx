"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * A report's filters apply themselves.
 *
 * Changing the branch and then reading the old figures is the failure this
 * removes: nothing on screen was wrong, but the numbers were answering the
 * previous question, and the only clue was a button you had not pressed. A
 * filter that has been changed and not applied is a report that lies quietly.
 *
 * Dropped into any GET form. It walks up to that form and submits it whenever
 * a control changes. The button marked `data-apply` is then hidden by CSS —
 * by a class on the document rather than by hiding the element itself, which
 * lasts exactly until the next render replaces the markup it was hiding.
 * Without JavaScript the class is never added, so the button is there and
 * works: enhancement, not replacement.
 *
 * Navigation goes through the router rather than the browser's own form
 * submit, so the page does not jump back to the top and the filters stay
 * where they are under the cursor. `replace` rather than `push`: eight
 * fiddles with a date range should not be eight presses of Back to leave.
 *
 * While it runs — two seconds on a report that asks the database several
 * questions — the figures underneath are dimmed. They are still the previous
 * branch's answer, and leaving them looking settled recreates the problem
 * this was written to fix, only briefly: numbers that look current while they
 * answer the question before last.
 */
export function AutoApply() {
  const mark = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  const [pending, start] = useTransition();

  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;

    document.documentElement.classList.add("js-autoapply");

    const submit = () => {
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) {
        // Empty means "no filter", and carrying it in the URL only makes the
        // address unreadable and the Clear link look wrong.
        if (typeof value === "string" && value !== "") params.set(key, value);
      }
      const query = params.toString();
      start(() => router.replace(query ? `?${query}` : window.location.pathname,
        { scroll: false }));
    };

    form.addEventListener("change", submit);
    // A form with a submit button still has one for keyboard users; keep it
    // from reloading the whole page when they press Enter.
    const onSubmit = (e: Event) => { e.preventDefault(); submit(); };
    form.addEventListener("submit", onSubmit);

    return () => {
      form.removeEventListener("change", submit);
      form.removeEventListener("submit", onSubmit);
    };
  }, [router]);

  // On the document rather than on this element, because what has to change
  // is everything except the filters — and that is the whole page below them.
  useEffect(() => {
    document.documentElement.classList.toggle("is-filtering", pending);
    if (pending) document.body.setAttribute("aria-busy", "true");
    else document.body.removeAttribute("aria-busy");
  }, [pending]);

  // The line along the filters is what says this on screen; the word is here
  // for anyone who cannot see it move. It is also this element that locates
  // the form, so it stays in the markup either way.
  return (
    <span ref={mark} className="visually-hidden" aria-live="polite">
      {pending ? "Updating the report" : ""}
    </span>
  );
}
