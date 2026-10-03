import type { FilePurpose } from "../../generated/prisma/enums.js";
import { FileVisibility } from "../../generated/prisma/enums.js";

export interface PurposePolicy {
  maxBytes: number;
  mimeTypes: string[];
  visibility: FileVisibility;
  textFormats?: Array<"vtt" | "csv" | "plain">;
}

const MB = 1024 * 1024;
const images = ["image/jpeg", "image/png", "image/webp"];
const documents = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const purposePolicies: Record<FilePurpose, PurposePolicy> = {
  AVATAR: { maxBytes: 5 * MB, mimeTypes: images, visibility: FileVisibility.PUBLIC },
  COURSE_COVER: { maxBytes: 10 * MB, mimeTypes: images, visibility: FileVisibility.PUBLIC },
  LESSON_MEDIA: { maxBytes: 2048 * MB, mimeTypes: ["video/mp4", "video/webm", "audio/mpeg", "audio/mp4"], visibility: FileVisibility.INSTITUTION },
  LESSON_RESOURCE: { maxBytes: 200 * MB, mimeTypes: [...documents, ...images, "text/plain", "text/csv"], visibility: FileVisibility.INSTITUTION, textFormats: ["plain", "csv"] },
  CAPTION: { maxBytes: 2 * MB, mimeTypes: ["text/vtt"], visibility: FileVisibility.INSTITUTION, textFormats: ["vtt"] },
  MESSAGE_ATTACHMENT: { maxBytes: 25 * MB, mimeTypes: [...images, "application/pdf", documents[0]!, "text/plain"], visibility: FileVisibility.PRIVATE, textFormats: ["plain"] },
  SUBMISSION: { maxBytes: 100 * MB, mimeTypes: [...documents, ...images, "text/plain"], visibility: FileVisibility.PRIVATE, textFormats: ["plain"] },
  REPORT_EXPORT: { maxBytes: 500 * MB, mimeTypes: ["text/csv"], visibility: FileVisibility.PRIVATE, textFormats: ["csv"] },
  DATA_EXPORT: { maxBytes: 2048 * MB, mimeTypes: ["application/json"], visibility: FileVisibility.PRIVATE },
};

const textMimeByFormat: Record<string, string> = { vtt: "text/vtt", csv: "text/csv", plain: "text/plain" };

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned.length > 0 ? cleaned : "file").slice(0, 200);
}

export function looksLikeUtf8Text(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export function detectTextFormat(sample: Buffer, declaredMime: string, policy: PurposePolicy): string | null {
  if (!policy.textFormats || !looksLikeUtf8Text(sample)) return null;
  const text = sample.toString("utf8").replace(/^\uFEFF/, "");
  if (policy.textFormats.includes("vtt") && declaredMime === "text/vtt") return text.startsWith("WEBVTT") ? "text/vtt" : null;
  if (/<\s*(script|html|svg|iframe)/i.test(text)) return null;
  const format = policy.textFormats.find((candidate) => textMimeByFormat[candidate] === declaredMime);
  return format ? textMimeByFormat[format]! : null;
}
