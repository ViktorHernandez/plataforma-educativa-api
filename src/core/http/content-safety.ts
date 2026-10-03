import { ErrorCode, badRequest } from "./errors.js";

const dangerousPatterns: RegExp[] = [
  /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|base|form|svg|math)\b/i,
  /\bon[a-z]+\s*=/i,
  /(javascript|vbscript|livescript)\s*:/i,
  /data\s*:\s*text\/html/i,
  /expression\s*\(/i,
];

export function findUnsafeContent(value: string): string | null {
  for (const pattern of dangerousPatterns) {
    const match = pattern.exec(value);
    if (match) return match[0];
  }
  return null;
}

export function assertSafeRichText(value: string | null | undefined, field: string): void {
  if (!value) return;
  const unsafe = findUnsafeContent(value);
  if (unsafe) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, "The content contains disallowed markup", { issues: [{ location: "body", path: field, message: "Disallowed markup" }] });
  }
}
