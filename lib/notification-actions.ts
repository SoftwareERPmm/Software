"use server";

import { sql } from "./db";
import { currentUser } from "./session";
import { DOC_TYPE_LABEL, docTypesFor, notificationsDefault } from "./auth";

export type NotificationItem = {
  id: string;
  /** Where clicking it goes: the document, or for a void, the one voided. */
  documentId: string;
  kind: "posted" | "voided" | "amended";
  actor: string;
  initials: string;
  docType: string;
  docLabel: string;
  docNo: string;
  partner: string | null;
  amount: number | null;
  currency: string;
  reason: string | null;
  at: string;
  unread: boolean;
};

export type NotificationState = {
  on: boolean;
  unread: number;
  items: NotificationItem[];
};

/**
 * What other people did, in the modules this person can reach.
 *
 * Derived from documents rather than written to a table of its own: a
 * document already records who made it and when (migration 0123), so a
 * second record of the same fact would only be a second thing to keep in
 * step. Three kinds of event:
 *   posted   an ordinary document
 *   voided   a reversal — the event is about the document it cancels
 *   amended  a new version that supersedes an earlier one
 *
 * What is left out, because it is not a separate act anyone took: the
 * delivery and receipt a counter sale writes beside its invoice, the
 * reversals a void writes for those, and the consignment settlement an
 * invoice raises for the consignor. One action, one notification.
 */
async function feed(userId: string, roles: string[], seenAt: Date | null, limit: number) {
  const types = docTypesFor(roles);
  if (types.length === 0) return [];
  const rows = await sql`
    select d.id, d.doc_type, d.doc_no, d.created_at, d.gross_total::float as amount, d.currency,
           d.reverses_document_id, d.supersedes_document_id,
           o.id as orig_id, o.doc_no as orig_no, o.doc_type as orig_type, o.void_reason,
           coalesce(p.name, op.name) as partner,
           u.name as actor, u.initials,
           d.created_at > coalesce(${seenAt}::timestamptz, now() - interval '7 days') as unread
      from document d
      join app_user u on u.id = d.created_by_id
      left join document o on o.id = d.reverses_document_id
      left join business_partner p on p.id = d.partner_id
      left join business_partner op on op.id = o.partner_id
     where d.created_by_id <> ${userId}
       and d.status <> 'DRAFT'
       and d.lifecycle_owner_id is null
       and (o.id is null or o.lifecycle_owner_id is null)
       and coalesce(o.doc_type, d.doc_type) = any(${types})
       and not exists (
         select 1 from consignment_settlement_line sl where sl.settlement_document_id = d.id)
     order by d.created_at desc
     limit ${limit}`;
  return (rows as unknown as Array<{
    id: string; doc_type: string; doc_no: string; created_at: Date; amount: number | null;
    reverses_document_id: string | null; supersedes_document_id: string | null;
    orig_id: string | null; orig_no: string | null; orig_type: string | null; void_reason: string | null;
    partner: string | null; actor: string; initials: string; unread: boolean; currency: string;
  }>).map((r): NotificationItem => {
    const voided = r.reverses_document_id !== null;
    const type = voided ? (r.orig_type ?? r.doc_type) : r.doc_type;
    return {
      id: r.id,
      documentId: voided ? (r.orig_id ?? r.id) : r.id,
      kind: voided ? "voided" : r.supersedes_document_id ? "amended" : "posted",
      actor: r.actor,
      initials: r.initials,
      docType: type,
      docLabel: DOC_TYPE_LABEL[type] ?? type.toLowerCase().replace(/_/g, " "),
      docNo: voided ? (r.orig_no ?? r.doc_no) : r.doc_no,
      partner: r.partner,
      amount: voided || r.amount === null ? null : Math.abs(Number(r.amount)),
      currency: r.currency ?? "MMK",
      reason: voided ? r.void_reason : null,
      at: new Date(r.created_at).toISOString(),
      unread: r.unread,
    };
  });
}

async function me() {
  const user = await currentUser();
  if (!user) return null;
  const [row] = await sql`
    select notifications_on, notifications_seen_at from app_user where id = ${user.id}`;
  const on = row?.notifications_on ?? notificationsDefault(user.roles);
  return { user, on: on as boolean, seenAt: (row?.notifications_seen_at ?? null) as Date | null };
}

/** The bell's whole state: whether it is on, how many are unread, and the latest twenty. */
export async function getNotifications(): Promise<NotificationState> {
  const m = await me();
  if (!m || !m.on) return { on: m?.on ?? false, unread: 0, items: [] };
  // One read serves both: the list shows the newest twenty, and the count
  // covers the newest hundred.
  const recent = await feed(m.user.id, m.user.roles, m.seenAt, 100);
  return { on: true, unread: recent.filter((i) => i.unread).length, items: recent.slice(0, 20) };
}

async function unreadCount(userId: string, roles: string[], seenAt: Date | null) {
  // Counted from a longer window than the list shows, but capped: "99+" is
  // as much as anyone needs to know.
  const items = await feed(userId, roles, seenAt, 100);
  return items.filter((i) => i.unread).length;
}

/** Just the count, for the badge — polled, so kept to one query's worth. */
export async function getUnreadCount(): Promise<{ on: boolean; unread: number }> {
  const m = await me();
  if (!m || !m.on) return { on: m?.on ?? false, unread: 0 };
  return { on: true, unread: await unreadCount(m.user.id, m.user.roles, m.seenAt) };
}

export async function markNotificationsSeen(): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  await sql`update app_user set notifications_seen_at = now() where id = ${user.id}`;
}

export async function setNotificationsOn(on: boolean): Promise<NotificationState> {
  const user = await currentUser();
  if (!user) return { on: false, unread: 0, items: [] };
  // Turning them on starts from now, not from a backlog of everything
  // missed while they were off.
  await sql`
    update app_user
       set notifications_on = ${on},
           notifications_seen_at = case when ${on} then now() else notifications_seen_at end
     where id = ${user.id}`;
  return getNotifications();
}
