"use client";

import { useEffect, useState } from "react";
import { Star, Printer, Link2, Check, Copy } from "lucide-react";

/**
 * The document toolbar: favourite, print, copy link.
 *
 * These are real, not placeholders. A button that looks live and does
 * nothing teaches people not to trust the toolbar, which is worse than not
 * having one — so each of these does the whole of what it claims, entirely
 * in the browser:
 *
 *   Star     remembered per document in localStorage. No server, no schema,
 *            no posting — a preference about a screen, kept where screen
 *            preferences belong.
 *   Print    window.print(). @media print in globals.css drops the chrome.
 *   Link     copies the document's URL, with the copied state shown for a
 *            moment so the click has an answer.
 *
 * Anything that would need the ledger — send, cancel, reset to draft — is
 * deliberately absent rather than stubbed. Those are posting decisions and
 * belong to the engine, not to a toolbar.
 */
export function ErpDocToolbar({ docId, docNo }: { docId: string; docNo: string }) {
  const [starred, setStarred] = useState(false);
  const [copied, setCopied] = useState(false);

  const key = `starred:${docId}`;

  useEffect(() => {
    try {
      setStarred(window.localStorage.getItem(key) === "1");
    } catch {
      // Private windows and blocked site data throw on access rather than
      // returning null. An unavailable preference is not an error worth
      // showing anyone.
    }
  }, [key]);

  const toggleStar = () => {
    setStarred((was) => {
      const now = !was;
      try {
        if (now) window.localStorage.setItem(key, "1");
        else window.localStorage.removeItem(key);
      } catch { /* see above */ }
      return now;
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused outright; say nothing rather than
      // claim a copy that did not happen.
    }
  };

  return (
    <div className="erp-tools">
      <button
        type="button" onClick={toggleStar}
        className={`erp-tool ${starred ? "on" : ""}`}
        aria-pressed={starred}
        title={starred ? `Remove ${docNo} from starred` : `Star ${docNo}`}
      >
        <Star size={15} strokeWidth={2} fill={starred ? "currentColor" : "none"} />
      </button>

      <button type="button" onClick={() => window.print()} className="erp-tool" title="Print">
        <Printer size={15} strokeWidth={2} />
      </button>

      <button type="button" onClick={copyLink} className="erp-tool"
              title={copied ? "Link copied" : "Copy link"}>
        {copied ? <Check size={15} strokeWidth={2} /> : <Link2 size={15} strokeWidth={2} />}
      </button>
    </div>
  );
}

/** Copies a document number — the thing people read out over the phone. */
export function ErpCopyNumber({ docNo }: { docNo: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="erp-copyno" title={`Copy ${docNo}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(docNo);
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        } catch { /* refused; stay quiet */ }
      }}
    >
      {done ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
    </button>
  );
}
