"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actions";
import type { Thresholds, Targets, MetricId } from "@/lib/supplier-metrics";
import { shortDate } from "@/lib/format";
import { HelpHint } from "./help-hint";

type MetricRow = { id: MetricId; name: string; unit: string; supported: boolean };

/**
 * The boundaries, described in the terms the person setting them thinks in.
 *
 * Each field says what happens at the extreme rather than naming the
 * variable: "a supplier paying this much over the going rate scores zero"
 * is a sentence somebody can agree or disagree with. "premiumCeiling" is
 * not.
 */
const BOUNDARIES: {
  key: keyof Thresholds; label: string; unit: string; help: string;
}[] = [
  {
    key: "cvLimit", label: "Lead-time spread scoring zero", unit: "ratio",
    help: "How much delivery times can vary before consistency scores nothing. "
      + "0.5 means the spread is half the average delivery time — a supplier "
      + "nobody can plan around. Lower is stricter.",
  },
  {
    key: "premiumCeiling", label: "Price premium scoring zero", unit: "%",
    help: "How far over the going rate a supplier can be before "
      + "competitiveness scores nothing. Meeting or beating the reference "
      + "price always scores 100.",
  },
  {
    key: "deviationCeiling", label: "Price movement scoring zero", unit: "%",
    help: "How much a supplier's own prices can move before stability scores "
      + "nothing. This is about whether a quote holds, not whether it is cheap.",
  },
  {
    key: "varianceCeiling", label: "Invoice variance scoring zero", unit: "%",
    help: "What share of invoices can disagree with the order or receipt "
      + "before the matching score reaches nothing.",
  },
];

export function SupplierSettingsForm({
  action, thresholds, targets, defaults, metrics, savedAt,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  thresholds: Thresholds;
  targets: Targets;
  defaults: { thresholds: Thresholds; targets: Targets };
  metrics: MetricRow[];
  savedAt: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(action as never, null);

  useEffect(() => { if (state && "ok" in state) router.refresh(); }, [state, router]);

  return (
    <form action={formAction}>
      {state && "error" in state && <div className="alert">{state.error}</div>}
      {state && "ok" in state && (
        <div className="page-sub" style={{ color: "var(--ok)" }}>Saved.</div>
      )}

      <section className="grid2">
        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>Business targets</h2>
              <HelpHint label="What a target does">
                What you expect of a supplier, shown beside each figure as a
                line to clear. Moving one changes nothing that has already
                happened: no score is recalculated and no past chart is
                redrawn. Leave one blank to have no target for it — blank is
                not nought, which would be a target every supplier clears.
              </HelpHint>
            </div>
          </div>
          <div className="card-body">
            <div className="fields">
              {metrics.filter((m) => m.supported).map((m) => (
                <div className="field" key={m.id}>
                  <label htmlFor={`g_${m.id}`}>{m.name}</label>
                  <input
                    id={`g_${m.id}`} name={`g_${m.id}`} type="number"
                    min="0" step="any"
                    defaultValue={targets[m.id] ?? ""}
                    placeholder={
                      defaults.targets[m.id] !== undefined
                        ? `default ${defaults.targets[m.id]}`
                        : "no target"
                    }
                  />
                  <div className="subline">
                    {m.unit === "" ? "a ratio — lower is better" : `in ${m.unit}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="headwith">
              <h2>Normalization boundaries</h2>
              <HelpHint label="What a boundary does">
                The 0&ndash;100 scale itself. Changing one redraws every
                chart, including ones already printed — the measurements do
                not move, but what they score does. Change them rarely, and
                say why. The defaults are illustrative: they were chosen so
                the first chart would draw, not discovered from your trade.
              </HelpHint>
            </div>
          </div>
          <div className="card-body">
            <div className="fields">
              {BOUNDARIES.map((b) => (
                <div className="field" key={b.key}>
                  <label htmlFor={`t_${b.key}`}>
                    {b.label}
                    {b.unit === "%" ? " (%)" : ""}
                  </label>
                  <input
                    id={`t_${b.key}`} name={`t_${b.key}`} type="number"
                    min="0" step="any"
                    defaultValue={thresholds[b.key]}
                    placeholder={`default ${defaults.thresholds[b.key]}`}
                  />
                  <div className="subline">{b.help}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        {savedAt && (
          <span className="page-sub">Last changed {shortDate(savedAt)}</span>
        )}
      </div>
    </form>
  );
}
