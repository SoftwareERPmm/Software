"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";
import { MIN_RADAR_AXES, MAX_RADAR_AXES, type MetricId } from "@/lib/supplier-metrics";

/**
 * Which three to six axes the radar is drawn from.
 *
 * The order matters and is preserved: a radar's shape changes entirely with
 * the order of its axes, so two people comparing screenshots need the same
 * sequence, and the sequence is therefore part of the URL rather than
 * component state. The whole selection lives in the query string — it
 * survives a refresh, it can be sent to somebody else, and the server
 * renders the chart the link describes.
 *
 * Below three axes a radar is a triangle with no shape to read; above six
 * the labels collide and nobody can tell which spoke is which. Both bounds
 * are enforced here and again on the server, because a hand-edited URL
 * should not be able to produce a chart the page cannot draw.
 */
export function RadarAxisPicker({
  axes, available, defaults, presets, saveAction,
}: {
  axes: MetricId[];
  available: { id: MetricId; name: string }[];
  defaults: MetricId[];
  presets: { id: string; name: string; axes: string[]; is_default: boolean }[];
  saveAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(saveAction as never, null);

  useEffect(() => {
    if (state && "ok" in state) { setSaving(false); router.refresh(); }
  }, [state, router]);

  const go = (next: MetricId[]) => {
    const p = new URLSearchParams(params.toString());
    p.set("axes", next.join(","));
    router.push(`${pathname}?${p.toString()}`);
  };

  const toggle = (id: MetricId) => {
    const on = axes.includes(id);
    if (on && axes.length <= MIN_RADAR_AXES) return;
    if (!on && axes.length >= MAX_RADAR_AXES) return;
    go(on ? axes.filter((a) => a !== id) : [...axes, id]);
  };

  const move = (id: MetricId, by: -1 | 1) => {
    const i = axes.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= axes.length) return;
    const next = [...axes];
    [next[i], next[j]] = [next[j], next[i]];
    go(next);
  };

  const atMin = axes.length <= MIN_RADAR_AXES;
  const atMax = axes.length >= MAX_RADAR_AXES;

  return (
    <details className="axis-picker">
      <summary>
        Customise radar
        <span className="page-sub"> · {axes.length} of {MAX_RADAR_AXES} axes</span>
      </summary>

      <div className="axis-picker-body">
        <ol className="axis-order">
          {axes.map((id, i) => {
            const m = available.find((a) => a.id === id);
            return (
              <li key={id}>
                <span>{m?.name ?? id}</span>
                <span className="axis-order-controls">
                  <button type="button" onClick={() => move(id, -1)}
                          disabled={i === 0} aria-label={`Move ${m?.name} earlier`}>↑</button>
                  <button type="button" onClick={() => move(id, 1)}
                          disabled={i === axes.length - 1}
                          aria-label={`Move ${m?.name} later`}>↓</button>
                  <button type="button" onClick={() => toggle(id)}
                          disabled={atMin} aria-label={`Remove ${m?.name}`}>×</button>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="axis-available">
          {available.filter((a) => !axes.includes(a.id)).map((a) => (
            <button key={a.id} type="button" className="chip"
                    onClick={() => toggle(a.id)} disabled={atMax}>
              + {a.name}
            </button>
          ))}
        </div>

        {presets.length > 0 && (
          <div className="axis-presets">
            <span className="page-sub">Saved:</span>
            {presets.map((p) => (
              <button key={p.id} type="button" className="chip"
                      onClick={() => go(p.axes as MetricId[])}>
                {p.name}{p.is_default ? " ·" : ""}
              </button>
            ))}
          </div>
        )}

        {state && "error" in state && <div className="alert">{state.error}</div>}

        {saving ? (
          // Saving what is on screen, named. The axes go in a hidden field
          // rather than being re-derived on the server, so what is saved is
          // exactly the arrangement being looked at.
          <form action={formAction} className="axis-save">
            <input type="hidden" name="axes" value={axes.join(",")} />
            <div className="field">
              <label htmlFor="preset-name">Save these {axes.length} axes as</label>
              <input id="preset-name" name="name" required
                     placeholder="Quality review, Cost review" />
            </div>
            <label className="check">
              <input type="checkbox" name="is_default" />
              open this one by default
            </label>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save preset"}
              </button>
              <button type="button" className="ghost"
                      onClick={() => setSaving(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setSaving(true)}>
              Save as preset
            </button>
            <Link className="page-sub" href="/purchases/supplier-performance/settings">
              Manage presets and thresholds
            </Link>
          </div>
        )}

        <div className="actions">
          {atMin && (
            <span className="page-sub">
              Three is the fewest a radar can show and still have a shape.
            </span>
          )}
          {atMax && (
            <span className="page-sub">
              Six is as many as will fit before the labels collide.
            </span>
          )}
          <button type="button" className="ghost" onClick={() => go(defaults)}>
            Restore default
          </button>
        </div>
      </div>
    </details>
  );
}
