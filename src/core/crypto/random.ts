import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

const humanAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomHumanCode(length: number): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += humanAlphabet[randomInt(humanAlphabet.length)];
  }
  return output;
}

export function randomSeed(): number {
  return randomInt(1, 2 ** 31 - 1);
}
