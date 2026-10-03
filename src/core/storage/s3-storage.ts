import { Readable, PassThrough } from "node:stream";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDisposition, type DownloadOptions, type StorageProvider, type StoredObjectInfo, type UploadTarget } from "./storage-provider.js";

export interface S3StorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async createUploadTarget(key: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<UploadTarget> {
    const command = new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return {
      method: "PUT",
      url,
      headers: { "content-type": contentType, "content-length": String(sizeBytes) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { sizeBytes: Number(result.ContentLength ?? 0), contentType: result.ContentType ?? null };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async readPrefix(key: string, bytes: number): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    const body = await result.Body?.transformToByteArray();
    return Buffer.from(body ?? []);
  }

  async createDownloadUrl(key: string, options: DownloadOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: contentDisposition(options.fileName, options.inline ?? false),
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async putStream(key: string, body: Readable, contentType: string): Promise<{ sizeBytes: number }> {
    let sizeBytes = 0;
    const counter = new PassThrough();
    counter.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
    });
    body.on("error", (error) => counter.destroy(error));
    body.pipe(counter);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.options.bucket, Key: key, Body: counter, ContentType: contentType },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
    return { sizeBytes };
  }

  async openReadStream(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    const body = result.Body;
    if (body instanceof Readable) return body;
    if (!body) throw new Error("Storage object has no body");
    return Readable.fromWeb(body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0]);
  }

  async move(sourceKey: string, targetKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: targetKey,
        CopySource: `${this.options.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: sourceKey }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}
