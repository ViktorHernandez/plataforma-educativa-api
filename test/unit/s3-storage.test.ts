import { describe, expect, it } from "vitest";
import { S3StorageProvider } from "../../src/core/storage/s3-storage.js";

const provider = new S3StorageProvider({
  endpoint: "http://127.0.0.1:1",
  region: "us-east-1",
  bucket: "unit-bucket",
  accessKeyId: "unit-access-key",
  secretAccessKey: "unit-secret-key",
  forcePathStyle: true,
});

describe("S3 presigned upload targets", () => {
  it("signs content type and length without a precomputed body checksum", async () => {
    const target = await provider.createUploadTarget("incoming/a/file.png", "image/png", 2048, 300);
    const url = new URL(target.url);
    expect(url.pathname).toBe("/unit-bucket/incoming/a/file.png");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect([...url.searchParams.keys()].some((name) => name.toLowerCase().startsWith("x-amz-checksum"))).toBe(false);
    expect(url.searchParams.get("x-amz-sdk-checksum-algorithm")).toBeNull();
    expect(target.headers).toEqual({ "content-type": "image/png", "content-length": "2048" });
  });

  it("builds download URLs that override content type and disposition", async () => {
    const url = new URL(await provider.createDownloadUrl("files/a/report.pdf", { fileName: "informe final.pdf", contentType: "application/pdf", expiresInSeconds: 60 }));
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toContain("attachment");
    expect([...url.searchParams.keys()].some((name) => name.toLowerCase().startsWith("x-amz-checksum"))).toBe(false);
  });
});
