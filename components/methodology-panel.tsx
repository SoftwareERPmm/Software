import {
  METRICS, DEFAULT_THRESHOLDS, DEFAULT_TARGETS,
} from "@/lib/supplier-metrics";

/**
 * How each number was arrived at, folded away until asked for.
 *
 * It was a permanent five-column strip across the middle of the page,
 * which pushed the supplier detail below the fold and was read once. But
 * it cannot simply go: a score somebody is about to take to a supplier
 * meeting has to be defensible, and "where does 85 come from" needs an
 * answer on the same page. So it is a disclosure — closed by default,
 * complete when opened.
 *
 * Every formula here is the one the code runs. When one changes, this text
 * changes with it, because both live in lib/supplier-metrics.ts and this
 * only renders what is declared there.
 */
export function MethodologyPanel() {
  return (
    <details className="card methodology">
      <summary className="card-head">
        <h2>Key metrics methodology</h2>
        <span className="page-sub">
          What each metric measures, what it does not, and the boundaries
          that turn a measurement into a score
        </span>
      </summary>

      <div className="card-body">
        <p className="page-sub">
          <strong>A target is not a scale.</strong> A business target is what
          the company wants — move it and nothing about history changes. A
          normalization boundary is what maps a measurement onto the 0–100
          axis; move that and every chart is redrawn. They are set separately
          and shown separately for that reason.
        </p>

        <dl className="methodology-list">
          {Object.values(METRICS).map((m) => (
            <div key={m.id} className={m.supported ? undefined : "is-unavailable"}>
              <dt>
                {m.name}
                {!m.supported && <span className="pill">not available</span>}
                {m.supported && DEFAULT_TARGETS[m.id] !== undefined && (
                  <span className="pill ok">target ≥ {DEFAULT_TARGETS[m.id]}%</span>
                )}
              </dt>
              <dd>
                <p>{m.methodology}</p>
                <p className="page-sub">
                  Reads: {m.dataSource}.
                  {m.supported
                    ? ` Needs at least ${m.minObservations} observations.`
                    : ` Needs: ${m.requires}`}
                </p>
              </dd>
            </div>
          ))}
        </dl>

        <p className="page-sub">
          Normalization boundaries in force: lead-time CV limit{" "}
          {DEFAULT_THRESHOLDS.cvLimit}, price premium ceiling{" "}
          {DEFAULT_THRESHOLDS.premiumCeiling}%, price
          deviation ceiling {DEFAULT_THRESHOLDS.deviationCeiling}%,
          matching variance ceiling{" "}
          {DEFAULT_THRESHOLDS.varianceCeiling}%. These are
          illustrative defaults, not discovered truths — they are here so the
          first chart draws, and a company is expected to set its own.
        </p>
      </div>
    </details>
  );
}
