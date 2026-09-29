import { randomUUID } from "node:crypto";
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * Cloudflare R2, which speaks S3.
 *
 * Two buckets, and which one a file goes in is decided by who may read it
 * rather than by what kind of file it is:
 *
 *   private — evidence about a transaction. A supplier's scanned bill, a
 *             signed delivery note, a photograph of damaged goods. Served
 *             only through this app, never addressable from outside.
 *   public  — pictures of products. Fetched on every catalogue page, worth
 *             nothing to a stranger, and served straight from the edge,
 *             which is the reason for having a public bucket at all.
 *
 * Nothing here decides which bucket a caller wants. The caller says, because
 * getting it wrong is a disclosure and a default would eventually make that
 * choice for somebody who was not thinking about it.
 */

export type Bucket = "private" | "public";

/** Read at call time, not at import: a missing key should fail the upload
 *  that needed it, not the whole build. */
function config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const privateBucket = process.env.R2_BUCKET_PRIVATE;
  const publicBucket = process.env.R2_BUCKET_PUBLIC;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;

  const missing = Object.entries({
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET_PRIVATE: privateBucket,
    R2_BUCKET_PUBLIC: publicBucket,
    R2_PUBLIC_BASE_URL: publicBase,
  }).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `File storage is not configured — ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"} not set. ` +
      `Until it is, uploads are refused rather than lost.`
    );
  }

  return {
    accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!,
    privateBucket: privateBucket!, publicBucket: publicBucket!,
    publicBase: publicBase!.replace(/\/+$/, ""),
  };
}

/** Whether uploads can work at all, for a screen that would rather say so
 *  than offer a button that throws. */
export function storageConfigured(): boolean {
  try { config(); return true; } catch { return false; }
}

let client: S3Client | null = null;
function s3(): S3Client {
  const c = config();
  // One client for the process. R2 has a single endpoint per account and
  // both buckets sit behind it, so the bucket is a per-call argument.
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }
  return client;
}

function bucketName(which: Bucket): string {
  const c = config();
  return which === "private" ? c.privateBucket : c.publicBucket;
}

/**
 * A key nobody can guess and nothing can collide with.
 *
 * The person's filename never becomes the key: two people upload
 * "invoice.pdf" in the same week, and a filename is their input rather than
 * ours. It is kept alongside in the row, for the download to be called
 * something recognisable.
 *
 * The prefix is only for reading a bucket listing by eye — R2 has no
 * folders, and nothing in the app parses a key back into its parts.
 */
export function newKey(prefix: string, filename?: string): string {
  const ext = filename?.includes(".")
    ? "." + filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)
    : "";
  const day = new Date().toISOString().slice(0, 10);
  return `${prefix}/${day}/${randomUUID()}${ext}`;
}

export async function putObject(input: {
  bucket: Bucket;
  key: string;
  body: Buffer;
  contentType: string;
  /** Sent back on download so a browser saves it under its own name. */
  downloadName?: string;
}): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket: bucketName(input.bucket),
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    ContentDisposition: input.downloadName
      ? `attachment; filename="${input.downloadName.replace(/["\\]/g, "")}"`
      : undefined,
  }));
}

/** The bytes back, for the route that streams a private file to somebody
 *  the app has decided may see it. */
export async function getObject(bucket: Bucket, key: string): Promise<{
  body: Buffer; contentType: string | undefined;
}> {
  const out = await s3().send(new GetObjectCommand({
    Bucket: bucketName(bucket), Key: key,
  }));
  const body = Buffer.from(await out.Body!.transformToByteArray());
  return { body, contentType: out.ContentType };
}

/**
 * Best effort, and deliberately so.
 *
 * A row is deleted inside a transaction; a bucket is not part of it. If the
 * object outlives its row the result is an orphan nobody can reach, which
 * costs a fraction of a cent. If a failed delete rolled back the row, the
 * user would be told their deletion failed when the record they care about
 * is gone. The row is the record; the object is the payload.
 */
export async function deleteObject(bucket: Bucket, key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  } catch {
    // Orphaned object. Nothing references it and nothing can reach it.
  }
}

/** Where a public object is readable from. Only ever the public bucket —
 *  there is no such address for a private one, which is the point. */
export function publicUrl(key: string): string {
  return `${config().publicBase}/${key}`;
}
