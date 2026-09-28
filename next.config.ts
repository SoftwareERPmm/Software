import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  experimental: {
    /**
     * A scanned A4 bill is two to five megabytes and the default here is one,
     * which would refuse most of the attachments this exists to accept.
     *
     * Twelve rather than something larger: the file travels through a
     * serverless function on its way to the bucket, so the ceiling is also
     * the most memory one upload can cost. If genuinely large files ever
     * need storing, the answer is a presigned URL that lets the browser PUT
     * straight to R2 and skips this path entirely — that needs CORS on the
     * bucket, which is why it is not the thing built first.
     */
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
