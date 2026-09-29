import { sql } from "@/lib/db";
import { publicUrl } from "@/lib/r2";

/**
 * The picture itself, served as bytes rather than carried in the page.
 *
 * A catalogue of two hundred items inlining two hundred data URIs is a page
 * that ships several megabytes of base64 on every load and caches none of it.
 * As a URL the browser fetches each once and keeps it, and the HTML stays the
 * size it was.
 *
 * Cached forever, deliberately. The src carries ?v=<photo_updated_at>, so
 * replacing a photo asks for a different URL — there is no stale picture to
 * invalidate, because the old one is no longer referenced by anything.
 *
 * Since 0105 the bytes live in the public R2 bucket and this hands the
 * browser a redirect to them, rather than reading them out of the database
 * and passing them along. Two round trips instead of one, and worth it: the
 * image itself then comes from Cloudflare's edge rather than through a
 * serverless function, and the redirect is a couple of hundred bytes against
 * the picture's forty thousand.
 *
 * The route stays rather than the pages linking at the bucket directly, so
 * that the address of a photo is this app's to decide. Moving buckets, or
 * putting a signed URL in front of one, then changes one file.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [row] = await sql<{
    photo_key: string | null; photo: Uint8Array | null; photo_mime: string | null;
  }[]>`select photo_key, photo, photo_mime from item where id = ${id}`;

  if (row?.photo_key) {
    return new Response(null, {
      status: 307,
      headers: {
        Location: publicUrl(row.photo_key),
        // Safe to keep, because the ?v= in the caller's src changes whenever
        // the picture does — this redirect only ever answers for one version.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  // Pictures stored before 0105 moved them to the bucket. Nothing on any
  // database is in this state, and the column is no longer written — but a
  // row that predates the move should still show its photo rather than a
  // gap, and the fallback costs one branch.
  if (!row?.photo || !row.photo_mime) {
    return new Response("No photo", { status: 404 });
  }

  return new Response(new Uint8Array(row.photo), {
    headers: {
      "Content-Type": row.photo_mime,
      "Content-Length": String(row.photo.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      // The bytes were produced by sharp and the type by us, but a browser
      // that decides for itself is a browser that can be talked into deciding
      // "HTML" about somebody's uploaded file.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
