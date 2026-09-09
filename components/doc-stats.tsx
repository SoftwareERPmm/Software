import type { LucideIcon } from "lucide-react";

/**
 * The three or four figures a document is really about, across the top.
 *
 * Ordered so they read as a sentence about where things stand — what arrived,
 * what was billed, what is still owed — and marked where one of them is the
 * problem. A tile with a tone is making a claim; the rest are just numbers,
 * and most of them should be.
 */
export type DocStat = {
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  note?: string;
  /** "warn" for the figure somebody has to act on, "ok" for one that is settled. */
  tone?: "warn" | "ok";
};

export function DocStats({ stats }: { stats: DocStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="docstats">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <div key={s.label} className={`docstat ${s.tone ?? ""}`}>
            <span className="docstat-icon"><Icon size={16} aria-hidden="true" /></span>
            <span className="docstat-label">{s.label}</span>
            <span className="docstat-value">
              {s.value}
              {s.unit && <span className="docstat-unit"> {s.unit}</span>}
            </span>
            {s.note && <span className="docstat-note">{s.note}</span>}
          </div>
        );
      })}
    </div>
  );
}
