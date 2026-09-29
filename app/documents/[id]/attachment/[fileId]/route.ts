import { getAttachment, getCompany } from "@/lib/queries";
import { getObject } from "@/lib/r2";

/**
 * A file from the private bucket, handed over by the app rather than by
 * Cloudflare.
 *
 * This route is the whole reason that bucket can stay private. A scanned
 * bill has a customer's name, a supplier's prices and sometimes a signature
 * on it, and none of that should be readable by anyone who guesses a URL —
 * so there is no public address for it, and every read comes through here.
 *
 * Today that means "anyone who can reach the app", which is everyone,
 * because there is no sign-in yet. That is not much of a gate, but it is a
 * gate in the right place: when authentication arrives it goes in this
 * function and every attachment in the system is behind it at once. A public
 * bucket could not be retrofitted the same way.
 *
 * The document id is in the path and checked against the row, so a file
 * cannot be fetched by pointing at a document it does not belong to.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params;

  // Not lib/actions' companyId: that file is "use server", so anything
  // exported from it becomes callable from a browser.
  const company = await getCompany();
  if (!company) return new Response("Not found", { status: 404 });

  const row = await getAttachment(company.id, fileId);
  if (!row || row.document_id !== id) {
    return new Response("Not found", { status: 404 });
  }

  let file: { body: Buffer; contentType: string | undefined };
  try {
    file = await getObject("private", row.r2_key as string);
  } catch {
    // The row says there is a file and the bucket disagrees. Says so plainly
    // rather than returning an empty download: this is the drift that keeping
    // bytes outside the database makes possible, and it should be legible
    // when it happens rather than look like a broken browser.
    return new Response(
      "This file is recorded but its contents could not be read from storage.",
      { status: 502 },
    );
  }

  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": (row.mime as string) || file.contentType || "application/octet-stream",
      "Content-Length": String(file.body.byteLength),
      // Shown in the browser where it can be — a scan is usually something to
      // look at rather than to file away — under the name it was given.
      "Content-Disposition":
        `inline; filename="${String(row.filename).replace(/["\\]/g, "")}"`,
      // Private, so the shared caches in between must not keep a copy.
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
