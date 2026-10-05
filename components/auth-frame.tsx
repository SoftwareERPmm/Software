import { getCompany } from "@/lib/queries";

/**
 * The frame around signing in: the app's own dark rail on the left, carrying
 * the company, and the form on the right. Signing in should feel like the
 * product opening, not like a separate site that happens to lead to it.
 * On a phone the rail folds into a header above the form.
 */
export async function AuthFrame({
  title, lead, children,
}: {
  title: string; lead?: React.ReactNode; children: React.ReactNode;
}) {
  const company = await getCompany().catch(() => null);
  const name = company?.name ?? "Myanmar ERP";
  const mark = (name.trim()[0] ?? "M").toUpperCase();
  return (
    <div className="auth">
      <aside className="auth-rail">
        <div className="auth-brand">
          <span className="auth-mark" aria-hidden="true">{mark}</span>
          <span className="auth-co">
            <span className="auth-co-name">{name}</span>
            {company?.name_my && <span className="auth-co-my" lang="my">{company.name_my}</span>}
          </span>
        </div>
        <p className="auth-rail-line">
          Inventory and accounting{company?.base_currency ? ` · ${company.base_currency}` : ""}
        </p>
      </aside>
      <main className="auth-main">
        <div className="auth-panel">
          <h1 className="auth-title">{title}</h1>
          {lead && <p className="auth-lead">{lead}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
