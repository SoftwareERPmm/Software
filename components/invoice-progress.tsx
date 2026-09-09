import Link from "next/link";
import { Package, Wallet, Link2, TriangleAlert } from "lucide-react";
import { money, qty, shortDate } from "@/lib/db";
import { Avatar } from "./document-rail";

/**
 * The two halves of a purchase invoice, side by side.
 *
 * They are separate because they run separately: goods can be outstanding
 * while the money is settled, and the money can be outstanding while every
 * box has arrived. One combined "status" hides whichever of the two is the
 * problem, and an invoice paid in full will sit looking finished with sixty
 * boxes that never turned up.
 *
 * Each half carries what is still owed, when it was owed by, who owns
 * chasing it, and the action that resolves it. A half that is settled says
 * so quietly and offers nothing — there is nothing to do.
 */

type Half = {
  outstanding: number;
  overdue: boolean;
  responsible?: string | null;
  initials?: string | null;
  task?: string | null;
};

export function InvoiceProgress({
  goods, payment, unit, receiveHref, payHref, linkReceiptHref,
}: {
  goods: Half & {
    expectedDate: string | null; expectedFrom: string | null;
    billed?: number; arrived?: number; unmatched?: boolean;
  };
  payment: Half & { dueDate: string | null };
  unit: string | null;
  receiveHref: string;
  payHref: string;
  /** Where a receipt that already exists can be attached, when that is possible. */
  linkReceiptHref?: string | null;
}) {
  const settled = goods.outstanding <= 0 && payment.outstanding <= 0;
  if (settled) return null;

  return (
    <div className="halves">
      <Half
        icon={Package}
        title="Goods / Delivery"
        state={goods}
        amount={goods.outstanding > 0
          ? `${qty(String(goods.outstanding))}${unit ? ` ${unit}` : ""} outstanding`
          : "All received"}
        rows={[
          {
            label: "Received against this bill",
            value: goods.unmatched
              ? "none — no receipt names it"
              : `${qty(String(goods.arrived ?? 0))} of ${qty(String(goods.billed ?? 0))}`,
          },
          goods.expectedDate
            ? { label: "Expected delivery", value: shortDate(goods.expectedDate),
                strong: goods.overdue }
            : { label: "Expected delivery",
                value: goods.expectedFrom ? `not set on ${goods.expectedFrom}` : "not ordered" },
        ]}
        actions={goods.outstanding > 0 ? (
          <>
            <Link href={receiveHref} className="btn">
              <Package size={14} aria-hidden="true" /> Receive goods
            </Link>
            {linkReceiptHref && (
              <Link href={linkReceiptHref} className="btn ghost">
                <Link2 size={14} aria-hidden="true" /> Link existing receipt
              </Link>
            )}
          </>
        ) : null}
      />

      <Half
        icon={Wallet}
        title="Payment"
        state={payment}
        amount={payment.outstanding > 0
          ? `${money(payment.outstanding)} outstanding`
          : "Paid in full"}
        rows={[
          payment.dueDate
            ? { label: "Due date", value: shortDate(payment.dueDate), strong: payment.overdue }
            : { label: "Due date", value: "on receipt" },
        ]}
        actions={payment.outstanding > 0 ? (
          <Link href={payHref} className="btn">
            <Wallet size={14} aria-hidden="true" /> Record payment
          </Link>
        ) : null}
      />
    </div>
  );
}

function Half({
  icon: Icon, title, state, amount, rows, actions,
}: {
  icon: typeof Package;
  title: string;
  state: Half;
  amount: string;
  rows: { label: string; value: string; strong?: boolean }[];
  actions: React.ReactNode;
}) {
  const done = state.outstanding <= 0;
  return (
    <section className={`half ${done ? "done" : state.overdue ? "late" : ""}`}>
      <div className="half-head">
        <span className="half-icon"><Icon size={15} aria-hidden="true" /></span>
        <h2>{title}</h2>
        {state.overdue && (
          <span className="pill overdue">
            <TriangleAlert size={11} aria-hidden="true" /> Overdue
          </span>
        )}
        {done && <span className="pill ok">Settled</span>}
      </div>

      <p className="half-amount">{amount}</p>

      <dl className="raildl">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd style={r.strong ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
              {r.value}
            </dd>
          </div>
        ))}
        {state.responsible && (
          <div>
            <dt>{state.task ?? "Responsible"}</dt>
            <dd className="railwho">
              <Avatar initials={state.initials ?? null} /> {state.responsible}
            </dd>
          </div>
        )}
      </dl>

      {actions && <div className="actions half-actions">{actions}</div>}
    </section>
  );
}
