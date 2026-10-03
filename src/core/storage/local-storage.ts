import { createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constantTimeEqual } from "../crypto/random.js";
import { contentDisposition, type DownloadOptions, type StorageProvider, type StoredObjectInfo, type UploadTarget } from "./storage-provider.js";

export interface LocalGrant {
  op: "put" | "get";
  key: string;
  exp: number;
  contentType: string;
  maxBytes?: number;
  disposition?: string;
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  private readonly root: string;

  constructor(
    rootDirectory: string,
    private readonly publicApiUrl: string,
    private readonly signingSecret: string,
  ) {
    this.root = path.resolve(rootDirectory);
  }

  resolvePath(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return resolved;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingSecret).update(`local-storage:${payload}`).digest("base64url");
  }

  issueGrant(grant: LocalGrant): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  verifyGrant(token: string, op: LocalGrant["op"]): LocalGrant | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !constantTimeEqual(this.sign(payload), signature)) return null;
    try {
      const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LocalGrant;
      if (grant.op !== op || grant.exp < Date.now()) return null;
      return grant;
    } catch {
      return null;
    }
  }

  async createUploadTarget(key: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<UploadTarget> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const token = this.issueGrant({ op: "put", key, exp: expiresAt.getTime(), contentType, maxBytes: sizeBytes });
    return {
      method: "PUT",
      url: `${this.publicApiUrl}/v1/files/local/object?token=${token}`,
      headers: { "content-type": contentType },
      expiresAt,
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const info = await stat(this.resolvePath(key));
      return { sizeBytes: info.size, contentType: null };
    } catch {
      return null;
    }
  }

  async readPrefix(key: string, bytes: number): Promise<Buffer> {
    const handle = await open(this.resolvePath(key), "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async readAll(key: string): Promise<Buffer> {
    return readFile(this.resolvePath(key));
  }

  async createDownloadUrl(key: string, options: DownloadOptions): Promise<string> {
    const token = this.issueGrant({
      op: "get",
      key,
      exp: Date.now() + options.expiresInSeconds * 1000,
      contentType: options.contentType,
      disposition: contentDisposition(options.fileName, options.inline ?? false),
    });
    return `${this.publicApiUrl}/v1/files/local/object?token=${token}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolvePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { mode: 0o600 });
  }

  async putStream(key: string, body: Readable): Promise<{ sizeBytes: number }> {
    const target = this.resolvePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.partial`;
    let sizeBytes = 0;
    const counter = new PassThrough();
    counter.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
    });
    try {
      await pipeline(body, counter, createWriteStream(temporary, { mode: 0o600 }));
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { sizeBytes };
  }

  async openReadStream(key: string): Promise<Readable> {
    const target = this.resolvePath(key);
    await stat(target);
    return createReadStream(target);
  }

  async move(sourceKey: string, targetKey: string): Promise<void> {
    const source = this.resolvePath(sourceKey);
    const target = this.resolvePath(targetKey);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}
