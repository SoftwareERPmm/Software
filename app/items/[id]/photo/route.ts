import { sql } from "@/lib/db";

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
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [row] = await sql<{ photo: Uint8Array | null; photo_mime: string | null }[]>`
    select photo, photo_mime from item where id = ${id}`;

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
