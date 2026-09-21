import Link from "next/link";
import { PERIOD_SPANS, resolvePeriod, type Period } from "@/lib/period";

/**
 * The window one card is reporting on.
 *
 * Per card rather than per page, so revenue can be read over a year while
 * the top sellers are read over this month — the comparison people actually
 * want is rarely the same span for every question on the screen.
 *
 * Which means each card has to say what it is showing, in its own header,
 * every time. A figure that could be any of five windows and does not name
 * the one it used is worse than no filter at all.
 */
export function PeriodPicker({
  current, hrefFor, label,
}: {
  current: Period;
  hrefFor: (spec: string) => string;
  /** What this picker filters, for anyone reading it with a screen reader. */
  label: string;
}) {
  return (
    <nav className="card-period" aria-label={`Period for ${label}`}>
      {PERIOD_SPANS.map((k) => {
        const on = current.key === k;
        return (
          <Link
            key={k}
            href={hrefFor(k)}
            className={`card-period-opt${on ? " on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-label={resolvePeriod(k).label}
          >
            {resolvePeriod(k).short}
          </Link>
        );
      })}
      {/* A month picked off the chart belongs to no span, so it takes its own
          slot at the end rather than leaving all four looking unselected. */}
      {current.month && (
        <span className="card-period-opt on" title={current.label}>
          {current.short}
        </span>
      )}
    </nav>
  );
}
