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
 * The claim is a row, so it works across restarts and across instances, and
 * the race is settled by the database rather than by hoping two requests do
 * not overlap:
 *
 *   the first request to insert the key owns it and posts
 *   a second request carrying that key finds the claim and waits for it
 *   when the first commits, the second is handed the document it made
 *
 * A claim whose posting failed is left with no document, and the next attempt
 * carrying that key takes it over — a failure is not a posted document, and
 * refusing to let somebody try again would be worse than the duplicate.
 */

/** How long to wait for the request that owns a claim, before giving up on it. */
const WAIT_MS = 15_000;
const POLL_MS = 150;

/**
 * A claim abandoned mid-flight — the process died between claiming and
 * posting. Long enough that a slow posting is never mistaken for a dead one.
 */
const STALE_MS = 60_000;

export type Posted = { id: string; docNo: string };

export async function postOnce<T extends Posted>(
  companyId: string,
  key: string | null | undefined,
  run: () => Promise<T>,
): Promise<T & { repeated?: true }> {
  // No key is the old behaviour, deliberately: scripts, imports and the test
  // suites post directly, and a missing key must never become a silent
  // refusal to post.
  if (!key) return run();

  const claimed = await claim(companyId, key);

  if (claimed === "ours") {
    try {
      const result = await run();
      await sql`
        update posting_attempt
           set document_id = ${result.id}, doc_no = ${result.docNo}, settled_at = now()
         where company_id = ${companyId} and key = ${key}`;
      return result;
    } catch (e) {
      // The claim goes back, or one failed attempt would block every retry of
      // a posting that has not happened.
      await sql`
        delete from posting_attempt
         where company_id = ${companyId} and key = ${key} and document_id is null`;
      throw e;
    }
  }

  // Somebody else owns it. Wait for what they posted.
  const waited = await waitFor(companyId, key);
  if (waited) return { ...(waited as T), repeated: true as const };

  // They finished without posting anything — their posting was refused, and
  // the claim was released. Take it from the top.
  return postOnce(companyId, key, run);
}

async function claim(companyId: string, key: string): Promise<"ours" | "theirs"> {
  const rows = await sql`
    insert into posting_attempt (company_id, key)
    values (${companyId}, ${key})
    on conflict (company_id, key) do update
       -- Taking over a claim nobody is coming back for. The where clause makes
       -- this a no-op for a live claim, which leaves the row untouched and
       -- returns nothing.
       set claimed_at = now()
     where posting_attempt.document_id is null
       and posting_attempt.claimed_at < now() - interval '60 milliseconds' * ${STALE_MS / 60}
    returning key`;
  return rows.length > 0 ? "ours" : "theirs";
}

async function waitFor(companyId: string, key: string): Promise<Posted | null> {
  const until = Date.now() + WAIT_MS;

  for (;;) {
    const [row] = await sql`
      select document_id, doc_no from posting_attempt
       where company_id = ${companyId} and key = ${key}`;

    if (!row) return null;                       // released after a refusal
    if (row.document_id) {
      return { id: row.document_id as string, docNo: (row.doc_no as string) ?? "" };
    }
    if (Date.now() > until) {
      throw new Error(
        "That submission is still being posted. Wait a moment and check the "
        + "document list before sending it again."
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
