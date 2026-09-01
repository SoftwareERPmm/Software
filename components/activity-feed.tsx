import Link from "next/link";
import {
  ShoppingCart, Truck, Receipt, RotateCcw, Wallet, ClipboardList, Package, ArrowLeftRight,
} from "lucide-react";
import { money, timeAgo } from "@/lib/format";

const ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  SALES_ORDER: ShoppingCart,
  DELIVERY: Truck,
  SALES_INVOICE: Receipt,
  SALES_RETURN: RotateCcw,
  CUSTOMER_RECEIPT: Wallet,
  PURCHASE_ORDER: ClipboardList,
  GOODS_RECEIPT: Package,
  PURCHASE_INVOICE: Receipt,
  PURCHASE_RETURN: RotateCcw,
  SUPPLIER_PAYMENT: Wallet,
  STOCK_ADJUSTMENT: ArrowLeftRight,
  STOCK_TRANSFER: ArrowLeftRight,
};

const label = (t: string) => t.replace(/_/g, " ").toLowerCase();

export type ActivityDoc = {
  id: string;
  doc_type: string;
  doc_no: string | null;
  partner_name: string | null;
  gross_total: string | number;
  posted_at: string | null;
  posting_date: string;
};

export function ActivityFeed({ docs }: { docs: ActivityDoc[] }) {
  if (docs.length === 0) return <div className="empty">Nothing posted yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {docs.map((d) => {
        const Icon = ICON[d.doc_type] ?? ClipboardList;
        return (
          <Link
            key={d.id}
            href={`/documents/${d.id}`}
            style={{
              display: "flex", alignItems: "center", gap: "0.7rem",
              padding: "0.55rem 0.4rem", margin: "0 -0.4rem", borderRadius: "6px",
              borderBottom: "1px solid var(--line-soft)",
            }}
            className="activity-row"
          >
            <span style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "28px", height: "28px", borderRadius: "999px", flexShrink: 0,
              background: "var(--line-soft)", color: "var(--brand)",
            }}>
              <Icon size={14} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block" }}>
                <span className="m" style={{ color: "var(--brand)" }}>{d.doc_no ?? "—"}</span>
                {" "}
                <span style={{ color: "var(--muted)" }}>{label(d.doc_type)}</span>
                {d.partner_name && <> · {d.partner_name}</>}
              </span>
            </span>
            <span style={{ flexShrink: 0, textAlign: "right" }}>
              <span className="m" style={{ display: "block", fontVariantNumeric: "tabular-nums" }}>
                {money(d.gross_total)}
              </span>
              <span className="page-sub" style={{ fontSize: "0.72rem" }}>
                {timeAgo(d.posted_at ?? d.posting_date)}
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
