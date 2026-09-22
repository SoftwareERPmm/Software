import { money } from "@/lib/format";

/**
 * What a year of corrections was made of.
 *
 * The categories are nominal, not a severity ramp, so this deliberately does
 * not reuse the aging report's green-to-red gradient: there is no sense in
 * which a discount is "worse" than a cancellation, and a ramp would invent
 * an order that does not exist. It borrows the dashboard's categorical
 * palette instead — the same hues the top-categories donut uses — and the
 * bar's only claim is relative size.
 *
 * Amounts, not counts. Twenty small goodwill discounts and one cancelled
 * order are not the same event, and what anybody acts on is the money.
 */
export const NOTE_REASONS = [
  { key: "RETURN", colour: "var(--brand)" },
  { key: "BILLING_ERROR", colour: "#E8A33D" },
  { key: "CANCELLATION", colour: "#3D7FE8" },
  { key: "DISCOUNT", colour: "#7A5CD6" },
  { key: "OTHER", colour: "#2FA8A0" },
  { key: "UNCATEGORISED", colour: "#9AA5B4" },
] as const;

/** Wordings run opposite ways on the two notes, as they do on the form. */
export function reasonLabel(key: string | null | undefined, isCredit: boolean) {
  switch (key) {
    case "RETURN":
      return isCredit ? "Goods returned" : "Goods rejected";
    case "BILLING_ERROR": return "Billing error";
    case "CANCELLATION": return "Cancellation";
    case "DISCOUNT": return isCredit ? "Discount" : "Reduction agreed";
    case "OTHER": return "Other";
    default: return "Not categorised";
  }
}

type Note = { adjustment_reason: string | null; gross_total: string | number };

export function NoteReasons({
  notes, isCredit,
}: {
  notes: Note[];
  isCredit: boolean;
}) {
  const rows = NOTE_REASONS.map((r) => {
    const mine = notes.filter(
      (n) => (n.adjustment_reason ?? "UNCATEGORISED") === r.key,
    );
    return {
      ...r,
      label: r.key === "UNCATEGORISED"
        ? "Not categorised"
        : reasonLabel(r.key, isCredit),
      value: mine.reduce((t, n) => t + Number(n.gross_total), 0),
      count: mine.length,
    };
  });

  const total = rows.reduce((t, r) => t + r.value, 0);
  const biggest = [...rows].sort((a, b) => b.value - a.value)[0];

  return (
    <div className="card">
      <div className="card-head">
        <h2>What was corrected</h2>
        <span className="page-sub">
          {total > 0 ? (
            <>
              <strong>{money(total)}</strong> across {notes.length}{" "}
              note{notes.length === 1 ? "" : "s"}
              {biggest && biggest.value > 0 && (
                <> · mostly {biggest.label.toLowerCase()}</>
              )}
            </>
          ) : (
            <>Nothing corrected yet</>
          )}
        </span>
      </div>

      <div className="card-body">
        {total > 0 ? (
          <div
            className="agingbar"
            role="img"
            aria-label={rows.filter((r) => r.value > 0)
              .map((r) => `${r.label} ${money(r.value)}`).join(", ")}
          >
            {rows.filter((r) => r.value > 0).map((r) => (
              <span key={r.key} className="agingbar-seg"
                    style={{ background: r.colour, flexGrow: r.value }} />
            ))}
          </div>
        ) : (
          <div className="agingbar agingbar-empty" aria-hidden="true" />
        )}

        <dl className="aginglist">
          {/* A category nobody has used is still worth a row at zero: the
              list doubles as the set of reasons on offer, and a reader who
              only ever sees the three in use cannot tell what is missing. */}
          {rows.map((r) => (
            <div key={r.key}>
              <dt>
                <span className="agingdot" style={{ background: r.colour }} aria-hidden="true" />
                {r.label}
              </dt>
              <dd>
                <span className="aging-amt"
                      style={{ color: r.value > 0 ? "var(--ink)" : "var(--muted)" }}>
                  {r.value > 0 ? money(r.value) : "—"}
                </span>
                <span className="aging-pct">
                  {r.count > 0 ? `${r.count} note${r.count === 1 ? "" : "s"}` : ""}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
