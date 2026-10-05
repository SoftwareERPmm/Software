import Link from "next/link";
import { SearchX } from "lucide-react";

export const metadata = { title: "Not found · Myanmar ERP" };

export default function NotFound() {
  return (
    <div className="gate">
      <div className="gate-panel">
        <span className="gate-code"><SearchX size={16} aria-hidden="true" /> Not found</span>
        <h1>There is nothing at this address</h1>
        <p>
          The link may be mistyped, or the record it pointed to no longer exists.
          Documents are never deleted once posted, so an old document link that
          fails was most likely copied wrong.
        </p>
        <div className="gate-actions">
          <Link href="/" className="btn">Go to the dashboard</Link>
          <Link href="/documents" className="btn ghost">All documents</Link>
        </div>
      </div>
    </div>
  );
}
