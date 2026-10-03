import { money } from "@/lib/format";

/**
 * The five bands, in the order a bill passes through them.
 *
 * Green through red because the sequence is a worsening one and that is the
 * one place a colour ramp says something true: 90+ is not a different kind of
 * debt from 31-60, it is the same debt later. `ink` is the darker reading of
 * each band, for a figure that has to stay legible against white.
 */
export const BUCKETS = [
  { key: "current_amt", field: "current_amt", bucket: "CURRENT", label: "Not yet due",
    band: "#7FBF9B", ink: "#2F6B4F" },
  { key: "d1_30",  field: "d1_30",  bucket: "1-30",  label: "1–30 days",
    band: "#F2D06B", ink: "#8A6A00" },
  { key: "d31_60", field: "d31_60", bucket: "31-60", label: "31–60 days",
    band: "#F0A868", ink: "#9A5316" },
  { key: "d61_90", field: "d61_90", bucket: "61-90", label: "61–90 days",
    band: "#E8879B", ink: "#A33049" },
  { key: "d90",    field: "d90",    bucket: "90+",   label: "90+ days",
    band: "#D9566B", ink: "#B4283C" },
  /* Last, and deliberately outside the ramp. Grey because it is not a
     position on the scale from healthy to hopeless — it is an absence of one.
     Given green it read as settled; given red it would read as overdue, and
     it is neither. Somebody simply has to find out what was agreed. */
  { key: "no_due",  field: "no_due",  bucket: "NO_DUE_DATE", label: "No due date",
    band: "#B9C2CC", ink: "#5B6672" },
] as const;

/**
 * The same ramp for goods that shipped and were never billed, which pass
 * through five bands of their own. No "not yet due" and no "no due date": a
 * delivery has a date and nothing about it is agreed, so the only question
 * is how long ago it left. The first week is its own band because inside it
 * nothing is wrong — the invoice is simply still being written.
 */
export const SHIPPED_BANDS = [
  { key: "d0_7",   bucket: "0-7",   label: "0–7 days",
    band: "#7FBF9B", ink: "#2F6B4F" },
  { key: "d8_30",  bucket: "8-30",  label: "8–30 days",
    band: "#F2D06B", ink: "#8A6A00" },
  { key: "d31_60", bucket: "31-60", label: "31–60 days",
    band: "#F0A868", ink: "#9A5316" },
  { key: "d61_90", bucket: "61-90", label: "61–90 days",
    band: "#E8879B", ink: "#A33049" },
  { key: "d90",    bucket: "90+",   label: "90+ days",
    band: "#D9566B", ink: "#B4283C" },
] as const;

type Band = { key: string; bucket: string; label: string; band: string; ink: string };

type Bucket = { aging_bucket: string; invoices: number; total: string };

/**
 * One side's aging, as a proportional bar and the figures under it.
 *
 * The bar is the point: five numbers in a row tell you the amounts, and only
 * their widths tell you the shape — whether what is owed is mostly current
 * with a tail, or mostly ninety days old with a little current on the front.
 * A band with nothing in it is left out of the bar rather than drawn at zero
 * width, so the segments that are there keep their proportions honestly.
 */
export function AgingBands({ title, buckets, bands = BUCKETS, subtitle }: {
  title: string; buckets: Bucket[];
  /** Which ramp to read the buckets against. Defaults to the invoice bands. */
  bands?: readonly Band[];
  /** Replaces the total in the card head, where the total is not the point. */
  subtitle?: React.ReactNode;
}) {
  const by = new Map(buckets.map((b) => [b.aging_bucket, Number(b.total ?? 0)]));
  const rows = bands.map((b) => ({ ...b, amount: by.get(b.bucket) ?? 0 }));
  const total = rows.reduce((t, r) => t + r.amount, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="page-sub">
          {subtitle ?? (
            <>Total <strong style={{ color: "var(--ink)" }}>{money(total)}</strong></>
          )}
        </span>
      </div>

      <div className="card-body">
        {total > 0 ? (
          <div className="agingbar" role="img"
               aria-label={rows.filter((r) => r.amount > 0)
                 .map((r) => `${r.label} ${money(r.amount)}`).join(", ")}>
            {rows.filter((r) => r.amount > 0).map((r) => (
              <span key={r.key} className="agingbar-seg"
                    style={{ background: r.band, flexGrow: r.amount }} />
            ))}
          </div>
        ) : (
          <div className="agingbar agingbar-empty" aria-hidden="true" />
        )}

        <dl className="aginglist">
          {rows.map((r) => (
            <div key={r.key}>
              <dt>
                <span className="agingdot" style={{ background: r.band }} aria-hidden="true" />
                {r.label}
              </dt>
              <dd>
                <span className="aging-amt" style={{ color: r.amount > 0 ? r.ink : "var(--muted)" }}>
                  {r.amount > 0 ? money(r.amount) : "—"}
                </span>
                <span className="aging-pct">
                  {total > 0 && r.amount > 0 ? `${Math.round((r.amount / total) * 100)}%` : ""}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
