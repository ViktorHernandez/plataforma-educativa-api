import type { Readable } from "node:stream";

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

export interface DownloadOptions {
  fileName: string;
  contentType: string;
  expiresInSeconds: number;
  inline?: boolean;
}

export interface StorageProvider {
  readonly name: string;
  createUploadTarget(key: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<UploadTarget>;
  head(key: string): Promise<StoredObjectInfo | null>;
  readPrefix(key: string, bytes: number): Promise<Buffer>;
  createDownloadUrl(key: string, options: DownloadOptions): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  putStream(key: string, body: Readable, contentType: string): Promise<{ sizeBytes: number }>;
  openReadStream(key: string): Promise<Readable>;
  move(sourceKey: string, targetKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
