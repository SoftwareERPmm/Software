import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getSupplierPerformanceSetting, getRadarPresets } from "@/lib/queries";
import { requireFeature } from "@/lib/plans";
import {
  METRICS, DEFAULT_THRESHOLDS, DEFAULT_TARGETS, resolveThresholds, resolveTargets,
} from "@/lib/supplier-metrics";
import { saveSupplierPerformanceSettings, deleteRadarPreset } from "@/lib/actions";
import { SupplierSettingsForm } from "@/components/supplier-settings-form";
import { PresetList } from "@/components/preset-list";
import { HelpHint } from "@/components/help-hint";

/**
 * What this company means by a good supplier.
 *
 * Two sections that look similar and are not the same thing, which is the
 * whole reason this page exists rather than a row of inputs on the
 * dashboard. A target is an ambition and moving it changes nothing that
 * has already happened. A normalization boundary is the scale itself, and
 * moving it redraws every chart ever drawn, including the one somebody
 * printed last week. They are set apart, labelled apart, and the page says
 * so in as many words.
 */
export default async function SupplierPerformanceSettingsPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company is set up yet.</div>;
  if (!requireFeature(company.plan, "supplier_performance")) notFound();

  const [stored, presets] = await Promise.all([
    getSupplierPerformanceSetting(company.id),
    getRadarPresets(company.id),
  ]);

  const thresholds = resolveThresholds(stored?.thresholds);
  const targets = resolveTargets(stored?.targets);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Supplier performance</span>
        <h1>Settings</h1>
        <HelpHint>
          Company-wide, and presentation only: everything here changes how
          figures are scored and shown, never what was purchased. Nothing
          on this page is read by posting, valuation or any document.
        </HelpHint>
        {/* The actions slot, which page-head pushes to the far end. */}
        <div className="actions">
          <Link className="btn ghost" href="/purchases/supplier-performance">
            Back to the dashboard
          </Link>
        </div>
      </div>

      <SupplierSettingsForm
        action={saveSupplierPerformanceSettings}
        thresholds={thresholds}
        targets={targets}
        defaults={{ thresholds: DEFAULT_THRESHOLDS, targets: DEFAULT_TARGETS }}
        metrics={Object.values(METRICS).map((m) => ({
          id: m.id, name: m.name, unit: m.unit, supported: m.supported,
        }))}
        savedAt={stored?.updated_at ?? null}
      />

      <PresetList presets={presets} action={deleteRadarPreset} />
    </>
  );
}
