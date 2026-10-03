import { createHmac, randomBytes } from "node:crypto";
import { base32Decode, base32Encode } from "../crypto/base32.js";
import { constantTimeEqual } from "../crypto/random.js";

export interface TotpOptions {
  digits: number;
  periodSeconds: number;
  algorithm: "sha1" | "sha256" | "sha512";
}

export const defaultTotpOptions: TotpOptions = { digits: 6, periodSeconds: 30, algorithm: "sha1" };

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function timeStep(at: Date, options: TotpOptions = defaultTotpOptions): number {
  return Math.floor(at.getTime() / 1000 / options.periodSeconds);
}

export function hotp(secret: Buffer, counter: number, options: TotpOptions = defaultTotpOptions): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(options.algorithm, secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** options.digits).padStart(options.digits, "0");
}

export function generateTotp(secretBase32: string, at: Date = new Date(), options: TotpOptions = defaultTotpOptions): string {
  return hotp(base32Decode(secretBase32), timeStep(at, options), options);
}

export interface TotpVerification {
  valid: boolean;
  step?: number;
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  params: { at?: Date; window?: number; lastUsedStep?: number | null; options?: TotpOptions } = {},
): TotpVerification {
  const options = params.options ?? defaultTotpOptions;
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d+$/.test(normalized) || normalized.length !== options.digits) return { valid: false };
  const secret = base32Decode(secretBase32);
  const current = timeStep(params.at ?? new Date(), options);
  const window = params.window ?? 1;
  let matchedStep: number | undefined;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (constantTimeEqual(hotp(secret, step, options), normalized) && matchedStep === undefined) {
      matchedStep = step;
    }
  }
  if (matchedStep === undefined) return { valid: false };
  if (params.lastUsedStep !== undefined && params.lastUsedStep !== null && matchedStep <= params.lastUsedStep) {
    return { valid: false };
  }
  return { valid: true, step: matchedStep };
}

export function buildOtpAuthUri(params: { secret: string; accountName: string; issuer: string; options?: TotpOptions }): string {
  const options = params.options ?? defaultTotpOptions;
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: options.algorithm.toUpperCase(),
    digits: String(options.digits),
    period: String(options.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
