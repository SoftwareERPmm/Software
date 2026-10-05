/**
 * Who created a document, as initials in a list. The full name is on hover
 * and on the document itself; a document from before anyone signed in has
 * nobody to name and shows a dash.
 */
export function By({ name, initials }: { name?: string | null; initials?: string | null }) {
  if (!name) return <span className="by-none" title="Recorded before sign-in existed">—</span>;
  return <span className="by-chip" title={name}>{initials ?? name.slice(0, 2).toUpperCase()}</span>;
}
