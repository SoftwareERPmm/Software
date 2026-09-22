import { money } from "@/lib/format";

/**
 * Shelf life left, as bands, worst first.
 *
 * The aging report's ramp runs green to red because a debt gets worse as it
 * ages. Stock runs the other way: a batch with a year left is the healthy
 * end and one already past its date is the loss. So the same ramp is read in
 * reverse — expired is the red end, and it comes first, because a card about
 * expiry that opens with the comfortable number buries the only figure
 * anybody has to act on today.
 *
 * Value at cost, not quantity. A hundred units of something cheap and ten of
 * something dear are not the same problem, and what a distributor decides
 * from is what the write-off would cost.
 */
export const EXPIRY_BANDS = [
  { band: "EXPIRED", label: "Expired", colour: "#D9566B", ink: "#B4283C" },
  { band: "D0_30",   label: "Within 30 days", colour: "#E8879B", ink: "#A33049" },
  { band: "D31_60",  label: "31–60 days", colour: "#F0A868", ink: "#9A5316" },
  { band: "D61_90",  label: "61–90 days", colour: "#F2D06B", ink: "#8A6A00" },
  { band: "OVER_90", label: "Over 90 days", colour: "#7FBF9B", ink: "#2F6B4F" },
] as const;

type Row = { band: string; batches: number; qty: string; value: string };

export function ExpiryBands({ bands }: { bands: Row[] }) {
  const by = new Map(bands.map((b) => [b.band, b]));
  const rows = EXPIRY_BANDS.map((b) => ({
    ...b,
    value: Number(by.get(b.band)?.value ?? 0),
    batches: Number(by.get(b.band)?.batches ?? 0),
  }));
  const total = rows.reduce((t, r) => t + r.value, 0);
  const atRisk = rows
    .filter((r) => r.band === "EXPIRED" || r.band === "D0_30")
    .reduce((t, r) => t + r.value, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Shelf life</h2>
        <span className="page-sub">
          {atRisk > 0 ? (
            <>
              <strong style={{ color: "var(--bad)" }}>{money(atRisk)}</strong>
              {" "}expired or expiring within 30 days
            </>
          ) : (
            <>All stock has more than 30 days left</>
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
              <span key={r.band} className="agingbar-seg"
                    style={{ background: r.colour, flexGrow: r.value }} />
            ))}
          </div>
        ) : (
          <div className="agingbar agingbar-empty" aria-hidden="true" />
        )}

        <dl className="aginglist">
          {rows.map((r) => (
            <div key={r.band}>
              <dt>
                <span className="agingdot" style={{ background: r.colour }} aria-hidden="true" />
                {r.label}
              </dt>
              <dd>
                <span className="aging-amt"
                      style={{ color: r.value > 0 ? r.ink : "var(--muted)" }}>
                  {r.value > 0 ? money(r.value) : "—"}
                </span>
                <span className="aging-pct">
                  {r.batches > 0
                    ? `${r.batches} batch${r.batches === 1 ? "" : "es"}`
                    : ""}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
