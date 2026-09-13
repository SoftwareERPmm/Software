import type { TransactionSql } from "postgres";
import { sql } from "./db";

/**
 * One submission, one posting.
 *
 * A double-clicked button, a browser retrying a request it believes failed, a
 * platform resending one it could not confirm — each of these arrives as a
 * second identical request, and every posting path in this app was free to
 * turn it into a second document with its own stock movements and its own
 * journal entry.
 *
 * Not to be confused with the same goods arriving twice, which is a fact and
 * must stay postable: a second delivery is a deliberate second transaction
 * and carries a key of its own.
 *
 * The claim and the posting commit together, in one transaction. That is the
 * whole of the design, and the first version got it wrong: it posted, then
 * recorded the result in a second statement, which leaves a window where the
 * documents exist and nothing remembers making them. A failure in that window
 * released the key and the retry posted everything again — the duplicate this
 * exists to prevent, produced by the thing preventing it.
 *
 * Committing them together also disposes of stale claims. A claim only
 * reaches the database if its posting did, so there is no such thing as a
 * claim with no document, and nothing has to be timed out or taken over: a
 * request that dies mid-posting rolls back and leaves no trace, and the
 * retry is free to claim the key properly.
 *
 * The race is settled by the unique index rather than by polling. Two
 * requests carrying one key: the first inserts and holds the row; the second
 * blocks on that insert for exactly as long as the first takes, then either
 * finds it committed — and is handed the document it made — or finds it gone,
 * because the first was refused, and posts in its place.
 */

export type Posted = { id: string; docNo: string };

export async function postOnce<T extends Posted>(
  companyId: string,
  key: string | null | undefined,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T & { repeated?: true }> {
  // No key is the old behaviour, deliberately: scripts, imports and the test
  // suites post directly, and a missing key must never become a silent
  // refusal to post.
  if (!key) return sql.begin(run) as Promise<T>;

  try {
    return (await sql.begin(async (tx) => {
      // Blocks here while another request holds this key, which is exactly as
      // long as that request's transaction. Then either it committed — and
      // this raises a unique violation, caught below — or it rolled back and
      // its row is gone, leaving this one free to take the key.
      await tx`
        insert into posting_attempt (company_id, key)
        values (${companyId}, ${key})`;

      const result = await run(tx);

      await tx`
        update posting_attempt
           set document_id = ${result.id}, doc_no = ${result.docNo}, settled_at = now()
         where company_id = ${companyId} and key = ${key}`;

      return result;
    })) as T;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;

    const [row] = await sql`
      select document_id, doc_no from posting_attempt
       where company_id = ${companyId} and key = ${key}`;

    if (row?.document_id) {
      return {
        id: row.document_id as string,
        docNo: (row.doc_no as string) ?? "",
        repeated: true as const,
      } as T & { repeated: true };
    }

    // The row exists but names no document: another request is still inside
    // its transaction and this one raced it to the index. Rare, and a second
    // attempt resolves it — by then that request has either committed or gone.
    throw new Error(
      "That submission is already being posted. Wait a moment, then check the "
      + "document list before sending it again."
    );
  }
}

/** 23505: the unique index on (company_id, key) — somebody already has it. */
function isDuplicateKey(e: unknown): boolean {
  return typeof e === "object" && e !== null
    && (e as { code?: string }).code === "23505";
}

/**
 * What this key already posted, if anything.
 *
 * For the paths that check something before posting — a correction compares
 * what the reader was shown against what the document says now, and rejects a
 * plan made from figures that have since moved. On a retry those figures
 * have moved: the first attempt moved them. Asked first, the retry is handed
 * the correction that succeeded instead of being told it is out of date.
 */
export async function alreadyPosted(
  companyId: string,
  key: string | null | undefined,
): Promise<Posted | null> {
  if (!key) return null;
  const [row] = await sql`
    select document_id, doc_no from posting_attempt
     where company_id = ${companyId} and key = ${key} and document_id is not null`;
  return row
    ? { id: row.document_id as string, docNo: (row.doc_no as string) ?? "" }
    : null;
}
