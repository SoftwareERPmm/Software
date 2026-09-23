"use client";

import { HelpHint } from "@/components/help-hint";

/**
 * One span, as a dial.
 *
 * A number alone does not say whether 178 days is ordinary or alarming. The
 * dial answers that at a glance by putting the figure on a scale somebody
 * chose, with the bands in the order a reader expects — green where you want
 * to be, red where you do not.
 *
 * Ticks every eighth of the scale, because a needle with nothing behind it
 * is decoration: it shows a position without saying a position on what.
 *
 * The scale has to be picked per span. Days payable runs much longer than
 * days inventory in any real trade, and forcing them onto one axis would
 * make the shorter dial read as permanently excellent.
 */
export function CycleGauge({
  value, max, label, hint, explain, invert = false,
}: {
  value: number | null;
  max: number;
  label: string;
  hint?: string;
  /** How the figure is worked out, behind the mark beside the title. */
  explain?: React.ReactNode;
  /** True where more is better — days payable. The bands run the other way. */
  invert?: boolean;
}) {
  const R = 78;          // arc radius
  const CX = 100;
  const CY = 96;
  const W = 14;          // arc thickness

  // Where on the dial the needle sits. Past the end it pins at the end
  // rather than spinning off, and says so by colour.
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const over = value !== null && value > max;
  const angle = Math.PI * (1 - frac);

  const point = (a: number, r: number) => ({
    x: CX + r * Math.cos(a),
    y: CY - r * Math.sin(a),
  });

  const arc = (fromFrac: number, toFrac: number, colour: string) => {
    const a0 = Math.PI * (1 - fromFrac);
    const a1 = Math.PI * (1 - toFrac);
    const p0 = point(a0, R);
    const p1 = point(a1, R);
    return (
      <path
        key={`${fromFrac}-${colour}`}
        d={`M ${p0.x} ${p0.y} A ${R} ${R} 0 0 1 ${p1.x} ${p1.y}`}
        fill="none" stroke={colour} strokeWidth={W} strokeLinecap="butt"
      />
    );
  };

  // Green → amber → red, reversed where a longer span is the good one.
  const bands = invert
    ? [["#D9566B", 0, 0.34], ["#E8A33D", 0.34, 0.67], ["#2E7D55", 0.67, 1]]
    : [["#2E7D55", 0, 0.34], ["#E8A33D", 0.34, 0.67], ["#D9566B", 0.67, 1]];

  // Short, and the figure sits high in the dial above its reach. The needle
  // pivots at the centre, so anything drawn near that centre is crossed by
  // it at some value — which is why the number moved up rather than the
  // needle merely shrinking.
  const needle = point(angle, R * 0.35);

  return (
    <div className="dash-card dash-card-pad">
      <div className="dash-section-head">
        <div>
          <h2 style={{ fontSize: "var(--t-md)" }}>
            {label}
            {explain && <HelpHint label={`How ${label} is worked out`}>{explain}</HelpHint>}
          </h2>
          {hint && <span className="dash-sub">{hint}</span>}
        </div>
      </div>

      <svg viewBox="0 0 200 118" role="img"
           aria-label={`${label}: ${value === null ? "no figure" : Math.round(value)} of ${max}`}
           style={{ width: "100%", maxWidth: 220, display: "block", margin: "0 auto" }}>
        {(bands as [string, number, number][]).map(([c, a, b]) => arc(a, b, c))}

        {/* Ticks. Eight gaps, nine marks, including both ends. */}
        {Array.from({ length: 9 }, (_, i) => {
          const f = i / 8;
          const a = Math.PI * (1 - f);
          const outer = point(a, R + W / 2);
          const inner = point(a, R + W / 2 - (i % 2 === 0 ? 7 : 4));
          return (
            <line key={i} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y}
                  stroke="var(--muted)" strokeWidth={i % 2 === 0 ? 1.4 : 1} opacity={0.65} />
          );
        })}

        {value !== null && (
          <>
            <line x1={CX} y1={CY} x2={needle.x} y2={needle.y}
                  stroke="var(--ink)" strokeWidth={2.4} strokeLinecap="round" />
            <circle cx={CX} cy={CY} r={4.5} fill="var(--ink)" />
          </>
        )}

        {/* Above the needle's reach — R * 0.35 is 27px, and this baseline is
            32px up, so no value can put the needle through the figure. */}
        <text x={CX} y={CY - 32} textAnchor="middle"
              style={{ fontSize: 24, fontWeight: 700, fill: "var(--ink)" }}>
          {value === null ? "—" : Math.round(value)}
        </text>
        <text x={CX} y={CY - 18} textAnchor="middle"
              style={{ fontSize: 10, fill: "var(--muted)" }}>
          days
        </text>

        <text x={CX - R} y={CY + 16} textAnchor="middle"
              style={{ fontSize: 9, fill: "var(--muted)" }}>0</text>
        <text x={CX + R} y={CY + 16} textAnchor="middle"
              style={{ fontSize: 9, fill: "var(--muted)" }}>{max}</text>
      </svg>

      {over && (
        <div className="subline" style={{ textAlign: "center", color: "var(--warn)" }}>
          past the end of the scale
        </div>
      )}
    </div>
  );
}
